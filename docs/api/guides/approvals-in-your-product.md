# Approvals in your own product

An agent that can restart a service or roll back a deployment should ask first.
And the asking should happen where your team already is — your dashboard, your
incident channel, your ticket queue — not in someone else's console.

The shape is a function tool that does nothing except record a decision. The
agent calls it, the turn parks, your application is notified, a person decides,
and you hand the answer back.

## Subscribe first

```bash
curl -s -X POST $GOBARE_API/v1/webhooks \
  -H "Authorization: Bearer $GOBARE_TOKEN" -H 'content-type: application/json' \
  -d '{ "url":"https://you.example.com/hooks/gobare",
        "events":["session.action_required","turn.completed","turn.failed"] }'
```

The response carries a `secret`, once. Store it; it is not shown again.

`session.action_required` is the event this guide turns on — *somebody needs to
decide something*.

## Make the approval a tool

```bash
curl -s -X POST $GOBARE_API/v1/sessions \
  -H "Authorization: Bearer $GOBARE_TOKEN" -H 'content-type: application/json' \
  -d '{
    "agent": {
      "model": "MiniMax-M3",
      "instructions": "You are on call. Do read-only investigation yourself. Before anything that changes production, call request_approval with what you intend to do and why, and wait. If you are refused, propose an alternative — do not work around it.",
      "tools": [{
        "type": "function",
        "name": "request_approval",
        "description": "Ask a human to approve an action that changes production. This tool records a decision and executes nothing.",
        "parameters": {
          "type": "object",
          "properties": {
            "action": { "type": "string", "description": "What you intend to do" },
            "reason": { "type": "string", "description": "Why it is necessary" },
            "blast_radius": { "type": "string", "description": "What it affects if it goes wrong" }
          },
          "required": ["action", "reason", "blast_radius"],
          "additionalProperties": false
        }
      }]
    },
    "input": "Alert A-4471: the export endpoint is at a 12% error rate. Investigate and fix it if you can."
  }'
```

Three choices worth copying:

- **The tool executes nothing.** It records a decision. The agent carries the
  action out itself once approved, which keeps the approval side-effect free and
  therefore safe to call twice.
- **`blast_radius` is required.** An approval request that does not say what is
  at stake cannot be judged.
- **"If you are refused, propose an alternative" is in the instructions.** What
  an agent should do after a refusal is a branch you design, not a default you
  inherit.

## Handle the notification

When the agent calls the tool, the turn parks and you are notified. Verify the
signature before you trust the body — see [webhooks.md](../webhooks.md) for the
formula.

Then read what it is waiting on:

```bash
curl -s "$GOBARE_API/v1/sessions/$SID" -H "Authorization: Bearer $GOBARE_TOKEN" | jq .required_actions
```

```json
[{ "type": "function_call", "turn_id": "turn_…", "call_id": "call_…",
   "name": "request_approval",
   "arguments": { "action": "Restart export-worker", "reason": "…", "blast_radius": "…" } }]
```

**Read the session rather than trusting the webhook payload.** Deliveries are
at-least-once and may arrive out of order; the session is the current truth.
Show `action`, `reason` and `blast_radius` to whoever is deciding.

## Send the decision back

```bash
curl -s -X POST "$GOBARE_API/v1/sessions/$SID/events" \
  -H "Authorization: Bearer $GOBARE_TOKEN" -H 'content-type: application/json' \
  -d '{"events":[{
    "type":"input.tool_result",
    "turn_id":"turn_…", "call_id":"call_…",
    "success": true,
    "output": "{\"approved\":true,\"by\":\"dana@you.example.com\",\"at\":\"2026-09-13T04:10:00Z\"}"
  }]}'
```

The turn continues. Include who approved and when — the transcript then holds
the audit trail, rather than it living only in your logs.

To refuse, answer with the refusal rather than an error:

```json
{ "success": true, "output": "{\"approved\":false,\"reason\":\"peak hours; wait for the 02:00 window\"}" }
```

`success: false` means *your tool failed*, which is a different thing and will
make the agent try to recover from a fault that did not happen.

## You have it working when

- The agent stops before acting, and `required_actions` names the tool with all
  three fields populated
- Your endpoint is notified without you polling
- After you answer, the turn continues and the agent does what was approved
- After a refusal, it proposes something else rather than doing it anyway
- Submitting the same `call_id` twice is reported as already resolved rather
  than acted on again

## What to know

**A person can take their time.** A turn parked on your tool is treated as in
flight, so idle pause leaves the workspace alone. The hard ceiling is the
workspace's two-hour lifetime. For a decision that may wait overnight, answer
the tool with "queued for review" and start a fresh round tomorrow.

**Deliveries are at-least-once and may repeat.** Make your handler idempotent
and read current state instead of trusting a payload snapshot.

**The Console has its own approval mode.** `approval_mode` and
`permission_rules` gate the agent for people working in the Console. The API
can see those requests but cannot answer them, which is why this guide uses a
function tool: it keeps the whole loop inside your product.
