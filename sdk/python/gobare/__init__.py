"""The Gobare Agent API client.

::

    from gobare import Gobare

    gobare = Gobare(token=os.environ["GOBARE_TOKEN"])
    session = gobare.sessions.create({"agent": {"model": "MiniMax-M3"}, "input": "…"})

── What is generated and what is not ──

``_generated/resources.py`` holds the operations that answer with JSON. It is
rewritten from the server's own route table on every build and must never be
edited by hand.

``lib/`` is hand-written and the generator never touches it. Each file there
exists because of something a generated client cannot know: that two 429s mean
opposite things, that an event stream is not JSON, that ``completed`` does not
mean the artifacts are fetchable, and that a webhook signature covers the raw
bytes.
"""

from ._client import Gobare
from ._transport import DEFAULT_BASE_URL, DEFAULT_TIMEOUT_SECONDS, Transport
from .lib.artifacts import ArtifactsNotReadyError, download_archive, download_artifact, wait_for_artifacts
from .lib.errors import (
    GobareAuthenticationError,
    GobareConflictError,
    GobareConnectionError,
    GobareError,
    GobareInvalidRequestError,
    GobareNotFoundError,
    GobarePermissionError,
    GobareProjectLimitError,
    GobareQueueFullError,
    GobareRateLimitError,
    GobareServerError,
    RateLimitSnapshot,
)
from .lib.events import watch

# Renamed on the way out. `verify` and `unwrap` are clear inside
# `lib/webhooks.py` and say nothing at the top level of a package that also
# talks about sessions, tokens and artifacts.
from .lib.webhooks import DEFAULT_TOLERANCE_MS as WEBHOOK_TOLERANCE_MS
from .lib.webhooks import WebhookVerificationError
from .lib.webhooks import unwrap as unwrap_webhook
from .lib.webhooks import verify as verify_webhook

__all__ = [
    "Gobare",
    "Transport",
    "DEFAULT_BASE_URL",
    "DEFAULT_TIMEOUT_SECONDS",
    "GobareError",
    "GobareAuthenticationError",
    "GobarePermissionError",
    "GobareNotFoundError",
    "GobareInvalidRequestError",
    "GobareConflictError",
    "GobareRateLimitError",
    "GobareProjectLimitError",
    "GobareQueueFullError",
    "GobareServerError",
    "GobareConnectionError",
    "RateLimitSnapshot",
    "watch",
    "wait_for_artifacts",
    "download_artifact",
    "download_archive",
    "ArtifactsNotReadyError",
    "verify_webhook",
    "unwrap_webhook",
    "WebhookVerificationError",
    "WEBHOOK_TOLERANCE_MS",
]

__version__ = "0.1.0"
