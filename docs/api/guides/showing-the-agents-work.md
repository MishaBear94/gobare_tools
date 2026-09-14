# Stream the agent's progress into your UI

> Published from the Gobare product repository. The canonical page is
> <https://docs.gobare.dev/guides/showing-the-agents-work> — read it there; this copy is for offline and for tooling.

Your users are watching an agent work. A spinner and the word "processing" is a
poor showing — what they want is what it is reading, what it changed, what it
ran, and what came out, with the ability to scroll back afterwards.

This page builds that: a live feed, resumable across a dropped connection.

## Before you start

A token and a model, as in the [quickstart](../quickstart.md). The stream is
plain [Server-Sent Events](https://developer.mozilla.org/docs/Web/API/Server-sent_events)
over HTTP — every language has a client, and the one below is thirty lines of
standard library.

## The whole thing

```tab:python
import json, os, threading, urllib.request

API, TOKEN = os.environ["GOBARE_API"], os.environ["GOBARE_TOKEN"]
AUTH = {"Authorization": "Bearer " + TOKEN, "content-type": "application/json"}

def post(path, body):
    return json.load(urllib.request.urlopen(
        urllib.request.Request(API + path, data=json.dumps(body).encode(),
                               headers=AUTH, method="POST")))

def stream(session_id, on_frame, last_event_id=None, until="turn.ended"):
    """Read events until `until` arrives. Returns the cursor to resume from."""
    url = f"{API}/v1/sessions/{session_id}/events"
    if last_event_id is not None:
        url += f"?last_event_id={last_event_id}"
    cursor, event_id = last_event_id, None
    with urllib.request.urlopen(urllib.request.Request(url, headers=AUTH)) as r:
        for raw in r:
            line = raw.decode().rstrip("\n")
            if line.startswith("id: "):
                event_id = int(line[4:])       # durable: replayable on reconnect
            elif line.startswith("data: "):
                frame = json.loads(line[6:])
                on_frame(frame, event_id)
                if event_id is not None:
                    cursor = event_id          # only durable ids are resumable
                event_id = None
                if frame["type"] == until:
                    return cursor
    return cursor

def render(frame, event_id):
    kind, p = frame["type"], frame.get("payload") or {}
    at = "·" if event_id is None else str(event_id)   # · means transient
    if kind == "agent.text":         print(p.get("delta", ""), end="", flush=True)
    elif kind == "agent.message":    print(f"\n[{at}] ─ settled")
    elif kind == "agent.tool_call":  print(f"\n[{at}] $ {p.get('toolName')}")
    elif kind == "file.changed":     print(f"[{at}] ~ {p.get('path')}")
    elif kind == "artifact.created": print(f"[{at}] + {p.get('path')} ({p.get('size_bytes')} bytes)")
    elif kind == "preview.ready":    print(f"[{at}] ▶ {p.get('url')}")
    else:                            print(f"[{at}] {kind}")

sid = post("/v1/sessions", {"agent": {"model": "MiniMax-M3"}})["id"]

# Subscribe FIRST, then send. The other order loses the opening frames.
result = {}
reader = threading.Thread(
    target=lambda: result.update(cursor=stream(sid, render)), daemon=True)
reader.start()

post(f"/v1/sessions/{sid}/events", {"events": [{
    "type": "input.message",
    "content": "Write /workspace/app.py, a minimal HTTP service returning "
               "{\"ok\":true}. Run it once to prove it answers and write the "
               "output to /workspace/outputs/proof.txt.",
}]})
reader.join(timeout=300)
print("\n\nresume from:", result.get("cursor"))
```
```tab:typescript
const { GOBARE_API: API, GOBARE_TOKEN: TOKEN } = process.env as Record<string, string>;
const AUTH = { Authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

async function post(path: string, body: unknown) {
  const response = await fetch(API + path, { method: "POST", headers: AUTH, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`POST ${path} → ${response.status} ${await response.text()}`);
  return response.json();
}

/** Read events until `until` arrives. Returns the cursor to resume from. */
async function stream(
  sessionId: string,
  onFrame: (frame: any, eventId: number | null) => void,
  { lastEventId = null as number | null, until = "turn.ended" } = {},
) {
  let url = `${API}/v1/sessions/${sessionId}/events`;
  if (lastEventId !== null) url += `?last_event_id=${lastEventId}`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });

  let cursor = lastEventId;
  let eventId: number | null = null;
  let buffer = "";
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();

  for (;;) {
    const { done, value } = await reader.read();
    if (done) return cursor;
    buffer += decoder.decode(value, { stream: true });
    // A frame ends at a blank line; chunk boundaries fall anywhere, so the
    // remainder is kept rather than parsed.
    let split: number;
    while ((split = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      for (const line of block.split("\n")) {
        if (line.startsWith("id: ")) eventId = Number(line.slice(4));  // durable
        else if (line.startsWith("data: ")) {
          const frame = JSON.parse(line.slice(6));
          onFrame(frame, eventId);
          if (eventId !== null) cursor = eventId;                      // only durable ids resume
          eventId = null;
          if (frame.type === until) {
            await reader.cancel();
            return cursor;
          }
        }
      }
    }
  }
}

function render(frame: any, eventId: number | null) {
  const p = frame.payload ?? {};
  const at = eventId === null ? "·" : String(eventId);   // · means transient
  if (frame.type === "agent.text") process.stdout.write(p.delta ?? "");
  else if (frame.type === "agent.message") console.log(`\n[${at}] ─ settled`);
  else if (frame.type === "agent.tool_call") console.log(`\n[${at}] $ ${p.toolName}`);
  else if (frame.type === "file.changed") console.log(`[${at}] ~ ${p.path}`);
  else if (frame.type === "artifact.created") console.log(`[${at}] + ${p.path} (${p.size_bytes} bytes)`);
  else if (frame.type === "preview.ready") console.log(`[${at}] ▶ ${p.url}`);
  else console.log(`[${at}] ${frame.type}`);
}

const session = await post("/v1/sessions", { agent: { model: "MiniMax-M3" } });

// Subscribe FIRST, then send. The other order loses the opening frames.
const watching = stream(session.id, render);

await post(`/v1/sessions/${session.id}/events`, {
  events: [{
    type: "input.message",
    content: 'Write /workspace/app.py, a minimal HTTP service returning {"ok":true}. ' +
             "Run it once to prove it answers and write the output to /workspace/outputs/proof.txt.",
  }],
});

console.log("\n\nresume from:", await watching);
```

**Subscribe before you send.** Subscribing after loses the opening frames
whenever the agent starts quickly — a bug that never reproduces on a
developer's machine and always reproduces in production.

## What arrives

The run above, counted frame by frame:

| Type | Count | Durable | What it is for |
| --- | ---: | ---: | --- |
| `user.message` | 1 | 1 | Your message, recorded |
| `sandbox.created` | 1 | 1 | The workspace is up |
| `turn.started` | 1 | 1 | Work begins |
| `agent.text` | 47 | **0** | The reply, a fragment at a time |
| `agent.message` | 2 | 2 | The same reply, settled |
| `agent.tool_call` | 5 | 5 | What it is about to run |
| `agent.tool_result` | 5 | 5 | What it got back |
| `file.changed` | 1 | 1 | Something in the workspace changed |
| `preview.ready` | 1 | 1 | A service it started is answering |
| `turn.ended` | 1 | 1 | This round is over |

Forty-seven of the seventy-five frames were text deltas, and **not one of them
was durable**. That is the shape of every run: most of the traffic is
animation, and all of the facts are in the rest.

A given run shows a subset of the full vocabulary, depending on what the agent
does and which model you are on.

## Which frames you can build on

One rule: **look for `id:`**.

```
id: 23686                   ← durable
data: {"object":"event","type":"agent.message","seq":23686,
       "created_at":1789319090764,"payload":{"text":"done"}}

                            ← transient: no id: line
data: {"object":"event","type":"agent.text","seq":null,
       "created_at":1789319090560,"payload":{"delta":"done"}}
```

Note the payload keys differ: a delta carries `payload.delta`, the settled
message carries `payload.text`. Rendering a delta by reading `payload.text`
prints nothing at all, silently — which is a mistake this page made until it
was run.

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

Every durable event after that id, then live frames. The script above returns
the cursor when it finishes — `resume from: 23781` — so remembering one integer
is the whole of crash recovery. No reconciliation pass, no diffing against
`/items`.

What you do **not** get back are the text deltas: the animation from a
disconnected period is gone, and the `agent.message` it settled into is
replayed in its place. Which is why the state machine runs on durable frames.

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

## When it goes wrong

| What you see | Why | Fix |
| --- | --- | --- |
| The first frames are missing | You sent the message before subscribing | Subscribe first; the script starts the reader before it posts |
| Nothing prints for `agent.text` | Reading `payload.text` instead of `payload.delta` | Deltas carry `delta`; settled messages carry `text` |
| Duplicated UI state after a reconnect | Driving state from transient frames | Key your state on `seq`; ignore frames without one |
| The stream just ends | The turn finished, or the connection dropped | Reconnect with `last_event_id`; nothing durable is lost |
| `429` opening a stream | The per-organization stream ceiling | Hold one stream per user, not one per component — [limits.md](../limits.md) |
| Terminal output never appears | It is not on this stream | You get what a command returned via `agent.tool_result`, not line by line |
