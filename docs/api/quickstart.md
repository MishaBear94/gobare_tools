# Quickstart

From nothing to a completed turn. Every call below is one this API actually
answers; the sequence is the one the release acceptance runs.

## 1. Connect a model

The API runs an agent against a model credential your organization owns. In the
Console, **Settings → LLM models**, connect one. The connection is verified
against the provider when you save it, so a wrong key fails there rather than
inside your first turn.

Note the credential's id if you want to name it explicitly. A session created
without one uses the organization's default.

You can also do this entirely from the terminal, once you have a token — see
[model-credentials.md](model-credentials.md):

```bash
curl -s -X POST $GOBARE_API/v1/model-credentials \
  -H "Authorization: Bearer $GOBARE_TOKEN" -H 'content-type: application/json' \
  -d '{"key":"sk-ant-api03-…"}'
```

Either way, read back what the organization has, rather than copying an id out
of a browser:

```bash
curl -s $GOBARE_API/v1/model-credentials -H "Authorization: Bearer $GOBARE_TOKEN"
```

```json
{"object":"list","data":[
  {"object":"model_credential","id":"cred_8f2a91c4d7b0e6","label":"MiniMax",
   "connector":"minimax","model":"MiniMax-M3","is_default":true}]}
```

The `model` is what goes in `agent.model`. Asking for one this organization has
not connected is refused by name, and so is naming a credential id that is not
one of its own.

## 2. Get a token

**If you have just signed up, you already have one.** A read/write key is
minted when your account first gets a workspace, and the screen you land on
after signing in hands it over. It is shown once and does not expire; Settings
lists it as created at signup, and you can revoke it there.

If you missed it, or you want a second one, mint it yourself: **Settings →
Developer access**, name it, choose **Agent API · read/write**, create. The
full value is shown once.

The kind matters. The default is **CLI import**, which holds only the `cli`
scope and is refused by every `/v1` route — that default exists so tokens
minted before this API existed keep doing exactly what they did. Choose
**Agent API · read** if your integration only watches.

```bash
export GOBARE_TOKEN=gbr_pat_...
export GOBARE_API=https://api.gobare.dev
```

Check what you have:

```bash
curl -s $GOBARE_API/v1/health -H "Authorization: Bearer $GOBARE_TOKEN"
```

```json
{"object":"health","status":"ok","version":"v1",
 "scopes":["sessions:read","sessions:write","tools:respond","artifacts:read","credentials:write"]}
```

`/v1/health` answers for any valid token, whatever its scopes — it is how you
find out what a token can do without guessing.

### What each scope unlocks

| Scope | Endpoints |
| --- | --- |
| `sessions:read` | Reading sessions, turns, items, agents, webhook subscriptions, model connections, and both event streams |
| `sessions:write` | Creating, renaming and deleting sessions; sending input (`input.message`, `input.steer`, `input.cancel`); replacing tools; agents; **creating and deleting webhook subscriptions** |
| `tools:respond` | `input.tool_result` — answering a required action, and nothing else |
| `artifacts:read` | Listing and downloading artifacts. **Not deleting** — that is `sessions:write`, because a scope named read must not destroy anything |
| `credentials:write` | Connecting and removing model providers |
| `cli` | `gobare pi import` only. Refused by every `/v1` route |

A call missing its scope is `403 permission_denied`, and the message names the
scope it wanted — so you never have to guess which one you left out.

`sessions:read` + `artifacts:read` is the read-only shape, and it really is
read-only: nothing it holds can delete, cancel or write.

`sessions:read` + `tools:respond` is a worker: it can watch a session and answer
its function calls, and it cannot send a message, cancel a turn or delete
anything. That is the token to give a fleet of tool handlers. The two scopes are
exact in both directions — `sessions:write` alone does not answer a tool call,
and `tools:respond` alone does not drive a session.

## 3. Set up your caller

Pick your language once — the rest of this page, and the whole site, follows
your choice.

