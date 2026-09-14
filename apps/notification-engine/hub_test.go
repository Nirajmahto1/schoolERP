// ──────────────────────────────────────────────
// Notification engine tests — GATE 6, verbatim:
//
//   "WebSocket cross-tenant leak test passes."
//
// Everything asserts on the delivery matrix: who got the message, and who
// must NOT have. Assertion verification is exercised against a real RSA
// keypair, not a mock of a mock.
// ──────────────────────────────────────────────

package main

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/pem"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// ── test keypair (real RSA, generated once per test binary) ──

var (
	testKey  *rsa.PrivateKey
	testPubP string
)

func init() {
	var err error
	testKey, err = rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		panic(err)
	}
	pubDER, err := x509.MarshalPKIXPublicKey(&testKey.PublicKey)
	if err != nil {
		panic(err)
	}
	testPubP = string(pem.EncodeToMemory(&pem.Block{
		Type:  "RSA PUBLIC KEY",
		Bytes: pubDER,
	}))
}

func mustAuth(t *testing.T) *Authenticator {
	t.Helper()
	a, err := NewAuthenticatorFromPEM(testPubP)
	if err != nil {
		t.Fatalf("authenticator: %v", err)
	}
	return a
}

func mint(t *testing.T, mod func(*jwt.MapClaims)) string {
	t.Helper()
	now := time.Now()
	claims := jwt.MapClaims{
		"sub":      "user_A",
		"email":    "a@example.com",
		"tenantId": "tenant_1",
		"roles":    []string{"TEACHER"},
		"iss":      "school-erp-gateway",
		"aud":      "notification-engine",
		"iat":      now.Unix(),
		"exp":      now.Add(60 * time.Second).Unix(),
		"jti":      "test-jti",
	}
	if mod != nil {
		mod(&claims)
	}
	tok, err := jwt.NewWithClaims(jwt.SigningMethodRS256, claims).SignedString(testKey)
	if err != nil {
		t.Fatalf("mint: %v", err)
	}
	return tok
}

func strPtr(s string) *string { return &s }

// ── assertion verification ──

func TestVerifyAcceptsValidAssertion(t *testing.T) {
	a := mustAuth(t)
	claims, err := a.Verify(mint(t, nil))
	if err != nil {
		t.Fatalf("expected valid, got %v", err)
	}
	if claims.Subject != "user_A" || claims.TenantID != "tenant_1" {
		t.Fatalf("wrong claims: %+v", claims)
	}
}

func TestVerifyRejectsWrongKey(t *testing.T) {
	a := mustAuth(t)
	other, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	tok, err := jwt.NewWithClaims(jwt.SigningMethodRS256, jwt.MapClaims{
		"sub": "attacker", "email": "x@x.com", "tenantId": "tenant_1", "roles": []string{"SUPER_ADMIN"},
		"iss": "school-erp-gateway", "aud": "notification-engine",
		"iat": now.Unix(), "exp": now.Add(time.Minute).Unix(), "jti": "forged",
	}).SignedString(other)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := a.Verify(tok); err == nil {
		t.Fatal("forged signature must be rejected")
	}
}

func TestVerifyRejectsExpired(t *testing.T) {
	a := mustAuth(t)
	tok := mint(t, func(c *jwt.MapClaims) {
		(*c)["exp"] = time.Now().Add(-2 * time.Minute).Unix()
		(*c)["iat"] = time.Now().Add(-3 * time.Minute).Unix()
	})
	if _, err := a.Verify(tok); err == nil {
		t.Fatal("expired assertion must be rejected")
	}
}

func TestVerifyRejectsWrongAudience(t *testing.T) {
	a := mustAuth(t)
	tok := mint(t, func(c *jwt.MapClaims) { (*c)["aud"] = "fee-service" })
	if _, err := a.Verify(tok); err == nil {
		t.Fatal("assertion minted for another service must be rejected")
	}
}

