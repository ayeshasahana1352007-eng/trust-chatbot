from __future__ import annotations

import asyncio
import json
import sys
from types import SimpleNamespace
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import ai_service
from ai_service import AIServiceError


def run_analysis(monkeypatch, model_analysis, sources, *, available=True, claims=None):
    responses = iter(
        [
            json.dumps({"claims": claims or ["The novel was first published in 1812."]}),
            json.dumps(model_analysis),
        ]
    )

    async def fake_generate(*args, **kwargs):
        return next(responses)

    async def fake_search(_claims):
        return sources, available

    monkeypatch.setattr(ai_service, "_generate", fake_generate)
    monkeypatch.setattr(ai_service, "search_evidence", fake_search)
    return asyncio.run(ai_service.analyze_answer("The novel was first published in 1812."))


def test_claim_without_retrieved_evidence_is_forced_to_insufficient(monkeypatch):
    result = run_analysis(
        monkeypatch,
        {
            "claim_assessments": [
                {
                    "claim_id": "c1",
                    "status": "CONTRADICTED",
                    "explanation": "The model guessed a contradiction.",
                    "evidence_ids": ["c1-e1"],
                }
            ],
            "bias": {"detected": False, "concerns": [], "explanation": "No obvious issue detected."},
            "revised_answer": "A guessed correction.",
            "change_explanation": "No source exists.",
        },
        [],
    )
    assert result["claims"][0]["status"] == "INSUFFICIENT_EVIDENCE"
    assert result["claims"][0]["evidence"] == []
    assert result["revisedAnswer"] is None


def test_contradiction_can_only_cite_a_returned_source(monkeypatch):
    source = {
        "id": "c1-e1",
        "title": "Pride and Prejudice",
        "url": "https://en.wikipedia.org/wiki/Pride_and_Prejudice",
        "excerpt": "It was first published in 1813.",
    }
    result = run_analysis(
        monkeypatch,
        {
            "claim_assessments": [
                {
                    "claim_id": "c1",
                    "status": "CONTRADICTED",
                    "explanation": "The retrieved excerpt states 1813.",
                    "evidence_ids": ["c1-e1", "fabricated-source"],
                }
            ],
            "bias": {"detected": False, "concerns": [], "explanation": "No obvious issue detected."},
            "revised_answer": "It was first published in 1813.",
            "change_explanation": "Corrected the date based on the retrieved evidence.",
        },
        [source],
    )
    claim = result["claims"][0]
    assert claim["status"] == "CONTRADICTED"
    assert [item["url"] for item in claim["evidence"]] == [source["url"]]
    assert result["revisedAnswer"] == "It was first published in 1813."


def test_bias_quotes_must_appear_in_the_original_answer(monkeypatch):
    answer = "Group X is less capable."
    responses = iter(
        [
            json.dumps({"claims": []}),
            json.dumps(
                {
                    "claim_assessments": [],
                    "bias": {
                        "detected": True,
                        "concerns": [
                            {
                                "text": answer,
                                "type": "Unfair generalization",
                                "explanation": "It makes a blanket statement about a group.",
                            },
                            {
                                "text": "A sentence that was never written.",
                                "type": "Invented quote",
                                "explanation": "This quote is not in the answer.",
                            },
                        ],
                        "explanation": "The answer makes a broad group-level claim.",
                    },
                    "revised_answer": "Capabilities vary between individuals.",
                    "change_explanation": "Removed the unsupported generalization.",
                }
            ),
        ]
    )

    async def fake_generate(*args, **kwargs):
        return next(responses)

    async def no_evidence(_claims):
        return [], True

    monkeypatch.setattr(ai_service, "_generate", fake_generate)
    monkeypatch.setattr(ai_service, "search_evidence", no_evidence)
    result = asyncio.run(ai_service.analyze_answer(answer))
    assert result["bias"]["detected"] is True
    assert len(result["bias"]["concerns"]) == 1
    assert result["bias"]["concerns"][0]["text"] == answer
    assert result["revisedAnswer"] == "Capabilities vary between individuals."


def test_unavailable_search_never_marks_claim_supported(monkeypatch):
    result = run_analysis(
        monkeypatch,
        {
            "claim_assessments": [
                {
                    "claim_id": "c1",
                    "status": "SUPPORTED",
                    "explanation": "The model has prior knowledge.",
                    "evidence_ids": [],
                }
            ],
            "bias": {"detected": False, "concerns": [], "explanation": "No obvious issue detected."},
            "revised_answer": None,
            "change_explanation": None,
        },
        [],
        available=False,
    )
    assert result["verificationAvailable"] is False
    assert result["claims"][0]["status"] == "INSUFFICIENT_EVIDENCE"


def test_gemini_request_uses_configured_model_and_json_mode(monkeypatch):
    captured = {}

    class FakeModels:
        def generate_content(self, **kwargs):
            captured.update(kwargs)
            return SimpleNamespace(text='{"claims":[]}')

    monkeypatch.setattr(
        ai_service, "_get_client", lambda: SimpleNamespace(models=FakeModels())
    )
    result = asyncio.run(
        ai_service._generate(
            "Check this response.",
            system_instruction="Return JSON only.",
            json_response=True,
        )
    )

    assert result == '{"claims":[]}'
    assert captured["model"] == "gemini-3.8-flash"
    assert captured["contents"] == "Check this response."
    assert captured["config"].system_instruction == "Return JSON only."
    assert captured["config"].response_mime_type == "application/json"
    assert captured["config"].max_output_tokens == 8192


