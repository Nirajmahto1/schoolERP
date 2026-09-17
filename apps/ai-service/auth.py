# ──────────────────────────────────────────────
# Assertion auth — Python twin of packages/auth assertion.ts
#
# Same contract analytics-service uses: the gateway mints a short-lived RS256
# JWT per proxied request (audience = ai-service, issuer = school-erp-gateway)
# and ships it in x-internal-assertion. The direct browser route
# (/api/v1/ai → ai-service) is intentionally NOT exposed through the gateway
# with a bearer token — every AI endpoint below requires the gateway
# assertion, so an ai-service port left reachable can only be used by the
# gateway. Fail-closed: no public key → 503 on everything.
# ──────────────────────────────────────────────

from __future__ import annotations

import os
from typing import Any, Optional

import jwt
from fastapi import Header, HTTPException, Request

INTERNAL_ASSERTION_HEADER = "x-internal-assertion"
ISSUER = "school-erp-gateway"
AUDIENCE = "ai-service"

_PUBLIC_KEY: Optional[str] = None
if os.getenv("INTERNAL_ASSERTION_PUBLIC_KEY"):
    _PUBLIC_KEY = os.getenv("INTERNAL_ASSERTION_PUBLIC_KEY", "").replace("\\n", "\n")


def set_public_key(pem: str) -> None:
    """Tests inject a keypair here; production reads the env at import."""
    global _PUBLIC_KEY
    _PUBLIC_KEY = pem.replace("\\n", "\n")


class Identity:
    """The verified caller — same shape `ctx(req)` returns on Node services."""

    def __init__(self, claims: dict[str, Any]) -> None:
        self.user_id: str = claims.get("sub", "")
        self.tenant_id: Optional[str] = claims.get("tenantId")
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
    if not _PUBLIC_KEY:
        raise HTTPException(
            status_code=503,
            detail="ai-service has no INTERNAL_ASSERTION_PUBLIC_KEY — refusing all requests.",
        )
    if not x_internal_assertion:
        raise HTTPException(
            status_code=401,
            detail="This endpoint requires a valid gateway-issued assertion.",
        )
    try:
        claims = jwt.decode(
            x_internal_assertion,
            _PUBLIC_KEY,
            algorithms=["RS256"],  # pinned: never accept `none`, never accept HMAC
            issuer=ISSUER,
            audience=AUDIENCE,
            options={"require": ["exp", "iss", "aud", "sub"]},
        )
    except jwt.PyJWTError:
        raise HTTPException(
            status_code=401,
            detail="This endpoint requires a valid gateway-issued assertion.",
        )
    request.state.identity = Identity(claims)
    return request.state.identity
