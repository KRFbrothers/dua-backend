"""Owner-only Dua Agent routes: capabilities, workspaces, documents, notes and approved actions.

Moved from app.py without behaviour changes. Handlers import ``app`` at request time and read every
app-level helper or setting as ``engine.NAME``, so monkeypatching ``app`` in tests still applies.
"""

import os

from flask import g, jsonify, request


def register_agent_routes(app):
    @app.route("/api/agent/capabilities", methods=["GET"])
    def agent_capabilities():
        import app as engine
        denied = engine.owner_access_error()
        if denied is not None:
            return denied
        import dua_engine.agent.agent_adk as agent_adk, dua_engine.agent.agent_store as agent_store, dua_engine.agent.agent_documents as agent_documents, dua_engine.agent.agent_models as agent_models, dua_engine.agent.agent_toolkit as agent_toolkit, dua_engine.coding.coding_terminal as coding_terminal, dua_engine.coding.coding_checkpoints as coding_checkpoints, dua_engine.automation.agent_automation as agent_automation, kill_switches
        try:
            agent_available = not kill_switches.agent_disabled() and kill_switches.maintenance_message() is None
            routes = agent_models.routes()
            agent_models.check_adapters()
            custom_tools = agent_toolkit.configured()
            token = os.environ.get("GITHUB_TOKEN", "").strip()
            github = None
            if token:
                try:
                    import dua_engine.coding.coding_agent as coding_agent
                    github = coding_agent.GitHubClient(token, coding_agent.repo_name())
                except Exception:
                    github = None
            import dua_engine.agent.agent_notes as agent_notes
            import dua_engine.agent.agent_tools as agent_tools
            notes = agent_notes.for_owner({"id": g.owner_id, "token": getattr(g, "owner_token", "")})
            documents_enabled = agent_documents.enabled()
            available_tools = agent_tools.declarations(
                github is not None, github is not None and github.issues_enabled(), notes is not None, documents_enabled)
            names = {item["name"] for item in available_tools}
            if agent_adk.enabled() and agent_available:
                names.update(custom_tools.tools)
            import imagine
            if not imagine.enabled() or not g.owner_id or not getattr(g, "owner_token", ""):
                names.discard("generate_image")
            if not agent_available:
                names.clear()
            import dua_engine.coding.coding_agent as coding_agent
            import dua_engine.coding.pr_flow as pr_flow
            catalog = {item["name"] for item in agent_tools.BASE_TOOLS + agent_automation.TOOLS +
                       agent_tools.ISSUE_TOOLS + agent_notes.TOOLS + coding_agent.TOOLS}
            catalog.add("search_documents")
            if pr_flow.enabled():
                catalog.add("check_pr_ci")
            if agent_adk.enabled():
                catalog.update(custom_tools.tools)
            return engine.no_store(jsonify({"adkEnabled": agent_adk.enabled() and agent_available, "storage": agent_store.status(),
                "embeddingConfigured": agent_documents.enabled(), "providerRoutes": routes,
                "customTools": sorted(custom_tools.tools), "tools": sorted(names),
                "toolCatalog": [{"id": name, "available": name in names,
                                 "reason": None if name in names else "Required service or provider is not configured."}
                                for name in sorted(catalog)], "answerStreaming": True,
                "codingExecution": coding_terminal.status(),
                "codingCheckpoints": {"configured": coding_checkpoints.enabled(), "liveVerified": False},
                "deviceAutomation": agent_automation.status(),
                "liveProvidersVerified": False, "build": os.environ.get("DUA_BUILD_SHA","unknown")}))
        except Exception:
            return engine.no_store(jsonify({"error": "ADK configuration is invalid or an optional adapter is missing."}), 503)

    @app.route("/api/agent/workspaces", methods=["GET"])
    def agent_workspaces_api():
        import app as engine
        denied = engine.owner_access_error()
        if denied is not None:
            return denied
        import dua_engine.coding.coding_checkpoints as coding_checkpoints, dua_engine.coding.coding_agent as coding_agent
        if not coding_checkpoints.enabled():
            return engine.no_store(jsonify({"code": "not_configured", "error": "Workspace checkpoints are not configured."}), 503)
        try:
            return engine.no_store(jsonify(coding_checkpoints.list_owned(g.owner_id, coding_agent.repo_name())))
        except Exception:
            return engine.no_store(jsonify({"error": "Workspace checkpoints are unavailable."}), 503)

    @app.route("/api/agent/documents", methods=["GET", "POST", "DELETE"])
    def agent_documents_api():
        import app as engine
        denied = engine.owner_access_error()
        if denied is not None:
            return denied
        import kill_switches
        if request.method != "GET":
            paused = kill_switches.maintenance_message()
            if paused:
                return engine.no_store(jsonify({"error": paused, "maintenance": True}), 503)
            if kill_switches.agent_disabled():
                return engine.no_store(jsonify({"error": kill_switches.AGENT_PAUSED, "paused": "agent"}), 503)
        import dua_engine.agent.agent_documents as agent_documents
        if not agent_documents.enabled():
            return engine.no_store(jsonify({"error": "ADK document storage/embeddings are not configured."}), 503)
        try:
            store = agent_documents.Documents(g.owner_id, agent_documents.VertexEmbeddings(engine.get_adc_client()))
            if request.method == "GET":
                return engine.no_store(jsonify({"documents": store.list()}))
            data = request.get_json(silent=True)
            if not isinstance(data, dict):
                raise ValueError("Invalid document request")
            if request.method == "DELETE":
                return engine.no_store(jsonify(store.delete(data.get("id"))))
            if "query" in data:
                return engine.no_store(jsonify({"matches": store.search(data["query"])}))
            return engine.no_store(jsonify(store.add(data.get("name"), data.get("text"), data.get("id"))))
        except (ValueError, TypeError):
            return engine.no_store(jsonify({"error": "Invalid document ID, text, name or query."}), 400)
        except Exception:
            return engine.no_store(jsonify({"error": "Document storage or embeddings are unavailable."}), 503)

    @app.route("/api/agent/notes/reindex", methods=["POST"])
    def agent_notes_reindex():
        import app as engine
        denied=engine.owner_access_error()
        if denied is not None:return denied
        import kill_switches
        paused = kill_switches.maintenance_message()
        if paused:
            return engine.no_store(jsonify({"error": paused, "maintenance": True}), 503)
        if kill_switches.agent_disabled():
            return engine.no_store(jsonify({"error": kill_switches.AGENT_PAUSED, "paused": "agent"}), 503)
        import dua_engine.agent.agent_notes as agent_notes,dua_engine.agent.agent_documents as agent_documents
        if not agent_documents.enabled():
            return engine.no_store(jsonify({"error":"Semantic memory is not configured."}),503)
        try:
            store=agent_notes.for_owner({"id":g.owner_id,"token":g.owner_token})
            if store is None:return engine.no_store(jsonify({"error":"Notes are not configured."}),503)
            store.semantic=agent_documents.Documents(g.owner_id,agent_documents.VertexEmbeddings(engine.get_adc_client()))
            data=request.get_json(silent=True)
            if not isinstance(data,dict):raise ValueError()
            return engine.no_store(jsonify(store.reindex(data.get("offset",0),data.get("limit",20))))
        except (ValueError,TypeError):
            return engine.no_store(jsonify({"error":"Invalid reindex batch."}),400)
        except Exception:
            return engine.no_store(jsonify({"error":"Reindex stopped; retry the same explicit batch after checking storage/provider readiness."}),503)

    @app.route("/api/agent/notes/status", methods=["GET"])
    def agent_notes_status():
        """Owner-only: whether the Agent's notes table is reachable. Never returns note data or counts."""
        import app as engine
        denied = engine.owner_access_error()
        if denied:
            return denied
        import dua_engine.agent.agent_notes as agent_notes
        store = agent_notes.for_owner({"id": getattr(g, "owner_id", None), "token": getattr(g, "owner_token", "")})
        ready, reason = agent_notes.probe(store)
        response = jsonify({"enabled": store is not None, "ready": ready, "reason": reason})
        response.headers["Cache-Control"] = "no-store"
        return response

    @app.route("/api/agent/action", methods=["POST"])
    def agent_action():
        """Owner approves or rejects ONE pending Agent write action by id. Only the stored args are used."""
        import app as engine
        import dua_engine.agent.agent_safety as agent_safety
        import kill_switches
        denied = engine.owner_access_error()
        if denied is not None:
            return denied
        if kill_switches.agent_disabled() or kill_switches.maintenance_message():
            # Nothing is executed or consumed; the approval can be retried once Agent is back.
            return engine.no_store(jsonify({"error": kill_switches.maintenance_message() or kill_switches.AGENT_PAUSED}), 503)
        data = request.get_json(silent=True)
        action_id = data.get("id") if isinstance(data, dict) else None
        decision = data.get("decision") if isinstance(data, dict) else None
        if not isinstance(action_id, str) or not engine.APPROVAL_ID.fullmatch(action_id) or decision not in ("approve", "reject"):
            return engine.no_store(jsonify({"error": "Invalid request."}), 400)
        try:
            import dua_engine.agent.agent_store as agent_store
            action = agent_store.approvals().take(action_id, getattr(g, "owner_id", None))
        except agent_safety.ApprovalError as error:
            return engine.no_store(jsonify({"error": error.message}), error.status)
        except Exception:
            return engine.no_store(jsonify({"error":"Approval storage is unavailable. No action was executed."}),503)
        if decision == "reject":
            app.logger.info("agent action rejected: %s", action["tool"])
            return engine.no_store(jsonify({"status": "rejected", "tool": action["tool"],
                                     "text": f"You declined: {action['title']}. Nothing was changed."}))
        try:
            ok, text = agent_safety.execute(action, engine.approval_env(getattr(g, "owner_id", None), getattr(g, "owner_token", "")))
        except Exception as error:
            app.logger.error("agent action failed (%s)",type(error).__name__)
            ok, text = False, f"{action['title']} failed. Nothing more will be retried; ask the agent again if needed."
        app.logger.info("agent action approved: %s (%s)", action["tool"], "done" if ok else "failed")
        return engine.no_store(jsonify({"status": "done" if ok else "failed", "tool": action["tool"], "text": text}))
