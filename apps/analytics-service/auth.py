# ──────────────────────────────────────────────
# Assertion auth — Python twin of packages/auth assertion.ts (Phase 7.1)
#
# The gateway mints a short-lived RS256 JWT per proxied request with
# audience = this service's name and issuer 'school-erp-gateway', and ships it
# in the `x-internal-assertion` header. Node services verify with
# `requireAssertion`; this module is the same contract for the FastAPI
# services, so the analytics data is always scoped to a *verified* branch —
# never to a client-supplied header (those are stripped at the edge anyway).
#
# Fail-closed: no public key configured → every request 503s. Missing/expired/
# wrong-audience assertion → 401 with the deliberately vague Node wording.
# ──────────────────────────────────────────────

from __future__ import annotations

import os
from typing import Any, Optional

import jwt
from fastapi import Header, HTTPException, Request

INTERNAL_ASSERTION_HEADER = "x-internal-assertion"
ISSUER = "school-erp-gateway"

_PUBLIC_KEY: Optional[str] = None
if os.getenv("INTERNAL_ASSERTION_PUBLIC_KEY"):
    _PUBLIC_KEY = os.getenv("INTERNAL_ASSERTION_PUBLIC_KEY", "").replace("\\n", "\n")


def public_key_configured() -> bool:
    return _PUBLIC_KEY is not None and len(_PUBLIC_KEY) > 0


def set_public_key(pem: str) -> None:
    """Tests inject a keypair here; production reads the env at import."""
    global _PUBLIC_KEY
    _PUBLIC_KEY = pem.replace("\\n", "\n")


class Identity:
    """The verified caller — the same shape `ctx(req)` returns on Node services."""

    def __init__(self, claims: dict[str, Any]) -> None:
        self.user_id: str = claims.get("sub", "")
        self.email: str = claims.get("email", "")
        self.tenant_id: Optional[str] = claims.get("tenantId")
        # The school row INSIDE the tenant database — Branch.schoolId FK target.
        # tenantId alone is control-plane (database routing); scoping data by it
        # would match nothing in the tenant schema.
        self.school_id: Optional[str] = claims.get("schoolId")
        self.branch_id: Optional[str] = claims.get("branchId")
        self.roles: list[str] = claims.get("roles", []) or []

    @property
    def is_super_admin(self) -> bool:
        return "SUPER_ADMIN" in self.roles


def require_identity(
    request: Request,
    x_internal_assertion: Optional[str] = Header(default=None, alias=INTERNAL_ASSERTION_HEADER),
) -> Identity:
    """FastAPI dependency: verify the gateway assertion, return the identity.

    Raises 503 when the service has no public key (misconfiguration is not an
    auth bypass), 401 for every assertion problem — vague by design, matching
    the Node services' wording.
    """
    if not public_key_configured():
        raise HTTPException(
            status_code=503,
            detail="analytics-service has no INTERNAL_ASSERTION_PUBLIC_KEY — refusing all requests.",
        )
    if not x_internal_assertion:
        raise HTTPException(
            status_code=401,
            detail="This endpoint requires a valid gateway-issued assertion.",
        )
    try:
        claims = jwt.decode(
            x_internal_assertion,
            _PUBLIC_KEY,  # type: ignore[arg-type]
            algorithms=["RS256"],  # pinned: never accept `none`, never accept HMAC
            issuer=ISSUER,
            audience="analytics-service",
            options={"require": ["exp", "iss", "aud", "sub"]},
        )
    except jwt.ExpiredSignatureError:
        raise HTTPException(
            status_code=401,
            detail="This endpoint requires a valid gateway-issued assertion.",
        )
    except jwt.InvalidAudienceError:
        raise HTTPException(
            status_code=401,
            detail="This endpoint requires a valid gateway-issued assertion.",
        )
    except jwt.PyJWTError:
        raise HTTPException(
            status_code=401,
            detail="This endpoint requires a valid gateway-issued assertion.",
        )

    # Mirror the Node middleware's request stash so handlers can re-read it.
    request.state.identity = Identity(claims)
    return request.state.identity