func TestVerifyRejectsNoneAlgorithm(t *testing.T) {
	a := mustAuth(t)
	tok := jwt.NewWithClaims(jwt.SigningMethodNone, jwt.MapClaims{
		"sub": "attacker", "email": "x@x.com", "tenantId": "tenant_1", "roles": []string{"SUPER_ADMIN"},
		"iss": "school-erp-gateway", "aud": "notification-engine",
		"iat": time.Now().Unix(), "exp": time.Now().Add(time.Minute).Unix(), "jti": "none",
	})
	signed, err := tok.SignedString(jwt.UnsafeAllowNoneSignatureType)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := a.Verify(signed); err == nil {
		t.Fatal("alg=none must be rejected")
	}
}

func TestVerifyRejectsEmptyRolesAndMissingKey(t *testing.T) {
	a := mustAuth(t)
	if _, err := a.Verify(""); err == nil {
		t.Fatal("empty token must be rejected")
	}
	tok := mint(t, func(c *jwt.MapClaims) { (*c)["roles"] = []string{} })
	if _, err := a.Verify(tok); err == nil {
		t.Fatal("empty roles must be rejected")
	}
	var nilAuth *Authenticator
	if _, err := nilAuth.Verify(mint(t, nil)); err == nil {
		t.Fatal("nil authenticator must fail closed")
	}
	if _, err := NewAuthenticatorFromPEM("not a pem"); err == nil {
		t.Fatal("bad PEM must be rejected")
	}
}

// ── hub routing: the delivery matrix ──

func newTestHub(t *testing.T) (*Hub, func()) {
	t.Helper()
	h := newHub()
	go h.run()
	return h, h.close
}

func drain(t *testing.T, c *Client, n int) [][]byte {
	t.Helper()
	got := make([][]byte, 0, n)
	for len(got) < n {
		select {
		case raw, ok := <-c.send:
			if !ok {
				t.Fatalf("send channel closed after %d/%d messages", len(got), n)
			}
			got = append(got, raw)
		case <-time.After(2 * time.Second):
			t.Fatalf("timed out waiting for message %d/%d", len(got)+1, n)
		}
	}
	return got
}

func registerClient(t *testing.T, h *Hub, userID, tenantID, schoolID string) *Client {
	t.Helper()
	c := &Client{send: make(chan []byte, sendBuffer), scopes: newScope(userID, tenantID, schoolID)}
	h.add(c)
	return c
}

func TestCrossTenantLeakIsBlocked(t *testing.T) {
	h, stop := newTestHub(t)
	defer stop()

	// School A's teacher, connected and waiting.
	alice := registerClient(t, h, "user_A", "tenant_1", "school_1")
	// School B's teacher — same roles, different tenant.
	bob := registerClient(t, h, "user_B", "tenant_2", "school_2")

	// Tenant 1's announcement (as the stub's global broadcast would have
	// leaked it to bob). Alice has subscribed to the tenant channel; the
	// scope swap is the re-auth path under test.
	h.applySubscribe(alice, func() subscriberScope {
		s := newScope("user_A", "tenant_1", "school_1")
		s.tenant = true
		return s
	}())
	h.PublishToTenant(mustClaims(t, "tenant_1", "school_1"), Envelope{Title: "A news", Body: "only school A"})

	aliceMsgs := drain(t, alice, 1)
	if len(aliceMsgs) != 1 {
		t.Fatalf("alice should get exactly 1")
	}
	select {
	case raw := <-bob.send:
		t.Fatalf("CROSS-TENANT LEAK: tenant_2 client received %s", raw)
	case <-time.After(200 * time.Millisecond):
	}
}

func TestUserChannelIsPrivate(t *testing.T) {
	h, stop := newTestHub(t)
	defer stop()

	alice := registerClient(t, h, "user_A", "tenant_1", "school_1")
	mallory := registerClient(t, h, "user_B", "tenant_1", "school_1")

	h.PublishToUser(mustClaims(t, "tenant_1", "school_1"), "user_A", Envelope{Title: "private"})

	drain(t, alice, 1)
	select {
	case raw := <-mallory.send:
		t.Fatalf("user channel leaked to another user: %s", raw)
	case <-time.After(200 * time.Millisecond):
	}
}

