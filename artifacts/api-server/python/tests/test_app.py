from __future__ import annotations

import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import main
from ai_service import AIServiceError


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("SESSION_SECRET", "test-session-secret")
    monkeypatch.setenv("RESPONSIBLE_AI_DB_PATH", str(tmp_path / "test.sqlite3"))
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    with TestClient(main.app) as test_client:
        yield test_client


def install_pipeline(
    monkeypatch,
    *,
    answer: str = "A sample answer.",
    analysis: dict | None = None,
) -> None:
    async def fake_generate_answer(history, question):
        return answer

    async def fake_analyze_answer(_answer):
        return analysis or {
            "claims": [],
            "bias": {
                "detected": False,
                "concerns": [],
                "explanation": "No obvious issue detected by automated analysis.",
            },
            "revisedAnswer": None,
            "changeExplanation": None,
            "warnings": [],
            "verificationAvailable": True,
        }

    monkeypatch.setattr(main, "generate_answer", fake_generate_answer)
    monkeypatch.setattr(main, "analyze_answer", fake_analyze_answer)


def create_conversation(client: TestClient) -> str:
    response = client.post(
        "/api/conversations", json={"title": "New conversation"}
    )
    assert response.status_code == 201
    return response.json()["id"]


def ask(client: TestClient, conversation_id: str, content: str = "A normal question?"):
    return client.post(
        f"/api/conversations/{conversation_id}/messages",
        json={"content": content},
    )


def test_normal_question_returns_real_pipeline_shape(client, monkeypatch):
    install_pipeline(
        monkeypatch,
        answer="The answer is clear.",
        analysis={
            "claims": [],
            "bias": {
                "detected": False,
                "concerns": [],
                "explanation": "No obvious issue detected by automated analysis.",
            },
            "revisedAnswer": None,
            "changeExplanation": None,
            "warnings": [],
            "verificationAvailable": True,
        },
    )
    result = ask(client, create_conversation(client)).json()
    assert result["question"]["role"] == "user"
    assert result["answer"]["content"] == "The answer is clear."
    assert result["answer"]["analysis"]["claims"] == []
    assert result["answer"]["analysis"]["verificationAvailable"] is True


def test_unsupported_claim_is_not_called_a_hallucination(client, monkeypatch):
    install_pipeline(
        monkeypatch,
        analysis={
            "claims": [
                {
                    "claim": "A difficult-to-verify statement.",
                    "status": "INSUFFICIENT_EVIDENCE",
                    "explanation": "No relevant source established this claim.",
                    "evidence": [],
                }
            ],
            "bias": {
                "detected": False,
                "concerns": [],
                "explanation": "No obvious issue detected.",
            },
            "revisedAnswer": None,
            "changeExplanation": None,
            "warnings": [],
            "verificationAvailable": True,
        },
    )
    response = ask(client, create_conversation(client)).json()
    claim = response["answer"]["analysis"]["claims"][0]
    assert claim["status"] == "INSUFFICIENT_EVIDENCE"
    assert claim["evidence"] == []


def test_contradicted_claim_has_inspectable_evidence(client, monkeypatch):
    evidence = {
        "title": "A real reference title",
        "url": "https://en.wikipedia.org/wiki/Example",
        "excerpt": "An excerpt returned by the evidence service.",
    }
    install_pipeline(
        monkeypatch,
        analysis={
            "claims": [
                {
                    "claim": "A contradicted statement.",
                    "status": "CONTRADICTED",
                    "explanation": "The retrieved evidence conflicts with this claim.",
                    "evidence": [evidence],
                }
            ],
            "bias": {
                "detected": False,
                "concerns": [],
                "explanation": "No obvious issue detected.",
            },
            "revisedAnswer": "A corrected answer.",
            "changeExplanation": "The change follows the supplied evidence.",
            "warnings": [],
            "verificationAvailable": True,
        },
    )
    response = ask(client, create_conversation(client)).json()
    analysis = response["answer"]["analysis"]
    assert analysis["claims"][0]["status"] == "CONTRADICTED"
    assert analysis["claims"][0]["evidence"][0]["url"] == evidence["url"]
    assert analysis["revisedAnswer"] == "A corrected answer."


def test_insufficient_evidence_stays_distinct_from_contradiction(client, monkeypatch):
    install_pipeline(
        monkeypatch,
        analysis={
            "claims": [
                {
                    "claim": "An uncertain statement.",
                    "status": "INSUFFICIENT_EVIDENCE",
                    "explanation": "Retrieved material was inconclusive.",
                    "evidence": [],
                }
            ],
            "bias": {
                "detected": False,
                "concerns": [],
                "explanation": "No obvious issue detected.",
            },
            "revisedAnswer": None,
            "changeExplanation": None,
            "warnings": [],
            "verificationAvailable": True,
        },
    )
    response = ask(client, create_conversation(client)).json()
    assert response["answer"]["analysis"]["claims"][0]["status"] == "INSUFFICIENT_EVIDENCE"
    assert response["answer"]["analysis"]["revisedAnswer"] is None


