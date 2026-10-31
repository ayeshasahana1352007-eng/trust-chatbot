# Verity implementation status

## Added in this package
- Email/password sign-up and login API routes.
- SQLite users table with unique, case-insensitive email addresses.
- Password storage using salted PBKDF2-HMAC-SHA256 (310,000 iterations); plain-text passwords are not stored.
- Signed, HTTP-only session cookie for logged-in accounts; logout clears the cookie.
- Login/signup screen in the existing React app and a logout action.
- Conversation ownership continues to use the authenticated user's ID, so new conversations are scoped per account.
- Existing chatbot, claim/evidence review, bias analysis, language selector, browser microphone input, and read-aloud features are preserved.

## Important limitations
- The project has not been built or run end-to-end in this environment. Python syntax and password-hash logic were checked, but frontend type-checking and API integration tests still need to be run after installing the project's dependencies.
- There is no password-reset/email-verification flow yet. Use a strong password and do not reuse a sensitive password for this prototype.
- Anonymous chat history created before signing in is not automatically migrated into a new account.
- Gemini responses still require a valid `GEMINI_API_KEY`, and the backend requires a strong `SESSION_SECRET`.
