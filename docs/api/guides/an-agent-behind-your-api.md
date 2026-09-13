# An agent behind your API

Your service receives a request, hands work to an agent, and returns. Nothing
waits. Later the agent finishes, your endpoint is called, and you collect the
result and notify whoever asked.

This is the difference between an API you call and an agent that runs.

## Dispatch and return

```bash
curl -s -X POST $GOBARE_API/v1/webhooks \
  -H "Authorization: Bearer $GOBARE_TOKEN" -H 'content-type: application/json' \
  -d '{ "url":"https://you.example.com/hooks/gobare",
        "events":["turn.completed","turn.failed","session.action_required"] }'
```

One subscription serves every session. The `secret` comes back once.

```bash
curl -s -X POST $GOBARE_API/v1/sessions \
  -H "Authorization: Bearer $GOBARE_TOKEN" -H 'content-type: application/json' \
  -H "Idempotency-Key: job-8842" \
  -d '{
    "agent": {
      "model": "MiniMax-M3",
      "instructions": "Answer with a short written summary and put any tables or charts in /workspace/outputs.",
      "tools": [{
        "type": "function",
        "name": "lookup_order",
        "description": "Fetch an order from the billing system by id.",
        "parameters": {
          "type": "object",
          "properties": { "order_id": { "type": "string" } },
          "required": ["order_id"],
          "additionalProperties": false
        }
      }]
    },
    "metadata": { "tenant": "acme", "job": "8842" },
    "input": "Where is order A-4471, and has anything gone wrong with it?"
  }'
```

Three things doing real work here:

- **`Idempotency-Key`** so a retried dispatch does not create a second session.
  Use your own job id. See [idempotency.md](../idempotency.md).
- **`metadata`** so the webhook that arrives later can be matched to the request
  that caused it. It is yours; we never interpret it.
- **`tools`** so the agent can reach into your systems. The next section is that
  loop.

Return to your caller now. Do not wait.

## Answer the agent's calls

When the agent calls `lookup_order`, the turn parks and you are notified with
`session.action_required`.

```bash
curl -s "$GOBARE_API/v1/sessions/$SID" -H "Authorization: Bearer $GOBARE_TOKEN" | jq .required_actions
```

Run the function on your side, then hand back the result:

```bash
curl -s -X POST "$GOBARE_API/v1/sessions/$SID/events" \
  -H "Authorization: Bearer $GOBARE_TOKEN" -H 'content-type: application/json' \
  -d '{"events":[{
    "type":"input.tool_result",
    "turn_id":"turn_…", "call_id":"call_…",
    "success": true,
    "output": "{\"status\":\"delayed_at_customs\",\"eta\":\"2026-09-20\"}"
  }]}'
```

**If your function throws, do not forward the exception text.** A stack trace is
an efficient way to put your database hostname into a model's context. Answer
with a fixed string:

```json
{ "success": false, "error": "The tool failed. Ask the user how to proceed." }
```

## Collect the result

`turn.completed` arrives when the turn has settled *and* its artifacts have
finished publishing, so you can fetch immediately:

```bash
curl -s "$GOBARE_API/v1/sessions/$SID/artifacts" -H "Authorization: Bearer $GOBARE_TOKEN"
curl -s "$GOBARE_API/v1/sessions/$SID/artifacts/$AID/content" -H "Authorization: Bearer $GOBARE_TOKEN"
```

The written answer is the last assistant message in `GET /v1/sessions/$SID/items`.

Then delete the session, or leave it and let it be reclaimed:

```bash
curl -s -X DELETE "$GOBARE_API/v1/sessions/$SID" -H "Authorization: Bearer $GOBARE_TOKEN"
```

## Running many at once

An organization holds a limited number of concurrent sessions. Past it, session
creation is refused with `429 project_limit_exceeded`, and — unlike
`429 rate_limit_exceeded` — **waiting will not help**. One never succeeds
without freeing a session; the other succeeds if you back off.

```python
if error["code"] == "rate_limit_exceeded":
    retry_after(response.headers["retry-after"])   # this one clears
elif error["code"] == "project_limit_exceeded":
    queue_for_later()                               # this one does not
```

Treat the two the same and your worker will spin forever on the first one.

## You have it working when

- You collected a result without ever polling a turn
- The signature on the delivery verifies, and a single altered byte does not
- Your function was called and its return value shows up in the agent's answer
- Re-dispatching with the same `Idempotency-Key` returns the original session
  rather than creating a second
- The two `429` codes are handled differently

## What to know

**Your handler may take its time.** A turn parked on your function is treated
as in flight, so the workspace is not paused underneath it. The ceiling is the
workspace's two-hour lifetime; for anything longer, answer with "in progress"
and start a fresh round when you have the result.

**There is no scheduler.** Gobare does not run anything on a timer. Use your own
cron or queue to call `POST /v1/sessions`.

**Tokens belong to people, not services.** A key minted by someone who leaves
goes with them. Treat it as a credential that will expire and keep it
rotatable.

**`turn.failed` says only that it failed.** The reason is in the turn's `error`
field and in `items`, not in the notification.