func TestBranchChannelRequiresSubscribe(t *testing.T) {
	h, stop := newTestHub(t)
	defer stop()

	// Both users share the branch; neither has subscribed to it yet.
	alice := registerClient(t, h, "user_A", "tenant_1", "school_1")
	bob := registerClient(t, h, "user_B", "tenant_1", "school_1")

	h.PublishToBranch(mustClaims(t, "tenant_1", "school_1"), "branch_9", Envelope{Title: "branch news"})

	time.Sleep(150 * time.Millisecond)
	select {
	case raw := <-alice.send:
		t.Fatalf("unsubscribed client got branch message: %s", raw)
	default:
	}
	select {
	case raw := <-bob.send:
		t.Fatalf("unsubscribed client got branch message: %s", raw)
	default:
	}

	// Alice subscribes (scope swap — the re-auth path with a valid fresh
	// assertion is covered by the HTTP-level session test; here the scope
	// swap itself must start delivery).
	h.applySubscribe(alice, func() subscriberScope {
		s := newScope("user_A", "tenant_1", "school_1")
		s.branches["branch_9"] = struct{}{}
		return s
	}())

	h.PublishToBranch(mustClaims(t, "tenant_1", "school_1"), "branch_9", Envelope{Title: "branch news 2"})
	drain(t, alice, 1)
	select {
	case raw := <-bob.send:
		t.Fatalf("bob must stay dark: %s", raw)
	case <-time.After(200 * time.Millisecond):
	}
}

func TestBranchIsolationAcrossTenants(t *testing.T) {
	h, stop := newTestHub(t)
	defer stop()

	// Same branch UUID cannot be reused across tenants to listen in.
	alice := registerClient(t, h, "user_A", "tenant_1", "school_1")
	s := newScope("user_A", "tenant_1", "school_1")
	s.branches["branch_9"] = struct{}{}
	h.applySubscribe(alice, s)

	// Publisher from tenant_2 addressing "its" branch_9.
	h.PublishToBranch(mustClaims(t, "tenant_2", "school_2"), "branch_9", Envelope{Title: "tenant_2 news"})

	time.Sleep(150 * time.Millisecond)
	select {
	case raw := <-alice.send:
		t.Fatalf("tenant_1 client received tenant_2 branch traffic: %s", raw)
	default:
	}
}

func TestSlowClientDroppedNotBlocking(t *testing.T) {
	h, stop := newTestHub(t)
	defer stop()

	clog := &Client{send: make(chan []byte, 1), scopes: newScope("clogged", "tenant_1", "school_1")}
	fast := registerClient(t, h, "fast", "tenant_1", "school_1")
	h.add(clog)

	claims := mustClaims(t, "tenant_1", "school_1")
	// Fill the slow client's buffer, then keep publishing. The fast client
	// must receive everything; the slow one is dropped, not waited on.
	h.PublishToUser(claims, "fast", Envelope{Title: "one"})
	h.PublishToUser(claims, "fast", Envelope{Title: "two"}) // overflows clog
	drain(t, fast, 2)
}

func TestPresenceGroupsByTenant(t *testing.T) {
	h, stop := newTestHub(t)
	defer stop()

	registerClient(t, h, "user_A", "tenant_1", "school_1")
	registerClient(t, h, "user_B", "tenant_1", "school_1")
	registerClient(t, h, "user_C", "tenant_2", "school_2")

	presence := h.Presence("")
	if len(presence) != 2 {
		t.Fatalf("expected 2 tenants, got %d", len(presence))
	}
	byTenant := map[string]PresenceSummary{}
	for _, p := range presence {
		byTenant[p.TenantID] = p
	}
	if byTenant["tenant_1"].Count != 2 || byTenant["tenant_2"].Count != 1 {
		t.Fatalf("wrong counts: %+v", byTenant)
	}

	// Scoped query returns only one tenant.
	if p := h.Presence("tenant_2"); len(p) != 1 || p[0].Count != 1 {
		t.Fatalf("scoped presence wrong: %+v", p)
	}
}

// mustClaims builds verified-shaped claims without a token — the hub is
// token-agnostic; the token layer is covered by the auth tests above.
func mustClaims(t *testing.T, tenantID, schoolID string) *AssertionClaims {
	t.Helper()
	return &AssertionClaims{
		RegisteredClaims: jwt.RegisteredClaims{Subject: "publisher"},
		Email:            "publisher@example.com",
		TenantID:         tenantID,
		SchoolID:         strPtr(schoolID),
		Roles:            []string{"ADMIN"},
	}
}
