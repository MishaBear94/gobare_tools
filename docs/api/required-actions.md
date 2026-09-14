# Required actions

How the agent calls *your* code. This is the one genuinely unusual thing in this
API, and the one nobody guesses from the endpoint list.

The shape: the agent stops mid-turn, the session goes to `requires_action`, and the session
reports what it needs. You do the work wherever your code runs, send the result
back, and the turn resumes from where it paused.

## Declaring a function

Give the session a tool the agent can call but the sandbox cannot execute.

```bash
curl -s -X PUT $GOBARE_API/v1/sessions/$SESSION/tools \
  -H "Authorization: Bearer $GOBARE_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"tools":[{
        "type":"function",
        "name":"lookup_order",
        "description":"Fetch an order from the billing system.",
        "parameters":{"type":"object","properties":{"order_id":{"type":"string"}},"required":["order_id"]}
      }]}'
```

The same call takes `mcp` servers and `skill` entries; `PUT` replaces the whole
configuration rather than merging, so send the complete list every time. You can
also pass `agent.tools` when creating the session.

## Noticing

Three ways, in increasing order of how much you have to do:

1. **Webhook** — subscribe to `session.action_required`.
2. **Event stream** — watch for `tool.required`.
3. **Polling** — a session whose
   `required_actions` is non-empty.

```bash
curl -s $GOBARE_API/v1/sessions/$SESSION -H "Authorization: Bearer $GOBARE_TOKEN"
```

```json
{"object":"session","id":"3f9c1b60-4e2a-4d18-9a77-6c0b2e5d81af","status":"requires_action",
 "required_actions":[{
   "type":"function_call",
   "turn_id":"turn_9d41c7e0a8b24f36",
   "call_id":"call_9a1f…",
   "name":"lookup_order",
   "arguments":{"order_id":"A-4471"},
   "created_at":1789…}]}
```

Three types appear here:

| `type` | Answered by |
| --- | --- |
| `function_call` | Your code — `input.tool_result` |
| `approval` | Your code — `input.approval` — or a person in the Console |
| `question` | Your code — `input.question_answer` — or a person in the Console |

All three are answerable through this API. `approval` and `question` can also be
answered by a person in the Console, which is often what you want — the point is
that an API-only integration is no longer stuck waiting for one.

## Answering

```bash
curl -s -X POST $GOBARE_API/v1/sessions/$SESSION/events \
  -H "Authorization: Bearer $GOBARE_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"events":[{
        "type":"input.tool_result",
        "turn_id":"turn_9d41c7e0a8b24f36",
        "call_id":"call_9a1f…",
        "success":true,
        "output":"{\"status\":\"shipped\",\"carrier\":\"DHL\"}"
      }]}'
```

Needs the `tools:respond` scope — and only that one. A token holding
`sessions:read` and `tools:respond` can watch this session and answer its
function calls while being unable to send it a message, cancel its turn or
delete it, which is what you want a fleet of tool handlers to hold.

`turn_id` and `call_id` are copied from the required action. **`output` must be
a string** — serialise it yourself. We cannot know whether your object was meant
as JSON text or as a structure the model should see some other way, and guessing
would be silent either way.

To report a failure, send `"success": false` with `"error"` instead of
`"output"`. Tell the agent what went wrong; it can often recover, and it
certainly cannot if you say nothing.

## The four outcomes

```json
{"object":"input.accepted","session_id":"3f9c1b60-4e2a-4d18-9a77-6c0b2e5d81af","type":"input.tool_result","outcome":"accepted"}
```

Named rather than collapsed into ok/not-ok, because they call for different
things next:

| `outcome` | Meaning | Do |
| --- | --- | --- |
| `accepted` | Delivered; the turn is resuming | Nothing |
| `already_resolved` | This call was answered before | Nothing. Usually a retry after a dropped connection, and it is not an error |
| `not_delivered` | Recorded, but the sandbox did not take it | The turn will not resume from this. Expect it to fail or time out |
| `unknown` | No such pending call | `404`. Check `turn_id` and `call_id`, or the turn has already moved on |

