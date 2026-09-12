# Required actions

How the agent calls *your* code. This is the one genuinely unusual thing in this
API, and the one nobody guesses from the endpoint list.

The shape: the agent stops mid-turn, the turn goes to `waiting`, and the session
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

## Noticing that you are needed

Three ways, in increasing order of how much you have to do:

1. **Webhook** — subscribe to `session.action_required`.
2. **Event stream** — watch for `tool.required`.
3. **Polling** — a turn whose `status` is `waiting`, or a session whose
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
| `function_call` | Your code, through this API |
| `approval` | A person, in the Console |
| `question` | A person, in the Console |

`approval` and `question` are listed so an integration can *see* that a human is
holding up a session it cares about. Answering them is a Console action.

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

Needs the `tools:respond` scope.

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

## A deadline

A required action does not wait forever. If nothing answers, the turn ends
rather than holding a sandbox open indefinitely — a session waiting on a caller
that crashed is still costing compute.

Answer promptly, and treat a turn found in `failed` with an unanswered action as
a thing to retry from the start rather than a state to resume.

## Why not just a webhook round trip

Because the turn is a single agent run, not a sequence of requests. The agent
paused mid-reasoning with its context intact; when your result arrives it
continues from exactly there. A design that ended the turn and started another
would lose that, and would make every function call a fresh conversation.
