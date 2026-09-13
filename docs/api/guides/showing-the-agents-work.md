# Showing the agent's work

If your users are watching an agent work, a spinner and the word "processing"
is a poor showing. What they want to see is what it is reading, what it
changed, what it ran, and what came out — and to scroll back through it
afterwards.

The event stream carries twenty-six kinds of thing, and it can be replayed.

## Subscribe first, then send

```bash
curl -s -X POST $GOBARE_API/v1/sessions \
  -H "Authorization: Bearer $GOBARE_TOKEN" -H 'content-type: application/json' \
  -d '{"agent":{"model":"MiniMax-M3"}}'
```

```bash
curl -N "$GOBARE_API/v1/sessions/$SID/events" -H "Authorization: Bearer $GOBARE_TOKEN"
```

```bash
curl -s -X POST "$GOBARE_API/v1/sessions/$SID/events" \
  -H "Authorization: Bearer $GOBARE_TOKEN" -H 'content-type: application/json' \
  -d '{"events":[{"type":"input.message","content":"Write /workspace/app.py, a minimal HTTP service returning {\"ok\":true}. Run it once to prove it answers and write the output to /workspace/outputs/proof.txt."}]}'
```

**That order matters.** Subscribing after sending loses the opening frames
whenever the agent starts quickly, which makes for a bug that never reproduces
on a developer's machine.

## What arrives

That task produces these, in this order:

```
user.message        your message, recorded
sandbox.created     the workspace is up
turn.started        work begins
agent.text     ×13  the reply, arriving a fragment at a time
agent.message  ×2   the same reply, settled
agent.tool_call ×4  what it is about to run
agent.tool_result ×4 what it got back
file.changed        something in the workspace changed
turn.ended          this round is over
artifact.created    a file was published and can be fetched
```

A given run shows a subset of the full vocabulary, depending on what the agent
does and which model you are on.

## Which frames you can build on

One rule: **look for `id:`**.

```
id: 4812                    ← durable
event: agent.message
data: {"type":"agent.message","seq":4812,…}

event: agent.text           ← transient
data: {"type":"agent.text","seq":null,…}
```

A durable frame has an integer `seq` and an `id:` line. It is stored, it is
replayed on reconnect, and it is a fact. A transient frame has `seq: null` and
no `id:`. It is not stored and not replayed.

**Drive your state machine from durable frames and treat transient ones as
animation.** Printing `agent.text` deltas as they arrive is exactly right.
Deciding "this step finished" from them is not: after a reconnect those deltas
are gone, while the `agent.message` they settled into is replayed.

## Reconnect without losing anything

```bash
curl -N "$GOBARE_API/v1/sessions/$SID/events?last_event_id=4812" \
  -H "Authorization: Bearer $GOBARE_TOKEN"
```

Every durable event after `4812`, then live frames. Remember the last `id:` and
your interface survives a dropped connection without a reconciliation pass.

## The full vocabulary

Twenty-six types, grouped by the question they answer on screen:

| To show | Use |
| --- | --- |
| What it is saying | `agent.text` (streaming) → `agent.message` (settled), `agent.thinking` |
| What it is doing | `agent.tool_call` → `agent.tool_result` |
| How the workspace changed | `file.changed` |
| Something is ready to download | `artifact.created` |
| A service is up and reachable | `preview.ready` |
| Its plan | `agent.todos` |
| It is blocked on a person | `approval.requested` / `approval.resolved`, `question.asked` / `question.answered` |
| It is blocked on your code | `tool.required` / `tool.resolved` |
| Where my message is in the queue | `message.queued` / `message.dequeued` |
| What the computer is doing | `sandbox.created` / `sandbox.paused` / `sandbox.resumed` |
| Context was compacted | `agent.compaction` |
| Something went wrong | `agent.error`, `workspace.recovery_failed` |
| Round boundaries | `turn.started` / `turn.ended`, `user.message` |

Three worth singling out:

- **`file.changed`** covers creation, modification and deletion; the payload
  says which. For a live diff view this is more useful than the assistant's
  prose.
- **`preview.ready`** means the agent started a service and a port answered.
  It is the signal that there is something to click.
- **`agent.todos`** is the agent's own checklist. Rendered as a task list, your
  users can see how many steps remain.

## You have it working when

- `user.message` is the first frame you receive, because you subscribed first
- `turn.started`, `agent.tool_call`, `agent.tool_result` and `turn.ended` all
  arrive
- Every frame either has an integer `seq` and an `id:`, or `seq: null` and
  neither — there is no third shape
- After reconnecting mid-run, durable events are strictly increasing, all
  greater than your cursor, and agree with `GET /items`
- No `agent.text` is replayed
- Your interface never polls `/turns`

## What to know

**Terminal output is not on this stream.** You see what a command returned
through `agent.tool_result`, but not the output arriving line by line.

**Transient frames are never replayed.** The animation from a disconnected
period is gone. The facts are not.

**Payload shapes vary by type and are not individually described in the OpenAPI
document**, which covers the envelope — `type`, `seq`, `created_at`, `payload`.
Branch on the type rather than expecting one parser to handle all of them.

**There is a ceiling on concurrent streams per organization** — see
[limits.md](../limits.md). In a multi-tenant interface, hold one stream per
user rather than one per component.
