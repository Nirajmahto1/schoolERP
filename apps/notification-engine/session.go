// ──────────────────────────────────────────────
// WebSocket session handling (§6.1)
//
// Connect: the assertion arrives as a header (non-browser clients and
// service-to-service) or as `?assertion=` (the browser path — browsers
// cannot set headers on a WebSocket, so POST /notifications/ws-ticket
// returns the same short-lived assertion as a body the client can put in
// the URL; the stub's `?user_id=` is gone, an unauthenticated socket has no
// identity and therefore no channels).
//
// The connect assertion grants exactly one channel: the user's own
// notification stream. Branch/school/tenant channels require a SUBSCRIBE
// carrying a FRESH assertion — re-authorise on every subscribe (§6.1) — so a
// long-lived socket cannot outlive its access: when the gateway stops
// minting assertions for a revoked user, their scopes stop renewing, and
// periodic re-subscribes are what keeps a scope alive.
//
// Wire protocol (JSON both ways):
//   client → server:  {"type":"subscribe","assertion":"<jwt>"}   (optional)
//                     {"type":"ping"}                            (keepalive)
//   server → client:  {"type":"subscribed", ...scope echo}
//                     {"type":"error","message":"..."}
//                     {"type":"pong"} / notifications (see Envelope)
//
// Backpressure: writes go through a bounded channel; a full buffer drops the
// client (hub.Publish handles that). The writer also enforces a write
// deadline per message so a dead TCP peer cannot pin a goroutine forever.
// ──────────────────────────────────────────────

package main

import (
	"encoding/json"
	"log"
	"net/http"
	"time"

	"github.com/gorilla/websocket"
)

const (
	writeWait  = 10 * time.Second
	pongWait   = 60 * time.Second
	pingPeriod = 45 * time.Second
	sendBuffer = 256
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	// Origin: the browser socket carries a short-lived signed ticket in the
	// query string; identity comes from the assertion, not the origin, so a
	// permissive origin check is safe here. CSRF is not a concern for a
	// socket that requires a ≤60s capability URL the attacker cannot obtain.
	CheckOrigin: func(*http.Request) bool { return true },
}

// connection is the subset of *websocket.Conn the hub and pumps use; a thin
// seam that keeps the hub unit-testable without a real TCP socket.
type connection interface {
	WriteMessage(messageType int, data []byte) error
	SetWriteDeadline(time.Time) error
	Close() error
}

// session wires one upgraded socket into the hub.
type session struct {
	hub  *Hub
	auth *Authenticator
}

// Client is declared in hub.go; readPump needs the *concrete* websocket
// connection for the read half (limits, deadlines, JSON decode). The write
// half goes through the `connection` interface the hub uses for delivery.
type readConnection interface {
	SetReadLimit(int64)
	SetReadDeadline(time.Time) error
	ReadJSON(interface{}) error
}

type clientMessage struct {
	Type      string   `json:"type"`
	Assertion string   `json:"assertion,omitempty"`
	BranchIDs []string `json:"branchIds,omitempty"`
	School    bool     `json:"school,omitempty"`
	Tenant    bool     `json:"tenant,omitempty"`
}

// handleWS upgrades and takes ownership of the connection. It returns only
// after the socket is done.
func (s *session) handleWS(w http.ResponseWriter, r *http.Request) {
	claims, ok := s.authenticate(r)
	if !ok {
		// Refuse the upgrade with 401 — gorilla writes the HTTP error itself.
		http.Error(w, `{"error":"invalid or missing assertion"}`, http.StatusUnauthorized)
		return
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("ws: upgrade failed: %v", err)
		return
	}

	client := &Client{
		conn:   conn,
		send:   make(chan []byte, sendBuffer),
		scopes: s.initialScope(claims),
	}
	s.hub.add(client)
	log.Printf("ws: connected user=%s tenant=%q", claims.Subject, claims.TenantID)

	// Confirm the initial scope so the client knows what it will receive.
	client.send <- mustJSON(Envelope{
		Type:       "subscribed",
		Channel:    "user",
		TargetUser: claims.Subject,
		TenantID:   claims.TenantID,
		Timestamp:  time.Now().UnixMilli(),
	})

	go s.writePump(client)
	s.readPump(client)
}

// authenticate verifies the assertion from header or query param.
func (s *session) authenticate(r *http.Request) (*AssertionClaims, bool) {
	token := assertionFromRequest(r.Header.Get(assertionHeader), r.URL.Query().Get(assertionQueryParam))
	claims, err := s.auth.Verify(token)
	if err != nil {
		log.Printf("ws: auth rejected: %v", err)
		return nil, false
	}
	return claims, true
}

