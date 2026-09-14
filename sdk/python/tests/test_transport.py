"""The transport, and the error classes it builds.

The mirror of `sdk/ts/src/transport.test.ts`. Every test here exists because the
TypeScript client has one for the same property: two clients that agree on the
happy path and disagree on a refusal are not two clients for the same API.
"""

from __future__ import annotations

import io
import json
import sys
import unittest
import urllib.error
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from gobare import (  # noqa: E402
    Gobare,
    GobareAuthenticationError,
    GobareConnectionError,
    GobareError,
    GobareProjectLimitError,
    GobareRateLimitError,
    GobareServerError,
    Transport,
)


class FakeResponse(io.BytesIO):
    def __init__(self, body: bytes, headers: dict[str, str] | None = None) -> None:
        super().__init__(body)
        self.headers = headers or {}

    def __enter__(self) -> "FakeResponse":
        return self

    def __exit__(self, *args: object) -> None:
        self.close()


class FakeOpener:
    """Records what was asked, answers with what the test set."""

    def __init__(self, answer: object = None) -> None:
        self.answer = answer if answer is not None else FakeResponse(b'{"ok":true}')
        self.calls: list[dict[str, object]] = []

    def open(self, request: object, timeout: float | None = None) -> object:
        self.calls.append(
            {
                "url": request.full_url,  # type: ignore[attr-defined]
                "method": request.get_method(),  # type: ignore[attr-defined]
                "headers": {k.lower(): v for k, v in request.header_items()},  # type: ignore[attr-defined]
                "body": request.data,  # type: ignore[attr-defined]
                "timeout": timeout,
            }
        )
        answer = self.answer() if callable(self.answer) else self.answer
        if isinstance(answer, BaseException):
            raise answer
        return answer


def http_error(status: int, body: object, headers: dict[str, str] | None = None, reason: str = "Error") -> urllib.error.HTTPError:
    raw = body if isinstance(body, (bytes, str)) else json.dumps(body)
    raw = raw.encode() if isinstance(raw, str) else raw
    import email.message

    message = email.message.Message()
    for name, value in (headers or {}).items():
        message[name] = value
    return urllib.error.HTTPError("https://api.gobare.dev/v1/x", status, reason, message, io.BytesIO(raw))


def client(answer: object = None) -> tuple[Gobare, FakeOpener]:
    opener = FakeOpener(answer)
    return Gobare(token="gbr_pat_test", opener=opener), opener


