# ──────────────────────────────────────────────
# Scheduled delivery (BUILD_PLAN 7.1)
#
# Analytics deliberately does NOT know how to send email or WhatsApp: that is
# communication-service's job (provider fallback chains, quiet hours, rate
# limits, per-message cost, delivery receipts). This module's whole purpose is
# to hand it a message — the report's download link — and report back whether
# the dispatcher accepted it.
#
# Two consequences worth stating plainly:
#   • stdlib urllib in a worker thread: no new dependency for one POST.
#   • a peer-call failure is recorded, never retried in a loop here. The next
#     scheduled run re-renders a fresh report anyway, and the delivery rows are
#     the audit trail an admin can look at.
# ──────────────────────────────────────────────

from __future__ import annotations

import asyncio
import json
import os
import urllib.error
import urllib.request
from typing import Any, Optional

try:  # package mode: uvicorn analytics_service.main:app
    from .assertions import mint_internal_assertion
except ImportError:  # direct mode: python main.py from this directory
    from assertions import mint_internal_assertion  # type: ignore[no-redef]

COMMUNICATION_SERVICE = "communication-service"


def communication_base_url() -> str:
    # Direct peer call, not through the gateway (which would need a user token).
    return os.getenv("COMMUNICATION_SERVICE_URL", "http://localhost:4005").rstrip("/")


def _post(url: str, body: dict[str, Any], assertion: str, timeout: float) -> tuple[int, str]:
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={"content-type": "application/json", "x-internal-assertion": assertion},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:  # noqa: S310 — fixed internal host
            return res.status, res.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except Exception as e:  # connection refused, DNS, timeout
        return 0, str(e)


async def dispatch_report(
    *,
    title: str,
    body: str,
    channel: str,
    target_roles: list[str],
    identity: dict[str, Any],
    variables: Optional[dict[str, str]] = None,
    timeout: float = 8.0,
) -> tuple[bool, int, str]:
    """Queue a report notification. Returns (delivered, recipients, error).

    `identity` is the schedule's owning context (user, tenant, branch) — the
    sweep acts as the person who created the schedule, so the audience
    resolution in communication-service is exactly what they would get from the
    UI. Roles are forced to SYSTEM-plus-target so an unattended sweep can never
    be used to reach an audience the creator could not.
    """
    assertion = mint_internal_assertion(
        audience=COMMUNICATION_SERVICE,
        user_id=identity.get("userId") or "system:report-scheduler",
        email=identity.get("email") or "reports@school-erp.local",
        # The sweep runs unattended, so there is no inbound assertion to inherit
        # a tenant from: take it from this deployment's own configuration, and
        # fall back to the documented empty-string "single database" value.
        tenant_id=identity.get("tenantId") or os.getenv("TENANT_ID") or "",
        school_id=identity.get("schoolId"),
        branch_id=identity.get("branchId"),
        roles=("SYSTEM",),
    )
    if not assertion:
        return (
            False,
            0,
            "INTERNAL_ASSERTION_PRIVATE_KEY is not configured — the report was rendered and "
            "stored, but no message was sent.",
        )

    payload = {
        "title": title,
        "content": body,
        "type": "NOTICE",
        "channel": channel,
        "targetRoles": target_roles,
        # A report is a staff artifact: without this the dispatcher's default
        # audience (every enrolled student's guardians) would mail a principal's
        # fee-arrears report to the whole parent body.
        "staffOnly": True,
        "variables": variables or {},
    }
    status, text = await asyncio.to_thread(
        _post, f"{communication_base_url()}/dispatch", payload, assertion, timeout
    )
    if status == 201:
        try:
            queued = int(json.loads(text).get("queued", 0))
        except (ValueError, AttributeError):
            queued = 0
        if queued == 0:
            # The dispatcher resolved nobody: a schedule targeted at a role
            # nobody holds is a misconfiguration the admin must see.
            return False, 0, "No recipients matched the schedule's target roles."
        return True, queued, ""
    if status == 0:
        return False, 0, f"communication-service unreachable: {text}"
    return False, 0, f"communication-service rejected the dispatch ({status}): {text[:200]}"