```tab:bash
export GOBARE_API=https://api.gobare.dev
export GOBARE_TOKEN=gbr_pat_...
```
```tab:typescript
import { createWriteStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const API = process.env.GOBARE_API ?? "https://api.gobare.dev";
const TOKEN = process.env.GOBARE_TOKEN!;

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${API}/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status} ${await response.text()}`);
  return response.json();
}
```
```tab:python
import json, os, shutil, tarfile, time, urllib.request, uuid

API = os.environ.get("GOBARE_API", "https://api.gobare.dev")
TOKEN = os.environ["GOBARE_TOKEN"]

def call(method, path, body=None, headers=None):
    request = urllib.request.Request(
        API + "/v1" + path,
        data=None if body is None else json.dumps(body).encode(),
        method=method,
        headers={
            "authorization": "Bearer " + TOKEN,
            **({} if body is None else {"content-type": "application/json"}),
            **(headers or {}),
        },
    )
    with urllib.request.urlopen(request) as response:
        return json.load(response)
```

Nothing to install: `fetch` and `urllib` are in the runtime you already have.
When the [TypeScript](typescript.md) and [Python](python.md) clients ship, they
replace this helper and nothing else on the page changes.

## 4. Create a session

```tab:bash
curl -s -X POST $GOBARE_API/v1/sessions \
  -H "Authorization: Bearer $GOBARE_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"agent":{"model":"MiniMax-M3"}}'
```
```tab:typescript
const session = await call("POST", "/sessions", { agent: { model: "MiniMax-M3" } });
```
```tab:python
session = call("POST", "/sessions", {"agent": {"model": "MiniMax-M3"}})
```

```json
{"object":"session","id":"3f9c1b60-4e2a-4d18-9a77-6c0b2e5d81af","status":"idle",
 "agent":{"model":"MiniMax-M3","model_credential_id":"cred_8f2a91c4d7b0e6","approval_mode":"auto"},
 "environment":{"type":"sandbox","state":"unknown","workspace_directory":"/workspace","repo":null},
 "preview":{"url":null,"port":null,"published_url":null},
 "required_actions":[]}
```

A session is a cloud computer. It is created immediately; its sandbox comes up
behind it, which is what `environment.state` reports:

| | |
| --- | --- |
| `unknown` | It has not reported yet. This is what you see right after creating one |
| `running` | Up and usable |
| `paused` | Idle, and woken by the next thing you send |
| `destroyed` | Reclaimed. It is rebuilt on demand |
| `recovering` | Being rebuilt |
| `recovery_failed` | The rebuild gave up — see `preview.recovery` and the session's events |

`preview.published_url` above is null because nothing is published yet; see
[preview.md](preview.md) for putting what the agent is serving at a public
address.

You do not have to wait for `running` before sending work: a message queues
against a session in any of these states and the workspace comes up to serve
it. Poll it only if you want to show someone what is happening.

A model is the only thing it needs. When you want this session to hold your
repository, your files, your secrets, or a limit on what the agent may do
without asking, that is all in [configuring a session](sessions.md) — and none
of it is required to finish this page.

## 5. Send work

```tab:bash
curl -s -X POST $GOBARE_API/v1/sessions/$SESSION/events \
  -H "Authorization: Bearer $GOBARE_TOKEN" \
  -H 'content-type: application/json' \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"events":[{"type":"input.message",
       "content":[{"type":"input_text","text":"Create /workspace/outputs/report.md summarising this workspace, then tell me what you found."}]}]}'
```
```tab:typescript
await call(
  "POST",
  `/sessions/${session.id}/events`,
  { events: [{ type: "input.message", content: "Create /workspace/outputs/report.md summarising this workspace, then tell me what you found." }] },
  { "idempotency-key": crypto.randomUUID() },
);
```
```tab:python
call(
    "POST",
    f"/sessions/{session['id']}/events",
    {"events": [{"type": "input.message", "content": "Create /workspace/outputs/report.md summarising this workspace, then tell me what you found."}]},
    {"idempotency-key": str(uuid.uuid4())},
)
```

```json
{"object":"input.accepted","session_id":"3f9c1b60-4e2a-4d18-9a77-6c0b2e5d81af","type":"input.message",
 "queued":false,"queue_position":null}