def test_bias_finding_can_produce_a_revised_answer(client, monkeypatch):
    install_pipeline(
        monkeypatch,
        answer="People in group X are naturally worse at this task.",
        analysis={
            "claims": [],
            "bias": {
                "detected": True,
                "concerns": [
                    {
                        "text": "People in group X are naturally worse at this task.",
                        "type": "Unfair generalization",
                        "explanation": "It attributes a trait to an entire social group.",
                    }
                ],
                "explanation": "The wording makes an unsupported group-level generalization.",
            },
            "revisedAnswer": "Performance varies among individuals and contexts.",
            "changeExplanation": "Removed the unsupported group-level generalization.",
            "warnings": [],
            "verificationAvailable": True,
        },
    )
    response = ask(client, create_conversation(client)).json()
    analysis = response["answer"]["analysis"]
    assert analysis["bias"]["detected"] is True
    assert analysis["bias"]["concerns"][0]["text"] in response["answer"]["content"]
    assert analysis["revisedAnswer"] == "Performance varies among individuals and contexts."


def test_fair_answer_is_not_rewritten(client, monkeypatch):
    install_pipeline(
        monkeypatch,
        answer="People have different preferences and experiences.",
    )
    response = ask(client, create_conversation(client)).json()
    analysis = response["answer"]["analysis"]
    assert analysis["bias"]["detected"] is False
    assert analysis["revisedAnswer"] is None


def test_model_failure_is_reported_without_a_fabricated_answer(client, monkeypatch):
    async def failed_generate(_history, _question):
        raise AIServiceError(
            "Gemini is temporarily overloaded (HTTP 503). "
            "No answer was returned. Retry shortly."
        )

    monkeypatch.setattr(main, "generate_answer", failed_generate)
    conversation_id = create_conversation(client)
    response = ask(client, conversation_id)
    assert response.status_code == 503
    assert "temporarily overloaded (HTTP 503)" in response.json()["detail"]
    assert "No answer was returned" in response.json()["detail"]

    conversation = client.get(f"/api/conversations/{conversation_id}")
    assert conversation.status_code == 200
    assert conversation.json()["messages"] == []


def test_conversation_data_survives_a_new_client_session(client, monkeypatch):
    install_pipeline(monkeypatch, answer="This answer is stored.")
    conversation_id = create_conversation(client)
    result = ask(client, conversation_id, "Remember this question?")
    assert result.status_code == 200
    cookie = client.cookies.get(main.COOKIE_NAME)
    assert cookie
    with TestClient(main.app, cookies={main.COOKIE_NAME: cookie}) as reopened_client:
        reopened = reopened_client.get(f"/api/conversations/{conversation_id}")
    assert reopened.status_code == 200
    assert reopened.json()["messages"][1]["content"] == "This answer is stored."


def test_session_cannot_access_another_sessions_conversations(client, monkeypatch):
    install_pipeline(monkeypatch)
    conversation_id = create_conversation(client)
    other_session = TestClient(main.app)
    with other_session:
        response = other_session.get(f"/api/conversations/{conversation_id}")
    assert response.status_code == 404


def test_dashboard_counts_only_saved_analysis_records(client, monkeypatch):
    install_pipeline(
        monkeypatch,
        analysis={
            "claims": [
                {
                    "claim": "A source-backed contradiction.",
                    "status": "CONTRADICTED",
                    "explanation": "The evidence conflicts with the statement.",
                    "evidence": [
                        {
                            "title": "A real reference",
                            "url": "https://en.wikipedia.org/wiki/Example",
                            "excerpt": "A retrieved excerpt.",
                        }
                    ],
                }
            ],
            "bias": {
                "detected": True,
                "concerns": [{"text": "quoted words", "type": "generalization", "explanation": "test"}],
                "explanation": "Potential concern.",
            },
            "revisedAnswer": "A revised answer.",
            "changeExplanation": "A test revision.",
            "warnings": [],
            "verificationAvailable": True,
        },
    )
    conversation_id = create_conversation(client)
    assert ask(client, conversation_id).status_code == 200
    dashboard = client.get("/api/dashboard").json()
    assert dashboard == {
        "totalQuestions": 1,
        "analyzedResponses": 1,
        "potentialHallucinations": 1,
        "potentialBiasIssues": 1,
        "revisedResponses": 1,
    }