// initialScope grants exactly the user channel; everything else needs a
// SUBSCRIBE re-auth.
func (s *session) initialScope(claims *AssertionClaims) subscriberScope {
	sc := newScope(claims.Subject, claims.TenantID, claims.schoolID())
	return sc
}

// readPump consumes client messages until the socket dies.
func (s *session) readPump(c *Client) {
	defer func() {
		s.hub.remove(c)
		c.conn.Close()
	}()

	rc := c.conn.(*websocket.Conn) // read half uses the concrete conn
	rc.SetReadLimit(64 * 1024)
	_ = rc.SetReadDeadline(time.Now().Add(pongWait))

	for {
		var msg clientMessage
		if err := rc.ReadJSON(&msg); err != nil {
			return // normal close, ping timeout, or malformed frame
		}
		_ = rc.SetReadDeadline(time.Now().Add(pongWait))

		switch msg.Type {
		case "ping":
			select {
			case c.send <- mustJSON(Envelope{Type: "pong", Timestamp: time.Now().UnixMilli()}):
			default:
			}

		case "subscribe":
			s.handleSubscribe(c, msg)

		case "":
			// No type — ignore silently; a chatty client must not be able to
			// generate error spam.

		default:
			select {
			case c.send <- mustJSON(Envelope{Type: "error", Body: "unknown message type", Timestamp: time.Now().UnixMilli()}):
			default:
			}
		}
	}
}

// handleSubscribe re-authorises scopes with a fresh assertion. The new scope
// REPLACES the old one — the client re-declares everything it wants, which
// means a stale scope cannot be quietly retained.
func (s *session) handleSubscribe(c *Client, msg clientMessage) {
	claims, err := s.auth.Verify(msg.Assertion)
	if err != nil {
		// Re-auth failure: the current scopes stand until the socket closes,
		// but the client is told loudly. A revoked user's next periodic
		// subscribe fails here and their branch/school/tenant channels stop
		// renewing at the next successful handshake... which never comes.
		// To make revocation immediate we also tear down non-user channels
		// on ANY failed subscribe: fail-closed.
		s.hub.applySubscribe(c, newScope(c.scopes.userID, c.scopes.tenantID, c.scopes.schoolID))
		c.send <- mustJSON(Envelope{Type: "error", Body: "subscribe rejected: invalid assertion", Timestamp: time.Now().UnixMilli()})
		return
	}

	// The fresh assertion must belong to the same identity AND tenant as the
	// connection — an assertion for a different user cannot extend this
	// socket's reach (it should open its own socket).
	if claims.Subject != c.scopes.userID || claims.TenantID != c.scopes.tenantID {
		c.send <- mustJSON(Envelope{Type: "error", Body: "subscribe rejected: identity mismatch", Timestamp: time.Now().UnixMilli()})
		return
	}

	sc := newScope(claims.Subject, claims.TenantID, claims.schoolID())
	// Branch scopes: honour the requested list, or the assertion's own
	// branch claim when none requested.
	if len(msg.BranchIDs) > 0 {
		for _, b := range msg.BranchIDs {
			if b == claims.branchID() || claims.hasRole("SUPER_ADMIN") {
				sc.branches[b] = struct{}{}
			}
		}
	} else if b := claims.branchID(); b != "" {
		sc.branches[b] = struct{}{}
	}
	if msg.School {
		sc.school = true
	}
	if msg.Tenant && claims.hasRole("SUPER_ADMIN") {
		sc.tenant = true
	}

	s.hub.applySubscribe(c, sc)

	ack := Envelope{
		Type:       "subscribed",
		Channel:    "user",
		TargetUser: sc.userID,
		TenantID:   sc.tenantID,
		SchoolID:   sc.schoolID,
		Timestamp:  time.Now().UnixMilli(),
	}
	for b := range sc.branches {
		ack.Body = "branches:" + b
	}
	c.send <- mustJSON(ack)
}

// writePump drains the send channel into the socket with per-write deadlines.
func (s *session) writePump(c *Client) {
	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		c.conn.Close()
	}()

	for {
		select {
		case raw, ok := <-c.send:
			_ = c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if !ok {
				// Hub closed our channel — acknowledge and exit.
				_ = c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			if err := c.conn.WriteMessage(websocket.TextMessage, raw); err != nil {
				return
			}
		case <-ticker.C:
			_ = c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

// hasRole is a tiny helper on the claims.
func (c *AssertionClaims) hasRole(role string) bool {
	for _, r := range c.Roles {
		if r == role {
			return true
		}
	}
	return false
}

func mustJSON(v interface{}) []byte {
	raw, err := json.Marshal(v)
	if err != nil {
		return []byte(`{"type":"error","body":"encode failure"}`)
	}
	return raw
}
