"""The hand-written half.

The mirror of `sdk/ts/src/lib/lib.test.ts`. Each test names a property the
generated layer cannot have, and the two clients must hold the same ones — a
Python caller and a TypeScript caller reconnecting to the same stream must end
up at the same cursor.
"""

from __future__ import annotations

import hashlib
import hmac
import io
import json
import sys
import threading
import unittest
import urllib.error
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from gobare import (  # noqa: E402
    ArtifactsNotReadyError,
    GobareNotFoundError,
    WebhookVerificationError,
    unwrap_webhook,
    verify_webhook,
    wait_for_artifacts,
    watch,
)
from gobare.lib.artifacts import download_artifact  # noqa: E402

SECRET = "whsec_test_1234"


class StreamTransport:
    """A transport whose `open` replays scripted SSE bodies."""

    timeout = 60.0

    def __init__(self, *bodies: bytes, stop_after: int | None = None, stop: threading.Event | None = None) -> None:
        self.bodies = list(bodies)
        self.opened: list[dict[str, object]] = []
        # Ends the watch after N connections. Counting opens rather than
        # reconnect attempts, because `attempt` resets on every successful
        # connect — it counts consecutive failures, so it is always 1 here.
        self.stop_after = stop_after
        self.stop = stop

    def open(self, method: str, path: str, *, query=None, headers=None, timeout=None):  # noqa: ANN001
        self.opened.append({"path": path, "query": query, "timeout": timeout})
        if self.stop is not None and self.stop_after is not None and len(self.opened) >= self.stop_after:
            self.stop.set()
        # An exhausted script answers with an empty stream rather than raising:
        # a raise here would be an error opening, which is deliberately not the
        # reconnect path, and the test would be measuring the wrong thing.
        return io.BytesIO(self.bodies.pop(0) if self.bodies else b"")


class EventsTest(unittest.TestCase):
    def test_no_cursor_and_cursor_zero_are_different_requests(self) -> None:
        # Zero is a real cursor — the one `cursor = 0` starts with. Folding the
        # two would either replay a whole session on every subscribe or lose a
        # first connection's backlog.
        transport = StreamTransport(b"")
        list(watch(transport, "s1", reconnect=False))
        self.assertIsNone(transport.opened[0]["query"])

        transport = StreamTransport(b"")
        list(watch(transport, "s1", last_event_id=0, reconnect=False))
        self.assertEqual(transport.opened[0]["query"], {"last_event_id": 0})

    def test_a_transient_frame_does_not_advance_the_resume_cursor(self) -> None:
        # A frame with no `id:` was never written down; resuming from it would
        # ask for history that does not exist.
        body = (
            b"id: 10\ndata: " + json.dumps({"type": "agent.message", "seq": 10}).encode() + b"\n\n"
            b"data: " + json.dumps({"type": "agent.text", "seq": None}).encode() + b"\n\n"
        )
        transport = StreamTransport(body, b"")
        seen = []
        for index, event in enumerate(watch(transport, "s1", on_reconnect=lambda *_: None)):
            seen.append(event["type"])
            if index == 1:
                break
        self.assertEqual(seen, ["agent.message", "agent.text"])

        # Reconnect and read where it asked to resume from: the durable frame's
        # id, not the transient frame that followed it.
        stop = threading.Event()
        # `retry:` first, so the reconnect pause is 10ms rather than the default
        # two seconds — the wait is real, and a test should not sit through it.
        transport = StreamTransport(b"retry: 10\n\n" + body, stop_after=2, stop=stop)
        for _ in watch(transport, "s1", stop=stop):
            pass
        self.assertEqual(transport.opened[1]["query"], {"last_event_id": 10})

    def test_a_frame_split_across_two_chunks_is_still_one_frame(self) -> None:
        # The failure that only shows up under load.
        payload = json.dumps({"type": "agent.message", "seq": 1, "payload": {"text": "hello"}})
        transport = StreamTransport(f"id: 1\ndata: {payload}\n\n".encode())
        events = list(watch(transport, "s1", reconnect=False))
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["payload"]["text"], "hello")

    def test_keep_alive_comments_and_unparseable_frames_do_not_end_the_stream(self) -> None:
        body = (
            b": ping\n\n"
            b"data: {not json\n\n"
            b"id: 4\ndata: " + json.dumps({"type": "turn.ended", "seq": 4}).encode() + b"\n\n"
        )
        transport = StreamTransport(body)
        events = list(watch(transport, "s1", reconnect=False))
        self.assertEqual([e["type"] for e in events], ["turn.ended"])

    def test_the_servers_retry_hint_replaces_the_default(self) -> None:
        # Reconnecting faster than the server asked, at the stream ceiling, is
        # refused for a stream the client has already closed.
        stop = threading.Event()
        transport = StreamTransport(b"retry: 50\n\n", stop_after=2, stop=stop)
        waits: list[float] = []
        for _ in watch(transport, "s1", stop=stop, on_reconnect=lambda a, wait, c: waits.append(wait)):
            pass
        self.assertEqual(waits[0], 0.05)

    def test_the_organization_stream_is_a_different_path(self) -> None:
        transport = StreamTransport(b"")
        list(watch(transport, None, reconnect=False))
        self.assertEqual(transport.opened[0]["path"], "/events")


