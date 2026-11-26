"""Unit tests for Context-Aware Semantic Cost Router (Phase 6A)."""
from pathlib import Path
import sys
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import dua_engine.agent.agent_models as agent_models


def test_classify_complexity_fast_tasks():
    for task in ['title', 'mention', 'memory_extraction', 'tagging', 'summary_short']:
        assert agent_models.classify_complexity(task=task) == agent_models.TIER_FAST


def test_classify_complexity_casual_qa():
    assert agent_models.classify_complexity(mode='auto', text='What is the capital of France?') == agent_models.TIER_FAST
    assert agent_models.classify_complexity(mode='auto', text='Hello Dua AI!') == agent_models.TIER_FAST


def test_classify_complexity_frontier_tasks():
    for task in ['revise', 'coding', 'agent_loop', 'pr_review', 'deep_analysis']:
        assert agent_models.classify_complexity(task=task) == agent_models.TIER_FRONTIER


def test_classify_complexity_frontier_modes():
    for mode in ['agent', 'build', 'reasoning']:
        assert agent_models.classify_complexity(mode=mode) == agent_models.TIER_FRONTIER


def test_classify_complexity_studio_revise():
    assert agent_models.classify_complexity(text='Please apply this change /revise') == agent_models.TIER_FRONTIER
    assert agent_models.classify_complexity(task='revise', text='add button') == agent_models.TIER_FRONTIER


def test_classify_complexity_coding_pr_keywords():
    queries = [
        'Please create PR for this bug fix',
        'Check the git diff and review',
        'Refactor architecture of database models',
        'Debug this traceback in Python',
        'Give a deep analysis of market trends',
        'Prove theorem using induction',
    ]
    for q in queries:
        assert agent_models.classify_complexity(text=q) == agent_models.TIER_FRONTIER


def test_classify_complexity_long_prompts():
    short_text = 'word ' * 400
    long_text = 'word ' * 401
    assert agent_models.classify_complexity(text=short_text) == agent_models.TIER_FAST
    assert agent_models.classify_complexity(text=long_text) == agent_models.TIER_FRONTIER


def test_classify_complexity_data_payload():
    fast_data = {
        'mode': 'auto',
        'messages': [{'role': 'user', 'text': 'How are you today?'}]
    }
    frontier_data = {
        'mode': 'agent',
        'messages': [{'role': 'user', 'text': 'Search the web and run tools'}]
    }
    assert agent_models.classify_complexity(data=fast_data) == agent_models.TIER_FAST
    assert agent_models.classify_complexity(data=frontier_data) == agent_models.TIER_FRONTIER


def test_select_semantic_model_defaults(monkeypatch):
    monkeypatch.delenv('FAST_MODEL', raising=False)
    monkeypatch.delenv('FRONTIER_MODEL', raising=False)
    monkeypatch.delenv('VERTEX_MODEL', raising=False)
    monkeypatch.delenv('AGENT_MODEL', raising=False)

    model, tier = agent_models.select_semantic_model(task='title')
    assert tier == agent_models.TIER_FAST
    assert model == agent_models.DEFAULT_FAST_MODEL

    model, tier = agent_models.select_semantic_model(mode='agent')
    assert tier == agent_models.TIER_FRONTIER
    assert model == agent_models.DEFAULT_FRONTIER_MODEL


def test_select_semantic_model_env_overrides(monkeypatch):
    monkeypatch.setenv('FAST_MODEL', 'gemini-2.5-flash')
    monkeypatch.setenv('FRONTIER_MODEL', 'anthropic/claude-3-7-sonnet')

    model, tier = agent_models.select_semantic_model(task='memory_extraction')
    assert tier == agent_models.TIER_FAST
    assert model == 'gemini-2.5-flash'

    model, tier = agent_models.select_semantic_model(mode='agent')
    assert tier == agent_models.TIER_FRONTIER
    assert model == 'anthropic/claude-3-7-sonnet'


def test_select_semantic_model_explicit_default():
    model, tier = agent_models.select_semantic_model(task='title', default_model='custom-model-x')
    assert tier == agent_models.TIER_FAST
    assert model == 'custom-model-x'


# --- K7: CHAT_MODEL_ROUTER wiring for plain (non-agent) chat ------------------------------------------

import json
from types import SimpleNamespace

import app as engine


def plain(text, **extra):
    return {"messages": [{"role": "user", "text": text}], **extra}


@pytest.fixture
def models(monkeypatch):
    """Distinct fast/frontier names so the tier choice is visible; get_model returns a cached Flash stand-in."""
    flash = SimpleNamespace(name="flash")
    monkeypatch.setattr(engine, "MODEL_NAME", "gemini-flash-test")
    monkeypatch.setattr(engine, "AGENT_MODEL", "gemini-argon-test")
    monkeypatch.setattr(engine, "get_model", lambda system=engine.SYSTEM_PROMPT: flash)
    return flash