```

`202`, not `200`: the agent has the work, not the answer. `queued: true` means
a turn was already running and yours will follow it — accepted, not rejected.

`content` also accepts a plain string. Send one event per request.

`outputs` is not decoration. Anything the agent writes under
`/workspace/outputs` is published as an artifact you can download later;
anything it writes elsewhere lives and dies with the workspace. Step 8 is the
difference.

The other three things you can send — a tool result, a steer, a stop — are in
[input.md](input.md).

## 6. Wait for the turn

A turn is one run of the agent. Poll it, or read [events.md](events.md) and
stream instead.

```tab:bash
# A turn appears a moment after the message, and settles later still — so the
# list is briefly empty. `// "pending"` is that moment, not a status the API sends.
while :; do
  STATUS=$(curl -s "$GOBARE_API/v1/sessions/$SESSION/turns?limit=1" \
    -H "Authorization: Bearer $GOBARE_TOKEN" | jq -r '.data[0].status // "pending"')
  [ "$STATUS" = "pending" ] || [ "$STATUS" = "working" ] || break
  sleep 3
done
```
```tab:typescript
// A turn appears a moment after the message, so the list is briefly empty.
let turn;
for (;;) {
  [turn] = (await call("GET", `/sessions/${session.id}/turns?limit=1`)).data;
  if (turn && turn.status !== "working") break;
  await new Promise((resolve) => setTimeout(resolve, 3000));
}
```
```tab:python
# A turn appears a moment after the message, so the list is briefly empty.
while True:
    turns = call("GET", f"/sessions/{session['id']}/turns?limit=1")["data"]
    turn = turns[0] if turns else None
    if turn and turn["status"] != "working":
        break
    time.sleep(3)
```

```json
{"object":"list","data":[{"object":"turn","id":"turn_9d41c7e0a8b24f36","session_id":"3f9c1b60-4e2a-4d18-9a77-6c0b2e5d81af",
  "status":"working","created_at":1789…,"started_at":1789…,"completed_at":null,
  "subagent_id":null,"error":null}],"has_more":false,"last_id":"turn_9d41c7e0a8b24f36"}
```

`status` is `working` until it settles, then `completed`, `failed` or
`cancelled`. There is no fourth value: **a turn parked on you is still
`working`.** What changes when the agent needs an answer is the *session* —
`status` becomes `requires_action` and `required_actions` fills in. Poll that,
not this. See [required-actions.md](required-actions.md).

A cold sandbox makes the first turn minutes rather than seconds.

One turn, by id, when you have kept one and want its current state without a
list around it:

```tab:bash
curl -s $GOBARE_API/v1/sessions/$SESSION/turns/$TURN \
  -H "Authorization: Bearer $GOBARE_TOKEN"
```
```tab:typescript
const current = await call("GET", `/sessions/${session.id}/turns/${turn.id}`);
```
```tab:python
current = call("GET", f"/sessions/{session['id']}/turns/{turn['id']}")
```

It carries the same fields as the list entry — including `artifacts`, which is
what step 8 waits on.

## 7. Read what happened

```tab:bash
curl -s "$GOBARE_API/v1/sessions/$SESSION/items?limit=100" \
  -H "Authorization: Bearer $GOBARE_TOKEN"
```
```tab:typescript
const { data: items } = await call("GET", `/sessions/${session.id}/items?limit=100`);
```
```tab:python
items = call("GET", f"/sessions/{session['id']}/items?limit=100")["data"]
```

Items are the durable record: `message`, `tool_call`, `command_execution`,
`file_change`, `approval`, `question`, `mcp_unavailable`, `error`. A `message`
carries `role` and `content`; the rest carry a type-specific `detail`.

`error` is the one to look for when a session reports `failed` and you find no
turns: a run that could not start leaves no turn behind, and this item says
why — `detail.message`. It used to be on the event stream only, so an
integration that polls had nothing to read.

This is the transcript, and it outlives the sandbox.

## 8. Collect the output

Anything the agent writes to `/workspace/outputs` is published when the turn
settles, and stays readable after the sandbox is gone.

```tab:bash
curl -s $GOBARE_API/v1/sessions/$SESSION/artifacts -H "Authorization: Bearer $GOBARE_TOKEN"
curl -s $GOBARE_API/v1/sessions/$SESSION/artifacts/$ARTIFACT/content \
  -H "Authorization: Bearer $GOBARE_TOKEN" -o report.md
