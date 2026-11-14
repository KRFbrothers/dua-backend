"""Pinned Dua Agent prompt and the five skills installed inside it.

The verbatim text lives in dua_agent_prompts.json. Chat mode "agent" asks for
skill ids; this module turns those ids into the system instruction. It does
not call a model.
"""

import json
from pathlib import Path

_DATA = json.loads(Path(__file__).with_name("dua_agent_prompts.json").read_text(encoding="utf-8"))

SUPER_AGENT_PROMPT = _DATA["superAgent"]
SKILLS = {item["id"]: item for item in _DATA["skills"]}
SKILL_ORDER = tuple(SKILLS)


class SkillSelectionError(ValueError):
    """The client asked for a skill id this agent does not install."""


def compose_dua_agent_instruction(skill_ids):
    """Super Agent prompt plus the enabled skill bodies, in catalog order."""
    if not isinstance(skill_ids, list) or len(skill_ids) > len(SKILL_ORDER) or len(set(skill_ids)) != len(skill_ids):
        raise SkillSelectionError("Invalid skills.")
    if any(not isinstance(skill_id, str) or skill_id not in SKILLS for skill_id in skill_ids):
        raise SkillSelectionError("Invalid skills.")
    selected = set(skill_ids)
    parts = [SUPER_AGENT_PROMPT.strip()]
    for skill_id in SKILL_ORDER:
        if skill_id not in selected:
            continue
        skill = SKILLS[skill_id]
        parts.append(f"# Enabled skill: {skill_id} ({skill['title']})\n{skill['summary']}\n\n{skill['body'].strip()}")
    return "\n\n".join(parts)
