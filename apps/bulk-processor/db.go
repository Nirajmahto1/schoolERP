// ──────────────────────────────────────────────
// Postgres via pgx stdlib.
//
// Deliberately GORM-free: the processor's SQL is eight hand-written
// statements with explicit column lists — an ORM buys nothing here and the
// streaming paths must never buffer a whole table anyway. CamelCase column
// names are quoted (the schema was created by Prisma).
// ──────────────────────────────────────────────

package main

import (
	"context"
	"fmt"
	neturl "net/url"
	"os"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

func newPool() (*pgxpool.Pool, error) {
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		return nil, fmt.Errorf("DATABASE_URL is required")
	}
	// Prisma-style URLs carry `?schema=public`; pgx would send that as a
	// startup parameter and Postgres rejects it. Translate the schema into
	// each connection's search_path instead, and relax TLS for local dev —
	// a local socket must not demand certificates.
	schema := "public"
	if u, err := neturl.Parse(url); err == nil {
		if s := u.Query().Get("schema"); s != "" {
			schema = s
			q := u.Query()
			q.Del("schema")
			u.RawQuery = q.Encode()
			url = u.String()
		}
		if u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1" {
			q := u.Query()
			if q.Get("sslmode") == "" {
				q.Set("sslmode", "prefer")
			}
			u.RawQuery = q.Encode()
			url = u.String()
		}
	}
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, fmt.Errorf("DATABASE_URL: %w", err)
	}
	// The schema from the URL becomes every connection's search_path — the
	// pgx equivalent of Prisma's `?schema=`.
	cfg.ConnConfig.RuntimeParams["search_path"] = schema
	cfg.MaxConns = 8
	cfg.MaxConnLifetime = time.Hour
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, err
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("database unreachable: %w", err)
	}
	return pool, nil
}

// queryer is the read side of pgx: it is satisfied by pgx.Tx (the commit
// path) and *pgxpool.Pool (validate/dry-run lookups), so the row logic is
// written once and runs against either.
type queryer interface {
	Exec(ctx context.Context, sql string, args ...any) (commandTag pgconn.CommandTag, err error)
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// execer is the write side used by the per-row commit functions. It adds
// Query to the set so helpers like classSectionIDs take one interface.
type execer interface {
	Exec(ctx context.Context, sql string, args ...any) (commandTag pgconn.CommandTag, err error)
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// ctx2 bounds one row's work: a stuck row must never wedge a 20k import.
// The budget is generous (a slow commit statement, not a hung network). The
// cancel is intentionally not called early — the context must stay alive
// for the caller's whole statement — so the vet warning is accepted here.
func ctx2() context.Context {
	c, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	_ = cancel
	return c
}

// tx runs fn in a transaction, rolling back on error.
func tx(ctx context.Context, pool *pgxpool.Pool, fn func(pgx.Tx) error) error {
	t, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	if err := fn(t); err != nil {
		_ = t.Rollback(ctx)
		return err
	}
	return t.Commit(ctx)
}
