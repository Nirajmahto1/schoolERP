// ──────────────────────────────────────────────
// Internal assertion key (ADR-3) — timetable-engine variant
//
// Same contract as the notification engine: verify the gateway's RS256
// assertion with the PUBLIC key, and refuse to start without it. There is
// deliberately no trust-the-network dev mode.
// ──────────────────────────────────────────────

package main

import (
	"errors"
	"fmt"
	"os"
	"strings"

	"github.com/golang-jwt/jwt/v5"
)

// Authenticator holds the parsed RSA public key.
type Authenticator struct {
	key interface{}
}

// NewAuthenticator reads INTERNAL_ASSERTION_PUBLIC_KEY from the environment.
func NewAuthenticator() (*Authenticator, error) {
	pem := strings.TrimSpace(os.Getenv("INTERNAL_ASSERTION_PUBLIC_KEY"))
	if pem == "" {
		return nil, errors.New(
			"INTERNAL_ASSERTION_PUBLIC_KEY is not set — the engine refuses to trust any client (fail-closed per ADR-3)",
		)
	}
	key, err := jwt.ParseRSAPublicKeyFromPEM([]byte(pem))
	if err != nil {
		return nil, fmt.Errorf("INTERNAL_ASSERTION_PUBLIC_KEY is not a valid RSA public key: %w", err)
	}
	return &Authenticator{key: key}, nil
}
