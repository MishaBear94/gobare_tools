# Idempotency

A retried write must not act twice. Send an `Idempotency-Key` header on any
request that changes something, and a retry with the same key returns the
stored answer instead of doing the work again.

```bash
curl -s -X POST $GOBARE_API/v1/sessions \
  -H "Authorization: Bearer $GOBARE_TOKEN" \
  -H "Idempotency-Key: 0f7c2e3a-…" \
  -H 'content-type: application/json' \
  -d '{"agent":{"model":"MiniMax-M3"}}'
```

Send the same key again and you get the same status and the same body — the
same session, not a second one.

## Coverage

A key is scoped to **your token, the method and the path**. The same key used on
a different endpoint is a different key, and one organization's keys are
invisible to another's.

It is **not** scoped to the body. Reusing a key with different content returns
the first call's answer; it does not perform the second call and it does not
report a conflict. Generate a fresh key per logical operation — a UUID per
attempt-group is the usual shape — rather than reusing one per session or per
day.

## Rules

| | |
| --- | --- |
| Applies to | Every method except `GET` |
| Key length | Up to 255 characters |
| Retained | 24 hours |
| Scope | `(token, method, path, key)` |

After 24 hours the record is gone and the same key acts for the first time
again. That is long enough to cover any retry a client should be making, and
short enough that the table does not grow forever.

## Not covered

A refusal. If a call is rejected — bad input, missing scope, rate limited — no
answer is stored, so your retry is a real attempt rather than a replay of a
failure.

That is why a rate limit refusal is safe to retry: the `429` did not consume
your key.

## Without a key

Writes still work; they are just not replay-safe. `POST .../events` with no key
sends the message, and sending it twice sends it twice.

The one case worth a key even in simple clients is `POST /v1/sessions`. A
network timeout on session creation is otherwise indistinguishable from a
failure, and retrying leaves you with two sandboxes and a concurrency limit you
are now closer to.

## Next

- [errors](errors.md) — what a retry can meet
- [limits](limits.md) — how often you may retry

## Two calls, one key, at the same time

A dropped connection followed by an immediate retry is the case this header
exists for, and most HTTP clients retry **in parallel** with the request they
think died. So the key is claimed before the work starts, not recorded after it
finishes.

The second caller gets `409 conflict`:

```json
{ "error": { "code": "conflict",
  "message": "A request with Idempotency-Key \"job-8842\" is already in flight. Retry in a moment; if it succeeded, the retry replays its answer rather than acting again." } }
```

Retry shortly and you get the first call's answer. Refused rather than made to
wait, because waiting means holding your connection open for work whose
duration we do not control, and a timeout is not something you can act on.

A call that fails releases its key, so the retry most likely to succeed is not
the one guaranteed to fail.
