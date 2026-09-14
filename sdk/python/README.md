# gobare

The official Python client for the Gobare Agent API.

```python
from gobare import Gobare

gobare = Gobare(token=os.environ["GOBARE_TOKEN"])

session = gobare.sessions.create({
    "agent": {"model": "MiniMax-M3"},
    "input": "Write /workspace/outputs/hello.txt and tell me when it is there.",
})
```

**Version 0.1.0, and the `0.` is load-bearing.** `/v1` is still making breaking
changes, so this package makes the semver promise that matches: anything can
change until 1.0.

## No dependencies

`urllib`, `hmac` and `json` are enough for everything here, including the event
stream. A client for an API is not a reason to pull a dependency into someone's
service.

## What is generated and what is not

`_generated/resources.py` is written from the server's **own route table** by
`scripts/sdk/generate-py.ts`, and `sdk/python/drift.test.ts` regenerates it and
fails on any difference. It is never edited by hand.

`lib/` is hand-written, and the generator never touches it. Each file there
exists because of something a generated client cannot know:

| File | What it knows |
| --- | --- |
| `errors.py` | `rate_limit_exceeded` is worth retrying and `project_limit_exceeded` never is, though both are `429` |
| `events.py` | the stream is not JSON; no cursor and cursor `0` are different requests; only persisted frames move the cursor |
| `artifacts.py` | `completed` does not mean the files are fetchable |
| `webhooks.py` | the signature covers the **raw bytes**, and the timestamp is in milliseconds |

## Waiting for files

```python
state = gobare.wait_for_artifacts(session["id"], turn["id"])
if state == "partial":
    ...  # some files were left behind; turn["artifacts_skipped"] says which
```

`completed` does not mean the artifacts are there — publication runs after the
turn settles, so there is a window where the list is legitimately empty and
indistinguishable from a turn that produced nothing.

## Watching a session

```python
for event in gobare.watch(session["id"]):
    if event["type"] == "agent.text":
        print(event["payload"]["delta"], end="", flush=True)
    elif event["type"] == "turn.ended":
        break
```

Start the watch **before** you send the input you want to watch. The other order
drops the opening events whenever the agent starts quickly — which is to say,
only in production.

Breaking out of the loop closes the connection and frees the stream slot. A
dropped connection reconnects from the last persisted event, so nothing durable
is missed; transient frames sent while disconnected are gone, which is what
"treat them as decoration" means in practice.

## Verifying a webhook

```python
from gobare import unwrap_webhook

event = unwrap_webhook(
    secret=os.environ["GOBARE_WEBHOOK_SECRET"],
    body=await request.body(),                       # raw bytes, not the parsed model
    signature=request.headers["x-gobare-signature"],
    timestamp=request.headers["x-gobare-timestamp"],
)
```

Passing a parsed object is refused rather than serialised: parsing and
re-serialising changes key order and whitespace, and a verifier written that way
passes every test against its own serialiser and fails against ours.

## Errors

```python
from gobare import GobareProjectLimitError, GobareRateLimitError

try:
    gobare.sessions.create({"agent": {"model": "MiniMax-M3"}})
except GobareRateLimitError as error:
    time.sleep(error.retry_after_seconds or 1)       # this one is worth retrying
except GobareProjectLimitError:
    ...                                              # this one never is
```

Every error carries `status`, `code`, `request_id` and `retryable`.
