"""Tests for the engine liveness and readiness endpoints (Phase 3 items 8.1, 8.2)."""
import os
import sys
import types
import unittest
from unittest import mock

from flask import Flask

from dua_engine import health as health_module


def make_app():
    app = Flask(__name__)
    app.register_blueprint(health_module.health)
    return app


class HealthTest(unittest.TestCase):
    def setUp(self):
        self.client = make_app().test_client()

    def test_liveness_is_200_and_does_no_io(self):
        with mock.patch.object(health_module, "_check_supabase") as supabase, \
             mock.patch.object(health_module, "_check_vertex") as vertex:
            response = self.client.get("/healthz")
        self.assertEqual(response.status_code, 200)
        body = response.get_json()
        self.assertEqual(body["status"], "ok")
        self.assertEqual(body["service"], "dua-ai-engine")
        self.assertEqual(response.headers["Cache-Control"], "no-store")
        supabase.assert_not_called()
        vertex.assert_not_called()

    def test_readiness_is_503_when_nothing_is_configured(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            response = self.client.get("/readyz")
        self.assertEqual(response.status_code, 503)
        body = response.get_json()
        self.assertEqual(body["status"], "not_ready")
        self.assertEqual(sorted(body["failed"]), ["supabase", "vertex"])
        self.assertEqual(body["checks"]["supabase"]["reason"], "not_configured")
        self.assertEqual(body["checks"]["vertex"]["reason"], "not_configured")

    def test_readiness_is_200_when_both_checks_pass(self):
        with mock.patch.object(health_module, "_check_supabase", return_value={"ok": True}), \
             mock.patch.object(health_module, "_check_vertex", return_value={"ok": True}):
            response = self.client.get("/readyz")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["status"], "ready")

    def test_readiness_names_only_the_failing_dependency(self):
        with mock.patch.object(health_module, "_check_supabase", return_value={"ok": True}), \
             mock.patch.object(health_module, "_check_vertex", return_value={"ok": False, "reason": "credentials_unavailable"}):
            response = self.client.get("/readyz")
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.get_json()["failed"], ["vertex"])

    def test_supabase_check_reports_unreachable_without_leaking_the_error(self):
        with mock.patch.dict(os.environ, {"SUPABASE_URL": "https://proj.supabase.co", "SUPABASE_ANON_KEY": "sb_publishable_x"}, clear=True), \
             mock.patch.object(health_module.requests, "get", side_effect=health_module.requests.RequestException("secret host detail")):
            result = health_module._check_supabase()
        self.assertEqual(result, {"ok": False, "reason": "unreachable"})
        self.assertNotIn("secret", str(result))

    def test_supabase_check_rejects_a_non_https_url(self):
        with mock.patch.dict(os.environ, {"SUPABASE_URL": "http://insecure.test", "SUPABASE_ANON_KEY": "k"}, clear=True):
            self.assertEqual(health_module._check_supabase()["reason"], "not_configured")

    def test_vertex_check_does_not_call_the_model(self):
        # A fake google.auth that fails to mint a token. The check must report a reason and
        # must never reach a model call, which is what makes it cheap enough for a probe.
        fake_auth = types.ModuleType("google.auth")
        fake_auth.default = mock.Mock(side_effect=Exception("no creds"))
        fake_transport = types.ModuleType("google.auth.transport")
        fake_requests = types.ModuleType("google.auth.transport.requests")
        fake_requests.Request = mock.Mock()
        with mock.patch.dict(os.environ, {"GOOGLE_CLOUD_PROJECT": "proj"}, clear=True), \
             mock.patch.dict(sys.modules, {
                 "google": types.ModuleType("google"),
                 "google.auth": fake_auth,
                 "google.auth.transport": fake_transport,
                 "google.auth.transport.requests": fake_requests,
             }):
            result = health_module._check_vertex()
        self.assertEqual(result, {"ok": False, "reason": "credentials_unavailable"})


if __name__ == "__main__":
    unittest.main()