```
```tab:typescript
const { data: artifacts } = await call("GET", `/sessions/${session.id}/artifacts`);

// Bytes, not JSON — so this one goes around the helper.
const file = await fetch(`${API}/v1/sessions/${session.id}/artifacts/${artifacts[0].id}/content`, {
  headers: { authorization: `Bearer ${TOKEN}` },
});
await writeFile("report.md", Buffer.from(await file.arrayBuffer()));
```
```tab:python
artifacts = call("GET", f"/sessions/{session['id']}/artifacts")["data"]

# Bytes, not JSON — so this one goes around the helper.
request = urllib.request.Request(
    f"{API}/v1/sessions/{session['id']}/artifacts/{artifacts[0]['id']}/content",
    headers={"authorization": "Bearer " + TOKEN},
)
with urllib.request.urlopen(request) as body, open("report.md", "wb") as out:
    shutil.copyfileobj(body, out)
```

When a turn produced more than one file, take them all at once:

```tab:bash
curl -s "$GOBARE_API/v1/sessions/$SESSION/artifacts/archive" \
  -H "Authorization: Bearer $GOBARE_TOKEN" | tar -x -C ./out
```
```tab:typescript
const archive = await fetch(`${API}/v1/sessions/${session.id}/artifacts/archive`, {
  headers: { authorization: `Bearer ${TOKEN}` },
});
await pipeline(Readable.fromWeb(archive.body!), createWriteStream("out.tar"));
```
```tab:python
request = urllib.request.Request(
    f"{API}/v1/sessions/{session['id']}/artifacts/archive",
    headers={"authorization": "Bearer " + TOKEN},
)
with urllib.request.urlopen(request) as body:
    # filter="data" is the safe extraction Python 3.14 makes the default; without
    # it this warns today and changes behaviour then.
    tarfile.open(fileobj=body, mode="r|").extractall("out", filter="data")
```

A tar, streamed. Add `?turn_id=…` to narrow it to one turn, and the entries
carry the workspace's own paths. Without it you get the whole session, and each
entry is prefixed with the turn that published it — two turns writing
`report.md` are two files, and a flat archive would extract as one.

## 9. Clean up

```tab:bash
curl -s -X DELETE $GOBARE_API/v1/sessions/$SESSION -H "Authorization: Bearer $GOBARE_TOKEN"
```
```tab:typescript
await call("DELETE", `/sessions/${session.id}`);
```
```tab:python
call("DELETE", f"/sessions/{session['id']}")
```

Deleting a session destroys its sandbox. Concurrent sessions are capped — see
[limits.md](limits.md) — so a client that creates and never deletes will stop
being able to create.

## Full example in TypeScript

Everything above is one call each. In practice you want the loop: subscribe,
send, answer whatever the agent asks you, resume if the connection drops. That
loop is [`run-session.ts`](https://github.com/MishaBear94/gobare_tools/blob/main/docs/api/run-session.ts)
— copy it into your project and use it:

<!-- gobare:runsession-usage -->
```ts
import { runSession } from "./run-session"

const result = await runSession({
  baseUrl: "https://api.gobare.dev",
  token: process.env.GOBARE_TOKEN!,
  input: "Look up order A-4471 and write what you find to /workspace/outputs/report.md.",
  session: {
    agent: {
      model: "MiniMax-M3",
      // Declaring the tool is what makes the agent able to call it. `handlers`
      // below only says which function answers — without this the agent never
      // learns `lookup_order` exists, and your handler is never reached.
      tools: [{
        type: "function",
        name: "lookup_order",
        description: "Fetch an order from the billing system by id.",
        parameters: {
          type: "object",
          properties: { order_id: { type: "string" } },
          required: ["order_id"],
          additionalProperties: false,
        },
      }],
    },
  },
  handlers: {
    lookup_order: async (args) => JSON.stringify(await billing.find((args as any).order_id)),
  },
  onEvent: (event) => console.log(event.type),
})