def test_router_off_by_default_keeps_every_plain_chat_on_the_flash_model(models, monkeypatch):
    monkeypatch.setattr(engine, "CHAT_MODEL_ROUTER", "0")
    for data in (plain("Debug this traceback in Python"), plain("hi", mode="reasoning"), plain("x " * 500)):
        assert engine.get_chat_model("sys", data) is models


def test_router_on_sends_complex_plain_chat_to_agent_model_with_flash_fallback(models, monkeypatch):
    monkeypatch.setattr(engine, "CHAT_MODEL_ROUTER", "1")
    for data in (plain("Debug this traceback in Python"), plain("hi", mode="reasoning"), plain("word " * 401)):
        model = engine.get_chat_model("sys", data)
        assert isinstance(model, engine.GenaiModel)
        assert (model.model_name, model.fallback, model.system) == ("gemini-argon-test", "gemini-flash-test", "sys")


def test_router_on_keeps_simple_plain_chat_on_flash(models, monkeypatch):
    monkeypatch.setattr(engine, "CHAT_MODEL_ROUTER", "1")
    assert engine.get_chat_model("sys", plain("What is the capital of France?")) is models
    assert engine.get_chat_model("sys", {"messages": []}) is models
    assert engine.get_chat_model("sys", plain("hello", mode=["not", "a", "string"])) is models


def test_router_ignores_client_task_field(models, monkeypatch):
    monkeypatch.setattr(engine, "CHAT_MODEL_ROUTER", "1")
    for task in ("coding", "deep_analysis", "agent_loop", "revise"):
        assert engine.get_chat_model("sys", plain("thanks!", task=task)) is models


def test_router_on_with_same_agent_model_stays_on_cached_flash(models, monkeypatch):
    monkeypatch.setattr(engine, "CHAT_MODEL_ROUTER", "1")
    monkeypatch.setattr(engine, "AGENT_MODEL", "gemini-flash-test")
    assert engine.get_chat_model("sys", plain("Debug this traceback")) is models


@pytest.fixture
def chat_route(monkeypatch):
    """Real /api/chat handler with google-free stand-ins (CI has no google-genai)."""
    used = []

    class FakeModel:
        def __init__(self, system, model_name=None, thinking_level=None, fallback=None):
            self.model_name, self.fallback = model_name or "flash", fallback

        def generate_content(self, contents, stream=False, generation_config=None, tools=None):
            used.append((self.model_name, self.fallback, stream))
            item = SimpleNamespace(text="ok", candidates=[SimpleNamespace(finish_reason="STOP")])
            return iter([item]) if stream else item

    monkeypatch.setattr(engine, "owner_access_error", lambda: None)
    monkeypatch.setattr(engine, "make_part", lambda **kwargs: kwargs)
    monkeypatch.setattr(engine, "make_content", lambda role, parts: (role, parts))
    monkeypatch.setattr(engine, "plain_chat_tools", lambda data: None)
    monkeypatch.setattr(engine, "GenaiModel", FakeModel)
    monkeypatch.setattr(engine, "get_model", lambda system=engine.SYSTEM_PROMPT: FakeModel(system))
    monkeypatch.setattr(engine, "MODEL_NAME", "flash")
    monkeypatch.setattr(engine, "AGENT_MODEL", "argon")
    monkeypatch.setattr(engine, "CHAT_MODEL_ROUTER", "1")
    return used


def post_chat(**body):
    return engine.app.test_client().post("/api/chat", json={"model": "Dua", **body})


def test_plain_chat_route_uses_the_routed_model_for_stream_and_json(chat_route):
    r = post_chat(stream=True, messages=[{"role": "user", "text": "Debug this traceback in Python"}])
    assert r.status_code == 200
    r.get_data()
    r = post_chat(messages=[{"role": "user", "text": "Debug this traceback in Python"}])
    assert r.status_code == 200 and r.get_json()["text"] == "ok"
    r = post_chat(messages=[{"role": "user", "text": "hello there"}])
    assert r.status_code == 200
    assert chat_route == [("argon", "flash", True), ("argon", "flash", False), ("flash", None, False)]


def test_agent_mode_never_uses_the_plain_chat_router(chat_route, monkeypatch):
    calls = []
    monkeypatch.setattr(engine, "get_chat_model", lambda *a: calls.append(a))

    monkeypatch.setattr(engine, "agent_producer", lambda *a, **k: (lambda enqueue: None))
    r = post_chat(stream=True, mode="agent", messages=[{"role": "user", "text": "Debug this traceback in Python"}])
    # The model choice happens before the SSE body starts; the agent stream itself is not consumed here.
    assert r.status_code == 200
    assert calls == []
    r.close()
