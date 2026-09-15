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
    # Prisma-style URLs carry `?schema=public`; asyncpg speaks search_path.
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
            max_size=int(os.getenv("ANALYTICS_POOL_SIZE", "5")),
            command_timeout=15,
        )


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
