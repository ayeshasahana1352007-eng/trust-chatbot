from __future__ import annotations

import json
import logging
import os
import re
import secrets
import hashlib
import hmac
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Any, Literal

from fastapi import FastAPI, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field
from itsdangerous import BadSignature, URLSafeTimedSerializer

from ai_service import (
    AIServiceError,
    MODEL,
    SEARCH_PROVIDER,
    analyze_answer,
    evidence_service_available,
    gemini_configured,
    generate_answer,
)
from db import connect, decode_analysis, encode_analysis, initialize_database

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
logging.getLogger("httpx").setLevel(logging.WARNING)
logger = logging.getLogger("responsible_ai.api")
COOKIE_NAME = "responsible_ai_session"
COOKIE_MAX_AGE = 60 * 60 * 24 * 365


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def session_signer() -> URLSafeTimedSerializer:
    secret = os.environ.get("SESSION_SECRET", "").strip()
    if not secret:
        raise RuntimeError("SESSION_SECRET must be configured in Replit Secrets.")
    return URLSafeTimedSerializer(secret, salt="responsible-ai-session-v1")


@asynccontextmanager
async def lifespan(_: FastAPI):
    session_signer()
    initialize_database()
    yield


app = FastAPI(
    title="Responsible AI Chatbot API",
    version="1.0.0",
    lifespan=lifespan,
)


@app.middleware("http")
async def isolate_browser_sessions(request: Request, call_next):
    signer = session_signer()
    token = request.cookies.get(COOKIE_NAME)
    owner_id: str | None = None
    if token:
        try:
            candidate = signer.loads(token, max_age=COOKIE_MAX_AGE)
            if isinstance(candidate, str):
                owner_id = candidate
        except BadSignature:
            owner_id = None

    fresh_token: str | None = None
    if owner_id is None:
        owner_id = str(uuid.uuid4())
        fresh_token = signer.dumps(owner_id)
    request.state.owner_id = owner_id
    request.state.user = None
    with connect() as connection:
        user = connection.execute(
            "SELECT id, name, email FROM users WHERE id = ?", (owner_id,)
        ).fetchone()
    if user:
        request.state.user = dict(user)
    response = await call_next(request)
    if fresh_token and request.url.path not in ("/api/auth/signup", "/api/auth/login"):
        forwarded_proto = request.headers.get("x-forwarded-proto", "").split(",")[0]
        response.set_cookie(
            key=COOKIE_NAME,
            value=fresh_token,
            max_age=COOKIE_MAX_AGE,
            httponly=True,
            secure=forwarded_proto == "https" or os.environ.get("NODE_ENV") == "production",
            samesite="lax",
            path="/",
        )
    return response


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class SignUpInput(StrictModel):
    name: str = Field(min_length=1, max_length=80)
    email: str = Field(min_length=5, max_length=254)
    password: str = Field(min_length=8, max_length=128)


class LoginInput(StrictModel):
    email: str = Field(min_length=5, max_length=254)
    password: str = Field(min_length=1, max_length=128)


def _password_hash(password: str, salt: bytes | None = None) -> str:
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, 310_000)
    return f"pbkdf2_sha256$310000${salt.hex()}${digest.hex()}"


def _verify_password(password: str, stored: str) -> bool:
    try:
        algorithm, iterations, salt_hex, digest_hex = stored.split("$")
        if algorithm != "pbkdf2_sha256":
            return False
        calculated = hashlib.pbkdf2_hmac(
            "sha256", password.encode("utf-8"), bytes.fromhex(salt_hex), int(iterations)
        ).hex()
        return hmac.compare_digest(calculated, digest_hex)
    except (ValueError, TypeError):
        return False


def _set_login_cookie(response: Response, user_id: str, request: Request) -> None:
    forwarded_proto = request.headers.get("x-forwarded-proto", "").split(",")[0]
    response.set_cookie(
        key=COOKIE_NAME, value=session_signer().dumps(user_id), max_age=COOKIE_MAX_AGE,
        httponly=True,
        secure=forwarded_proto == "https" or os.environ.get("NODE_ENV") == "production",
        samesite="lax", path="/",
    )


class ConversationInput(StrictModel):
    title: str = Field(min_length=1, max_length=120)


class ConversationPatch(StrictModel):
    title: str = Field(min_length=1, max_length=120)


