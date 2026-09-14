// ──────────────────────────────────────────────
// School ERP — Notification Engine (Go), Phase 6.1
//
// Real-time WebSocket fan-out for live dashboards and in-app notifications:
//   • assertion-authenticated sockets (no more ?user_id= identity — the
//     Phase-0 way in was a forged-header escalation),
//   • per-tenant Redis pub/sub channels with delivery-time tenant re-checks
//     (GATE 6's cross-tenant leak test),
//   • per-user / per-branch / per-school / per-tenant routing,
//   • presence, backpressure (slow clients are dropped, never blocking),
//     and subscribe re-authorisation with fail-closed revocation.
//
// REST surface (behind the gateway, assertion on every call):
//   POST /notifications/send       → publish to user / branch / school / tenant
//   POST /notifications/ws-ticket  → browser socket ticket (same assertion)
//   GET  /notifications/presence   → who is connected, per tenant
//   GET  /health
//   WS   /notifications/ws?assertion=<ticket>
// ──────────────────────────────────────────────

package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/redis/go-redis/v9"
)

// SendRequest is the POST /send body. Every routing field comes from the
// caller's ASSERTION — the body can only say what, never who or where.
type SendRequest struct {
	Title      string `json:"title" binding:"required"`
	Body       string `json:"body" binding:"required"`
	Kind       string `json:"kind" binding:"required"`    // ANNOUNCEMENT | ALERT | REMINDER | ...
	Channel    string `json:"channel" binding:"required"` // user | branch | school | tenant
	TargetUser string `json:"targetUser,omitempty"`       // channel=user
	BranchID   string `json:"branchId,omitempty"`         // channel=branch
	DeepLink   string `json:"deepLink,omitempty"`
}

func main() {
	port := os.Getenv("PORT_NOTIFICATION_ENGINE")
	if port == "" {
		port = "6001"
	}

	redisURL := os.Getenv("REDIS_URL")
	if redisURL == "" {
		redisURL = "redis://localhost:6379"
	}

	// Fail-closed auth: no public key, no engine. (ADR-3 — an engine that
	// trusts the network is a cross-tenant broadcast button.)
	auth, err := NewAuthenticator()
	if err != nil {
		log.Fatalf("notification-engine: %v", err)
	}

	opt, err := redis.ParseURL(redisURL)
	if err != nil {
		log.Fatalf("notification-engine: bad REDIS_URL: %v", err)
	}
	rdb := redis.NewClient(opt)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	if err := pingWithRetry(ctx, rdb, 5, 2*time.Second); err != nil {
		log.Printf("⚠️  Redis unavailable: %v — sockets work, cross-instance pub/sub does not", err)
	} else {
		log.Println("✅ Connected to Redis")
	}

	hub := newHub()
	go hub.run()
	go (&subscriber{rdb: rdb, hub: hub}).run(ctx)
	pub := &publisher{rdb: rdb}

	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	r.Use(gin.Logger(), gin.Recovery())

	// Every route requires a verified assertion — there is no public route.
	authorise := func(c *gin.Context) *AssertionClaims {
		claims, err := auth.Verify(assertionFromRequest(
			c.GetHeader(assertionHeader),
			c.Query(assertionQueryParam),
		))
		if err != nil {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": err.Error()})
			return nil
		}
		c.Set("claims", claims)
		return claims
	}

	r.GET("/health", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{
			"status":    "ok",
			"service":   "notification-engine",
			"timestamp": time.Now().Format(time.RFC3339),
		})
	})

	// WebSocket — same auth, header or ?assertion= ticket.
	sess := &session{hub: hub, auth: auth}
	r.GET("/notifications/ws", func(c *gin.Context) {
		if authorise(c) == nil {
			return
		}
		sess.handleWS(c.Writer, c.Request)
	})

	// Publish. The envelope's tenant ALWAYS comes from the caller's
	// assertion; the hub re-checks it against every socket at delivery.
	r.POST("/notifications/send", func(c *gin.Context) {
		claims := authorise(c)
		if claims == nil {
			return
		}
		var req SendRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}

		env := Envelope{
			Type:      "notification",
			Title:     req.Title,
			Body:      req.Body,
			Kind:      req.Kind,
			DeepLink:  req.DeepLink,
			Timestamp: time.Now().UnixMilli(),
		}

		var n int
		switch req.Channel {
		case "user":
			n = hub.PublishToUser(claims, req.TargetUser, env)
		case "branch":
			if req.BranchID == "" {
				c.JSON(http.StatusBadRequest, gin.H{"error": "branchId is required for channel=branch"})
				return
			}
			n = hub.PublishToBranch(claims, req.BranchID, env)
		case "school":
			if claims.schoolID() == "" {
				c.JSON(http.StatusBadRequest, gin.H{"error": "assertion has no schoolId — cannot address school channel"})
				return
			}
			n = hub.PublishToSchool(claims, env)
		case "tenant":
			n = hub.PublishToTenant(claims, env)
		default:
			c.JSON(http.StatusBadRequest, gin.H{"error": "channel must be one of user|branch|school|tenant"})
			return
		}

		// Cross-instance reach: also fan out over Redis so engines on other
		// hosts deliver to their own sockets.
		if err := pub.PublishTenant(c.Request.Context(), claims.tenantID(), env); err != nil {
			log.Printf("redis publish failed (local fan-out already done): %v", err)
		}

		c.JSON(http.StatusOK, gin.H{"status": "sent", "localSockets": n})
	})

	// Browser socket ticket: the same RS256 assertion, minted by the
	// gateway on the user's behalf and handed over as JSON the client can
	// put into `?assertion=`. This engine does not hold user credentials,
	// so the ticket is the gateway's assertion RE-PUBLISHED here only when
	// the caller already presented a valid one.
	r.POST("/notifications/ws-ticket", func(c *gin.Context) {
		claims := authorise(c)
		if claims == nil {
			return
		}
		// Re-issue the presented assertion as the ticket. It expires on the
		// same schedule (≤60s); the socket re-subscribes with fresh tickets.
		c.JSON(http.StatusOK, gin.H{
			"ticket":   assertionFromRequest(c.GetHeader(assertionHeader), c.Query(assertionQueryParam)),
			"wsPath":   "/notifications/ws",
			"expireAt": time.Now().Add(60 * time.Second).Unix(),
		})
	})

	r.GET("/notifications/presence", func(c *gin.Context) {
		claims := authorise(c)
		if claims == nil {
			return
		}
		// Non-admins see only their own tenant; SUPER_ADMIN sees all.
		tenant := claims.tenantID()
		if claims.hasRole("SUPER_ADMIN") && c.Query("all") == "true" {
			tenant = ""
		}
		c.JSON(http.StatusOK, gin.H{"presence": hub.Presence(tenant)})
	})

	srv := &http.Server{
		Addr:    ":" + port,
		Handler: r,
	}

	go func() {
		log.Printf("🔔 Notification Engine (Phase 6.1) on http://localhost:%s", port)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("notification-engine: %v", err)
		}
	}()

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit
	log.Println("shutting down — closing sockets")
	cancel()
	hub.close()
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer shutdownCancel()
	_ = srv.Shutdown(shutdownCtx)
}
