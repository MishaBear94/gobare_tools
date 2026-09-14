"""Verifying a delivery.

The only thing in this library with no endpoint behind it — nothing in the route
table describes an inbound request — which is exactly why it belongs here rather
than anywhere a generator could reach. It is also the trap with the worst
failure mode: get it wrong and every delivery is rejected, looking identical to
a wrong secret.

Three rules, each of which has its own way of being got wrong:

1. **Verify the raw bytes.** Frameworks hand you a parsed object; parsing and
   re-serialising changes key order and whitespace. A verifier written that way
   passes every test against its own serialiser and fails against ours.
2. **The timestamp is inside the signed material**, as ``{timestamp}.{body}``.
   Beside it rather than inside, a captured delivery stays valid forever.
3. **The timestamp is milliseconds.** Dividing by 1000, which a seconds-shaped
   example invites, rejects every delivery and fails looking exactly like a bad
   signature.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import time
from typing import Any, Callable, Dict, Optional, Union

#: Five minutes. Wide enough for clock skew, narrow enough to bound a replay.
DEFAULT_TOLERANCE_MS = 5 * 60 * 1000


class WebhookVerificationError(Exception):
    pass


def _now_ms() -> float:
    return time.time() * 1000


def unwrap(
    *,
    secret: str,
    body: Union[str, bytes, bytearray],
    signature: str,
    timestamp: Union[str, int, float],
    tolerance_ms: Optional[float] = None,
    now: Optional[Callable[[], float]] = None,
) -> Dict[str, Any]:
    """Verify and parse, or raise saying which rule failed.

    ::

        @app.post("/hooks/gobare")
        async def hook(request: Request):
            event = unwrap(
                secret=os.environ["GOBARE_WEBHOOK_SECRET"],
                body=await request.body(),          # raw bytes, not the parsed model
                signature=request.headers["x-gobare-signature"],
                timestamp=request.headers["x-gobare-timestamp"],
            )
            return Response(status_code=200)        # answer first, work after
    """
    if not isinstance(body, (str, bytes, bytearray)):
        raise WebhookVerificationError(
            "body must be the raw bytes or string, not a parsed object. Parsing and "
            "re-serialising changes key order and whitespace, and the signature will "
            "not match. In FastAPI use await request.body(); in Flask "
            "request.get_data(); in Django request.body."
        )
    if not signature:
        raise WebhookVerificationError("no x-gobare-signature header")
    if timestamp is None or timestamp == "":
        raise WebhookVerificationError("no x-gobare-timestamp header")

    # Signed as the exact digits sent, so the string is used rather than a
    # number converted and converted back — 1789305457283.0 is not what was
    # signed.
    sent = str(timestamp)
    try:
        millis = float(sent)
    except ValueError:
        raise WebhookVerificationError(f"x-gobare-timestamp is not a number: {sent!r}") from None

    tolerance = DEFAULT_TOLERANCE_MS if tolerance_ms is None else tolerance_ms
    current = (now or _now_ms)()
    if tolerance != float("inf") and abs(current - millis) > tolerance:
        drift = round((current - millis) / 1000)
        raise WebhookVerificationError(
            f"x-gobare-timestamp is {abs(drift)}s {'old' if drift > 0 else 'in the future'}, "
            f"past the {round(tolerance / 1000)}s tolerance. The timestamp is in "
            "milliseconds — if you divided it by 1000, that is this error."
        )

    raw = body.encode("utf-8") if isinstance(body, str) else bytes(body)
    expected = hmac.new(secret.encode("utf-8"), sent.encode("ascii") + b"." + raw, hashlib.sha256).hexdigest()

    # compare_digest rather than ==, so a wrong signature cannot be found one
    # character at a time.
    if not hmac.compare_digest(expected, signature):
        raise WebhookVerificationError("signature does not match")

    try:
        return json.loads(raw.decode("utf-8"))
    except ValueError:
        raise WebhookVerificationError("the signature is valid but the body is not JSON") from None


def verify(**kwargs: Any) -> bool:
    """True if this delivery is genuine and recent. Never raises.

    Use :func:`unwrap` unless you have a reason to want a boolean — the reason a
    verification failed is usually the thing you needed to know.
    """
    try:
        unwrap(**kwargs)
        return True
    except WebhookVerificationError:
        return False
