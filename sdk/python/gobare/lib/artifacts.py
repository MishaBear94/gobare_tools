"""Getting the bytes out, and knowing when there are bytes to get.

Two of these are hand-written because they do not answer with JSON: an
artifact's content carries the artifact's own recorded type, and the archive is
a tar. The third is hand-written because it is not an endpoint at all — it is
the state machine that stands between "the turn finished" and "the files are
fetchable", and getting it wrong is the single most reported way to see an empty
artifact list.
"""

from __future__ import annotations

import threading
import time
import urllib.parse
from typing import Any, Optional

from .errors import GobareError


class ArtifactsNotReadyError(GobareError):
    def __init__(self, turn_id: str, state: Optional[str], waited_seconds: float) -> None:
        super().__init__(
            status=0,
            code="unknown",
            message=f"turn {turn_id} still reports artifacts={state} after {round(waited_seconds)}s",
            request_id=None,
            rate_limit=None,
        )
        self.state = state


def wait_for_artifacts(
    transport: Any,
    session_id: str,
    turn_id: str,
    *,
    timeout_seconds: float = 90.0,
    poll_seconds: float = 1.0,
    stop: Optional[threading.Event] = None,
) -> Optional[str]:
    """Block until a turn's files are fetchable, and say which way it ended.

    ::

        state = gobare.wait_for_artifacts(session_id, turn_id)
        if state == "partial":
            # Some files were left behind. `turn["artifacts_skipped"]` says
            # which and why.

    **``completed`` does not mean the files are there.** Publication runs after
    settlement so a storage problem cannot fail a turn that did good work, which
    means there is a window where ``GET /artifacts`` answers with an empty list —
    indistinguishable from a turn that produced nothing. Every caller has to wait
    for this, so it lives here rather than in every caller.

    Returns ``ready``, ``partial`` or ``failed``; raises only on timeout.
    ``partial`` is returned rather than raised because the turn did publish —
    silently treating it as success is what the separate value exists to
    prevent, and treating it as failure would throw away files that are there.

    Returns **None** for a settled turn that reports no state at all: one from
    before the field existed. That is a third answer rather than a guess,
    because both guesses are wrong — ``ready`` would promise files nobody
    checked, and ``failed`` would condemn a turn that very likely published
    fine.
    """
    deadline = time.monotonic() + timeout_seconds
    last: Optional[str] = None

    while True:
        turn = transport.request(
            "GET",
            f"/sessions/{urllib.parse.quote(session_id, safe='')}/turns/{urllib.parse.quote(turn_id, safe='')}",
        )
        last = turn.get("artifacts")

        if last is not None and last != "pending":
            return last

        # A settled turn reporting no state at all predates the field, and will
        # never report one — so waiting is waiting for something that cannot
        # arrive.
        settled = turn.get("status") in ("completed", "failed", "cancelled")
        if last is None and settled:
            return None
        if turn.get("status") in ("failed", "cancelled"):
            return last or "failed"

        if time.monotonic() + poll_seconds > deadline:
            raise ArtifactsNotReadyError(turn_id, last, timeout_seconds)
        if stop is not None and stop.wait(poll_seconds):
            return last
        if stop is None:
            time.sleep(poll_seconds)


def download_artifact(transport: Any, session_id: str, artifact_id: str, *, timeout: Optional[float] = None) -> Any:
    """Download one artifact's bytes.

    Returns the live response so the caller chooses what to do with a file that
    may be 200 MiB: iterate it to disk, or ``.read()`` a small one. Buffering it
    here would make the largest legal artifact an out-of-memory error inside the
    library.
    """
    return transport.open(
        "GET",
        f"/sessions/{urllib.parse.quote(session_id, safe='')}/artifacts/{urllib.parse.quote(artifact_id, safe='')}/content",
        timeout=timeout,
    )


def download_archive(
    transport: Any,
    session_id: str,
    *,
    turn_id: Optional[str] = None,
    timeout: Optional[float] = None,
) -> Any:
    """Download every artifact as one tar.

    Without ``turn_id`` each entry is prefixed with the turn that published it,
    because the same path published by two turns is two files and a flat archive
    would extract as one — silently the last.

    An artifact whose stored copy is gone is omitted and named in a
    ``gobare-omitted.txt`` entry inside the archive. Look for it: the status line
    went out with the first byte, so that file is the only place the omission can
    be reported.
    """
    return transport.open(
        "GET",
        f"/sessions/{urllib.parse.quote(session_id, safe='')}/artifacts/archive",
        query=None if turn_id is None else {"turn_id": turn_id},
        timeout=timeout,
    )