`already_resolved` is the one worth designing for: at-least-once delivery on the
notification side means you will sometimes answer twice, and answering twice is
legitimate rather than a bug to guard against.

## Deadlines

**By default there is no deadline.** Nothing times a required action out. The
turn waits for you, the workspace is not paused underneath it, and the session
stays `requires_action` until you answer.

That is the right default and the wrong one to leave alone in production: a
process that dies mid-answer holds a workspace until its age cap with nothing
anywhere saying so. So you can declare your own, per tool:

```json
{ "type": "function", "name": "lookup_order", "timeout_seconds": 30,
  "parameters": { "type": "object", "properties": { "order_id": { "type": "string" } } } }
```

Per tool rather than per session, because the answer is a property of the
function. A billing lookup that has not replied in thirty seconds is not going
to; an approval may legitimately take until morning. One number for the whole
session would force the slowest tool's patience on every other one.

**Past the deadline the call fails and the turn carries on.** It does not fail
the turn. The agent has usually done real work before it reached your tool, and
throwing that away because your process died is a worse outcome than the one
the deadline exists to prevent — so a timed-out function is an ordinary
failure, the agent is told not to retry it, and it continues or reports that it
could not. This is also what makes the number safe to guess: too short costs
you one failed call, not a lost turn.

Each pending action reports its own `expires_at` in Unix milliseconds, or null
when it has none. Accepted range is 1 to 7200 seconds — the ceiling is the
workspace's own lifetime, because a deadline past the point where the session
is reclaimed could never arrive.

Approvals and questions never expire. Those are waiting on a person in the
Console, and timing one out would be us deciding somebody took too long to
think.

Whether or not you set one, the workspace's own ceiling still applies and
belongs to the session rather than to the action: **a workspace is reclaimed two
hours after it starts**, and a turn still parked when that arrives ends as
`failed`. That number lives in [limits.md](limits.md) and nowhere else.

So: for a decision that might take minutes, answer whenever you are ready. For
one that might take overnight — a person approving a production change, say —
do not hold the turn. Answer the tool with "queued for review" and start a fresh
round when the decision arrives; see
[Approvals in your own product](guides/approvals-in-your-product.md).

## When it goes wrong

| What you see | Why | Fix |
| --- | --- | --- |
| Your poller waits forever on a `working` session | It is parked on a `question` or an `approval`, which **only a person in the Console can answer** | Branch on `required_actions[].type`. If nothing in your product can answer one, instruct the agent never to ask |
| `400` — "not a function call, so it cannot be answered with input.tool_result" | You answered a `question` or `approval` through the API | The action stays open; a person resolves it. This used to be accepted, close the action, and strand the session |
| `404 No pending action` | `turn_id` or `call_id` is not from this session, or the call already expired | Copy both from `required_actions` verbatim |
| `outcome: "not_delivered"` | The call timed out while you were computing the answer | Raise that tool's `timeout_seconds` to what your service really needs |
| `outcome: "already_resolved"` | You answered twice | Nothing. A retry after a dropped connection is legitimate |
| `403 permission_denied` | The token lacks `tools:respond` | Mint one with that scope |
| The agent invents an answer instead of calling your function | Nothing told it the function is the only source of truth | Say so in `instructions`, and describe the tool in terms of what it knows |

More symptoms, across the whole API, in
[troubleshooting.md](troubleshooting.md); the shape every refusal arrives in is
[errors.md](errors.md).

## Compared with webhooks

Because the turn is a single agent run, not a sequence of requests. The agent
paused mid-reasoning with its context intact; when your result arrives it
continues from exactly there. A design that ended the turn and started another
would lose that, and would make every function call a fresh conversation.

## Next

- [input](input.md) — the four things you can send, `input.tool_result` among them
- [tools](tools.md) — declare the functions the agent may call
- [approvals in your product](guides/approvals-in-your-product.md) — put a person in the loop
