"""The client: generated resources, plus the hand-written parts.

``Resources`` is regenerated wholesale, so nothing may be added to it. This
class is where the two halves meet — it extends the generated tree with the
things ``lib/`` provides, which is the only place the two are allowed to know
about each other.
"""

from __future__ import annotations

import threading
from typing import Any, Callable, Dict, Iterator, Optional

from ._generated.resources import Resources
from ._transport import Transport
from .lib.artifacts import download_archive, download_artifact, wait_for_artifacts
from .lib.events import watch


class Gobare(Resources):
    def __init__(
        self,
        *,
        token: str,
        base_url: Optional[str] = None,
        timeout: Optional[float] = None,
        opener: Any = None,
    ) -> None:
        transport = Transport(token=token, base_url=base_url, timeout=timeout, opener=opener)
        super().__init__(transport)
        self.transport = transport

    @property
    def base_url(self) -> str:
        """Where this client is pointed. Useful in a log line when it is not where you thought."""
        return self.transport.base_url

    def watch(
        self,
        session_id: Optional[str] = None,
        *,
        last_event_id: Optional[int] = None,
        stop: Optional[threading.Event] = None,
        reconnect: bool = True,
        on_reconnect: Optional[Callable[[int, float, Optional[int]], None]] = None,
    ) -> Iterator[Dict[str, Any]]:
        """Watch one session's events, or every session the organization owns.

        ::

            for event in gobare.watch(session["id"]):
                if event["type"] == "turn.ended":
                    break

        **Start this before you send the input you want to watch.** The other
        order drops the opening events whenever the agent starts quickly — which
        is to say, only in production.
        """
        return watch(
            self.transport,
            session_id,
            last_event_id=last_event_id,
            stop=stop,
            reconnect=reconnect,
            on_reconnect=on_reconnect,
        )

    def wait_for_artifacts(
        self,
        session_id: str,
        turn_id: str,
        *,
        timeout_seconds: float = 90.0,
        poll_seconds: float = 1.0,
        stop: Optional[threading.Event] = None,
    ) -> Optional[str]:
        """Block until a turn's files are fetchable. Returns ``ready``, ``partial`` or ``failed``.

        ``completed`` does not mean the files are there; see the note in
        ``lib/artifacts.py``. ``None`` means the turn predates the field and
        cannot say — a third answer rather than a guess, because both guesses
        are wrong.
        """
        return wait_for_artifacts(
            self.transport,
            session_id,
            turn_id,
            timeout_seconds=timeout_seconds,
            poll_seconds=poll_seconds,
            stop=stop,
        )

    def download_artifact(self, session_id: str, artifact_id: str, *, timeout: Optional[float] = None) -> Any:
        """One artifact's bytes, as a live response so you choose whether to buffer it."""
        return download_artifact(self.transport, session_id, artifact_id, timeout=timeout)

    def download_archive(self, session_id: str, *, turn_id: Optional[str] = None, timeout: Optional[float] = None) -> Any:
        """Every artifact as one tar, as a live response."""
        return download_archive(self.transport, session_id, turn_id=turn_id, timeout=timeout)
