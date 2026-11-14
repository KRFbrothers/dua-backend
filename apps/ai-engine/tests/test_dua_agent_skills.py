import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import app as engine
from dua_engine.agent.dua_agent_skills import SKILL_ORDER, compose_dua_agent_instruction


def test_enabled_skills_follow_the_super_agent_prompt_in_catalog_order():
    text = compose_dua_agent_instruction(["code-reviewer", "frontend-developer"])
    assert text.startswith("**`skill-creator`**")
    assert text.index("You are Frontend Developer") < text.index("You are Code Reviewer")
    assert "You are a backend system architect" not in text
    assert "Enabled skill: frontend-developer (Frontend Developer)" in text
    assert "Enabled skill: code-reviewer (Code Reviewer)" in text


def test_system_text_adds_skills_only_for_agent_mode():
    system = engine.system_text({"mode": "agent", "skills": ["api-tester"]})
    assert system.startswith(engine.SYSTEM_PROMPT)
    assert "You are API Tester" in system
    assert "You are Frontend Developer" not in system
    plain = engine.system_text({"mode": "agent"})
    assert "skill-creator" not in plain


def test_unknown_or_misplaced_skills_are_rejected():
    with pytest.raises(engine.BadRequest):
        engine.system_text({"mode": "auto", "skills": ["frontend-developer"]})
    with pytest.raises(engine.BadRequest):
        engine.system_text({"mode": "agent", "skills": ["frontend"]})
    with pytest.raises(engine.BadRequest):
        engine.system_text({"mode": "agent", "skills": ["code-reviewer", "code-reviewer"]})
    assert len(SKILL_ORDER) == 5
