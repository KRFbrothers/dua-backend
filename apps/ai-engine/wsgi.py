"""Gunicorn entry point: the Flask engine wrapped with UI CORS middleware."""
from app import app
from web_cors import CorsMiddleware

app.wsgi_app = CorsMiddleware(app.wsgi_app)
