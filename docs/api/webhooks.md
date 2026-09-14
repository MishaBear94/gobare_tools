# Webhooks

> Published from the Gobare product repository. The canonical page is
> <https://docs.gobare.dev/webhooks> — read it there; this copy is for offline and for tooling.


Be told what happened instead of watching for it. Delivery is **at least once**,
which is the only promise worth making over a network we do not control.

## Subscribing

```bash
curl -s -X POST $GOBARE_API/v1/webhooks \
  -H "Authorization: Bearer $GOBARE_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com/hooks/gobare","events":["session.idle","turn.failed"]}'
```

```json
{"object":"webhook.subscription","id":"whsub_6c1e40b9a72d58f3","url":"https://example.com/hooks/gobare",
 "events":["session.idle","turn.failed"],"active":true,"secret":"whsec_<returned once>"}
```

**The secret is returned once.** Store it; it is what makes a delivery
verifiable. `GET /v1/webhooks` lists subscriptions without it, and
`DELETE /v1/webhooks/{webhook_id}` removes one.

## Event types

| Event | When |
| --- | --- |
| `session.created` | A session was created |
| `session.action_required` | The agent is waiting on you |
| `session.working` | A turn started |
| `session.idle` | The session went quiet |
| `session.failed` | The session entered a failed state |
| `turn.completed` | A turn finished successfully |
| `turn.failed` | A turn did not |

This is a shorter list than the event stream's on purpose: a webhook is for
facts worth waking a system up for, not for watching an agent think.

## The payload

```json
{
  "object": "event",
  "type": "session.action_required",
  "created_at": 1789172121302,
  "data": { "session_id": "3f9c1b60-4e2a-4d18-9a77-6c0b2e5d81af", "required_action": { "type": "function_call" } }
}
```

**`data` names the object; it never embeds it.** A receiver that reads the
session afterwards sees current truth. One that trusted an embedded copy would
act on a snapshot that was already stale when it was signed — and we would owe
you a second schema to keep compatible forever.

## Verifying a delivery

Two headers:

```
x-gobare-timestamp: 1789305457283
x-gobare-signature: 7f3a…
```

The signature is `HMAC-SHA256(secret, "{timestamp}.{body}")`, hex. **The
timestamp is inside the signed material, not only beside it** — without that, a
captured delivery stays valid forever and you have no way to reject an old one.

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

export function verify(secret: string, timestamp: number, body: string, presented: string): boolean {
  const expected = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  if (expected.length !== presented.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(presented, "hex"));
  } catch {
    return false;
  }
}
```

In Python, the same three rules — `compare_digest` is the timing-safe compare:

```python
import hashlib, hmac

def verify(secret: str, timestamp: str, body: bytes, presented: str) -> bool:
    expected = hmac.new(secret.encode(),
                        timestamp.encode() + b"." + body,
                        hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, presented)
```

Verify against the **raw** body, before any JSON parse and re-serialise — a
round trip changes key order and whitespace and will not match.

Getting the raw body is the part frameworks make hard, and each one has its own
way:

| | |
| --- | --- |
| Express | `express.raw({type: "application/json"})` on this route — `express.json()` has already discarded the bytes |
| FastAPI | `await request.body()`, not the parsed model |
| Flask | `request.get_data()`, not `request.json` |
| Next.js | Read the stream; the App Router gives you `await req.text()` |

A verifier that re-serialises the parsed object passes every test you write
against your own serialiser and fails against ours.

**The timestamp is milliseconds**, the same units as `Date.now()`. It is signed
as the exact digits sent, so verify with the string you received rather than a
number you converted and converted back.

Then reject a timestamp far from your own clock:

```ts
if (Math.abs(Date.now() - Number(timestamp)) > 5 * 60_000) return false;
```

A few minutes is a reasonable window; we do not pick one for you because your
tolerance for clock skew is yours to decide. Dividing by 1000 first — which is
what a seconds-shaped example invites — rejects every delivery, and it fails
looking exactly like a bad signature.

## One subscription per address and event set

Subscribing the same URL to exactly the same events twice is refused with
`409 conflict`, naming the subscription already doing it:

```json
{ "error": { "code": "conflict",
  "message": "This organization already subscribes https://you.example.com/hooks to exactly these events, as whsub_… Delete it first if you want a new secret, or subscribe a different address — a second identical subscription would deliver everything twice." } }
```

A duplicate is easy to create by accident — retrying a create that appeared to
fail is enough — and what it buys you is every delivery twice, permanently,
with nothing anywhere saying so. Deliveries are already at-least-once; doubling
them is a different problem.

The same address subscribed to a *different* set of events is a different
subscription and is allowed: one endpoint for completions and another for the
ones that need a person is a reasonable shape.

## Retries

A delivery is owed until it is delivered or given up on. Any non-2xx response,
or no response, is a failure.

| Attempt | After |
| --- | --- |
| 1 | immediately |
| 2 | 1 minute |
| 3 | 5 minutes |
| 4 | 30 minutes |
| 5 | 2 hours |
| 6 | 6 hours |

Six attempts over roughly nine hours: long enough that a deploy or a short
outage on your side is survivable, short enough that a permanently broken
endpoint stops being retried the same day. After that the delivery is marked
dead with the reason recorded.

A receiver that hangs is abandoned after 10 seconds and retried. Answer
quickly and do the work afterwards.

## At-least-once delivery

**Deliveries can arrive more than once, and can arrive out of order.** The queue
is rows in a database rather than timers in memory, so a restart still owes
what it owed — and the same property means a retry can overtake nothing and a
network can duplicate.

Make your handler idempotent. The event names an object; read the object.

## `turn.completed` waits for the artifacts

The notification means "come and look", so it is sent once that turn's
artifacts have finished publishing rather than the instant the turn settles.
Without that wait, an integration doing the obvious thing — receive the call,
fetch the artifacts — found an empty list, which is indistinguishable from a
turn that produced nothing.

If publication has not finished after 30 seconds the notification is sent
regardless. Read `artifacts` on the turn to tell the two apart: `ready` means
an empty list is final, `pending` means come back, and `partial` means some
files were left behind — `artifacts_skipped` on the turn says which and why.

A delivery that never arrives is usually a subscription that was never created,
a URL that is not https, or an event name that is not one of the above — see
[troubleshooting.md](troubleshooting.md) for symptoms and
[errors.md](errors.md) for the refusal shape.

## Next

- [events](events.md) — watch a single session live instead
- [idempotency](idempotency.md) — deliveries arrive at least once
