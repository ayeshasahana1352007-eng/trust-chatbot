# Verity implementation status

## Included in this package
- Existing React/TypeScript frontend and Python FastAPI backend are preserved.
- Email/password sign-up and login API routes: `/api/auth/signup`, `/api/auth/login`, `/api/auth/me`, and `/api/auth/logout`.
- SQLite users table with unique, case-insensitive email addresses.
- Password storage using salted PBKDF2-HMAC-SHA256 (310,000 iterations); plain-text passwords are not stored.
- Signed, HTTP-only session cookie for logged-in accounts; logout clears the cookie.
- Login/signup screen in the existing React app and a logout action.
- Conversation ownership is scoped to the authenticated user's ID.
- Existing chatbot, evidence/claim review, bias analysis, language selector, browser microphone input, and read-aloud features are preserved.
- `RUN_IN_CODESPACES.md` explains the intended browser-based development setup.

## Checks and limitations
- Python syntax compilation passed for `main.py`, `db.py`, and `ai_service.py`.
- ZIP integrity check passed.
- A full pytest run was attempted but could not complete because the environment could not reach PyPI to download a dependency. The frontend typecheck/build and end-to-end login/chat flow have not been verified here.
- No password-reset or email-verification flow is included yet.
- Anonymous chat history created before signup is not automatically migrated into an account.
- Gemini responses require a valid `GEMINI_API_KEY`; provider quotas still apply. The backend also requires a strong `SESSION_SECRET`.
- Do not treat this as production-ready until dependencies install, typecheck/build and tests pass, and deployment security is reviewed.