class TransportTest(unittest.TestCase):
    def test_a_token_is_required_and_the_message_says_where_to_get_one(self) -> None:
        with self.assertRaises(ValueError) as caught:
            Transport(token="")
        self.assertIn("Console", str(caught.exception))

    def test_a_trailing_slash_does_not_become_a_double_slash(self) -> None:
        transport = Transport(token="t", base_url="https://api.gobare.dev/")
        self.assertEqual(transport.url("/sessions"), "https://api.gobare.dev/v1/sessions")

    def test_the_two_429s_are_different_classes(self) -> None:
        # The property this library exists for: both are 429, and a retry helper
        # that treats them alike spins forever on the second.
        gobare, _ = client(http_error(429, {"error": {"code": "rate_limit_exceeded", "message": "slow down"}}, {"retry-after": "7"}))
        with self.assertRaises(GobareRateLimitError) as rate:
            gobare.health.retrieve()
        self.assertTrue(rate.exception.retryable)
        self.assertEqual(rate.exception.retry_after_seconds, 7)

        gobare, _ = client(http_error(429, {"error": {"code": "project_limit_exceeded", "message": "5 of 5"}}))
        with self.assertRaises(GobareProjectLimitError) as limit:
            gobare.health.retrieve()
        self.assertFalse(limit.exception.retryable)
        self.assertNotIsInstance(limit.exception, GobareRateLimitError)

    def test_the_request_id_survives_from_the_body_or_the_header(self) -> None:
        gobare, _ = client(http_error(400, {"error": {"code": "invalid_request", "message": "no", "request_id": "req_body"}}))
        with self.assertRaises(GobareError) as from_body:
            gobare.health.retrieve()
        self.assertEqual(from_body.exception.request_id, "req_body")

        gobare, _ = client(http_error(500, "<html>gateway</html>", {"x-request-id": "req_header"}))
        with self.assertRaises(GobareServerError) as from_header:
            gobare.health.retrieve()
        self.assertEqual(from_header.exception.request_id, "req_header")
        # The proxy's own words, not a generic sentence: they are the only clue
        # to which hop refused.
        self.assertIn("gateway", str(from_header.exception))

    def test_an_unrecognised_code_still_lands_on_the_right_side_of_retryable(self) -> None:
        gobare, _ = client(http_error(503, {"error": {"code": "something_new", "message": "later"}}))
        with self.assertRaises(GobareServerError) as caught:
            gobare.health.retrieve()
        self.assertTrue(caught.exception.retryable)

    def test_no_response_at_all_is_not_a_server_error(self) -> None:
        gobare, _ = client(OSError("connection refused"))
        with self.assertRaises(GobareConnectionError) as caught:
            gobare.health.retrieve()
        self.assertTrue(caught.exception.retryable)
        self.assertIn("did not get a response", str(caught.exception))

    def test_401_is_its_own_class(self) -> None:
        gobare, _ = client(http_error(401, {"error": {"code": "authentication_error", "message": "bad token"}}))
        with self.assertRaises(GobareAuthenticationError):
            gobare.health.retrieve()

    def test_rate_limit_headers_are_read_when_present(self) -> None:
        gobare, _ = client(
            http_error(
                429,
                {"error": {"code": "rate_limit_exceeded", "message": "slow"}},
                {"x-ratelimit-limit": "60", "x-ratelimit-remaining": "0", "x-ratelimit-reset": "30", "x-ratelimit-resource": "sessions"},
            )
        )
        with self.assertRaises(GobareRateLimitError) as caught:
            gobare.health.retrieve()
        snapshot = caught.exception.rate_limit
        assert snapshot is not None
        # Which bucket, not just that there is one: the same token holds two.
        self.assertEqual(snapshot.resource, "sessions")
        self.assertEqual((snapshot.limit, snapshot.remaining, snapshot.reset_seconds), (60, 0, 30))

    def test_path_parameters_are_encoded_and_absent_query_is_not_sent(self) -> None:
        gobare, opener = client(FakeResponse(b'{"object":"list","data":[]}'))
        gobare.sessions.turns.list("a/b?c")
        url = opener.calls[0]["url"]
        self.assertIn("a%2Fb%3Fc", str(url))
        self.assertNotIn("?", str(url).split("/v1/")[1])

    def test_query_values_that_are_none_are_dropped(self) -> None:
        gobare, opener = client(FakeResponse(b'{"object":"list","data":[]}'))
        gobare.sessions.turns.list("s1", query={"limit": 5, "order": None})
        url = str(opener.calls[0]["url"])
        self.assertIn("limit=5", url)
        self.assertNotIn("order", url)

    def test_an_idempotency_key_rides_on_the_request_and_only_when_given(self) -> None:
        gobare, opener = client(FakeResponse(b'{"object":"session","id":"s1"}'))
        gobare.sessions.create({"agent": {"model": "m"}}, idempotency_key="job-8842")
        self.assertEqual(opener.calls[0]["headers"]["idempotency-key"], "job-8842")

        gobare, opener = client(FakeResponse(b'{"object":"session","id":"s1"}'))
        gobare.sessions.create({"agent": {"model": "m"}})
        self.assertNotIn("idempotency-key", opener.calls[0]["headers"])

    def test_a_body_is_sent_as_json_and_a_read_carries_no_content_type(self) -> None:
        gobare, opener = client(FakeResponse(b'{"object":"session","id":"s1"}'))
        gobare.sessions.create({"agent": {"model": "MiniMax-M3"}})
        write = opener.calls[0]
        self.assertEqual(write["headers"]["content-type"], "application/json")
        self.assertEqual(json.loads(write["body"]), {"agent": {"model": "MiniMax-M3"}})

        gobare, opener = client(FakeResponse(b'{"object":"health"}'))
        gobare.health.retrieve()
        self.assertNotIn("content-type", opener.calls[0]["headers"])

    def test_an_empty_body_is_not_a_json_parse_error(self) -> None:
        # A 204-shaped answer, and a proxy answering with HTML. Neither should
        # surface as a decoder error the caller cannot act on.
        gobare, _ = client(FakeResponse(b""))
        self.assertIsNone(gobare.health.retrieve())

    def test_the_resource_tree_is_the_shape_the_documentation_promises(self) -> None:
        gobare, _ = client()
        # The verb comes from the response schema, not the path: anything answering
        # a …List is , everything else reading is . That is why
        # model_connectors is  — it answers a catalog object.
        for path in ("sessions.create", "sessions.turns.list", "sessions.items.list", "sessions.artifacts.retrieve",
                     "sessions.artifacts.delete", "sessions.files.retrieve", "sessions.files.content.retrieve",
                     "sessions.files.refresh.create", "sessions.fork.create", "sessions.preview.create",
                     "sessions.tools.replace", "webhooks.create", "agents.create", "model_credentials.list",
                     "model_connectors.retrieve", "environment_profiles.list", "health.retrieve"):
            cursor: object = gobare
            for part in path.split("."):
                self.assertTrue(hasattr(cursor, part), f"client.{path} is missing at {part}")
                cursor = getattr(cursor, part)
            self.assertTrue(callable(cursor), f"client.{path} is not callable")

    def test_the_streaming_endpoints_are_absent_from_the_generated_tree(self) -> None:
        # They are hand-written; a generated method would parse an event stream
        # as JSON. `sessions.events` exists for the POST, and must not have a
        # `retrieve`.
        gobare, _ = client()
        self.assertFalse(hasattr(gobare.sessions.events, "retrieve"))
        self.assertFalse(hasattr(gobare.sessions.artifacts, "archive"))


if __name__ == "__main__":
    unittest.main()
