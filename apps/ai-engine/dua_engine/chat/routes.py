"""Chat routes: /api/chat (JSON or SSE stream, plain chat and Agent mode), /api/title and legacy /chat.

Moved from app.py without behaviour changes. Handlers import ``app`` at request time and read every
app-level helper or setting as ``engine.NAME``, so monkeypatching ``app`` in tests still applies.
"""

import json
import os

from flask import Response, g, jsonify, request, stream_with_context


def register_chat_routes(app):
    @app.route("/api/chat", methods=["POST"])
    def api_chat():
        import app as engine
        denied = engine.owner_access_error()
        if denied is not None:
            return denied
        data = request.get_json(silent=True)
        if not isinstance(data, dict):
            return jsonify({"error": "Invalid request."}), 400
        resume_id = data.get("resumeRun")
        if resume_id is not None:
            import dua_engine.agent.agent_store as agent_store
            import dua_engine.agent.agent_adk as agent_adk
            import asyncio
            if not agent_store.database_url() or not agent_adk.enabled():
                return engine.no_store(jsonify({"error": "Durable ADK sessions are not configured."}), 503)
            try:
                if not isinstance(resume_id, str):
                    raise ValueError()
                saved = asyncio.run(agent_store.get_task(g.owner_id, resume_id))
                if saved is None or saved.state.get("dua_schema") != 1 or not saved.state.get("dua_request"):
                    return engine.no_store(jsonify({"error": "Owned task not found."}), 404)
                if saved.state.get("dua_answer"):
                    return engine.no_store(jsonify({"error": "This task already completed. No work was repeated."}), 409)
                data = {**saved.state["dua_request"], "mode": "agent", "stream": True}
            except (ValueError, TypeError):
                return engine.no_store(jsonify({"error": "Invalid task ID."}), 400)
            except Exception:
                return engine.no_store(jsonify({"error": "Task storage is unavailable."}), 503)
        if data.get("persistence") is not None:
            return jsonify({"error": "Server reply saving is not available on the Google Cloud engine."}), 400
        if data.get("model") is not None and data.get("model") not in engine.APP_MODELS:
            return jsonify({"error": "Supported model select karein."}), 400
        try:
            attachments = engine.decode_attachments(data.get("attachments"))
            contents = engine.build_contents(data.get("messages"), attachments)
            # Custom skill bodies are read with the owner's own token (RLS); starter-only requests skip Supabase.
            system = engine.system_text(data, engine.custom_skills_for(data, getattr(g, "owner_token", "")))
        except engine.BadRequest as error:
            return jsonify({"error": error.message}), error.status

        agent = data.get("mode") == "agent"
        allowed_tools = None
        if "allowedTools" in data:
            selected = data.get("allowedTools")
            if not agent:
                return engine.no_store(jsonify({"error": "allowedTools is only valid for Agent mode."}), 400)
            if (not isinstance(selected, list) or len(selected) > 128 or
                    any(not isinstance(name, str) or not name or len(name) > 64 for name in selected) or
                    len(set(selected)) != len(selected)):
                return engine.no_store(jsonify({"error": "allowedTools must be a list of unique tool IDs."}), 400)
            allowed_tools = set(selected)
            try:
                import dua_engine.agent.agent_adk as agent_adk
                import dua_engine.agent.agent_documents as agent_documents
                import dua_engine.agent.agent_notes as agent_notes
                import dua_engine.agent.agent_toolkit as agent_toolkit
                import dua_engine.agent.agent_tools as agent_tools
                import dua_engine.coding.coding_agent as coding_agent
                import kill_switches
                token = os.environ.get("GITHUB_TOKEN", "").strip()
                github = coding_agent.GitHubClient(token, coding_agent.repo_name()) if token else None
                notes = agent_notes.for_owner({"id": g.owner_id, "token": getattr(g, "owner_token", "")})
                names = {item["name"] for item in agent_tools.declarations(
                    github is not None, github is not None and github.issues_enabled(), notes is not None,
                    agent_documents.enabled())}
                if agent_adk.enabled() and not kill_switches.agent_disabled() and kill_switches.maintenance_message() is None:
                    names.update(agent_toolkit.configured().tools)
                import imagine
                if not imagine.enabled() or not g.owner_id or not getattr(g, "owner_token", ""):
                    names.discard("generate_image")
                unavailable = sorted(allowed_tools - names)
                if unavailable:
                    return engine.no_store(jsonify({"code": "tool_unavailable", "error": "One or more selected tools are unavailable.",
                                             "tools": unavailable}), 422)
            except Exception:
                app.logger.exception("agent tool capability validation failed")
                return engine.no_store(jsonify({"error": "Agent tool capabilities are unavailable."}), 503)
        import kill_switches
        paused = kill_switches.maintenance_message()
        if paused:
            return engine.no_store(jsonify({"error": paused, "maintenance": True}), 503)
        if agent and kill_switches.agent_disabled():
            return engine.no_store(jsonify({"error": kill_switches.AGENT_PAUSED, "paused": "agent"}), 503)
        import openrouter
        free_model = data.get("openrouter")
        if free_model is not None and (not openrouter.enabled() or not openrouter.allowed(free_model)):
            return jsonify({"error": "This free model is not available. Choose another model."}), 400
        # Free models answer plain chat only; Agent, web, code and Build stay on Gemini.
        use_free = free_model is not None and data.get("stream") is True and not agent and data.get("mode") in (None, "auto", "reasoning") \
            and not data.get("web") and not data.get("code")
        if agent and data.get("stream") is not True:
            return jsonify({"error": "Agent mode needs streaming. Update the app."}), 400
        chat_config = {}
        if not agent and not use_free:
            level = engine.pick_thinking_level(data)
            app.logger.info("thinking level: %s", level)
            if engine.THINKING_ROUTER != "0":
                chat_config["generation_config"] = {"thinking_level": level}
            if data.get("stream") is True and engine.CHAT_THINKING_EVENTS != "0":
                chat_config.setdefault("generation_config", {})["include_thoughts"] = True
            if engine.CHAT_MAX_OUTPUT_TOKENS > 0:
                chat_config.setdefault("generation_config", {})["max_output_tokens"] = engine.CHAT_MAX_OUTPUT_TOKENS
            try:
                tools = engine.plain_chat_tools(data)
            except Exception:
                app.logger.warning("plain chat tool configuration unavailable")
                return jsonify({"error": engine.GENERIC_ERROR}), 502
            if tools:
                chat_config["tools"] = tools
        include_code = not agent and not use_free and bool(data.get("code")) and engine.CHAT_CODE_EXECUTION == "1"
        # Plain chat only: Agent (route_agent + tool loop) and OpenRouter free models keep their own models.
        chat_model = None if agent or use_free else engine.get_chat_model(system, data)
        if data.get("stream") is not True:
            try:
                try:
                    response = chat_model.generate_content(contents, **chat_config)
                except Exception as error:
                    if not engine.wait_for_chat_retry(error):
                        raise
                    response = chat_model.generate_content(contents, **chat_config)
                text = engine.chat_chunk_text(response, include_code)
                sources = engine.grounding_sources(response)
            except Exception:
                app.logger.exception("api chat failed")
                return jsonify({"error": engine.GENERIC_ERROR}), 502
            if not text.strip() and not engine.finish_truncated(response):
                return jsonify({"error": engine.GENERIC_ERROR}), 502
            result = {"text": text + engine.sources_footer(sources)}
            if sources:
                result["sources"] = sources
            notice = engine.unsupported_notice(data)
            if notice:
                result["notice"] = notice
            if engine.finish_truncated(response):
                result.update(truncated=True, hint=engine.CONTINUE_HINT)
            return jsonify(result)

        notice = engine.unsupported_notice(data)
        if use_free:
            has_files = bool(attachments) or any(isinstance(m, dict) and m.get("attachments") for m in data.get("messages") or [])
            notice = "Free models read text only; attached images and audio were not sent." if has_files else None

        def _trim_adk_request(raw):
            clean = {}
            for k in ("messages", "attachments", "memory", "personality", "model", "allowedTools"):
                if k not in raw:
                    continue
                if k == "attachments" and isinstance(raw[k], list):
                    clean[k] = [{"name": a.get("name"), "mimeType": a.get("mimeType")} for a in raw[k] if isinstance(a, dict)]
                elif k == "messages" and isinstance(raw[k], list):
                    clean[k] = raw[k][-24:]
                else:
                    clean[k] = raw[k]
            return clean

        owner = {"id": getattr(g, "owner_id", None), "token": getattr(g, "owner_token", ""),
                 "memory": data.get("memory") if isinstance(data.get("memory"), str) else "",
                 "allowed_tools": sorted(allowed_tools) if allowed_tools is not None else None,
                 "adk_run_id": resume_id, "adk_resume": resume_id is not None,
                 "adk_request": _trim_adk_request(data)}

        def events():
            chunks = engine.queue.Queue(maxsize=16)
            stopped = engine.threading.Event()

            def enqueue(kind, chunk=None):
                while not stopped.is_set():
                    try:
                        chunks.put((kind, chunk), timeout=0.5)
                        return True
                    except engine.queue.Full:
                        continue
                return False

            def vertex_stream():
                iterator = None
                try:
                    if agent:
                        engine.agent_producer(data.get("messages"), attachments, system, owner, cancelled=stopped.is_set)(enqueue)
                        return
                    if use_free:
                        openrouter.stream(free_model, system, data.get("messages"), enqueue, reasoning=data.get("mode") == "reasoning")
                        return
                    retried = False
                    while True:
                        received = False
                        try:
                            iterator = iter(chat_model.generate_content(contents, stream=True, **chat_config))
                            for chunk in iterator:
                                received = True
                                if not enqueue("chunk", chunk):
                                    break
                            break
                        except Exception as error:
                            # Retry 429 once, only before any chunk reached the client; never after partial output.
                            if retried or received or stopped.is_set() or not engine.wait_for_chat_retry(error):
                                raise
                            retried = True
                            if iterator is not None and hasattr(iterator, "close"):
                                try:
                                    iterator.close()
                                except Exception:
                                    pass
                            iterator = None
                    enqueue("done")
                except Exception:
                    app.logger.exception("api chat stream failed")
                    enqueue("error")
                finally:
                    if iterator is not None and hasattr(iterator, "close"):
                        try:
                            iterator.close()
                        except Exception:
                            app.logger.exception("Vertex stream cleanup failed")

            engine.threading.Thread(target=vertex_stream, name="dua-vertex-stream", daemon=True).start()
            truncated = False
            sent = False
            plain_sources = []
            try:
                # Flush headers promptly; the worker also covers delays obtaining the iterator itself.
                yield ": heartbeat\n\n"
                if notice:
                    yield engine.sse({"type": "notice", "message": notice})
                while True:
                    try:
                        kind, chunk = chunks.get(timeout=engine.HEARTBEAT_SECONDS)
                    except engine.queue.Empty:
                        yield ": heartbeat\n\n"
                        continue
                    if kind == "error":
                        yield engine.sse({"type": "error", "message": engine.GENERIC_ERROR, "status": 502})
                        return
                    if kind == "fail":  # friendly, already-safe message (e.g. free model rate limit)
                        message, status = chunk
                        yield engine.sse({"type": "error", "message": message, "status": status})
                        return
                    if kind == "done":
                        truncated = truncated or chunk is True
                        break
                    if kind == "event":
                        sent = sent or chunk.get("type") == "text"
                        yield engine.sse(chunk)
                        continue
                    truncated = truncated or engine.finish_truncated(chunk)
                    if not agent and not use_free:
                        engine.merge_chat_sources(plain_sources, chunk)
                        thought = engine.chunk_thoughts(chunk) if engine.CHAT_THINKING_EVENTS != "0" else ""
                        if thought:
                            yield engine.sse({"type": "thinking", "delta": thought})
                    text = engine.chat_chunk_text(chunk, include_code) if not agent and not use_free else engine.chunk_text(chunk)
                    if text:
                        sent = True
                        yield engine.sse({"type": "text", "delta": text})
                    else:
                        # Metadata-only chunks must not reset queue polling without emitting any bytes.
                        yield ": heartbeat\n\n"
                if not sent and not truncated:
                    yield engine.sse({"type": "error", "message": engine.GENERIC_ERROR, "status": 502})
                    return
                if plain_sources:
                    yield engine.sse({"type": "sources", "sources": plain_sources})
                    yield engine.sse({"type": "text", "delta": engine.sources_footer(plain_sources)})
                if truncated:
                    yield engine.sse({"type": "notice", "message": engine.CONTINUE_HINT,
                               "truncated": True, "hint": engine.CONTINUE_HINT})
                yield engine.sse({"type": "done", **({"truncated": True} if truncated else {})})
            finally:
                # On client disconnect (GeneratorExit at a yield) or normal end: stop enqueuing, close the iterator on its
                # owning worker, and tell the Agent loop to stop calling the model and tools (stopped.is_set).
                stopped.set()

        return Response(stream_with_context(events()), headers=engine.SSE_HEADERS,
                        content_type="text/event-stream; charset=utf-8")

    @app.route("/api/title", methods=["POST"])
    def api_title():
        """Short chat title for the drawer: one cheap call (low thinking, small cap, JSON), owner-only."""
        import app as engine
        denied = engine.owner_access_error()
        if denied is not None:
            return denied
        import kill_switches
        paused = kill_switches.maintenance_message()
        if paused:
            return engine.no_store(jsonify({"error": paused, "maintenance": True}), 503)
        data = request.get_json(silent=True) or {}
        user = str(data.get("user", "")).strip()[:4000]
        reply = str(data.get("reply", "")).strip()[:4000]
        if not user:
            return jsonify({"error": "Message is empty"}), 400
        try:
            response = engine.get_model(engine.SYSTEM_PROMPT).generate_content(
                f"{engine.TITLE_PROMPT}\n\nUser: {user}\n\nAssistant: {reply}",
                generation_config={"max_output_tokens": engine.TITLE_TOKENS, "temperature": 0.2, "thinking_level": "low",
                                   "response_mime_type": "application/json",
                                   "response_schema": {"type": "OBJECT", "properties": {"title": {"type": "STRING"}}, "required": ["title"]}})
            title = engine.clean_title(json.loads(engine.chunk_text(response) or "{}").get("title"))
        except Exception:
            app.logger.warning("title generation failed")
            return jsonify({"error": engine.GENERIC_ERROR}), 502
        if not title:
            return jsonify({"error": engine.GENERIC_ERROR}), 502
        return jsonify({"title": title})

    @app.route("/chat", methods=["POST"])
    def chat():
        import app as engine
        denied = engine.owner_access_error()
        if denied is not None:
            return denied
        import kill_switches
        paused = kill_switches.maintenance_message()
        if paused:
            return engine.no_store(jsonify({"error": paused, "maintenance": True}), 503)
        data = request.get_json(silent=True) or {}
        user_message = str(data.get("message", "")).strip()
        if not user_message:
            return jsonify({"error": "Message is empty"}), 400
        if len(user_message) > engine.MAX_MESSAGE_CHARS:
            return jsonify({"error": "Message is too long"}), 413
        try:
            response = engine.get_model().generate_content(user_message)
            return jsonify({"reply": response.text})
        except Exception:  # don't leak internal error details to clients
            app.logger.exception("chat failed")
            return jsonify({"error": "The Dua AI engine could not answer right now."}), 500
