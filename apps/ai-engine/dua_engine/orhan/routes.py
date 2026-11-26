"""Owner-only Dua Work plan and single-step routes (legacy /api/orhan/* paths). The Node API stores the task."""

import os

from flask import jsonify, request

from dua_engine.orhan.coordinator import RESEARCH_SYSTEM, StepFailure, default_plan, run_agent_step


def register_orhan_routes(app):
    @app.route("/api/orhan/plan", methods=["POST"])
    def orhan_plan():
        import app as engine
        import kill_switches
        denied = engine.owner_access_error()
        if denied is not None:
            return denied
        paused = _paused(kill_switches)
        if paused is not None:
            return paused
        data = request.get_json(silent=True) or {}
        prompt = data.get("prompt") if isinstance(data, dict) else None
        if not isinstance(prompt, str) or not prompt.strip():
            return engine.no_store(jsonify({"error": "The job is empty."}), 400)
        if len(prompt) > 4000:
            return engine.no_store(jsonify({"error": "The job is too long."}), 413)
        team = data.get("team") if isinstance(data, dict) and isinstance(data.get("team"), list) else None
        return engine.no_store(jsonify(default_plan(prompt, team=team)))

    @app.route("/api/orhan/step", methods=["POST"])
    def orhan_step():
        import app as engine
        import kill_switches
        denied = engine.owner_access_error()
        if denied is not None:
            return denied
        paused = _paused(kill_switches)
        if paused is not None:
            return paused
        data = request.get_json(silent=True) or {}
        if not isinstance(data, dict):
            return engine.no_store(jsonify({"error": "Invalid request."}), 400)
        agent = data.get("agent")
        prompt = data.get("prompt")
        inputs = data.get("inputs") if isinstance(data.get("inputs"), dict) else {}
        if not isinstance(agent, str) or not isinstance(prompt, str):
            return engine.no_store(jsonify({"error": "Invalid request."}), 400)
        if len(prompt) > 4000:
            return engine.no_store(jsonify({"error": "The job is too long."}), 413)
        # Only the named prior results are forwarded. Memory and files are not on this call.
        limited = {key: inputs.get(key) for key in ("research", "check") if key in inputs}

        def complete(system, user):
            response = engine.get_model(system).generate_content(
                user,
                generation_config={"max_output_tokens": 4096, "temperature": 0.2, "thinking_level": "low", "timeout_seconds": 25},
            )
            return engine.chunk_text(response)

        def search(job):
            if os.environ.get("CHAT_WEB_SEARCH", "1") == "0":
                return None
            response = engine.get_model(RESEARCH_SYSTEM).generate_content(
                job,
                generation_config={"max_output_tokens": 2048, "temperature": 0.2, "thinking_level": "low", "timeout_seconds": 25},
                tools=[engine.google_search_tool()],
            )
            return engine.chunk_text(response)

        try:
            output = run_agent_step(agent, prompt, limited, complete, None if os.environ.get("CHAT_WEB_SEARCH", "1") == "0" else search)
        except StepFailure as error:
            return engine.no_store(jsonify({"status": "failed", "error": error.message}))
        except Exception:
            app.logger.warning("orhan step failed")
            return engine.no_store(jsonify({"error": "Dua Agent could not finish this step."}), 502)
        return engine.no_store(jsonify({"status": "completed", "output": output}))


def _paused(kill_switches):
    import app as engine
    message = kill_switches.maintenance_message()
    if message:
        return engine.no_store(jsonify({"error": message, "maintenance": True}), 503)
    if kill_switches.agent_disabled():
        return engine.no_store(jsonify({"error": kill_switches.AGENT_PAUSED, "paused": "agent"}), 503)
    return None
