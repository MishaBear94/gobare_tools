"""Refusals, as classes you can branch on.

Hand-written, and the first of the four files in ``lib/``. The generated
resources know what each endpoint returns; none of them can know that two
refusals sharing a status call for opposite responses.

── The distinction this file exists for ──

``429`` is two different things::

    rate_limit_exceeded      wait for Retry-After, then the retry succeeds
    project_limit_exceeded   **retrying never succeeds.** Delete a session,
                             or ask for a higher ceiling.

A client that treats every 429 alike — which is what every retry helper does by
default — spins forever on the second one, at full rate, forever. The published
documentation says this in prose; prose is not something an ``except`` block can
read.
"""

from __future__ import annotations

from typing import Any, Literal, Mapping, Optional, Type, Union

GobareErrorCode = Literal[
    "invalid_request",
    "authentication_error",
    "permission_denied",
    "not_found",
    "method_not_allowed",
    "conflict",
    "queue_full",
    "rate_limit_exceeded",
    "project_limit_exceeded",
    "context_length_exceeded",
    "provider_error",
    "provider_unauthorized",
    "sandbox_error",
    "sandbox_unavailable",
    "directory_unavailable",
    "workspace_recovery_failed",
    "bridge_incompatible",
    "internal_error",
]


class RateLimitSnapshot:
    """What a ``/v1`` response says is left in the caller's budget."""

    __slots__ = ("limit", "remaining", "reset_seconds", "resource")

    def __init__(self, limit: int, remaining: int, reset_seconds: int, resource: str) -> None:
        self.limit = limit
        self.remaining = remaining
        #: Whole seconds until this bucket is full again.
        self.reset_seconds = reset_seconds
        #: **Which** bucket. The same token holds two, with different numbers.
        self.resource = resource

    def __repr__(self) -> str:
        return f"RateLimitSnapshot(resource={self.resource!r}, remaining={self.remaining}, reset_seconds={self.reset_seconds})"


class GobareError(Exception):
    def __init__(
        self,
        *,
        status: int,
        code: Union[GobareErrorCode, str],
        message: str,
        request_id: Optional[str] = None,
        rate_limit: Optional[RateLimitSnapshot] = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        #: Quote this when reporting a problem. Also on ``x-request-id``.
        self.request_id = request_id
        self.rate_limit = rate_limit

    @property
    def retryable(self) -> bool:
        """Whether trying the same call again could ever work.

        The one question a retry wrapper needs answered, and the one it gets
        wrong from the status alone.
        """
        return False

    def __repr__(self) -> str:
        return f"{type(self).__name__}(status={self.status}, code={self.code!r}, request_id={self.request_id!r})"


class GobareAuthenticationError(GobareError):
    pass


class GobarePermissionError(GobareError):
    pass


class GobareNotFoundError(GobareError):
    pass


class GobareInvalidRequestError(GobareError):
    pass


class GobareConflictError(GobareError):
    pass


class GobareRateLimitError(GobareError):
    """Retrying works, once you have waited."""

    def __init__(self, *, retry_after_seconds: Optional[float] = None, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        #: From ``Retry-After``. Seconds. None only if the header was absent.
        self.retry_after_seconds = retry_after_seconds

    @property
    def retryable(self) -> bool:
        return True


class GobareProjectLimitError(GobareError):
    """Retrying does **not** work. The organization is at its ceiling.

    Deliberately not a subclass of :class:`GobareRateLimitError` even though
    both are 429: an ``except GobareRateLimitError: retry()`` that caught this
    one would be the exact infinite loop this file exists to prevent.
    """

    @property
    def retryable(self) -> bool:
        return False


class GobareQueueFullError(GobareError):
    """The queue for a busy session is full. Retryable once the turn moves on."""

    @property
    def retryable(self) -> bool:
        return True


class GobareServerError(GobareError):
    """5xx, and the transient sandbox conditions."""

    @property
    def retryable(self) -> bool:
        return True


class GobareConnectionError(Exception):
    """No HTTP answer at all: DNS, refused connection, abort, timeout."""

    def __init__(self, method: str, url: str, cause: BaseException) -> None:
        super().__init__(f"{method} {url} did not get a response: {cause}")
        self.__cause__ = cause

    @property
    def retryable(self) -> bool:
        return True


_BY_CODE: Mapping[str, Type[GobareError]] = {
    "authentication_error": GobareAuthenticationError,
    "permission_denied": GobarePermissionError,
    "not_found": GobareNotFoundError,
    "invalid_request": GobareInvalidRequestError,
    "conflict": GobareConflictError,
    "project_limit_exceeded": GobareProjectLimitError,
    "queue_full": GobareQueueFullError,
    "provider_error": GobareServerError,
    "sandbox_error": GobareServerError,
    "sandbox_unavailable": GobareServerError,
    "directory_unavailable": GobareServerError,
    "workspace_recovery_failed": GobareServerError,
    "internal_error": GobareServerError,
}


def _header(headers: Mapping[str, str], name: str) -> Optional[str]:
    """Case-insensitive lookup, because header casing is not ours to rely on."""
    for key, value in headers.items():
        if key.lower() == name:
            return value
    return None


def _read_rate_limit(headers: Mapping[str, str]) -> Optional[RateLimitSnapshot]:
    limit = _header(headers, "x-ratelimit-limit")
    remaining = _header(headers, "x-ratelimit-remaining")
    if limit is None or remaining is None:
        return None
    reset = _header(headers, "x-ratelimit-reset") or "0"
    return RateLimitSnapshot(
        limit=int(float(limit)),
        remaining=int(float(remaining)),
        reset_seconds=int(float(reset)),
        resource=_header(headers, "x-ratelimit-resource") or "general",
    )


def error_from(status: int, reason: str, headers: Mapping[str, str], parsed: Any, raw: str) -> GobareError:
    """Build the right class from a refusal."""
    envelope = parsed.get("error") if isinstance(parsed, dict) else None
    envelope = envelope if isinstance(envelope, dict) else {}
    code = envelope.get("code") or "unknown"
    request_id = envelope.get("request_id") or _header(headers, "x-request-id")
    rate_limit = _read_rate_limit(headers)

    # Falls back to the raw text rather than to a generic sentence: when the
    # envelope is missing it is usually a proxy answering, and its own words are
    # the only clue to which hop refused.
    message = envelope.get("message")
    if not message:
        message = f"{status} {reason}: {raw[:200]}" if raw else f"{status} {reason}"

    base: dict[str, Any] = {
        "status": status,
        "code": code,
        "message": message,
        "request_id": request_id,
        "rate_limit": rate_limit,
    }

    if code == "rate_limit_exceeded":
        header = _header(headers, "retry-after")
        return GobareRateLimitError(retry_after_seconds=None if header is None else float(header), **base)

    specific = _BY_CODE.get(code)
    if specific is not None:
        return specific(**base)
    # Status is the fallback, not the primary key: a code we do not know yet
    # still lands in the right half of retryable-versus-not.
    if status >= 500:
        return GobareServerError(**base)
    return GobareError(**base)
