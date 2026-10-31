# Run Verity in GitHub Codespaces (browser-only setup)

This project is a pnpm monorepo with a React/Vite frontend and an Express gateway
that starts a Python/FastAPI service. The gateway serves API routes and proxies
requests to the Python service. You do not need to manually connect frontend and
backend if you start them using the commands below.

## 1. Put the project in GitHub

Create a repository and upload the **contents** of the `responsible-ai-chatbot`
folder (not the ZIP file itself). Keep `.env` and any API keys out of GitHub.
Then open the repository and choose **Code → Codespaces → Create codespace**.

## 2. Configure secrets in the Codespaces terminal

Use the terminal inside the Codespace. Create a local `.env` file from the example:

```bash
cp .env.example .env
```

Edit `.env` in the browser editor and set:

```dotenv
GEMINI_API_KEY=your_actual_gemini_api_key
SESSION_SECRET=replace_with_a_long_random_secret
RESPONSIBLE_AI_DB_PATH=
```

Do not commit `.env` or share your API key. Generate a session secret with a
secure random generator; do not use the example text above as a real secret.

## 3. Install dependencies

The Codespace needs Node.js, pnpm, Python 3.13, and `uv`. Check first:

```bash
node --version
corepack --version
python --version
uv --version
```

If `pnpm` is not available, enable Corepack and activate pnpm:

```bash
corepack enable
corepack prepare pnpm@latest --activate
```

Install dependencies:

```bash
pnpm install --frozen-lockfile
uv sync --locked
```

## 4. Start the API gateway (backend)

In terminal 1, from the repository root:

```bash
pnpm --filter @workspace/api-server run dev
```

Wait until the service reports that it is listening. The API gateway starts the
Python FastAPI service as a child process and routes `/api` calls to it.

## 5. Start the frontend

In terminal 2, from the repository root:

```bash
pnpm --filter @workspace/responsible-ai-chatbot run dev
```

Use the forwarded Vite port URL shown by Codespaces. Do not expose the backend
port publicly unless you understand the security implications.

## Troubleshooting

- If a command fails, copy the **first complete error message** from the terminal.
- A valid `GEMINI_API_KEY` is required for AI answers; provider quotas still apply.
- Keep `SESSION_SECRET` stable between restarts or existing login cookies become invalid.
- SQLite requires a writable filesystem. Ephemeral Codespaces may not be a permanent
  production database; back up data or use a managed database before deployment.
- Browser voice input needs microphone permission and a compatible browser.
- Run `pnpm run typecheck` and `uv run --locked pytest artifacts/api-server/python/tests`
  before treating the app as verified.
