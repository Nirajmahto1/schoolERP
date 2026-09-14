// ──────────────────────────────────────────────
// Progress reporting to the notification engine (BUILD_PLAN 6.3)
//
// A 20k-row import takes minutes; without feedback an admin staring at a
// spinner assumes it died and uploads again — duplicate rows. The processor
// pushes throttled progress envelopes over the engine's user channel, so the
// console shows "1,200 / 5,000 rows · 12 errors so far" while the import
// runs, and a terminal COMPLETED/FAILED message the moment it ends.
//
// The engine is optional infrastructure: progress is fire-and-forget with a
// short timeout and silent failure — an unreachable engine must never fail
// an import that is otherwise succeeding. No private key configured simply
// disables progress (nil reporter), mirroring the dev-without-Redis stance.
// ──────────────────────────────────────────────

package main

import (
	"bytes"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

const engineAudience = "notification-engine"

// mintClaims is the assertion the processor mints for engine calls. Identity
// is the uploader's (Subject), role SYSTEM, ttl 30s — same shape as the
// attendance service's peer calls to communication-service.
type mintClaims struct {
	Email    string   `json:"email"`
	TenantID string   `json:"tenantId"`
	SchoolID *string  `json:"schoolId"`
	BranchID *string  `json:"branchId"`
	Roles    []string `json:"roles"`
	jwt.RegisteredClaims
}

type progressReporter struct {
	url        string
	privateKey *rsa.PrivateKey
	client     *http.Client

	mu       sync.Mutex
	lastSent time.Time
}

// newProgressReporter returns nil (progress disabled) when the signing key
// or engine URL is absent — imports still run, just silently.
func newProgressReporter() *progressReporter {
	raw := os.Getenv("INTERNAL_ASSERTION_PRIVATE_KEY")
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	if !strings.Contains(raw, "BEGIN") {
		raw = strings.ReplaceAll(raw, `\n`, "\n")
	}
	block, _ := pem.Decode([]byte(raw))
	if block == nil {
		log.Printf("progress reporting disabled: INTERNAL_ASSERTION_PRIVATE_KEY is not a PEM block")
		return nil
	}
	key, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		log.Printf("progress reporting disabled: %v", err)
		return nil
	}
	rsaKey, ok := key.(*rsa.PrivateKey)
	if !ok {
		log.Printf("progress reporting disabled: private key is not RSA")
		return nil
	}
	url := os.Getenv("NOTIFICATION_ENGINE_URL")
	if url == "" {
		url = "http://localhost:6001"
	}
	return &progressReporter{
		url:        strings.TrimRight(url, "/"),
		privateKey: rsaKey,
		client:     &http.Client{Timeout: 5 * time.Second},
	}
}

// mintAssertion signs a 30-second RS256 assertion for the engine, carrying
// the uploader's identity so the engine's tenant checks see a real tenant.
func (p *progressReporter) mintAssertion(caller *AssertionClaims) (string, error) {
	now := time.Now()
	claims := mintClaims{
		Email:    caller.Email,
		TenantID: caller.TenantID,
		Roles:    []string{"SYSTEM"},
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   caller.Subject,
			Issuer:    assertionIssuer,
			Audience:  jwt.ClaimStrings{engineAudience},
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(30 * time.Second)),
		},
	}
	if caller.BranchID != "" {
		claims.BranchID = &caller.BranchID
	}
	return jwt.NewWithClaims(jwt.SigningMethodRS256, claims).SignedString(p.privateKey)
}

// sendEnvelope posts one user-channel push. Throttled to one message per
// gap except the terminal call, which always goes out.
func (p *progressReporter) sendEnvelope(caller *AssertionClaims, env map[string]string, terminal bool) {
	p.mu.Lock()
	if !terminal && time.Since(p.lastSent) < 2*time.Second {
		p.mu.Unlock()
		return
	}
	p.lastSent = time.Now()
	p.mu.Unlock()

	assertion, err := p.mintAssertion(caller)
	if err != nil {
		log.Printf("progress: mint: %v", err)
		return
	}
	body := map[string]string{
		"channel":    "user",
		"targetUser": caller.Subject,
		"title":      env["title"],
		"body":       env["body"],
		"kind":       env["kind"],
		"deepLink":   env["deepLink"],
	}
	buf, _ := json.Marshal(body)
	req, err := http.NewRequest(http.MethodPost, p.url+"/notifications/send", bytes.NewReader(buf))
	if err != nil {
		return
	}
	req.Header.Set("content-type", "application/json")
	req.Header.Set("x-internal-assertion", assertion)
	resp, err := p.client.Do(req)
	if err != nil {
		return // engine down — import continues silently
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		log.Printf("progress: engine returned %d", resp.StatusCode)
	}
}

// progress envelope bodies. One job = one import run.
func progressBody(jobID, phase string, done, total, errors int) map[string]string {
	pct := 0
	if total > 0 {
		pct = done * 100 / total
	}
	title := fmt.Sprintf("Import %s — %d/%d rows (%d%%)", jobID, done, total, pct)
	if errors > 0 {
		title += fmt.Sprintf(" · %d with errors", errors)
	}
	return map[string]string{
		"title":    title,
		"body":     phase,
		"kind":     "PROGRESS",
		"deepLink": "/dashboard/imports/" + jobID,
	}
}

func completedBody(jobID string, total, errors int) map[string]string {
	verdict := "COMPLETED"
	if errors > 0 && errors == total {
		verdict = "FAILED"
	}
	return map[string]string{
		"title":    fmt.Sprintf("Import %s finished: %s — %d/%d rows, %d rejected", jobID, verdict, total-errors, total, errors),
		"body":     verdict,
		"kind":     "PROGRESS",
		"deepLink": "/dashboard/imports/" + jobID,
	}
}

// report emits a throttled mid-run update; done == total emits the terminal
// message, which is never throttled.
func (p *progressReporter) report(caller *AssertionClaims, jobID, phase string, done, total, errors int) {
	if p == nil || caller == nil {
		return
	}
	terminal := done >= total && total > 0
	env := progressBody(jobID, phase, done, total, errors)
	if terminal {
		env = completedBody(jobID, total, errors)
	}
	p.sendEnvelope(caller, env, terminal)
}

// jobID names one import run for the progress feed and deep links.
func newJobID(kind string) string {
	b := make([]byte, 5)
	_, _ = rand.Read(b)
	return fmt.Sprintf("%s_%d_%x", kind, time.Now().Unix(), b)
}
