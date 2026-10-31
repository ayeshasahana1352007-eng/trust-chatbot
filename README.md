# Responsible AI Chatbot

A full-stack chat app that uses Google Gemini for answers, analyzes factual claims
against retrieved evidence, checks for potential bias, and saves conversation
history in SQLite.

## Setup

1. Add `GEMINI_API_KEY` and `SESSION_SECRET` in Replit Secrets. Do not place secret
   values in frontend code or commit them.
2. Run the API Server and Responsible AI Chatbot web workflows.
3. Open the web preview and start a new conversation.

`SESSION_SECRET` should be a long, random value. The app uses it to sign
HTTP-only, same-site browser session cookies. Conversations are isolated by
browser session; there is no email/password or cross-device account system.

## Stack and commands

- Frontend: React, TypeScript, Tailwind CSS, Vite
- API: FastAPI, Python 3.13, Uvicorn
- AI: Official Google Gen AI Python SDK; model `gemini-3.8-flash`
- Persistence: SQLite
- Evidence retrieval: Wikimedia Wikipedia search API (no additional key required)

Useful commands:

```bash
uv sync --locked
pnpm --filter @workspace/api-server run dev
pnpm --filter @workspace/responsible-ai-chatbot run dev
pnpm run typecheck
uv run --locked pytest artifacts/api-server/python/tests
```

After changing `lib/api-spec/openapi.yaml`, regenerate the typed client:

```bash
pnpm --filter @workspace/api-spec run codegen
```

`.env.example` lists supported environment-variable names only. For local runs,
set values in the shell or Replit Secrets; the app does not load `.env` files.

## How analysis works

1. Gemini generates the original answer.
2. Gemini extracts short, checkable factual claims.
3. The API searches Wikipedia and passes actual search excerpts to Gemini for
   evidence assessment. Only source IDs returned by the search service can be
   included in citations. Missing or inconclusive evidence is labeled
   `INSUFFICIENT_EVIDENCE`; it is not treated as a confirmed error.
4. Gemini evaluates potential bias in context. Neutral mentions of social groups
   are not sufficient to flag bias.
5. A revised answer is shown only when the analysis finds a source-backed
   contradiction or a potential unfair generalization. Revisions are not
   guaranteed to be correct.

Evidence search is a useful first-pass document retrieval source, not a
comprehensive fact-checking service. Search availability, article coverage, and
automated model judgments can be imperfect. Search queries are sent to the
Wikimedia API. Requests identify the app with the User-Agent required by
Wikimedia's API policy. When evidence retrieval is unavailable, the app says so
rather than presenting fabricated citations.

Gemini requests have a 45-second timeout. The app reports invalid credentials,
quota/rate limits, unavailable models, timeouts, and temporary provider outages
as distinct actionable errors. A temporary 503 or high-demand response is not
evidence of an invalid API key; retry the request after the provider recovers.


## Local development (Mac/Linux)

This is a pnpm workspace with a Python FastAPI service. Install Node.js (LTS),
pnpm, Python 3.13, and `uv` first. From the repository root run:

```bash
cp .env.example .env
# Edit .env and set GEMINI_API_KEY plus a long random SESSION_SECRET.
uv sync --locked
pnpm install --frozen-lockfile
```

The app currently has browser-session-based history, not email/password accounts.
Voice input depends on browser Web Speech API support and microphone permission.
The response-language selector adds an instruction to the prompt; it is not a
translation-quality guarantee. The AI and evidence checks are probabilistic and
can be wrong. Do not use this project as the sole basis for high-stakes decisions.

## Implementation note

The UI includes response-language selection (English, Tamil, Tanglish, Hindi),
browser speech input, and read-aloud controls. These changes have not been
validated with a complete dependency install/build in this environment; run the
commands below and fix any reported type/build issues before deployment.

## Deployment

Set both required secrets for the deployment environment, then publish the web
artifact through Replit. The API gateway starts the FastAPI service and routes
`/api` requests to it. SQLite is created at
`artifacts/api-server/data/responsible-ai.sqlite3` by default; set
`RESPONSIBLE_AI_DB_PATH` to choose another writable location.

Google's current Gemini API model list:
<https://ai.google.dev/gemini-api/docs/models>

## Email/password accounts
The app includes email/password sign-up and login endpoints (`/api/auth/signup`, `/api/auth/login`, `/api/auth/me`, and `/api/auth/logout`). Passwords are stored as salted PBKDF2-HMAC-SHA256 hashes, and login uses a signed HTTP-only session cookie. Configure a long random `SESSION_SECRET` before running. Email verification and password reset are not included yet. See `IMPLEMENTATION_STATUS.md` for verification limits and other caveats.
