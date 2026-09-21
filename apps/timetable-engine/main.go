// ──────────────────────────────────────────────
// School ERP — Timetable Engine (Go), Phase 6.2
//
// The strongest Go case in the system: a constraint solver for school
// timetables with a hard-constraint checker that refuses to emit anything
// imperfect. Schools do this on paper over a week; the engine does it in
// milliseconds, deterministic under a seed.
//
// REST surface (behind the gateway, internal assertion on every call):
//   POST /timetable/validate       → check any timetable against the hard rules
//   POST /timetable/generate       → solve; "solved" means ZERO violations
//   POST /timetable/substitutions  → cover suggestions for absent teachers
//   GET  /health
// ──────────────────────────────────────────────

package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"runtime"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
)

const assertionIssuer = "school-erp-gateway"
const assertionAudience = "timetable-engine"

// AssertionClaims mirrors @school-erp/auth's claim schema (only what the
// engine logs is declared; jwt/v5 ignores the rest).
type AssertionClaims struct {
	Email    string   `json:"email"`
	TenantID string   `json:"tenantId"`
	Roles    []string `json:"roles"`
	jwt.RegisteredClaims
}

// startTime feeds the /metrics uptime gauge.
var startTime = time.Now()

func main() {
	port := os.Getenv("PORT_TIMETABLE_ENGINE")
	if port == "" {
		port = "6003"
	}

	auth, err := NewAuthenticator()
	if err != nil {
		log.Fatalf("timetable-engine: %v", err)
	}

	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	r.Use(gin.Logger(), gin.Recovery())

	authorise := func(c *gin.Context) *AssertionClaims {
		token := c.GetHeader("x-internal-assertion")
		if token == "" {
			token = c.Query("assertion")
		}
		parsed, err := jwt.ParseWithClaims(token, &AssertionClaims{},
			func(*jwt.Token) (interface{}, error) { return auth.key, nil },
			jwt.WithValidMethods([]string{"RS256"}),
			jwt.WithIssuer(assertionIssuer),
			jwt.WithAudience(assertionAudience),
			jwt.WithLeeway(5*time.Second),
		)
		if err != nil || !parsed.Valid || parsed.Claims.(*AssertionClaims).Subject == "" {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "invalid or missing internal assertion"})
			return nil
		}
		return parsed.Claims.(*AssertionClaims)
	}

	r.GET("/health", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{
			"status":    "ok",
			"service":   "timetable-engine",
			"timestamp": time.Now().Format(time.RFC3339),
		})
	})

	// Phase 11: Prometheus runtime metrics (stdlib only).
	r.GET("/metrics", func(c *gin.Context) {
		var ms runtime.MemStats
		runtime.ReadMemStats(&ms)
		body := fmt.Sprintf(
			"# TYPE uptime_seconds gauge\nuptime_seconds %.3f\n"+
				"# TYPE process_resident_memory_bytes gauge\nprocess_resident_memory_bytes %d\n"+
				"# TYPE go_goroutines gauge\ngo_goroutines %d\n",
			time.Since(startTime).Seconds(), ms.Sys, runtime.NumGoroutine(),
		)
		c.Data(http.StatusOK, "text/plain; version=0.0.4", []byte(body))
	})

	// Validate an externally-produced (hand-edited, imported, legacy)
	// timetable against the hard rules. The checker is the same one the
	// solver uses internally — one source of truth.
	r.POST("/timetable/validate", func(c *gin.Context) {
		if authorise(c) == nil {
			return
		}
		var req struct {
			Problem Problem `json:"problem"`
			Slots   []Slot  `json:"slots"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		if err := req.Problem.validate(); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		vs := req.Problem.CheckFull(req.Slots)
		status := "valid"
		if len(vs) > 0 {
			status = "violations"
		}
		c.JSON(http.StatusOK, gin.H{"status": status, "violations": vs, "checked": len(req.Slots)})
	})

	// Generate: solve the spec. "solved" guarantees zero hard violations.
	r.POST("/timetable/generate", func(c *gin.Context) {
		if authorise(c) == nil {
			return
		}
		var p Problem
		if err := c.ShouldBindJSON(&p); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		if err := p.validate(); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, p.Solve())
	})

	// Substitutions: cover suggestions for absent teachers on one day.
	r.POST("/timetable/substitutions", func(c *gin.Context) {
		if authorise(c) == nil {
			return
		}
		var sp SubstitutionProblem
		if err := c.ShouldBindJSON(&sp); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, SuggestSubstitutions(sp))
	})

	srv := &http.Server{Addr: ":" + port, Handler: r}
	go func() {
		log.Printf("📅 Timetable Engine (Phase 6.2) on http://localhost:%s", port)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("timetable-engine: %v", err)
		}
	}()

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit
	log.Println("shutting down")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = srv.Shutdown(ctx)
}
