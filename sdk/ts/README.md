# @gobare/api

The official TypeScript client for the Gobare Agent API.

```ts
import { Gobare } from "@gobare/api";

const gobare = new Gobare({ token: process.env.GOBARE_TOKEN! });

const session = await gobare.sessions.create({
  agent: { model: "MiniMax-M3" },
  input: "Write /workspace/outputs/hello.txt and tell me when it is there.",
});
```

**Version 0.1.0, and the `0.` is load-bearing.** `/v1` is still making breaking
changes — the tool configuration response changed shape on 2026-09-14 — so this
package makes the semver promise that matches: anything can change until 1.0.

That is deliberately *not* how OpenAI does it. Their client puts the Agents API
under `client.beta.agents.*` because the same library also serves stable
surfaces it must not destabilise. This library serves one API, so there is
nothing here to tell apart, and a `beta` namespace on every call would be
friction that buys nothing. A `0.x` version says the same thing and costs the
caller nothing.

## What is generated and what is not

```
src/
  generated/resources.ts   ← rewritten by `pnpm sdk:generate`. Never edit.
  transport.ts             ← hand-written
  lib/                     ← hand-written. The generator never touches it.
```

The split follows `openai-python`, whose `CONTRIBUTING.md` says the generator
"will never modify the contents of `src/openai/lib/`". Where the line falls,
though, is ours, and it was not a judgement call — it was measured.

**Thirty-three of the API's thirty-eight operations answer with JSON.** Those
are generated from the server's own route table, in this repository, so a route
change and its client change land in the same commit. `generated/drift.test.ts`
regenerates and fails on any difference.

**Five are not generated**, and each one is a thing a generated method would get
wrong:

| | why it is hand-written |
| --- | --- |
| `GET /v1/events` | `text/event-stream` — a generated method would `JSON.parse` a connection that stays open for the life of a session |
| `GET /v1/sessions/{id}/events` | the same |
| `GET /v1/sessions/{id}/artifacts/archive` | a tar stream |
| `GET /v1/sessions/{id}/artifacts/{id}/content` | raw bytes, in the artifact's own type |
| `GET /v1/openapi.json` | describes the API rather than holding data in it |

## Errors

The one distinction worth knowing before you write a `catch`:

```ts
import { GobareRateLimitError, GobareProjectLimitError } from "@gobare/api";

try {
  await gobare.sessions.create({ agent: { model: "MiniMax-M3" } });
} catch (error) {
  if (error instanceof GobareRateLimitError) {
    // Wait error.retryAfterSeconds. The retry will succeed.
  }
  if (error instanceof GobareProjectLimitError) {
    // **Retrying never succeeds.** Delete a session, or ask for a higher ceiling.
  }
}
```

Both are `429`. A client that treats them alike spins forever on the second one.
`GobareProjectLimitError` is deliberately *not* a subclass of
`GobareRateLimitError`, so the obvious `instanceof` check cannot catch it by
accident.

Everything that reaches the server carries `status`, `code`, `requestId` and, on
an authenticated call, `rateLimit`. Something that never reached it throws
`GobareConnectionError` instead — no request id to quote, nothing server-side to
investigate.

## Regenerating

```bash
pnpm sdk:generate
```

Reads the local route table, not the deployed `openapi.json`. Generating from
the deployment would mean the client could only catch up after a release — and
a client that lags the API by one deploy is wrong exactly when the API is newest.
