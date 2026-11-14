"""Three fixed Orhan agents. A new agent is a job description plus tools, not a new model.

Research may search. Checker only reads that research. Writer only writes a document
after Checker accepts it. None of them can email, pay, delete, or save memory.
"""

MAX_PROMPT = 4000
MAX_OUTPUT = 12000

AGENTS = {
    "research": {
        "name": "Research",
        "tools": ["search"],
        "can": "Search the web and write findings from those results.",
        "cannot": "Email, payment, delete, and memory.",
    },
    "checker": {
        "name": "Checker",
        "tools": [],
        "can": "Read the research and say if it is enough to write from.",
        "cannot": "Search, email, payment, delete, and memory.",
    },
    "writer": {
        "name": "Writer",
        "tools": [],
        "can": "Write one document from the checked research.",
        "cannot": "Search, email, payment, delete, and memory.",
    },
}

RESEARCH_SYSTEM = (
    "You are Research for Dua Agent. Use only the web search tool. Write short findings from those results. "
    "If search is missing or empty, say that in one sentence and do not invent sources. "
    "Do not send email, spend money, delete anything, or save memory."
)
CHECKER_SYSTEM = (
    "You are Checker for Dua Agent. Read only the research you are given. "
    "The first line must be exactly 'VERDICT: pass' or 'VERDICT: fail'. "
    "Fail when there are no sources, the research says search was unavailable, or the findings do not answer the job. "
    "Do not search, write a new document, send email, spend money, delete anything, or save memory."
)
WRITER_SYSTEM = (
    "You are Writer for Dua Agent. Write one markdown document using only the research and the checker note. "
    "Do not add facts that are not in the research. Do not search, send email, spend money, delete anything, or save memory."
)


class StepFailure(Exception):
    def __init__(self, message):
        super().__init__(message)
        self.message = message


def clip(value, limit):
    text = " ".join(str(value or "").split())
    return text[:limit]


def agents_public():
    return [{"id": key, "name": value["name"], "tools": list(value["tools"]), "can": value["can"], "cannot": value["cannot"]} for key, value in AGENTS.items()]


def default_plan(prompt, team=None):
    title = clip(prompt, 80) or "Dua Agent task"
    if not team or not isinstance(team, list):
        return {
            "title": title,
            "agents": agents_public(),
            "steps": [
                {"id": "research", "agent": "research", "title": "Research", "dependsOn": []},
                {"id": "check", "agent": "checker", "title": "Check the research", "dependsOn": ["research"]},
                {"id": "document", "agent": "writer", "title": "Write the document", "dependsOn": ["check"]},
            ],
        }
    steps = []
    agents = []
    prev = []
    for idx, member in enumerate(team):
        if not isinstance(member, dict):
            continue
        mid = clip(member.get("id") or f"agent_{idx}", 40)
        mname = clip(member.get("name") or mid, 40)
        mtools = [clip(t, 40) for t in member.get("tools", []) if isinstance(t, str)]
        mcan = clip(member.get("can") or f"Assist as {mname}.", 200)
        mcannot = clip(member.get("cannot") or "Unauthorized actions.", 200)
        agents.append({"id": mid, "name": mname, "tools": mtools, "can": mcan, "cannot": mcannot})
        step_id = mid
        steps.append({"id": step_id, "agent": mid, "title": mname, "dependsOn": list(prev)})
        prev = [step_id]
    if not steps:
        return default_plan(prompt, team=None)
    return {
        "title": title,
        "agents": agents,
        "steps": steps,
    }


def checker_passed(text):
    lines = str(text or "").strip().splitlines()
    return bool(lines) and lines[0].strip().lower().startswith("verdict: pass")


def _need(inputs, key):
    value = inputs.get(key) if isinstance(inputs, dict) else None
    text = value.strip() if isinstance(value, str) else ""
    if not text:
        raise StepFailure("The previous step has no result to read.")
    return clip(text, MAX_OUTPUT)


def run_agent_step(agent, prompt, inputs, complete, search):
    """Run one agent. `complete(system, user)` returns model text. `search(prompt)` returns findings or None when search is off."""
    if agent not in AGENTS:
        raise StepFailure("That agent is not available.")
    job = clip(prompt, MAX_PROMPT)
    if not job:
        raise StepFailure("The job is empty.")
    if agent == "research":
        if search is None:
            raise StepFailure("Search is not connected. Research stopped before any document was written.")
        try:
            findings = search(job)
        except StepFailure:
            raise
        except Exception:
            raise StepFailure("Search failed. Research stopped before any document was written.")
        findings = clip(findings, MAX_OUTPUT)
        if not findings:
            raise StepFailure("Search returned nothing. Research stopped before any document was written.")
        return findings
    if agent == "checker":
        research = _need(inputs, "research")
        text = clip(complete(CHECKER_SYSTEM, f"Job:\n{job}\n\nResearch:\n{research}"), MAX_OUTPUT)
        if not checker_passed(text):
            raise StepFailure(clip(text, 300) or "Checker did not accept the research.")
        return text
    research = _need(inputs, "research")
    check = _need(inputs, "check")
    text = clip(complete(WRITER_SYSTEM, f"Job:\n{job}\n\nResearch:\n{research}\n\nChecker:\n{check}"), MAX_OUTPUT)
    if not text:
        raise StepFailure("Writer returned an empty document.")
    return text
