"""Liveness and readiness for the Dua AI engine (Phase 3 items 8.1, 8.2).

Before this module the engine had one endpoint, `/`, which reported configuration but
never checked a dependency. A revision whose Supabase or Vertex credentials had expired
still answered 200, so Cloud Run kept sending it traffic.

Two questions, kept apart:
  /healthz  liveness  - the process can answer. No network, no credentials.
  /readyz   readiness - the process can do real work. Checks what it needs.

A readiness failure returns 503 so traffic moves to a healthy revision. Liveness stays
200 so the platform does not kill a process that is merely waiting on a dependency.

Nothing here returns a secret, a project id, a model name or an error string from a
provider. Only a short machine-readable reason, matching the privacy rule in the Node
request logger.

Deliberately stdlib only. The CI job that runs these tests builds an isolated venv with
Flask and pytest and nothing else, so a module-level `import requests` made the whole
test module fail to collect. A probe should also not pay for a third-party import at
cold start.
"""
from __future__ import annotations

import os
import time
import urllib.error
import urllib.request

from flask import Blueprint, jsonify

health = Blueprint("dua_health", __name__)

_STARTED = time.monotonic()
_TIMEOUT = 4.0


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """A probe must not follow a redirect: the answer is about this exact URL."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D102
        return None


_OPENER = urllib.request.build_opener(_NoRedirect)


def _no_store(payload, status: int):
    response = jsonify(payload)
    response.status_code = status
    response.headers["Cache-Control"] = "no-store"
    return response


def _check_supabase() -> dict:
    base = (os.environ.get("SUPABASE_URL") or "").rstrip("/")
    key = os.environ.get("SUPABASE_ANON_KEY") or os.environ.get("SUPABASE_PUBLISHABLE_KEY") or ""
    if not base.startswith("https://") or not key:
        return {"ok": False, "reason": "not_configured"}
    request = urllib.request.Request(f"{base}/auth/v1/health", headers={"apikey": key}, method="GET")
    try:
        with _OPENER.open(request, timeout=_TIMEOUT) as response:
            status = getattr(response, "status", 0)
            return {"ok": True} if 200 <= status < 300 else {"ok": False, "reason": f"status_{status}"}
    except urllib.error.HTTPError as error:
        return {"ok": False, "reason": f"status_{error.code}"}
    except Exception:  # noqa: BLE001 - any transport failure is the same answer to a probe
        return {"ok": False, "reason": "unreachable"}


def _check_vertex() -> dict:
    """Checks that Vertex credentials exist and can mint a token.

    It does not call the model: a readiness probe must be cheap and must not spend quota.
    """
    project = os.environ.get("GOOGLE_CLOUD_PROJECT") or ""
    if not project:
        return {"ok": False, "reason": "not_configured"}
    try:
        import google.auth
        from google.auth.transport.requests import Request as GoogleRequest

        credentials, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/cloud-platform"])
        credentials.refresh(GoogleRequest())
        return {"ok": True} if credentials.token else {"ok": False, "reason": "no_token"}
    except Exception:  # noqa: BLE001 - any auth failure is the same answer to a probe
        return {"ok": False, "reason": "credentials_unavailable"}


@health.route("/healthz", methods=["GET"])
def healthz():
    """Liveness. Deliberately does no I/O."""
    return _no_store(
        {
            "status": "ok",
            "service": "dua-ai-engine",
            "version": os.environ.get("DUA_BUILD_VERSION", ""),
            "uptimeSeconds": int(time.monotonic() - _STARTED),
        },
        200,
    )


@health.route("/readyz", methods=["GET"])
def readyz():
    """Readiness. Checks the dependencies this service actually needs."""
    checks = {"supabase": _check_supabase(), "vertex": _check_vertex()}
    failed = [name for name, value in checks.items() if not value.get("ok")]
    ready = not failed
    payload = {
        "status": "ready" if ready else "not_ready",
        "service": "dua-ai-engine",
        "version": os.environ.get("DUA_BUILD_VERSION", ""),
        "checks": checks,
    }
    if failed:
        payload["failed"] = failed
    return _no_store(payload, 200 if ready else 503)