class WebhookTest(unittest.TestCase):
    def sign(self, timestamp: int, body: bytes) -> str:
        return hmac.new(SECRET.encode(), f"{timestamp}.".encode() + body, hashlib.sha256).hexdigest()

    def test_a_genuine_delivery_verifies_and_one_changed_byte_does_not(self) -> None:
        body = json.dumps({"object": "event", "type": "turn.completed"}).encode()
        now = 1_789_000_000_000
        signature = self.sign(now, body)
        event = unwrap_webhook(secret=SECRET, body=body, signature=signature, timestamp=now, now=lambda: now)
        self.assertEqual(event["type"], "turn.completed")

        with self.assertRaises(WebhookVerificationError):
            unwrap_webhook(secret=SECRET, body=body + b" ", signature=signature, timestamp=now, now=lambda: now)

    def test_passing_a_parsed_object_is_refused_with_the_fix_named(self) -> None:
        now = 1_789_000_000_000
        with self.assertRaises(WebhookVerificationError) as caught:
            unwrap_webhook(secret=SECRET, body={"type": "turn.completed"}, signature="x", timestamp=now, now=lambda: now)  # type: ignore[arg-type]
        message = str(caught.exception)
        self.assertIn("raw bytes", message)
        for framework in ("FastAPI", "Flask", "Django"):
            self.assertIn(framework, message)

    def test_seconds_instead_of_milliseconds_is_named_as_the_cause(self) -> None:
        # The mistake a seconds-shaped example invites. It fails looking exactly
        # like a bad signature, so the message has to say so.
        body = b"{}"
        now = 1_789_000_000_000
        seconds = now // 1000
        with self.assertRaises(WebhookVerificationError) as caught:
            unwrap_webhook(secret=SECRET, body=body, signature=self.sign(seconds, body), timestamp=seconds, now=lambda: now)
        self.assertIn("milliseconds", str(caught.exception))

    def test_an_old_delivery_is_rejected_even_with_a_valid_signature(self) -> None:
        body = b"{}"
        sent = 1_789_000_000_000
        with self.assertRaises(WebhookVerificationError) as caught:
            unwrap_webhook(secret=SECRET, body=body, signature=self.sign(sent, body), timestamp=sent, now=lambda: sent + 10 * 60 * 1000)
        self.assertIn("old", str(caught.exception))

    def test_a_signature_of_the_wrong_length_does_not_raise_out_of_compare(self) -> None:
        body = b"{}"
        now = 1_789_000_000_000
        self.assertFalse(verify_webhook(secret=SECRET, body=body, signature="abc", timestamp=now, now=lambda: now))

    def test_a_valid_signature_over_a_body_that_is_not_json_says_which_half_failed(self) -> None:
        body = b"not json at all"
        now = 1_789_000_000_000
        with self.assertRaises(WebhookVerificationError) as caught:
            unwrap_webhook(secret=SECRET, body=body, signature=self.sign(now, body), timestamp=now, now=lambda: now)
        self.assertIn("not JSON", str(caught.exception))


class FakeTurns:
    """A transport that answers `GET /turns/{id}` from a script."""

    timeout = 60.0

    def __init__(self, *turns: dict) -> None:
        self.turns = list(turns)
        self.reads = 0

    def request(self, method: str, path: str, **kwargs: object) -> dict:
        self.reads += 1
        return self.turns.pop(0) if len(self.turns) > 1 else self.turns[0]


class ArtifactsTest(unittest.TestCase):
    def test_waiting_stops_at_ready_and_at_partial_rather_than_reading_it_as_success(self) -> None:
        transport = FakeTurns({"status": "completed", "artifacts": "pending"}, {"status": "completed", "artifacts": "ready"})
        self.assertEqual(wait_for_artifacts(transport, "s1", "t1", poll_seconds=0.001), "ready")

        # `partial` is returned rather than raised: the turn did publish, and
        # treating it as failure would throw away files that are there.
        transport = FakeTurns({"status": "completed", "artifacts": "partial"})
        self.assertEqual(wait_for_artifacts(transport, "s1", "t1", poll_seconds=0.001), "partial")

    def test_a_turn_from_before_the_field_existed_does_not_spin_to_the_timeout(self) -> None:
        # Both guesses are wrong — `ready` would promise files nobody checked,
        # `failed` would condemn a turn that very likely published fine.
        transport = FakeTurns({"status": "completed"})
        self.assertIsNone(wait_for_artifacts(transport, "s1", "t1", timeout_seconds=5, poll_seconds=0.001))
        self.assertEqual(transport.reads, 1)

    def test_a_turn_stuck_on_pending_times_out_and_says_what_it_was_reporting(self) -> None:
        transport = FakeTurns({"status": "working", "artifacts": "pending"})
        with self.assertRaises(ArtifactsNotReadyError) as caught:
            wait_for_artifacts(transport, "s1", "t1", timeout_seconds=0.01, poll_seconds=0.005)
        self.assertEqual(caught.exception.state, "pending")
        self.assertIn("pending", str(caught.exception))

    def test_downloading_bytes_does_not_parse_them_as_json(self) -> None:
        class Bytes:
            timeout = 60.0

            def open(self, method: str, path: str, **kwargs: object):  # noqa: ANN001
                return io.BytesIO(b"\x89PNG\r\n\x1a\n not json")

        response = download_artifact(Bytes(), "s1", "art_1")
        self.assertTrue(response.read().startswith(b"\x89PNG"))

    def test_a_refused_download_still_raises_a_typed_error(self) -> None:
        # A refusal *is* JSON even though a success is not, so the error path
        # parses and the success path deliberately does not.
        class Refuses:
            timeout = 60.0

            def open(self, method: str, path: str, **kwargs: object):  # noqa: ANN001
                from gobare.lib.errors import error_from

                raise error_from(404, "Not Found", {}, {"error": {"code": "not_found", "message": "gone"}}, "")

        with self.assertRaises(GobareNotFoundError):
            download_artifact(Refuses(), "s1", "art_1")


if __name__ == "__main__":
    unittest.main()
