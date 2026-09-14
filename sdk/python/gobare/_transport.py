"""One HTTP call, and the rules every call obeys.

Hand-written and small on purpose. The generated resources know paths, methods
and types; everything a caller can get wrong that is *not* specific to one
endpoint lives here, once.

── Why the standard library ──

``urllib`` rather than ``requests`` or ``httpx``, so installing this client
installs nothing else. The TypeScript client uses ``fetch`` for the same reason:
it is what the runtime already has. The cost is that the opener is built by
hand, which is thirty lines; the benefit is that a client for an API is not a
reason to take a dependency into someone's service.

── Why synchronous ──

TypeScript has no choice about being async. Python does, and a synchronous
client is what the calls here actually are — one request, one answer. The two
streaming helpers in ``lib/`` are generators, which is how Python expresses the
same thing an async iterator expresses there.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Mapping, Optional

from .lib.errors import GobareConnectionError, error_from

DEFAULT_BASE_URL = "https://api.gobare.dev"
#: Long enough for a cold sandbox to answer, short enough to fail rather than hang.
DEFAULT_TIMEOUT_SECONDS = 60.0


class Transport:
    def __init__(
        self,
        *,
        token: str,
        base_url: Optional[str] = None,
        timeout: Optional[float] = None,
        opener: Optional[urllib.request.OpenerDirector] = None,
    ) -> None:
        if not token:
            raise ValueError("A token is required. Mint one in the Console under Build.")
        self._token = token
        # Trailing slash removed once here rather than guarded at every call
        # site; "https://api.gobare.dev/" + "/v1/sessions" is a path that 404s
        # in a way that reads like the endpoint does not exist.
        self.base_url = (base_url or DEFAULT_BASE_URL).rstrip("/")
        self.timeout = DEFAULT_TIMEOUT_SECONDS if timeout is None else timeout
        #: Public because ``lib/`` needs it: the streaming helpers must use the
        #: same opener, or an injected one is honoured by every generated
        #: operation and silently ignored by the hand-written ones.
        self.opener = opener or urllib.request.build_opener()

    def headers(self, extra: Optional[Mapping[str, str]] = None) -> dict[str, str]:
        """The headers every request carries, exposed so ``lib/`` streams match."""
        headers = {"authorization": f"Bearer {self._token}"}
        headers.update(extra or {})
        return headers

    def url(self, path: str, query: Optional[Mapping[str, Any]] = None) -> str:
        url = f"{self.base_url}/v1{path}"
        pairs = []
        for name, value in (query or {}).items():
            # None means "not asked for". Sending it as the string "None" is
            # refused by the API, which reads to the caller as a bug in the
            # value they passed rather than in the passing of it.
            if value is None:
                continue
            if isinstance(value, bool):
                value = "true" if value else "false"
            pairs.append((name, str(value)))
        if pairs:
            url = f"{url}?{urllib.parse.urlencode(pairs)}"
        return url

    def open(
        self,
        method: str,
        path: str,
        *,
        query: Optional[Mapping[str, Any]] = None,
        headers: Optional[Mapping[str, str]] = None,
        timeout: Optional[float] = None,
    ) -> Any:
        """Make the call and hand back the live response, unread.

        Used by ``lib/`` for the four endpoints that do not answer with JSON: an
        event stream that must be read frame by frame, and bytes a caller may
        want to spool to disk rather than into memory.
        """
        url = self.url(path, query)
        request = urllib.request.Request(url, method=method, headers=self.headers(headers))
        try:
            return self.opener.open(request, timeout=self.timeout if timeout is None else timeout)
        except urllib.error.HTTPError as failure:
            raw = failure.read().decode("utf-8", "replace")
            raise _from_http_error(failure, raw) from None
        except Exception as cause:  # noqa: BLE001 — see GobareConnectionError
            # A DNS failure, a refused connection, a timeout. Separated from
            # every HTTP status because the answer is different: there is no
            # request id to quote and no error code to branch on, and treating
            # it as a 500 sends callers looking for a server-side cause that
            # does not exist.
            raise GobareConnectionError(method, url, cause) from cause

    def request(
        self,
        method: str,
        path: str,
        *,
        body: Any = None,
        query: Optional[Mapping[str, Any]] = None,
        idempotency_key: Optional[str] = None,
        timeout: Optional[float] = None,
        headers: Optional[Mapping[str, str]] = None,
    ) -> Any:
        extra: dict[str, str] = {}
        if body is not None:
            extra["content-type"] = "application/json"
        if idempotency_key:
            extra["idempotency-key"] = idempotency_key
        extra.update(headers or {})

        url = self.url(path, query)
        data = None if body is None else json.dumps(body).encode("utf-8")
        request = urllib.request.Request(url, data=data, method=method, headers=self.headers(extra))

        try:
            with self.opener.open(request, timeout=self.timeout if timeout is None else timeout) as response:
                raw = response.read().decode("utf-8", "replace")
                return _parse(raw)
        except urllib.error.HTTPError as failure:
            raw = failure.read().decode("utf-8", "replace")
            raise _from_http_error(failure, raw) from None
        except Exception as cause:  # noqa: BLE001
            raise GobareConnectionError(method, url, cause) from cause


def _parse(raw: str) -> Any:
    """Parsed leniently.

    A proxy between us and you can answer with HTML, and a JSONDecodeError is a
    worse thing to hand someone than the status and the first line of what
    actually came back.
    """
    if not raw:
        return None
    try:
        return json.loads(raw)
    except ValueError:
        return None


def _from_http_error(failure: urllib.error.HTTPError, raw: str) -> Exception:
    headers = {key: value for key, value in failure.headers.items()}
    return error_from(failure.code, failure.reason or "", headers, _parse(raw), raw)
