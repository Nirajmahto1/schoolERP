// ──────────────────────────────────────────────
// Internal-assertion verification (ADR-3), fail-closed.
//
// Same contract as the timetable/notification engines: RS256, issuer
// school-erp-gateway, audience bulk-processor, 5s leeway. The service
// refuses to boot without INTERNAL_ASSERTION_PUBLIC_KEY — no
// trust-the-network dev mode.
// ──────────────────────────────────────────────

package main

import (
	"crypto/rsa"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
	"strings"

	"github.com/golang-jwt/jwt/v5"
)

const (
	assertionIssuer    = "school-erp-gateway"
	assertionAudience  = "bulk-processor"
	assertionKeyEnvVar = "INTERNAL_ASSERTION_PUBLIC_KEY"
)

// AssertionClaims mirrors @school-erp/auth's claim schema (only what the
// processor logs is declared; jwt/v5 ignores the rest).
type AssertionClaims struct {
	Email    string   `json:"email"`
	TenantID string   `json:"tenantId"`
	BranchID string   `json:"branchId,omitempty"`
	Roles    []string `json:"roles"`
	jwt.RegisteredClaims
}

type authenticator struct {
	key *rsa.PublicKey
}

func NewAuthenticator() (*authenticator, error) {
	raw := os.Getenv(assertionKeyEnvVar)
	if strings.TrimSpace(raw) == "" {
		return nil, fmt.Errorf("%s is required — refusing to start without assertion verification (fail-closed)", assertionKeyEnvVar)
	}
	if !strings.Contains(raw, "BEGIN") {
		// single-line \n-escaped form
		raw = strings.ReplaceAll(raw, `\n`, "\n")
	}
	block, _ := pem.Decode([]byte(raw))
	if block == nil {
		return nil, errors.New("INTERNAL_ASSERTION_PUBLIC_KEY is not a PEM block")
	}
	pub, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("INTERNAL_ASSERTION_PUBLIC_KEY: %w", err)
	}
	rsaKey, ok := pub.(*rsa.PublicKey)
	if !ok {
		return nil, errors.New("INTERNAL_ASSERTION_PUBLIC_KEY is not an RSA key")
	}
	return &authenticator{key: rsaKey}, nil
}

// Verify parses + validates a token. Exported claim fields are populated on
// success; the caller still decides what an empty Subject means for it.
func (a *authenticator) Verify(token string) (*AssertionClaims, error) {
	claims := &AssertionClaims{}
	parsed, err := jwt.ParseWithClaims(token, claims,
		func(*jwt.Token) (interface{}, error) { return a.key, nil },
		jwt.WithValidMethods([]string{"RS256"}),
		jwt.WithIssuer(assertionIssuer),
		jwt.WithAudience(assertionAudience),
		jwt.WithLeeway(5*1e9), // 5s; jwt/v5 takes a time.Duration
	)
	if err != nil {
		return nil, err
	}
	if !parsed.Valid {
		return nil, errors.New("invalid token")
	}
	return claims, nil
}
