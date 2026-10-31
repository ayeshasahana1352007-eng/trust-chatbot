# Responsible AI Chatbot

A session-private Gemini chat app that checks factual claims against Wikipedia
search evidence, highlights uncertainty and potential framing concerns, and
keeps conversation history in SQLite.

## Run & Operate

- Start the `artifacts/api-server: API Server` and `artifacts/responsible-ai-chatbot: web` workflows.
- `uv sync --locked` — install the Python environment.
- `uv run --locked pytest artifacts/api-server/python/tests` — run backend tests.
- `pnpm run typecheck` — check workspace TypeScript.
- Required Replit Secrets: `GEMINI_API_KEY` and `SESSION_SECRET`.

## Stack

- Frontend: React, TypeScript, Vite, TanStack Query
- API: FastAPI, Python 3.13, Uvicorn
- AI: Google's official `google-genai` SDK
- Evidence: Wikimedia Wikipedia REST API
- Persistence: SQLite

## Where things live

- `artifacts/responsible-ai-chatbot/src` — chat UI and evidence/bias review.
- `artifacts/api-server/python` — API routes, Gemini prompts, retrieval, and tests.
- `artifacts/api-server/python/tests` — AI pipeline and session-isolation tests.
- `lib/api-spec/openapi.yaml` — API contract used to generate the typed client.
- `artifacts/api-server/data` — default SQLite database location.

## Architecture decisions

- Sessions are private to the signed browser cookie; there are no user accounts.
- Only evidence returned by the retrieval service can be cited in claim analysis.
- When evidence is missing or a provider is unavailable, claims remain unverified.
- API credentials stay server-side in Replit Secrets.

## Product

The app answers questions, checks extracted claims against retrieved source
excerpts, reports potential bias/framing concerns, and stores session history.

## User preferences

Preserve the uploaded app's existing features, architecture, and visual design
when repairing it.

## Gotchas

- Wikimedia requests must include descriptive `User-Agent` and `Api-User-Agent` headers.
- The React web app calls `/api` through the API gateway; keep both workflows running.
- Run backend tests and workspace typechecking after service or contract changes.

## Pointers

- See `README.md` for setup, analysis behavior, and deployment notes.
