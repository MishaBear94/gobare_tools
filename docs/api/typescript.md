# TypeScript client

> Published from the Gobare product repository. The canonical page is
> <https://docs.gobare.dev/typescript> — read it there; this copy is for offline and for tooling.

Everything on the other pages is a `curl`, because the API is the product and
`curl` is the shortest way to see it work. This page is for after that: when you
are putting it in a service and want the compiler to catch what a prose warning
cannot.

```bash
git clone https://github.com/MishaBear94/gobare_tools.git
npm install ./gobare_tools/sdk/ts
```

**Not on npm yet** — `/v1` is still making breaking changes, so the package is
published to a registry when the surface settles rather than before. It is on
GitHub now, and npm cannot install a subdirectory from a git URL, which is why
this is two lines rather than one. The install builds it: you get JavaScript
with declarations, importable from plain `node`, not the TypeScript source.

```ts
import { Gobare } from "@gobare/api";

const gobare = new Gobare({ token: process.env.GOBARE_TOKEN! });

const session = await gobare.sessions.create({
  agent: { model: "MiniMax-M3" },
  input: "Write /workspace/outputs/hello.txt saying hello, then tell me you did.",
});

for await (const event of gobare.watch(session.id)) {
  if (event.type === "turn.ended") break;
}
```

**Version 0.1.0, and the `0.` is deliberate.** `/v1` is still making breaking
changes — see the [changelog](changelog.md) — so the package makes the semver
promise that matches. Pin it.

## What it is, and what it is not

It is a client for `/v1`. It does not run an agent loop in your process, hold
your conversation state, or give you a second way to define an agent — those
are the API's job, and a library that duplicated them would be a second thing
to keep in step.

Every operation that answers with JSON is **generated** from the same route
table the server matches against, in the same repository, so a route and its
client method change in one commit. Five are hand-written, and each is
hand-written because a generated method would be wrong about it: the two event
streams, the artifact archive, an artifact's raw bytes, and — the one with no
endpoint at all — verifying a webhook.

The [Python client](python.md) is the same thing, from the same table, by a
second emitter sharing the same exclusion list. A test fails if an operation
reaches one client and not the other.

## The five things it does that a curl does not

Each of these is written up on its own page as a warning. Here they are as
code that cannot be got wrong.

### 1. The two 429s are different classes

```ts
import { GobareRateLimitError, GobareProjectLimitError } from "@gobare/api";

try {
  await gobare.sessions.create({ agent: { model: "MiniMax-M3" } });
} catch (error) {
  if (error instanceof GobareRateLimitError) {
    await sleep(error.retryAfterSeconds! * 1000);   // the retry will succeed
  } else if (error instanceof GobareProjectLimitError) {
    await deleteOldestSession();                    // retrying never succeeds
  }
}
```

`GobareProjectLimitError` is **not** a subclass of `GobareRateLimitError`, so
the obvious `instanceof` retry cannot catch it by accident. That accident is an
infinite loop at full rate. See [limits.md](limits.md).

Every error carries `status`, `code`, `requestId` and `retryable`; an
authenticated call also carries `rateLimit` with the bucket's name, so the
`general` and `sessions` numbers cannot be confused for each other. Something
that never reached us throws `GobareConnectionError` instead — no request id to
quote, nothing server-side to investigate.

### 2. The event stream resumes on its own

```ts
for await (const event of gobare.watch(session.id)) { … }
```

A dropped connection reconnects from the last **persisted** event. Transient
frames — text deltas, thinking — carry `seq: null` and never advance the
cursor, because a cursor that named one would ask for a row that was never
written.

Omitting `lastEventId` means live frames only, which is what "subscribe before
you send" needs; passing `0` means everything. They are different requests and
the client keeps them apart. See [events.md](events.md).

### 3. `completed` does not mean the files are there

```ts
const state = await gobare.waitForArtifacts(session.id, turn.id);
if (state === "partial") { /* turn.artifacts_skipped says which and why */ }

const file = await gobare.downloadArtifact(session.id, artifactId);
await pipeline(file.body!, createWriteStream("out.csv"));
```

Publication runs after settlement, so there is a window where the artifact list
is empty and indistinguishable from a turn that produced nothing.
`waitForArtifacts` is that wait, once, rather than in every caller.

It returns `ready`, `partial`, `failed`, or `null` for a turn from before the
field existed — a fourth answer rather than a guess, because both guesses are
wrong. Downloads hand back a `Response` rather than a buffer, so a 200 MiB
artifact streams instead of becoming an out-of-memory error inside the library.

### 4. Webhook verification, with the raw-body trap closed

```ts
import { unwrapWebhook } from "@gobare/api";

app.post("/hooks/gobare", express.raw({ type: "application/json" }), (req, res) => {
  const event = unwrapWebhook({
    secret: process.env.GOBARE_WEBHOOK_SECRET!,
    body: req.body,                              // the Buffer, not a parsed object
    signature: req.header("x-gobare-signature")!,
    timestamp: req.header("x-gobare-timestamp")!,
  });
  res.sendStatus(200);                           // answer first, work afterwards
  handle(event);
});
```

Passing a parsed object is **refused rather than serialised**, and the refusal
names the fix for Express, FastAPI, Flask and Next.js — because serialising it
for you would reproduce, silently and on our side, the exact bug that makes
every delivery fail. A seconds-shaped timestamp is diagnosed by name instead of
arriving as "signature does not match", which is the same afternoon saved.

See [webhooks.md](webhooks.md).

### 5. Idempotency keys are a first-class argument

```ts
await gobare.sessions.create({ … }, { idempotencyKey: `job-${jobId}` });
```

A key that identifies the *work*, not the attempt. A fresh uuid per try is the
same as sending none. See [idempotency.md](idempotency.md).

## Reading a single file, without the library

If you would rather see the whole loop than add a dependency,
[`run-session.ts`](run-session.ts) is the same job in one screen, importing
nothing. It is the file our own end-to-end tests and launch gates run through,
so it cannot drift from the API.

Take the library when you want types and the five guards above. Take the single
file when you want to read it once and copy the parts you need.

## When something goes wrong

The error classes carry `requestId` — quote it. Symptoms are indexed by what
you see in [troubleshooting.md](troubleshooting.md), and every refusal shape is
in [errors.md](errors.md).

## Next

- [quickstart.md](quickstart.md) — the same path in `curl`, with the token step
- [events.md](events.md) — what the frames mean
- [required-actions.md](required-actions.md) — letting the agent call your code
