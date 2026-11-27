"""Gunicorn entry point: the Flask engine wrapped with UI CORS middleware."""
from app import app
from web_cors import CorsMiddleware

# Phase 3 items 8.1, 8.2: /healthz (liveness) and /readyz (readiness).
# Registered here because gunicorn loads `wsgi:app` (adk_server.py execs
# `gunicorn ... wsgi:app`), so this is the production entry point. `/` is left
# exactly as it was, because the app reads its capability flags from there.
from dua_engine.health import health as health_blueprint

app.register_blueprint(health_blueprint)

app.wsgi_app = CorsMiddleware(app.wsgi_app)
