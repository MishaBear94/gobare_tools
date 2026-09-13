# Work that spans hours

Some jobs are not one request. You ask the agent to build something, look at
what it did, come back after lunch and ask for the next piece. Between those
two moments the workspace may have been paused and its computer released.

The conversation does not restart. Send the next message and the agent picks up
where it left off.

## What this relies on

The transcript lives in the control plane, not in the workspace. The workspace
is where work happens; the record of what happened is somewhere that outlives
it. So pausing costs you nothing except the time to wake up.

## Start the work

```bash
curl -s -X POST $GOBARE_API/v1/sessions \
  -H "Authorization: Bearer $GOBARE_TOKEN" -H 'content-type: application/json' \
  -d '{
    "agent": {
      "model": "MiniMax-M3",
      "instructions": "Write FastAPI with type hints and Pydantic models. Run it locally before you call anything done."
    },
    "input": "Build a warehouse robot status API: GET /robots/{id}/status returns battery and current task. Smoke test it and show me the output."
  }'
```

Keep the `id` from the response; the examples below call it `$SID`.

`instructions` stay with the session for every turn. Use them for the things
that are true of all your work — house style, what "done" means, what not to
touch — and leave `input` for the task itself.

## Watch it, don't poll it

```bash
curl -N "$GOBARE_API/v1/sessions/$SID/events" -H "Authorization: Bearer $GOBARE_TOKEN"
```

```
id: 4812
event: agent.message
data: {"object":"event","type":"agent.message","seq":4812,…}
```

**Record the last `id:` you saw.** Only durable events carry one. See
[Showing the agent's work](showing-the-agents-work.md) for what else is on this
stream.

## Reconnect where you left off

Connections drop. Pass the last id you saw:

```bash
curl -N "$GOBARE_API/v1/sessions/$SID/events?last_event_id=4812" \
  -H "Authorization: Bearer $GOBARE_TOKEN"
```

You get every durable event after that point, then live frames again. The
cursor always names a row that exists, so resuming is exact rather than
approximate — you do not have to reconcile against `items` afterwards.

You will miss the typing animation from the gap. You will not miss anything
that happened: `agent.text` is a transient stream of deltas, and its settled
form `agent.message` is durable and replayed.

## Let it go idle

Do nothing for a while. The workspace pauses:

```bash
curl -s "$GOBARE_API/v1/sessions/$SID" -H "Authorization: Bearer $GOBARE_TOKEN" | jq -r .environment.state
# running → paused
```

The filesystem is snapshotted. The computer stops costing you anything.

## Come back and say the next thing

```bash
curl -s -X POST "$GOBARE_API/v1/sessions/$SID/events" \
  -H "Authorization: Bearer $GOBARE_TOKEN" -H 'content-type: application/json' \
  -d '{"events":[{"type":"input.message","content":"Add pytest coverage for that API, including the case where the robot id does not exist."}]}'
```

No resume call, no replaying history, no re-explaining. Sending the message
wakes the workspace, and "that API" means something to the agent because the
transcript was never in the workspace to begin with.

## Check that it really remembered

```bash
curl -s "$GOBARE_API/v1/sessions/$SID/items?limit=200&order=asc" \
  -H "Authorization: Bearer $GOBARE_TOKEN"
```

Both rounds appear as one continuous record.

## You have it working when

- The second round lands without you restating anything, and the reply refers
  to what was built in the first
- `environment.state` went `running → paused → running` on its own
- `items` is continuous across both rounds
- After reconnecting with `last_event_id`, the events you receive are strictly
  increasing and none are repeated

## What to know

**A workspace lives two hours.** That is the computer's lifetime, not the
turn's — a single turn may run a long time. Work that spans days should be
several sessions, with anything worth keeping written to `/workspace/outputs`
so it becomes an artifact.

**Idle pause is a deployment setting.** You cannot tune it per session.

**Snapshots restore files, not processes.** A server the agent started is not
running after a wake. Ask it to start the server again in the next turn.

**Artifacts outlive the workspace.** Anything under `/workspace/outputs` is
published when the turn settles and remains downloadable after the computer is
gone.
