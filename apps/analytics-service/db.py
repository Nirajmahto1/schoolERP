# ──────────────────────────────────────────────
# DB pool — asyncpg, one pool per process (Phase 7.1)
#
# Analytics reads the SAME tenant schema the Node services write to. The plan's
# "read from a replica" note is honoured by the DATABASE_URL being pointable at
# a replica without code change — the service never writes.
# ──────────────────────────────────────────────

from __future__ import annotations

import os
from typing import Any, Optional

import asyncpg

_pool: Optional[asyncpg.Pool] = None


def database_url() -> str:
    url = os.getenv("DATABASE_URL", "")
    if not url:
        raise RuntimeError("DATABASE_URL is not set — analytics has nothing to read from.")
    # Prisma-style URLs carry `?schema=public` (→ search_path) and pool params
    # like `connection_limit` that asyncpg must never see as a libpq option —
    # an unknown query param reaches the socket layer and dies with
    # WinError 10022. Strip everything except the params we translate.
    if "?" in url:
        base, _, params = url.partition("?")
        kept = []
        for kv in params.split("&"):
            k, _, v = kv.partition("=")
            if k == "schema":
                kept.append(f"search_path={v}")
            # connection_limit / pool_timeout etc. are Prisma-pool settings:
            # intentionally dropped here (the asyncpg pool is sized separately).
        url = f"{base}?{'&'.join(kept)}" if kept else base
    return url


async def init_pool() -> None:
    global _pool
    if _pool is None:
        _pool = await asyncpg.create_pool(
            database_url(),
            min_size=1,
            max_size=int(os.getenv("ANALYTICS_POOL_SIZE", "5")),
            command_timeout=15,
        )
        # A wrong-DB boot is otherwise silent: every query returns honest zeros
        # for a branch that exists only in another database. Log the connected
        # database ONCE so the zombie-process class of bug is visible in the
        # first log line, not after an hour of wondering why counts are 0.
        async with _pool.acquire() as conn:
            connected = await conn.fetchval("SELECT current_database()")
        print(f"[analytics] connected to database: {connected}", flush=True)


async def close_pool() -> None:
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None


async def ready() -> bool:
    try:
        await init_pool()
        async with _pool.acquire() as conn:  # type: ignore[union-attr]
            return await conn.fetchval("SELECT TRUE") is True
    except Exception:
        return False


async def fetch(query: str, *args: Any) -> list[asyncpg.Record]:
    await init_pool()
    async with _pool.acquire() as conn:  # type: ignore[union-attr]
        return await conn.fetch(query, *args)


async def fetchrow(query: str, *args: Any) -> Optional[asyncpg.Record]:
    await init_pool()
    async with _pool.acquire() as conn:  # type: ignore[union-attr]
        return await conn.fetchrow(query, *args)


async def fetchval(query: str, *args: Any) -> Any:
    await init_pool()
    async with _pool.acquire() as conn:  # type: ignore[union-attr]
        return await conn.fetchval(query, *args)
