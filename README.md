# dua-backend

Owner-locked Dua AI backend for a separate UI. This repository has the Python engine and the Node API. It does not include the Android app, the website, or old design files.

## Run locally

Copy `.env.example` to `.env` and fill the values. Do not commit `.env`.

Node API, from `apps/api`:

```text
npm install
npm start
```

The API listens on `http://127.0.0.1:3000`. Set the UI `API_BASE_URL` to that origin.

Python engine, from `apps/ai-engine`:

```text
py -3 -m pip install -r requirements.txt
py -3 app.py
```

Set the UI `ENGINE_BASE_URL` to the engine origin. Dua Agent chat, including the five skill ids, goes to the engine `POST /api/chat`.

A browser UI must be listed in `WEB_ORIGINS`. Android sends no `Origin` header.

Request and response shapes are in `API_CONTRACT.md`.

## Tests

```text
cd apps/api
node --test test/web-chat.test.mjs test/orhan-tasks.test.mjs
```

```text
cd apps/ai-engine
py -3 -m pytest -q tests/test_dua_agent_skills.py tests/test_app.py tests/test_orhan.py
```

<!-- pr.sh probe 2026-11-15T07:19:23Z -->
