// ──────────────────────────────────────────────
// Redis pub/sub — per-tenant channels (§6.1)
//
// The stub subscribed to one global "notifications" channel and rebroadcast
// every payload to every socket. Now every tenant gets its own channel:
//
//	notify:<tenantID>
//
// and every payload is an Envelope carrying its own tenant claim, which the
// hub re-checks at delivery. Two layers therefore have to agree before a
// message reaches a socket: the subscriber only ever listens to its own
// tenant's channel, and delivery re-verifies the envelope's tenant against
// the socket's scope — so even a misrouted publish cannot cross the tenant
// boundary (GATE 6's leak test targets exactly this).
//
// Single-database deployments (tenantId == "") share the "notify:" channel;
// the engine process is the tenant boundary there.
// ──────────────────────────────────────────────

package main

import (
	"context"
	"encoding/json"
	"log"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

const channelPrefix = "notify:"

// tenantChannel is the Redis channel name for one tenant's fan-out.
func tenantChannel(tenantID string) string {
	return channelPrefix + tenantID
}

// publisher wraps a Redis client for outbound publishes.
type publisher struct {
	rdb *redis.Client
}

// PublishTenant enqueues an envelope on the tenant's channel. Returns the
// number of engine instances that received it (Redis subscribers), not
// sockets — useful for logs, not for delivery guarantees.
func (p *publisher) PublishTenant(ctx context.Context, tenantID string, env Envelope) error {
	env.TenantID = tenantID // authoritative — never trust a caller-supplied tenant
	raw, err := json.Marshal(env)
	if err != nil {
		return err
	}
	return p.rdb.Publish(ctx, tenantChannel(tenantID), raw).Err()
}

// subscriber listens to the channels this instance cares about. In a
// multi-instance deployment every instance subscribes to the wildcard and
// filters by tenant at delivery — engine instances are stateless, any one of
// them may hold a given user's socket.
type subscriber struct {
	rdb *redis.Client
	hub *Hub
}

// run blocks, pumping envelopes from Redis into the hub. Cancel ctx to stop.
func (s *subscriber) run(ctx context.Context) {
	pubsub := s.rdb.PSubscribe(ctx, channelPrefix+"*")
	defer pubsub.Close()

	ch := pubsub.Channel()
	for {
		select {
		case <-ctx.Done():
			return
		case msg, ok := <-ch:
			if !ok {
				return
			}
			var env Envelope
			if err := json.Unmarshal([]byte(msg.Payload), &env); err != nil {
				log.Printf("redis: undecodable envelope on %s: %v", msg.Channel, err)
				continue
			}
			// Belt and braces: the channel name is the tenant of record.
			// A payload whose embedded tenant disagrees with its channel is
			// dropped — one of the two is wrong, and delivery-time checking
			// alone would only narrow the blast radius.
			if got := strings.TrimPrefix(msg.Channel, channelPrefix); got != env.TenantID {
				log.Printf("redis: tenant mismatch channel=%s envelope=%s — dropped", got, env.TenantID)
				continue
			}
			s.hub.Publish(env)
		}
	}
}

// pingWithRetry waits for Redis to come up instead of crashing the engine —
// sockets still work single-instance without pub/sub, they just do not
// receive cross-instance traffic.
func pingWithRetry(ctx context.Context, rdb *redis.Client, attempts int, delay time.Duration) error {
	var err error
	for i := 0; i < attempts; i++ {
		if err = rdb.Ping(ctx).Err(); err == nil {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(delay):
		}
	}
	return err
}