if (result.status !== "completed") throw new Error(`turn ${result.status}: ${result.error?.message}`)
console.log(result.text)
```
<!-- /gobare:runsession-usage -->

It is not a package, on purpose — see [design-decisions.md](design-decisions.md). It is
also not a transcription: the same file is what `pnpm e2e:v1:minimax` runs
against production, so it cannot rot without a test going red.

The tool is declared in two halves, and both are required: `agent.tools` is
what the *model* is told about, and `handlers` is what *your process* answers
with. Declaring without a handler parks the turn on a call nobody answers;
handling without a declaration means the call never happens.

To work on a repository, add `environment: { repo: "acme/site" }` — your
organization needs a GitHub connection first, or the request is refused up
front.

Three things it does that are easy to get wrong by hand, and wrong silently:

- **Subscribes before sending.** The other order loses the opening events
  whenever the agent starts quickly — which is to say sometimes.
- **Answers required actions.** Left unanswered, a turn stays `working` and the
  session stays `requires_action` for as long as the workspace lives — nothing
  times it out, and nothing else moves until you answer.
- **Never sends a thrown handler's message to the model.** A stack trace is an
  excellent way to put your database host into a model's context, so a failing
  handler yields a fixed string instead.

And one thing a generated client would not: it **resumes**. A dropped
connection continues from `Last-Event-ID` rather than starting over or losing
the middle. See [events.md](events.md).

## Artifacts

Anything the agent writes under `/workspace/outputs` is published as an
artifact — a durable copy that outlives the workspace.

Publishing happens **after** the turn settles, so that a storage problem can
never delay or fail your work. That means `status: "completed"` is not yet a
promise that `GET /v1/sessions/{id}/artifacts` will list anything. The turn
tells you which it is:

| `turn.artifacts` | |
| --- | --- |
| `null` | The turn has not settled, or predates this field |
| `pending` | Settled; publication is still running. An empty list here means *not yet* |
| `ready` | Publication finished. An empty list here means the turn produced nothing |
| `failed` | Publication could not run. Quote the turn id when reporting it |

```bash
# Wait for the artifacts, not merely for the turn.
until [ "$(curl -s "$GOBARE_API/v1/sessions/$SID/turns?limit=1" \
  -H "Authorization: Bearer $GOBARE_TOKEN" | jq -r '.data[0].artifacts')" != "pending" ]; do sleep 1; done
curl -s "$GOBARE_API/v1/sessions/$SID/artifacts" -H "Authorization: Bearer $GOBARE_TOKEN"
```

The `turn.completed` **webhook** already waits for you: it is sent once
publication settles, so an unattended integration can fetch artifacts the
moment it is called. If publication is still running after 30 seconds the
notification is sent anyway, with the turn still reading `pending` — a late
answer being better than none.

## Next

You have a session, a turn and its output. Where to go depends on what you are
building:

- [guides](guides/README.md) — six complete programs: documents to JSON, an agent behind your API, approvals, live progress
- [sessions.md](sessions.md) — your repository, your files, your secrets, limits on what the agent may do
- [agents.md](agents.md) — save this configuration under a name and reuse it
- [events.md](events.md) — stream instead of polling, and resume where you dropped
- [required-actions.md](required-actions.md) — let the agent call your code
- [webhooks.md](webhooks.md) — be told instead of watching
- [pagination.md](pagination.md) — paging any collection, and finding a session by your own job id

If a step above did not do what this page says it would,
[troubleshooting.md](troubleshooting.md) is arranged by symptom, and
[errors.md](errors.md) is the shape every refusal arrives in.
