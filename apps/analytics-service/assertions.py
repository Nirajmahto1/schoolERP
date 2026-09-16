# ──────────────────────────────────────────────
# Peer assertions — Python twin of packages/auth mintAssertion (BUILD_PLAN 7.1)
#
# The scheduled-report sweep has to hand a message to communication-service,
# and direct service-to-service calls are authenticated the same way the
# gateway does it (ADR-3): a short-lived RS256 assertion carrying the caller's
# identity, audience-bound to the callee.
#
# Per ADR-3 a leaf service may hold only the PUBLIC key, and then it simply
# cannot mint — this module returns None and the caller degrades: the report is
# still rendered and stored, and the delivery row records exactly why it was
# not sent, instead of failing silently or pretending to have sent it.
# ──────────────────────────────────────────────

from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

import jwt

ISSUER = "school-erp-gateway"


def private_key() -> Optional[str]:
    """Signing material from the environment (PEM with literal \\n escapes)."""
    raw = os.getenv("INTERNAL_ASSERTION_PRIVATE_KEY", "")
    return raw.replace("\\n", "\n") if raw else None


def peer_calls_enabled() -> bool:
    return private_key() is not None


def mint_internal_assertion(
    *,
    audience: str,
    user_id: str,
    email: str,
    tenant_id: Optional[str],
    branch_id: Optional[str],
    school_id: Optional[str] = None,
    roles: tuple[str, ...] = ("SYSTEM",),
    ttl_seconds: int = 30,
) -> Optional[str]:
    """Mint an assertion a peer service will verify (audience = its own name).

    Claims mirror `mintAssertion` in packages/auth exactly: the same `sub`,
    `email`, `tenantId`, `schoolId`, `branchId`, `roles` shape the Node services
    put in `ctx(req)`. A 30-second TTL is deliberate — the token exists to
    authorise one immediate call, not to be stored.
    """
    key = private_key()
    if not key:
        return None

    now = datetime.now(timezone.utc)
    payload: dict[str, Any] = {
        "sub": user_id,
        "email": email,
        # The Node verifier's schema requires a STRING here — an empty one is
        # the documented "no multi-tenant routing" value (local dev and
        # single-database deployments sign it empty). A JSON null fails
        # validation and comes back as a bare 401.
        "tenantId": tenant_id or "",
        "schoolId": school_id,
        "branchId": branch_id,
        "roles": list(roles) or ["SYSTEM"],
        "impersonatedBy": None,
        "iss": ISSUER,
        "aud": audience,
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(seconds=ttl_seconds)).timestamp()),
        "jti": uuid.uuid4().hex,
    }
    return jwt.encode(payload, key, algorithm="RS256")
