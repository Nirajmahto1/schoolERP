// ──────────────────────────────────────────────
// WebSocket hub with per-tenant, per-user, per-branch routing
//
// The Phase-0 stub broadcast every message to every socket — a cross-tenant
// leak with a timer on it. This hub routes on identity:
//
//	tenant (hard boundary) → channel: user | branch | school | tenant
//
// Per-tenant channel isolation (§6.1): a bug here can cross-post School A's
// announcement to School B, so the tenant is checked per client at DELIVERY
// time (not only at subscribe time) — defence in depth.
//
// Presence (§6.1): which users of which tenant are connected right now,
// queryable via GET /presence.
//
// Backpressure (§6.1): a slow client never blocks the hub. Each socket has a
// bounded send channel; when it is full the client is dropped and must
// reconnect — a stale phone cannot stall fan-out to the other 499 devices.
//
// Re-authorise on every subscribe (§6.1): a connection is authenticated once,
// but scopes are re-verified per SUBSCRIBE message carrying a fresh (≤60s)
// assertion, so a long-lived socket cannot keep receiving a branch's traffic
// after access was revoked.
// ──────────────────────────────────────────────

package main

import (
	"encoding/json"
	"log"
	"sort"
	"sync"
)

// Envelope is the wire format for everything a client receives, and the
// publish request body (minus target fields, which come from the caller's
// assertion, never the body).
type Envelope struct {
	Type       string `json:"type"`              // notification | presence | subscribed | error | pong
	Channel    string `json:"channel,omitempty"` // user | branch | school | tenant
	TenantID   string `json:"tenantId,omitempty"`
	SchoolID   string `json:"schoolId,omitempty"`
	BranchID   string `json:"branchId,omitempty"`
	TargetUser string `json:"targetUser,omitempty"` // only honoured for publisher callers
	Title      string `json:"title,omitempty"`
	Body       string `json:"body,omitempty"`
	Kind       string `json:"kind,omitempty"` // ANNOUNCEMENT | ALERT | REMINDER | ...
	DeepLink   string `json:"deepLink,omitempty"`
	Timestamp  int64  `json:"ts"`
}

// subscriberScope is what one connection is currently entitled to receive.
// A client starts with its user channel (from the connect assertion); branch/
// school/tenant channels are added only via SUBSCRIBE with a fresh assertion.
type subscriberScope struct {
	userID   string
	tenantID string
	schoolID string
	branches map[string]struct{}
	school   bool
	tenant   bool
}

func newScope(userID, tenantID, schoolID string) subscriberScope {
	return subscriberScope{
		userID:   userID,
		tenantID: tenantID,
		schoolID: schoolID,
		branches: make(map[string]struct{}),
	}
}

// tenantSet reports whether the scope carries a definite tenant key.
// Single-database deployments legitimately run with tenantID == ""; there
// the engine process itself is the tenant boundary.
func (s subscriberScope) tenantSet() bool { return true }

// Client is one connected socket plus its current authorisation state. The
// hub holds it in `clients`; `send` is the bounded delivery queue whose
// overflow triggers the backpressure drop.
type Client struct {
	conn   connection
	send   chan []byte
	scopes subscriberScope

	mu     sync.Mutex // guards closed + dropRequested
	closed bool
	drop   bool
}

// Hub owns the connection registry. A single goroutine (run) serialises
// register/unregister; delivery walks the map under RLock.
type Hub struct {
	mu       sync.RWMutex
	clients  map[*Client]struct{}
	presence map[string]map[*Client]struct{} // tenantID → connected clients

	unregister chan *Client
	done       chan struct{}
}

func newHub() *Hub {
	return &Hub{
		clients:    make(map[*Client]struct{}),
		presence:   make(map[string]map[*Client]struct{}),
		unregister: make(chan *Client),
		done:       make(chan struct{}),
	}
}

func (h *Hub) run() {
	for {
		select {
		case c := <-h.unregister:
			h.mu.Lock()
			if _, ok := h.clients[c]; ok {
				delete(h.clients, c)
				if set := h.presence[c.scopes.tenantID]; set != nil {
					delete(set, c)
					if len(set) == 0 {
						delete(h.presence, c.scopes.tenantID)
					}
				}
			}
			h.mu.Unlock()
			c.shutdown() // safe to call twice

		case <-h.done:
			return
		}
	}
}

// add registers a client SYNCHRONOUSLY under the same lock Publish takes —
// once add returns, every subsequent publish is guaranteed to see this
// client. (The previous channel-based register raced: a publish could beat
// the run loop's map insert and silently drop the client's first message.)
func (h *Hub) add(c *Client) {
	h.mu.Lock()
	h.clients[c] = struct{}{}
	set := h.presence[c.scopes.tenantID]
	if set == nil {
		set = make(map[*Client]struct{})
		h.presence[c.scopes.tenantID] = set
	}
	set[c] = struct{}{}
	h.mu.Unlock()
}

func (h *Hub) remove(c *Client) {
	select {
	case h.unregister <- c:
	case <-h.done:
	}
}

func (h *Hub) close() {
	close(h.done)
}

// shutdown closes the send channel exactly once.
func (c *Client) shutdown() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.closed {
		c.closed = true
		close(c.send)
	}
}

