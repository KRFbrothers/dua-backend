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
