# Input

> Published from the Gobare product repository. The canonical page is
> <https://docs.gobare.dev/input> — read it there; this copy is for offline and for tooling.

Everything you can send a session, in one place.

All four go to the same endpoint, one per request:

```
POST /v1/sessions/{session_id}/events
```

The body is always an array of exactly one event. Batching two would need a
partial-failure result nothing could act on, so it is refused rather than
half-supported.

```json
{ "events": [ { "type": "input.message", "content": "…" } ] }
```

A success is `202`, not `200` — the agent has the work, not the answer.

| Type | What it does | When it is refused |
| --- | --- | --- |
| `input.message` | Say something. Starts a turn, or queues behind the running one | `queue_full` at five queued |
| `input.tool_result` | Answer a function the agent called | `not_found` if no such call is pending |
| `input.approval` | Allow or refuse something the agent asked to do | `invalid_request` without `call_id` and a boolean `approved` |
| `input.question_answer` | Answer a question the agent asked | `invalid_request` without `call_id` and a non-empty `answer` |
| `input.steer` | Change course mid-turn | `conflict` when no turn is running |
| `input.cancel` | Stop the running turn | Accepted even when nothing is running |

Every refusal arrives in the shape described in [errors.md](errors.md), with the
code above in `error.code`.

---

## `input.message`

```bash
curl -s -X POST $GOBARE_API/v1/sessions/$SESSION/events \
  -H "Authorization: Bearer $GOBARE_TOKEN" \
  -H 'content-type: application/json' \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"events":[{"type":"input.message","content":"Summarise this repo."}]}'
```

`content` takes a string, or an array of parts if you prefer the longer form:

```json
{ "type": "input.message", "content": [ { "type": "input_text", "text": "Summarise this repo." } ] }
```

Sent while a turn is running, it **queues** rather than interrupting — see
[design-decisions.md](design-decisions.md) for why that is not steering. The
reply tells you which happened:

```json
{ "object": "input.accepted", "type": "input.message", "queued": true, "queue_position": 1 }
```

Send an [`Idempotency-Key`](idempotency.md). A retried send without one is a
second message.

### Finding the turn your message produced

The reply carries no `turn_id`, because at the moment it is written there is no
turn yet — the agent starts one when it picks the message up, which is later
even when nothing was queued.

If you watch [events](events.md) or take a [webhook](webhooks.md), the turn id
arrives with them and there is nothing to do. If you poll, there is one trap
worth knowing:

```bash
# Wrong: on a session that has run before, this returns the PREVIOUS turn —
# which is already `completed`, so the wait ends immediately and you read the
# results of work you did not ask for.
curl -s "$GOBARE_API/v1/sessions/$SESSION/turns?limit=1"
```

Remember the latest turn id *before* you send, and wait for one that is
different:

```bash
BEFORE=$(curl -s "$GOBARE_API/v1/sessions/$SESSION/turns?limit=1" \
  -H "Authorization: Bearer $GOBARE_TOKEN" | jq -r '.data[0].id // ""')
# … send …
until [ "$(curl -s "$GOBARE_API/v1/sessions/$SESSION/turns?limit=1" \
  -H "Authorization: Bearer $GOBARE_TOKEN" | jq -r '.data[0].id')" != "$BEFORE" ]; do sleep 1; done
```

A fresh session has no previous turn, so a first message needs none of this.

## `input.tool_result`

The answer to a function the agent called. `turn_id` and `call_id` are copied
from the [required action](required-actions.md) verbatim.

```bash
curl -s -X POST $GOBARE_API/v1/sessions/$SESSION/events \
  -H "Authorization: Bearer $GOBARE_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"events":[{"type":"input.tool_result","turn_id":"'$TURN'","call_id":"'$CALL'",
       "success":true,"output":"{\"status\":\"shipped\"}"}]}'
```

| Field | | |
| --- | --- | --- |
| `turn_id` | required | From the required action |
| `call_id` | required | From the required action |
| `success` | required | Whether your function worked |
| `output` | when `success` is true | A string. Serialise JSON yourself |
| `error` | when `success` is false | A string the model will read |

The reply's `outcome` is the thing to check:

- `accepted` — the turn has it and continues
- `already_resolved` — this call was answered before; the second answer is
  discarded rather than applied
- `not_delivered` — nothing was waiting for it

**Never put a thrown exception's message in `error`.** It goes to the model,
and a stack trace is an efficient way to put your database host into a prompt.
Send a fixed string; log the real one.

## `input.steer`

Change course while a turn is running.

```bash
curl -s -X POST $GOBARE_API/v1/sessions/$SESSION/events \
  -H "Authorization: Bearer $GOBARE_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"events":[{"type":"input.steer","content":"Stop — use Go instead."}]}'
```

This is the deliberate half of the divergence: a plain message waits its turn,
and redirecting work in flight has to be asked for by name. Sent when no turn
is running, it is a `conflict` — there is nothing to steer, and silently
turning it into a message would be a different thing than you asked for.

## `input.cancel`

Stop the running turn.

```bash
curl -s -X POST $GOBARE_API/v1/sessions/$SESSION/events \
  -H "Authorization: Bearer $GOBARE_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"events":[{"type":"input.cancel"}]}'
```

No other fields. The turn settles as `cancelled` — not `failed`, because you
asked for it, and a failure status would send you looking for a fault that is
not there.

Cancelling when nothing is running is accepted rather than refused: a caller
racing a finishing turn should not have to care which of them won.

Work already done stays. Items the turn produced remain readable, and anything
published to `/workspace/outputs` before the stop is still collected.

## Next

- [required-actions.md](required-actions.md) — the calls you answer with `input.tool_result`
- [events.md](events.md) — watching what the agent does with what you sent
- [idempotency.md](idempotency.md) — retrying a send without sending twice
