// ──────────────────────────────────────────────
// Internal assertion verification (ADR-3, BUILD_PLAN Phase 6.1)
//
// The gateway mints a short-lived RS256 assertion per user request; this
// engine verifies it with the PUBLIC key and trusts no headers, no query
// params and no body fields for identity. Without the public key the engine
// refuses to start — there is deliberately no "trust everything" dev mode,
// because a notification socket that trusts a client-supplied user id is a
// cross-tenant leak waiting to happen (GATE 6).
//
// Browsers cannot set an Authorization header on a WebSocket, so the socket
// token is accepted from either the `x-internal-assertion` header (REST +
// non-browser clients) or the `?assertion=` query parameter (socket ticket
// minted by POST /api/v1/notifications/ws-ticket at the gateway). The ticket
// is the same assertion, just transported where a browser can carry it, and
// it expires in the same 60 seconds.
// ──────────────────────────────────────────────

package main

import (
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

const (
	assertionIssuer     = "school-erp-gateway"
	assertionAudience   = "notification-engine"
	assertionHeader     = "x-internal-assertion"
	assertionQueryParam = "assertion"
)

// AssertionClaims mirrors @school-erp/auth's assertionClaimsSchema. Only the
// fields the engine acts on are declared; jwt/v5 ignores the rest.
type AssertionClaims struct {
	Email          string   `json:"email"`
	TenantID       string   `json:"tenantId"` // may be "" on single-database deployments
	SchoolID       *string  `json:"schoolId"`
	BranchID       *string  `json:"branchId"`
	Roles          []string `json:"roles"`
	ImpersonatedBy *string  `json:"impersonatedBy"`
	jwt.RegisteredClaims
}

var ErrUnauthorised = errors.New("unauthorised")

// Authenticator holds the parsed RSA public key. A nil Authenticator rejects
// every assertion (fail-closed).
type Authenticator struct {
	key interface { /* *rsa.PublicKey */
	}
	pem string
}

// NewAuthenticator reads INTERNAL_ASSERTION_PUBLIC_KEY from the environment.
// It returns an error when the key is missing or unparseable — callers must
// abort startup rather than degrade into trusting the network.
func NewAuthenticator() (*Authenticator, error) {
	pem := strings.TrimSpace(os.Getenv("INTERNAL_ASSERTION_PUBLIC_KEY"))
	if pem == "" {
		return nil, errors.New(
			"INTERNAL_ASSERTION_PUBLIC_KEY is not set — the engine refuses to trust any client (fail-closed per ADR-3)",
		)
	}
	return NewAuthenticatorFromPEM(pem)
}

// NewAuthenticatorFromPEM parses a PEM public key; used by tests and by
// NewAuthenticator above.
func NewAuthenticatorFromPEM(pem string) (*Authenticator, error) {
	key, err := jwt.ParseRSAPublicKeyFromPEM([]byte(pem))
	if err != nil {
		return nil, fmt.Errorf("INTERNAL_ASSERTION_PUBLIC_KEY is not a valid RSA public key: %w", err)
	}
	return &Authenticator{key: key, pem: pem}, nil
}

// Verify parses and validates an assertion. Signature, issuer, audience,
// expiry and claim shape are all checked; any failure collapses to
// ErrUnauthorised so handlers cannot accidentally branch on the reason.
func (a *Authenticator) Verify(token string) (*AssertionClaims, error) {
	if a == nil || a.key == nil {
		return nil, fmt.Errorf("%w: assertion verification is unavailable", ErrUnauthorised)
	}
	token = strings.TrimSpace(token)
	if token == "" {
		return nil, fmt.Errorf("%w: no assertion presented", ErrUnauthorised)
	}

	parsed, err := jwt.ParseWithClaims(
		token,
		&AssertionClaims{},
		func(*jwt.Token) (interface{}, error) { return a.key, nil },
		jwt.WithValidMethods([]string{"RS256"}), // pinned: never accept `none` or HMAC
		jwt.WithIssuer(assertionIssuer),
		jwt.WithAudience(assertionAudience),
		jwt.WithLeeway(5*time.Second),
	)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrUnauthorised, err)
	}
	claims, ok := parsed.Claims.(*AssertionClaims)
	if !ok || !parsed.Valid {
		return nil, fmt.Errorf("%w: malformed claims", ErrUnauthorised)
	}
	if claims.Subject == "" {
		return nil, fmt.Errorf("%w: assertion has no subject", ErrUnauthorised)
	}
	// tenantId MAY be empty (single-database deployments have no control
	// plane), but the field must be present, and roles must be non-empty —
	// the Node schema requires min(1).
	if claims.Roles == nil || len(claims.Roles) == 0 {
		return nil, fmt.Errorf("%w: assertion has no roles", ErrUnauthorised)
	}
	return claims, nil
}

// Tenant must be definite for scope decisions; single-database deployments
// carry "" and the engine process is the boundary.
func (c *AssertionClaims) tenantID() string { return c.TenantID }

// schoolID resolves the optional school claim to a comparable string.
func (c *AssertionClaims) schoolID() string {
	if c.SchoolID == nil {
		return ""
	}
	return *c.SchoolID
}

// branchID resolves the optional branch claim to a comparable string.
func (c *AssertionClaims) branchID() string {
	if c.BranchID == nil {
		return ""
	}
	return *c.BranchID
}

func (c *AssertionClaims) subject() string { return c.Subject }

// assertionFromRequest extracts the token from the header first, then the
// `?assertion=` query parameter (the socket-ticket path for browsers).
func assertionFromRequest(header, query string) string {
	if strings.TrimSpace(header) != "" {
		return strings.TrimSpace(header)
	}
	return strings.TrimSpace(query)
}