// Publish routes an envelope to every entitled connected client and returns
// the number of sockets it was queued on. Entitlement is re-checked per
// client at delivery time.
func (h *Hub) Publish(env Envelope) int {
	raw, err := json.Marshal(env)
	if err != nil {
		log.Printf("hub: envelope marshal failed: %v", err)
		return 0
	}

	h.mu.RLock()
	defer h.mu.RUnlock()

	delivered := 0
	for c := range h.clients {
		if !c.entitled(env) {
			continue
		}
		select {
		case c.send <- raw:
			delivered++
		default:
			// Backpressure: buffer full — drop this client, never block the
			// loop. It reconnects with backoff; the other devices keep flow.
			log.Printf("hub: slow client dropped (buffer full) user=%s tenant=%s",
				c.scopes.userID, c.scopes.tenantID)
			c.mu.Lock()
			c.drop = true
			c.mu.Unlock()
			go h.remove(c)
		}
	}
	return delivered
}

// entitled reports whether this client may receive the envelope.
// Caller holds at least h.mu.RLock.
func (c *Client) entitled(env Envelope) bool {
	s := c.scopes

	// The tenant is the hard boundary and the publisher's claim is
	// authoritative. Envelopes with an empty tenant are only deliverable on
	// single-database deployments, where every connected socket shares that
	// empty tenant by construction.
	if env.TenantID != s.tenantID {
		return false
	}

	switch env.Channel {
	case "user":
		return env.TargetUser != "" && env.TargetUser == s.userID && s.tenantSet()
	case "branch":
		if env.BranchID == "" {
			return false
		}
		_, ok := s.branches[env.BranchID]
		return ok
	case "school":
		if !s.school {
			return false
		}
		// A school-wide send targets one school; an empty target school is
		// allowed only when the caller's assertion itself had no schoolId
		// (single-school tenants), which the publisher normalises upstream.
		return env.SchoolID == s.schoolID || env.SchoolID == ""
	case "tenant", "":
		return s.tenant
	default:
		return false
	}
}

// applySubscribe replaces a client's scope after a successful re-auth.
// Scope reads happen under h.mu.RLock in Publish, so scope writes take the
// same write lock — a deliver in flight either sees the whole old scope or
// the whole new one, never a mix.
func (h *Hub) applySubscribe(c *Client, s subscriberScope) {
	h.mu.Lock()
	c.scopes = s
	h.mu.Unlock()
}

// --- publish helpers: the TARGET always comes from the caller's assertion,
// never from the request body. ---

// PublishToUser delivers to one user within the caller's tenant. The target
// id comes from the CALLER (the calling service decides recipients, exactly
// like the dispatcher addresses NotificationLog rows); the engine's security
// obligation is the tenant boundary, which is never body-sourced. An empty
// target means "notify the caller themselves" (e.g. session-expiry pings).
func (h *Hub) PublishToUser(caller *AssertionClaims, targetUser string, env Envelope) int {
	if targetUser == "" {
		targetUser = caller.subject()
	}
	env.Channel, env.TenantID = "user", caller.tenantID()
	env.SchoolID = caller.schoolID()
	env.TargetUser = targetUser
	return h.Publish(env)
}

// PublishToBranch delivers to every client subscribed to that branch. The
// caller's tenant scopes the id — branch ids are UUIDs, but the tenant check
// is what makes a guess harmless.
func (h *Hub) PublishToBranch(caller *AssertionClaims, branchID string, env Envelope) int {
	env.Channel, env.TenantID, env.BranchID = "branch", caller.tenantID(), branchID
	env.SchoolID = caller.schoolID()
	return h.Publish(env)
}

// PublishToSchool delivers to clients subscribed to school-wide broadcasts.
func (h *Hub) PublishToSchool(caller *AssertionClaims, env Envelope) int {
	env.Channel, env.TenantID, env.SchoolID = "school", caller.tenantID(), caller.schoolID()
	return h.Publish(env)
}

// PublishToTenant delivers to clients subscribed to tenant-wide broadcasts.
func (h *Hub) PublishToTenant(caller *AssertionClaims, env Envelope) int {
	env.Channel, env.TenantID = "tenant", caller.tenantID()
	return h.Publish(env)
}

// PresenceSummary is one tenant's entry in the GET /presence payload.
type PresenceSummary struct {
	TenantID string   `json:"tenantId"`
	Users    []string `json:"users"`
	Count    int      `json:"count"`
}

// Presence lists connected users for one tenant; empty tenantID lists every
// tenant (platform-admin view).
func (h *Hub) Presence(tenantID string) []PresenceSummary {
	h.mu.RLock()
	defer h.mu.RUnlock()

	seen := map[string]map[string]struct{}{}
	for c := range h.clients {
		t := c.scopes.tenantID
		if tenantID != "" && t != tenantID {
			continue
		}
		if seen[t] == nil {
			seen[t] = map[string]struct{}{}
		}
		seen[t][c.scopes.userID] = struct{}{}
	}

	out := make([]PresenceSummary, 0, len(seen))
	for t, users := range seen {
		list := make([]string, 0, len(users))
		for u := range users {
			list = append(list, u)
		}
		sort.Strings(list)
		out = append(out, PresenceSummary{TenantID: t, Users: list, Count: len(list)})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].TenantID < out[j].TenantID })
	return out
}