class ChatMessageInput(StrictModel):
    content: str = Field(min_length=1, max_length=10_000)


class RegenerateInput(StrictModel):
    questionId: str = Field(min_length=1, max_length=80)


def _conversation(row: Any) -> dict[str, str]:
    return {
        "id": row["id"],
        "title": row["title"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


def _message(row: Any) -> dict[str, Any]:
    return {
        "id": row["id"],
        "role": row["role"],
        "content": row["content"],
        "createdAt": row["created_at"],
        "analysis": decode_analysis(row["analysis_json"]),
    }


def _owned_conversation(conversation_id: str, owner_id: str) -> Any:
    with connect() as connection:
        row = connection.execute(
            """
            SELECT id, owner_id, title, created_at, updated_at
            FROM conversations
            WHERE id = ? AND owner_id = ?
            """,
            (conversation_id, owner_id),
        ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Conversation not found.")
    return row


def _owner(request: Request) -> str:
    return request.state.owner_id


def _analysis_or_unavailable(answer: str) -> dict[str, Any]:
    return {
        "claims": [],
        "bias": {
            "detected": False,
            "concerns": [],
            "explanation": "Potential-bias analysis is unavailable; no conclusion was made.",
        },
        "revisedAnswer": None,
        "changeExplanation": None,
        "warnings": ["Evidence and bias analysis could not be completed."],
        "verificationAvailable": False,
    }


async def _respond_to_question(
    conversation_id: str,
    owner_id: str,
    question: str,
    history: list[dict[str, str]],
    *,
    question_id: str | None = None,
) -> dict[str, Any]:
    try:
        original_answer = await generate_answer(history, question)
    except AIServiceError as error:
        raise HTTPException(status_code=error.status_code, detail=str(error)) from None

    warnings: list[str] = []
    try:
        analysis = await analyze_answer(original_answer)
    except Exception as error:
        logger.warning("Answer analysis failed (error type: %s)", type(error).__name__)
        analysis = _analysis_or_unavailable(original_answer)
    if not isinstance(analysis, dict):
        analysis = _analysis_or_unavailable(original_answer)
    analysis.setdefault("claims", [])
    analysis.setdefault(
        "bias",
        {
            "detected": False,
            "concerns": [],
            "explanation": "Potential-bias analysis is unavailable; no conclusion was made.",
        },
    )
    analysis.setdefault("revisedAnswer", None)
    analysis.setdefault("changeExplanation", None)
    analysis.setdefault("warnings", warnings)
    analysis.setdefault("verificationAvailable", False)

    question_id = question_id or str(uuid.uuid4())
    answer_id = str(uuid.uuid4())
    question_created_at = now_iso()
    answer_created_at = now_iso()
    with connect() as connection:
        if question_id:
            existing = connection.execute(
                """
                SELECT id FROM messages
                WHERE id = ? AND conversation_id = ? AND role = 'user'
                """,
                (question_id, conversation_id),
            ).fetchone()
        else:
            existing = None
        if existing is None:
            connection.execute(
                """
                INSERT INTO messages
                    (id, conversation_id, role, content, created_at, question_id, analysis_json)
                VALUES (?, ?, 'user', ?, ?, NULL, NULL)
                """,
                (question_id, conversation_id, question, question_created_at),
            )
        connection.execute(
            """
            INSERT INTO messages
                (id, conversation_id, role, content, created_at, question_id, analysis_json)
            VALUES (?, ?, 'assistant', ?, ?, ?, ?)
            """,
            (
                answer_id,
                conversation_id,
                original_answer,
                answer_created_at,
                question_id,
                encode_analysis(analysis),
            ),
        )
        conversation = connection.execute(
            "SELECT title FROM conversations WHERE id = ? AND owner_id = ?",
            (conversation_id, owner_id),
        ).fetchone()
        title = conversation["title"] if conversation else ""
        if title.strip().lower() in ("new conversation", "new chat"):
            updated_title = " ".join(question.split())[:72] or "New conversation"
            connection.execute(
                "UPDATE conversations SET title = ?, updated_at = ? WHERE id = ? AND owner_id = ?",
                (updated_title, answer_created_at, conversation_id, owner_id),
            )
        else:
            connection.execute(
                "UPDATE conversations SET updated_at = ? WHERE id = ? AND owner_id = ?",
                (answer_created_at, conversation_id, owner_id),
            )
        question_row = connection.execute(
            "SELECT * FROM messages WHERE id = ?", (question_id,)
        ).fetchone()
        answer_row = connection.execute(
            "SELECT * FROM messages WHERE id = ?", (answer_id,)
        ).fetchone()

    return {"question": _message(question_row), "answer": _message(answer_row)}


@app.get("/api/healthz")
async def health_check():
    return {"status": "healthy"}


@app.get("/api/auth/me")
async def auth_me(request: Request):
    return {"authenticated": bool(request.state.user), "user": request.state.user}


@app.post("/api/auth/signup")
async def auth_signup(body: SignUpInput, request: Request, response: Response):
    name = body.name.strip()
    email = body.email.strip().lower()
    if not name:
        raise HTTPException(status_code=422, detail="Please enter your name.")
    if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email):
        raise HTTPException(status_code=422, detail="Enter a valid email address.")
    user_id = str(uuid.uuid4())
    try:
        with connect() as connection:
            connection.execute(
                "INSERT INTO users (id, name, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?)",
                (user_id, name, email, _password_hash(body.password), now_iso()),
            )
    except Exception as error:
        if "UNIQUE constraint failed: users.email" in str(error):
            raise HTTPException(status_code=409, detail="An account with this email already exists. Please log in.") from None
        raise
    _set_login_cookie(response, user_id, request)
    return {"authenticated": True, "user": {"id": user_id, "name": name, "email": email}}


@app.post("/api/auth/login")
async def auth_login(body: LoginInput, request: Request, response: Response):
    email = body.email.strip().lower()
    with connect() as connection:
        user = connection.execute(
            "SELECT id, name, email, password_hash FROM users WHERE email = ? COLLATE NOCASE", (email,)
        ).fetchone()
    if user is None or not _verify_password(body.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="Email or password is incorrect.")
    _set_login_cookie(response, user["id"], request)
    return {"authenticated": True, "user": {"id": user["id"], "name": user["name"], "email": user["email"]}}


@app.post("/api/auth/logout")
async def auth_logout(response: Response):
    response.delete_cookie(key=COOKIE_NAME, path="/", httponly=True, samesite="lax")
    return {"authenticated": False, "user": None}


@app.get("/api/conversations")
async def list_conversations(request: Request):
    with connect() as connection:
        rows = connection.execute(
            """
            SELECT id, owner_id, title, created_at, updated_at
            FROM conversations
            WHERE owner_id = ?
            ORDER BY updated_at DESC
            """,
            (_owner(request),),
        ).fetchall()
    return [_conversation(row) for row in rows]


@app.post("/api/conversations", status_code=201)
async def create_conversation(body: ConversationInput, request: Request):
    owner_id = _owner(request)
    conversation_id = str(uuid.uuid4())
    created = now_iso()
    with connect() as connection:
        connection.execute(
            """
            INSERT INTO conversations (id, owner_id, title, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (conversation_id, owner_id, body.title, created, created),
        )
        row = connection.execute(
            "SELECT * FROM conversations WHERE id = ?", (conversation_id,)
        ).fetchone()
    return _conversation(row)


@app.delete("/api/conversations/history")
async def clear_conversation_history(request: Request):
    with connect() as connection:
        result = connection.execute(
            "DELETE FROM conversations WHERE owner_id = ?", (_owner(request),)
        )
        deleted_count = result.rowcount
    return {"deletedCount": deleted_count}


@app.get("/api/conversations/{conversation_id}")
async def get_conversation(conversation_id: str, request: Request):
    owner_id = _owner(request)
    conversation = _owned_conversation(conversation_id, owner_id)
    with connect() as connection:
        rows = connection.execute(
            """
            SELECT * FROM messages
            WHERE conversation_id = ?
            ORDER BY rowid ASC
            """,
            (conversation_id,),
        ).fetchall()
    return {
        **_conversation(conversation),
        "messages": [_message(row) for row in rows],
    }


@app.patch("/api/conversations/{conversation_id}")
async def rename_conversation(
    conversation_id: str, body: ConversationPatch, request: Request
):
    owner_id = _owner(request)
    _owned_conversation(conversation_id, owner_id)
    updated = now_iso()
    with connect() as connection:
        connection.execute(
            """
            UPDATE conversations SET title = ?, updated_at = ?
            WHERE id = ? AND owner_id = ?
            """,
            (body.title, updated, conversation_id, owner_id),
        )
        row = connection.execute(
            "SELECT * FROM conversations WHERE id = ?", (conversation_id,)
        ).fetchone()
    return _conversation(row)


@app.delete("/api/conversations/{conversation_id}")
async def delete_conversation(conversation_id: str, request: Request):
    owner_id = _owner(request)
    _owned_conversation(conversation_id, owner_id)
    with connect() as connection:
        connection.execute(
            "DELETE FROM conversations WHERE id = ? AND owner_id = ?",
            (conversation_id, owner_id),
        )
    return {"deleted": True}


@app.post("/api/conversations/{conversation_id}/messages")
async def send_message(
    conversation_id: str, body: ChatMessageInput, request: Request
):
    owner_id = _owner(request)
    _owned_conversation(conversation_id, owner_id)
    with connect() as connection:
        rows = connection.execute(
            """
            SELECT role, content FROM messages
            WHERE conversation_id = ?
            ORDER BY rowid DESC LIMIT 12
            """,
            (conversation_id,),
        ).fetchall()
    history = [
        {"role": row["role"], "content": row["content"]}
        for row in reversed(rows)
    ]
    return await _respond_to_question(
        conversation_id, owner_id, body.content, history
    )


@app.post("/api/conversations/{conversation_id}/regenerate")
async def regenerate_answer(
    conversation_id: str, body: RegenerateInput, request: Request
):
    owner_id = _owner(request)
    _owned_conversation(conversation_id, owner_id)
    with connect() as connection:
        question_row = connection.execute(
            """
            SELECT * FROM messages
            WHERE id = ? AND conversation_id = ? AND role = 'user'
            """,
            (body.questionId, conversation_id),
        ).fetchone()
        if question_row is None:
            raise HTTPException(status_code=404, detail="Question not found.")
        history_rows = connection.execute(
            """
            SELECT role, content FROM messages
            WHERE conversation_id = ? AND rowid < (
                SELECT rowid FROM messages WHERE id = ?
            )
            ORDER BY rowid DESC LIMIT 12
            """,
            (conversation_id, body.questionId),
        ).fetchall()
    history = [
        {"role": row["role"], "content": row["content"]}
        for row in reversed(history_rows)
    ]
    return await _respond_to_question(
        conversation_id,
        owner_id,
        question_row["content"],
        history,
        question_id=question_row["id"],
    )


@app.get("/api/dashboard")
async def get_dashboard(request: Request):
    with connect() as connection:
        total_questions = connection.execute(
            """
            SELECT COUNT(*) FROM messages m
            JOIN conversations c ON c.id = m.conversation_id
            WHERE c.owner_id = ? AND m.role = 'user'
            """,
            (_owner(request),),
        ).fetchone()[0]
        answer_rows = connection.execute(
            """
            SELECT m.analysis_json FROM messages m
            JOIN conversations c ON c.id = m.conversation_id
            WHERE c.owner_id = ? AND m.role = 'assistant'
              AND m.analysis_json IS NOT NULL
            """,
            (_owner(request),),
        ).fetchall()

    hallucinations = 0
    bias_issues = 0
    revised_responses = 0
    for row in answer_rows:
        analysis = decode_analysis(row["analysis_json"])
        if not analysis:
            continue
        if any(
            isinstance(claim, dict) and claim.get("status") == "CONTRADICTED"
            for claim in analysis.get("claims", [])
        ):
            hallucinations += 1
        bias = analysis.get("bias")
        if isinstance(bias, dict) and bias.get("detected") is True:
            bias_issues += 1
        if isinstance(analysis.get("revisedAnswer"), str) and analysis["revisedAnswer"]:
            revised_responses += 1
    return {
        "totalQuestions": total_questions,
        "analyzedResponses": len(answer_rows),
        "potentialHallucinations": hallucinations,
        "potentialBiasIssues": bias_issues,
        "revisedResponses": revised_responses,
    }


@app.get("/api/settings")
async def get_settings():
    search_available = await evidence_service_available()
    return {
        "provider": "Google Gemini",
        "model": MODEL,
        "geminiConfigured": gemini_configured(),
        "evidenceSearchProvider": SEARCH_PROVIDER,
        "evidenceSearchAvailable": search_available,
        "requiredEnvironmentVariables": ["GEMINI_API_KEY", "SESSION_SECRET"],
    }
