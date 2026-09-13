# Webhooks

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

## Events you may subscribe to

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
x-gobare-timestamp: 1789172121
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

Verify against the **raw** body, before any JSON parse and re-serialise — a
round trip changes key order and whitespace and will not match.

Then reject a timestamp far from your own clock. A few minutes is a reasonable
window; we do not pick one for you because your tolerance for clock skew is
yours to decide.

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

## What at-least-once means for you

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
an empty list is final, `pending` means come back.
