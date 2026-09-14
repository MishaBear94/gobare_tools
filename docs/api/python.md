# Python client

> Published from the Gobare product repository. The canonical page is
> <https://docs.gobare.dev/python/> — read it there; this copy is for offline and for tooling.

Everything on the other pages is a `curl`, because the API is the product and
`curl` is the shortest way to see it work. This page is for after that: when you
are putting it in a service and would rather import the five guards below than
re-read the warnings that describe them.

```bash
pip install "gobare @ git+https://github.com/MishaBear94/gobare_tools#subdirectory=sdk/python"
```

**Not on PyPI yet** — `/v1` is still making breaking changes, so the package is
published to an index when the surface settles rather than before. It is on
GitHub now, which is what the line above installs, and it is the same code:
the public repository is a mirror of the one the API is built in.

```python
import os
from gobare import Gobare

gobare = Gobare(token=os.environ["GOBARE_TOKEN"])

session = gobare.sessions.create({
    "agent": {"model": "MiniMax-M3"},
    "input": "Write /workspace/outputs/hello.txt saying hello, then tell me you did.",
})

for event in gobare.watch(session["id"]):
    if event["type"] == "turn.ended":
        break
```

**Version 0.1.0, and the `0.` is deliberate.** `/v1` is still making breaking
changes — see the [changelog](changelog.md) — so the package makes the semver
promise that matches. Pin it.

## No dependencies

`urllib`, `hmac` and `json` are enough for everything here, including the event
stream. A client for an API is not a reason to pull a dependency into someone's
service, and a guard fails the build if one ever appears.

## Synchronous, on purpose

The calls here are one request and one answer, which is what a synchronous
function is. The two streaming helpers are generators, which is how Python says
what an async iterator says in TypeScript — you write `for event in …`, and
breaking out of the loop closes the connection and frees the stream slot.

## The same client, twice

This and the [TypeScript client](typescript.md) are generated from the **same
route table the server matches against**, by two emitters that share one
exclusion list. A test regenerates both and fails on any difference, and a
second test fails if an operation reaches one client and not the other — so
"the SDK" is one thing in two languages rather than two libraries that drift.

Five operations are hand-written in both, each because a generated method would
be wrong about it: the two event streams, the artifact archive, an artifact's
raw bytes, and — the one with no endpoint at all — verifying a webhook.

## The five things it does that a curl does not

### 1. The two 429s are different classes

```python
from gobare import GobareProjectLimitError, GobareRateLimitError

try:
    gobare.sessions.create({"agent": {"model": "MiniMax-M3"}})
except GobareRateLimitError as error:
    time.sleep(error.retry_after_seconds or 1)      # the retry will succeed
except GobareProjectLimitError:
    delete_oldest_session()                         # retrying never succeeds
```

`GobareProjectLimitError` is **not** a subclass of `GobareRateLimitError`, so an
`except GobareRateLimitError: retry()` cannot catch it by accident. That accident
is an infinite loop at full rate. See [limits.md](limits.md).

Every error carries `status`, `code`, `request_id` and `retryable`; an
authenticated call also carries `rate_limit` with the bucket's name, so the
`general` and `sessions` numbers cannot be confused for each other. Something
that never reached us raises `GobareConnectionError` instead — no request id to
quote, nothing server-side to investigate.

### 2. The event stream resumes on its own

```python
for event in gobare.watch(session["id"]):
    if event["type"] == "agent.text":
        print(event["payload"]["delta"], end="", flush=True)
```

A dropped connection reconnects from the last **persisted** event. Transient
frames — text deltas, thinking — carry `seq: null` and never advance the cursor,
because a cursor that named one would ask for a row that was never written.

Omitting `last_event_id` means live frames only, which is what "subscribe before
you send" needs; passing `0` means everything. They are different requests and
the client keeps them apart. See [events.md](events.md).

Note `payload["delta"]` above, not `payload["text"]` — the settled
`agent.message` carries `text`, the streaming `agent.text` carries `delta`.

### 3. `completed` does not mean the files are there

```python
state = gobare.wait_for_artifacts(session["id"], turn["id"])
if state == "partial":
    ...  # turn["artifacts_skipped"] says which files, and why

with gobare.download_artifact(session["id"], artifact_id) as body:
    with open("out.csv", "wb") as out:
        shutil.copyfileobj(body, out)
```

Publication runs after settlement, so there is a window where the artifact list
is empty and indistinguishable from a turn that produced nothing.
`wait_for_artifacts` is that wait, once, rather than in every caller.

It returns `ready`, `partial`, `failed`, or `None` for a turn from before the
field existed — a fourth answer rather than a guess, because both guesses are
wrong. Downloads hand back the live response rather than bytes, so a 200 MiB
artifact streams instead of becoming a MemoryError inside the library.

### 4. Webhook verification, with the raw-body trap closed

```python
from gobare import unwrap_webhook

@app.post("/hooks/gobare")
async def hook(request: Request):
    event = unwrap_webhook(
        secret=os.environ["GOBARE_WEBHOOK_SECRET"],
        body=await request.body(),                   # raw bytes, not the parsed model
        signature=request.headers["x-gobare-signature"],
        timestamp=request.headers["x-gobare-timestamp"],
    )
    return Response(status_code=200)                 # answer first, work afterwards
```

Passing a parsed object is **refused rather than serialised**, and the refusal
names the fix for FastAPI, Flask and Django — because serialising it for you
would reproduce, silently and on our side, the exact bug that makes every
delivery fail. A seconds-shaped timestamp is diagnosed by name instead of
arriving as "signature does not match", which is the same afternoon saved.

See [webhooks.md](webhooks.md).

### 5. Idempotency keys are a first-class argument

```python
gobare.sessions.create({...}, idempotency_key=f"job-{job_id}")
```

A key that identifies the *work*, not the attempt. A fresh uuid per try is the
same as sending none. See [idempotency.md](idempotency.md).

## Without the library

Every guide under [guides](guides/README.md) is a complete program using nothing
but the standard library, for the same reason this page exists: you should be
able to see the whole loop before you take a dependency on anything, including
ours.

Take the library when you want the five guards above without writing them. Take
the guides when you want to read the loop once and copy the parts you need.

## When something goes wrong

The error classes carry `request_id` — quote it. Symptoms are indexed by what
you see in [troubleshooting.md](troubleshooting.md), and every refusal shape is
in [errors.md](errors.md).

## Next

- [quickstart.md](quickstart.md) — the same path in `curl`, with the token step
- [events.md](events.md) — what the frames mean
- [required-actions.md](required-actions.md) — letting the agent call your code