def test_gemini_client_reads_only_the_configured_secret_and_sets_timeout(monkeypatch):
    client_args = {}

    class FakeClient:
        def __init__(self, **kwargs):
            client_args.update(kwargs)

    monkeypatch.setenv("GEMINI_API_KEY", "test-secret-value")
    monkeypatch.setattr(ai_service.genai, "Client", FakeClient)
    monkeypatch.setattr(ai_service, "_client", None)
    monkeypatch.setattr(ai_service, "_client_key", None)

    client = ai_service._get_client()

    assert isinstance(client, FakeClient)
    assert client_args["api_key"] == "test-secret-value"
    options = client_args["http_options"]
    assert options.timeout == 12_000
    assert options.retry_options.attempts == 2
    assert options.retry_options.http_status_codes == [408, 500, 502, 503, 504]


class FakeProviderError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.status_code = code
        self.message = message


@pytest.mark.parametrize(
    ("code", "provider_message", "expected"),
    [
        (401, "Invalid API key", "rejected the API key"),
        (400, "API key not valid", "rejected the configured API key"),
        (429, "Quota exceeded", "rate-limited"),
        (404, "Model not found", "model is unavailable"),
        (503, "This model is currently experiencing high demand", "temporarily overloaded (HTTP 503)"),
        (504, "Deadline expired before operation could complete", "deadline expired (HTTP 504)"),
    ],
)
def test_gemini_provider_errors_are_reported_without_raw_provider_details(
    code, provider_message, expected
):
    result = ai_service._provider_error(FakeProviderError(code, provider_message))

    assert isinstance(result, AIServiceError)
    assert expected in str(result)
    assert provider_message not in str(result)
    assert "test-secret-value" not in str(result)


def test_gemini_network_and_timeout_errors_are_actionable():
    timed_out = ai_service._provider_error(httpx.ReadTimeout("provider timeout"))
    unreachable = ai_service._provider_error(httpx.ConnectError("connection refused"))

    assert "timed out" in str(timed_out)
    assert "Could not reach Gemini" in str(unreachable)


def test_gemini_empty_or_malformed_response_is_not_returned(monkeypatch):
    class FakeModels:
        def generate_content(self, **_kwargs):
            return SimpleNamespace(text=None)

    monkeypatch.setattr(
        ai_service, "_get_client", lambda: SimpleNamespace(models=FakeModels())
    )

    with pytest.raises(AIServiceError, match="empty or malformed"):
        asyncio.run(
            ai_service._generate("Question", system_instruction="Answer honestly.")
        )


def install_fake_wikipedia(monkeypatch, *, payload=None, error=None):
    requests = []
    client_options = []

    class FakeResponse:
        status_code = 200

        def json(self):
            return payload

        def raise_for_status(self):
            if error:
                raise error

    class FakeAsyncClient:
        def __init__(self, **kwargs):
            client_options.append(kwargs)

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def get(self, url, *, params):
            requests.append({"url": url, "params": params})
            return FakeResponse()

    monkeypatch.setattr(ai_service.httpx, "AsyncClient", FakeAsyncClient)
    return requests, client_options


def test_wikipedia_search_uses_documented_endpoint_and_identified_user_agent(
    monkeypatch,
):
    requests, client_options = install_fake_wikipedia(
        monkeypatch,
        payload={
            "pages": [
                {
                    "key": "Jane_Austen",
                    "title": "Jane Austen",
                    "excerpt": '<span class="searchmatch">English novelist</span>',
                }
            ]
        },
    )

    sources, available = asyncio.run(
        ai_service.search_evidence(["Jane Austen was an English novelist"])
    )

    assert available is True
    assert sources == [
        {
            "id": "c1-e1",
            "title": "Jane Austen",
            "url": "https://en.wikipedia.org/wiki/Jane_Austen",
            "excerpt": "English novelist",
        }
    ]
    assert requests == [
        {
            "url": "https://en.wikipedia.org/w/rest.php/v1/search/page",
            "params": {"q": "Jane Austen was an English novelist", "limit": 2},
        }
    ]
    assert client_options[0]["headers"]["User-Agent"] == ai_service.WIKIMEDIA_USER_AGENT
    assert client_options[0]["headers"]["Api-User-Agent"] == ai_service.WIKIMEDIA_USER_AGENT


def test_wikipedia_status_check_uses_valid_search_parameters(monkeypatch):
    requests, client_options = install_fake_wikipedia(monkeypatch, payload={"pages": []})

    available = asyncio.run(ai_service.evidence_service_available())

    assert available is True
    assert requests == [
        {
            "url": "https://en.wikipedia.org/w/rest.php/v1/search/page",
            "params": {"q": "Wikimedia", "limit": 1},
        }
    ]
    assert client_options[0]["headers"]["Api-User-Agent"] == ai_service.WIKIMEDIA_USER_AGENT


@pytest.mark.parametrize(
    "failure",
    [
        httpx.HTTPStatusError(
            "blocked",
            request=httpx.Request("GET", "https://en.wikipedia.org/w/rest.php/v1/search/page"),
            response=httpx.Response(
                403,
                request=httpx.Request(
                    "GET", "https://en.wikipedia.org/w/rest.php/v1/search/page"
                ),
            ),
        ),
        None,
    ],
)
def test_wikipedia_search_failure_or_malformed_payload_is_unavailable(
    monkeypatch, failure
):
    payload = {"unexpected": []} if failure is None else None
    install_fake_wikipedia(monkeypatch, payload=payload, error=failure)

    sources, available = asyncio.run(ai_service.search_evidence(["A factual claim"]))

    assert sources == []
    assert available is False
