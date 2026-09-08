// ──────────────────────────────────────────────
// School ERP — Notification Engine (Go)
// Real-time WebSocket notifications via Redis Pub/Sub
// ──────────────────────────────────────────────

package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
	"github.com/redis/go-redis/v9"
)

// ── WebSocket Hub ──

type Client struct {
	conn     *websocket.Conn
	userID   string
	branchID string
	send     chan []byte
}

type Hub struct {
	clients    map[string]*Client
	broadcast  chan []byte
	register   chan *Client
	unregister chan *Client
	mu         sync.RWMutex
}

func newHub() *Hub {
	return &Hub{
		clients:    make(map[string]*Client),
		broadcast:  make(chan []byte, 256),
		register:   make(chan *Client),
		unregister: make(chan *Client),
	}
}

func (h *Hub) run() {
	for {
		select {
		case client := <-h.register:
			h.mu.Lock()
			h.clients[client.userID] = client
			h.mu.Unlock()
			log.Printf("Client connected: %s", client.userID)

		case client := <-h.unregister:
			h.mu.Lock()
			if _, ok := h.clients[client.userID]; ok {
				delete(h.clients, client.userID)
				close(client.send)
			}
			h.mu.Unlock()
			log.Printf("Client disconnected: %s", client.userID)

		case message := <-h.broadcast:
			h.mu.RLock()
			for _, client := range h.clients {
				select {
				case client.send <- message:
				default:
					close(client.send)
					delete(h.clients, client.userID)
				}
			}
			h.mu.RUnlock()
		}
	}
}

// ── WebSocket upgrader ──

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin:     func(r *http.Request) bool { return true },
}

// ── Redis subscriber ──

func subscribeRedis(ctx context.Context, rdb *redis.Client, hub *Hub) {
	pubsub := rdb.Subscribe(ctx, "notifications")
	defer pubsub.Close()

	ch := pubsub.Channel()
	for msg := range ch {
		log.Printf("Redis message received: %s", msg.Payload)
		hub.broadcast <- []byte(msg.Payload)
	}
}

// ── Notification API ──

type SendNotificationRequest struct {
	Title    string   `json:"title" binding:"required"`
	Body     string   `json:"body" binding:"required"`
	Type     string   `json:"type" binding:"required"` // ANNOUNCEMENT, ALERT, REMINDER
	UserIDs  []string `json:"user_ids"`                // Empty = broadcast
	BranchID string   `json:"branch_id"`
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

	// Redis client
	opt, err := redis.ParseURL(redisURL)
	if err != nil {
		log.Fatalf("Failed to parse Redis URL: %v", err)
	}
	rdb := redis.NewClient(opt)

	ctx := context.Background()
	if _, err := rdb.Ping(ctx).Result(); err != nil {
		log.Printf("⚠️  Redis not available: %v (running without pub/sub)", err)
	} else {
		log.Println("✅ Connected to Redis")
	}

	// WebSocket hub
	hub := newHub()
	go hub.run()
	go subscribeRedis(ctx, rdb, hub)

	// Gin router
	r := gin.Default()

	// Health check
	r.GET("/health", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{
			"status":    "ok",
			"service":   "notification-engine",
			"timestamp": time.Now().Format(time.RFC3339),
		})
	})

	// WebSocket endpoint
	r.GET("/notifications/ws", func(c *gin.Context) {
		// Phase 0: identity headers are no longer accepted (forged-header
		// escalation). The user id comes from a query parameter only for this
		// interim stub; Phase 6 rewrites the engine with assertion-based auth
		// and WebSocket subprotocol authentication.
		userID := c.Query("user_id")
		branchID := ""

		conn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
		if err != nil {
			log.Printf("WebSocket upgrade error: %v", err)
			return
		}

		client := &Client{
			conn:     conn,
			userID:   userID,
			branchID: branchID,
			send:     make(chan []byte, 256),
		}

		hub.register <- client

		// Writer goroutine
		go func() {
			defer conn.Close()
			for msg := range client.send {
				if err := conn.WriteMessage(websocket.TextMessage, msg); err != nil {
					break
				}
			}
		}()

		// Reader goroutine (keep-alive)
		go func() {
			defer func() {
				hub.unregister <- client
				conn.Close()
			}()
			for {
				_, _, err := conn.ReadMessage()
				if err != nil {
					break
				}
			}
		}()
	})

	// Send notification via REST → Redis Pub/Sub → WebSocket
	r.POST("/notifications/send", func(c *gin.Context) {
		var req SendNotificationRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}

		payload := `{"title":"` + req.Title + `","body":"` + req.Body + `","type":"` + req.Type + `"}`

		if err := rdb.Publish(ctx, "notifications", payload).Err(); err != nil {
			log.Printf("Failed to publish notification: %v", err)
			// Fallback: direct broadcast
			hub.broadcast <- []byte(payload)
		}

		c.JSON(http.StatusOK, gin.H{"status": "sent"})
	})

	log.Printf("🔔 Notification Engine running on http://localhost:%s", port)
	if err := r.Run(":" + port); err != nil {
		log.Fatalf("Failed to start server: %v", err)
	}
}
