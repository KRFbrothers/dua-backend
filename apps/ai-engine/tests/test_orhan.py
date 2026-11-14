import os
import sys
from types import SimpleNamespace

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import app as engine
from owner_auth import OwnerAuthError


@pytest.fixture
def client(monkeypatch):
    monkeypatch.delenv("DUA_APP_TOKEN", raising=False)
    monkeypatch.delenv("DUA_DISABLE_AGENT", raising=False)
    monkeypatch.delenv("DUA_MAINTENANCE", raising=False)
    monkeypatch.setattr(engine, "verify_owner", lambda _authorization: "owner-id")
    return engine.app.test_client()


def auth_post(client, path, payload):
    return client.post(path, json=payload, headers={"Authorization": "Bearer token"})


def test_plan_uses_only_research_checker_and_writer(client):
    response = auth_post(client, "/api/orhan/plan", {"prompt": "Research three competitors and write a document"})
    assert response.status_code == 200
    body = response.get_json()
    assert [agent["id"] for agent in body["agents"]] == ["research", "checker", "writer"]
    assert body["agents"][0]["tools"] == ["search"]
    assert body["agents"][1]["tools"] == []
    assert body["agents"][2]["tools"] == []
    assert [step["dependsOn"] for step in body["steps"]] == [[], ["research"], ["check"]]
    assert "memory" in body["agents"][0]["cannot"].lower()


def _reject_owner(_authorization):
    raise OwnerAuthError("Authentication required. Sign in from Profile before using online AI.", 401)


def test_missing_login_is_rejected(monkeypatch):
    monkeypatch.delenv("DUA_APP_TOKEN", raising=False)
    monkeypatch.setattr(engine, "verify_owner", _reject_owner)
    response = engine.app.test_client().post("/api/orhan/plan", json={"prompt": "Research competitors"})
    assert response.status_code == 401


def test_agent_pause_stops_a_plan(client, monkeypatch):
    monkeypatch.setenv("DUA_DISABLE_AGENT", "1")
    response = auth_post(client, "/api/orhan/plan", {"prompt": "Research competitors"})
    assert response.status_code == 503
    assert response.get_json()["paused"] == "agent"


def test_research_stops_when_search_is_off(client, monkeypatch):
    monkeypatch.setenv("CHAT_WEB_SEARCH", "0")
    called = []
    monkeypatch.setattr(engine, "get_model", lambda system: called.append(system))
    response = auth_post(client, "/api/orhan/step", {"agent": "research", "prompt": "Find competitors", "inputs": {}})
    assert response.status_code == 200
    body = response.get_json()
    assert body["status"] == "failed"
    assert "Search is not connected" in body["error"]
    assert called == []


def test_checker_reads_research_without_search(client, monkeypatch):
    class Fake:
        def __init__(self):
            self.tools = "unset"
            self.contents = ""

        def generate_content(self, contents, stream=False, generation_config=None, tools=None):
            self.tools = tools
            self.contents = contents
            return SimpleNamespace(text="VERDICT: fail\nNo sources.")

    fake = Fake()
    monkeypatch.setattr(engine, "get_model", lambda _system: fake)
    response = auth_post(client, "/api/orhan/step", {
        "agent": "checker",
        "prompt": "Find competitors",
        "inputs": {"research": "A note with no sources.", "memory": "do not pass this memory"},
    })
    assert response.status_code == 200
    assert response.get_json()["status"] == "failed"
    assert fake.tools is None
    assert "A note with no sources." in fake.contents
    assert "do not pass this memory" not in fake.contents


def test_writer_does_not_receive_a_search_tool(client, monkeypatch):
    class Fake:
        def generate_content(self, contents, stream=False, generation_config=None, tools=None):
            self.tools = tools
            self.contents = contents
            return SimpleNamespace(text="# Brief\n\nOnly the research.")

    fake = Fake()
    monkeypatch.setattr(engine, "get_model", lambda _system: fake)
    response = auth_post(client, "/api/orhan/step", {
        "agent": "writer",
        "prompt": "Find competitors",
        "inputs": {"research": "Source: example.com", "check": "VERDICT: pass", "memory": "private note"},
    })
    assert response.get_json()["status"] == "completed"
    assert fake.tools is None
    assert "Source: example.com" in fake.contents
    assert "private note" not in fake.contents


def test_unknown_agent_is_refused(client):
    response = auth_post(client, "/api/orhan/step", {"agent": "email", "prompt": "Send the report", "inputs": {}})
    assert response.get_json()["status"] == "failed"
    assert "not available" in response.get_json()["error"]
