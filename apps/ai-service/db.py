# ──────────────────────────────────────────────
# DB pool — asyncpg, one pool per process.
#
# The ai-service reads the SAME tenant schema the Node services write to —
# it never writes. analytics-service's wrong-database boot guard is copied:
# the connected database is logged once so a zombie process pointed at the
# demo DB is visible in the first log line, not after an hour of zeros.
# ──────────────────────────────────────────────

from __future__ import annotations

import os
from typing import Any, Optional

import asyncpg

_pool: Optional[asyncpg.Pool] = None


def database_url() -> str:
    url = os.getenv("DATABASE_URL", "")
    if not url:
        raise RuntimeError("DATABASE_URL is not set — ai-service has nothing to read from.")
    if "schema=" in url:
        base, _, params = url.partition("?")
        for kv in params.split("&"):
            k, _, v = kv.partition("=")
            if k == "schema":
                url = f"{base}?search_path={v}"
    return url


async def init_pool() -> None:
    global _pool
    if _pool is None:
        _pool = await asyncpg.create_pool(
            database_url(),
            min_size=1,
            max_size=int(os.getenv("AI_POOL_SIZE", "3")),
            command_timeout=15,
        )
        async with _pool.acquire() as conn:
            connected = await conn.fetchval("SELECT current_database()")
        print(f"[ai-service] connected to database: {connected}", flush=True)


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
