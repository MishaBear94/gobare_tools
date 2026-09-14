# Continue work across hours and rounds

Some jobs are not one request. You ask for something, look at what came back,
go to lunch, and ask for the next piece. In between, the workspace may have
been paused and its computer released.

What you build here: a session you can come back to. The conversation does not
restart, the files are still there, and the second round knows what the first
one did.

```
round 1  →  workspace pauses (free)  →  round 2 wakes it  →  same files, same context
```

## Before you start

A token and a model, as in the [quickstart](../quickstart.md). Nothing else —
continuity is the default, not a feature you turn on.

## The whole thing

```tab:python
import json, os, time, urllib.request

API, TOKEN = os.environ["GOBARE_API"], os.environ["GOBARE_TOKEN"]
AUTH = {"Authorization": "Bearer " + TOKEN, "content-type": "application/json"}

def call(method, path, body=None):
    return json.load(urllib.request.urlopen(urllib.request.Request(
        API + path, data=json.dumps(body).encode() if body is not None else None,
        headers=AUTH, method=method)))

def say(session_id, text):
    """Send a message and wait for the round to finish."""
    call("POST", f"/v1/sessions/{session_id}/events",
         {"events": [{"type": "input.message", "content": text}]})
    while True:
        turn = call("GET", f"/v1/sessions/{session_id}/turns?limit=1")["data"][0]
        if turn["status"] != "working" and turn["artifacts"] != "pending":
            return turn
        time.sleep(5)

session = call("POST", "/v1/sessions", {"agent": {
    "model": "MiniMax-M3",
    # True of every round. The task itself goes in the message.
    "instructions": "Write Python with type hints. Run what you write before "
                    "calling it done. Never ask the user a clarifying question: "
                    "state your assumption and continue.",
}})
sid = session["id"]
print("session", sid)

say(sid, "Build /workspace/robots.py: a warehouse robot status API with "
         "GET /robots/<id>/status returning battery and current task. Smoke test it.")

state = call("GET", f"/v1/sessions/{sid}")["environment"]["state"]
print("after round 1:", state)

# …hours later, in a different process. All you kept was the session id.
say(sid, "Add pytest coverage for that API, including the case where the "
         "robot id does not exist.")

print("after round 2:", call("GET", f"/v1/sessions/{sid}")["environment"]["state"])
items = call("GET", f"/v1/sessions/{sid}/items?limit=200&order=asc")["data"]
print(f"{len(items)} items across both rounds, one continuous record")
```
```tab:typescript
const { GOBARE_API: API, GOBARE_TOKEN: TOKEN } = process.env as Record<string, string>;
const AUTH = { Authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

async function call(method: string, path: string, body?: unknown) {
  const response = await fetch(API + path, {
    method,
    headers: AUTH,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status} ${await response.text()}`);
  return response.json();
}

/** Send a message and wait for the round to finish. */
async function say(sessionId: string, text: string) {
  await call("POST", `/v1/sessions/${sessionId}/events`, {
    events: [{ type: "input.message", content: text }],
  });
  for (;;) {
    const [turn] = (await call("GET", `/v1/sessions/${sessionId}/turns?limit=1`)).data;
    if (turn && turn.status !== "working" && turn.artifacts !== "pending") return turn;
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}

const session = await call("POST", "/v1/sessions", {
  agent: {
    model: "MiniMax-M3",
    // True of every round. The task itself goes in the message.
    instructions:
      "Write TypeScript with explicit types. Run what you write before calling it done. " +
      "Never ask the user a clarifying question: state your assumption and continue.",
  },
});
console.log("session", session.id);

await say(session.id, "Build /workspace/robots.ts: a warehouse robot status API with " +
  "GET /robots/:id/status returning battery and current task. Smoke test it.");

console.log("after round 1:", (await call("GET", `/v1/sessions/${session.id}`)).environment.state);

// …hours later, in a different process. All you kept was the session id.
await say(session.id, "Add test coverage for that API, including the case where the robot id does not exist.");

console.log("after round 2:", (await call("GET", `/v1/sessions/${session.id}`)).environment.state);
const { data: items } = await call("GET", `/v1/sessions/${session.id}/items?limit=200&order=asc`);
console.log(`${items.length} items across both rounds, one continuous record`);
```

Nothing in round two restates round one. **"That API" means something to the
agent** because the transcript lives in the control plane, not in the
workspace — so releasing the computer costs you nothing but the time to wake it.

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

## When it goes wrong

| What you see | Why | Fix |
| --- | --- | --- |
| The agent does not remember round one | You created a new session instead of reusing the id | Keep the session id; that *is* the continuity |
| A server it started is gone after a wake | Snapshots restore files, not processes | Ask it to start the server again in the next round |
| `environment.state` is `destroyed` | The workspace passed its two-hour lifetime | Send the next message anyway; it is rebuilt on demand |
| Files from round one are missing after a rebuild | A rebuilt workspace is not a restored one | Anything worth keeping goes to `/workspace/outputs` — artifacts outlive the computer |
| The first round is still running | Sending again queues behind it rather than interrupting | That is deliberate; to change course mid-turn use [`input.steer`](../input.md) |
