"""The event stream, as a generator that survives a dropped connection.

Hand-written because a generated method cannot be right here: the response is
``text/event-stream``, and a client built from a document that once said
``application/json`` would have parsed a connection held open for the life of a
session.

── What this file knows that the endpoint description cannot ──

1. **No cursor and cursor ``0`` are different requests.** No cursor is live
   frames only, which is what "subscribe before you send" needs. ``0`` is
   everything, because zero is a real cursor — it is the one ``cursor = 0``
   starts with. A client that normalised the two would either replay a
   session's whole history on every subscribe, or lose a first connection's
   backlog. Both look like the API misbehaving.

2. **Only persisted events advance the cursor.** Transient frames — text
   deltas, thinking, progress — carry ``seq: null``. Advancing on one would
   produce a cursor naming a row that was never written, and the resume after
   it would ask for history that does not exist.

3. **Reconnecting has to honour the server's own ``retry:`` hint.** It is
   deliberately longer than the time it takes the proxy to notice a connection
   has gone. A client reconnecting faster, at its stream ceiling, is refused
   for a stream it has already closed.
"""

from __future__ import annotations

import json
import threading
import urllib.parse
from typing import Any, Callable, Dict, Iterable, Iterator, Optional

DEFAULT_RETRY_SECONDS = 2.0


class _Frame:
    __slots__ = ("id", "event", "data", "retry")

    def __init__(self) -> None:
        self.id: Optional[str] = None
        self.event: Optional[str] = None
        self.data: str = ""
        self.retry: Optional[float] = None


def _frames(lines: Iterable[bytes]) -> Iterator[_Frame]:
    """Parse an SSE byte stream into frames.

    Written out rather than taken from a library because the whole thing is a
    dozen lines of state machine, and the failure mode of getting it slightly
    wrong — a frame split across two chunks — only appears under load.

    Iterating the response yields whole lines however the bytes arrived, so the
    chunk boundary problem is handled by the file object; what is left is
    accumulating lines until the blank one that ends a frame.
    """
    frame = _Frame()
    data: list[str] = []
    for raw in lines:
        line = raw.decode("utf-8", "replace").rstrip("\n").rstrip("\r")
        if line == "":
            frame.data = "\n".join(data)
            if frame.data or frame.retry is not None:
                yield frame
            frame = _Frame()
            data = []
            continue
        # ": ping" every fifteen seconds. Not a frame.
        if line.startswith(":"):
            continue
        head, _, rest = line.partition(":")
        value = rest[1:] if rest.startswith(" ") else rest
        if head == "data":
            data.append(value)
        elif head == "id":
            frame.id = value
        elif head == "event":
            frame.event = value
        elif head == "retry":
            try:
                frame.retry = float(value)
            except ValueError:
                pass
    # A stream that ends without a trailing blank line still has a frame in it.
    if data:
        frame.data = "\n".join(data)
        yield frame


def watch(
    transport: Any,
    session_id: Optional[str] = None,
    *,
    last_event_id: Optional[int] = None,
    stop: Optional[threading.Event] = None,
    reconnect: bool = True,
    on_reconnect: Optional[Callable[[int, float, Optional[int]], None]] = None,
) -> Iterator[Dict[str, Any]]:
    """Watch a session's events, or the whole organization's when ``session_id`` is None.

    ::

        for event in gobare.watch(session.id):
            if event["type"] == "turn.ended":
                break

    Breaking out of the loop closes the generator, which closes the connection
    and frees the stream slot.
    """
    path = "/events" if session_id is None else f"/sessions/{urllib.parse.quote(session_id, safe='')}/events"
    # None and 0 are kept apart all the way down. A truthiness check here would
    # turn "everything" into "live only" and lose a first connection's whole
    # backlog.
    cursor: Optional[int] = last_event_id
    retry_seconds = DEFAULT_RETRY_SECONDS
    attempt = 0

    while True:
        if stop is not None and stop.is_set():
            return

        response = transport.open(
            "GET",
            path,
            query=None if cursor is None else {"last_event_id": cursor},
            headers={"accept": "text/event-stream"},
            # The stream is held open deliberately; the request timeout that
            # suits a JSON call would close it every minute and make the
            # reconnect path the normal path.
            timeout=None if transport.timeout is None else max(transport.timeout, 600.0),
        )
        attempt = 0

        try:
            for frame in _frames(response):
                if frame.retry is not None:
                    retry_seconds = frame.retry / 1000.0
                if not frame.data:
                    continue

                try:
                    event = json.loads(frame.data)
                except ValueError:
                    # A frame we cannot read is skipped rather than fatal: the
                    # stream is an allowlist that grows, and one unparseable
                    # frame is not a reason to drop a session's whole feed.
                    continue

                # Only a persisted event carries an "id:" line, and only a
                # persisted event may move the cursor. Advancing on a transient
                # frame would name a row that was never written.
                if frame.id:
                    try:
                        cursor = int(frame.id)
                    except ValueError:
                        pass

                yield event
        except Exception:
            if stop is not None and stop.is_set():
                return
            if not reconnect:
                raise
        finally:
            # Close rather than merely drop it. An unread body is a live socket;
            # this is also what runs when the caller breaks out of the loop.
            try:
                response.close()
            except Exception:  # noqa: BLE001 — closing must not mask the reason we are here
                pass

        if not reconnect or (stop is not None and stop.is_set()):
            return

        attempt += 1
        if on_reconnect is not None:
            on_reconnect(attempt, retry_seconds, cursor)
        # `Event.wait` rather than `sleep`, so a caller that sets `stop` during
        # the pause is not made to wait it out.
        if stop is not None:
            if stop.wait(retry_seconds):
                return
        else:
            threading.Event().wait(retry_seconds)
