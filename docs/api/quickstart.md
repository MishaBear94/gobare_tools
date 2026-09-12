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

## 2. Mint a token

**Settings → Developer access.** Name the token, choose **Agent API ·
read/write**, and create it. The full value is shown once.

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
 "scopes":["sessions:read","sessions:write","tools:respond","artifacts:read"]}
```

`/v1/health` answers for any valid token, whatever its scopes — it is how you
find out what a token can do without guessing.

### What each scope unlocks

| Scope | Endpoints |
| --- | --- |
| `sessions:read` | Reading sessions, turns, items, and both event streams |
| `sessions:write` | Creating, renaming and deleting sessions; sending input; replacing tools; environment templates |
| `tools:respond` | `input.tool_result` — answering a required action |
| `artifacts:read` | Listing, downloading and deleting artifacts |
| `cli` | `gobare pi import` only. Refused by every `/v1` route |

A call missing its scope is `403 permission_denied`, and the message names the
scope it wanted — so you never have to guess which one you left out.

## 3. Create a session

```bash
curl -s -X POST $GOBARE_API/v1/sessions \
  -H "Authorization: Bearer $GOBARE_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"agent":{"model":"MiniMax-M3"}}'
```

```json
{"object":"session","id":"3f9c1b60-4e2a-4d18-9a77-6c0b2e5d81af","status":"idle",
 "agent":{"model":"MiniMax-M3","model_credential_id":"cred_8f2a91c4d7b0e6","approval_mode":"auto"},
 "environment":{"type":"sandbox","state":"starting","workspace_directory":"/workspace","repo":null},
 "preview":{"url":null,"port":null,"published_url":null},
 "required_actions":[]}
```

A session is a cloud computer. It is created immediately; its sandbox comes up
behind it, which is what `environment.state` reports.

### Creating and prompting in one call

Pass `input` and the session starts working immediately:

```bash
curl -s -X POST $GOBARE_API/v1/sessions \
  -H "Authorization: Bearer $GOBARE_TOKEN" -H 'content-type: application/json' \
  -d '{"agent":{"model":"MiniMax-M3"},"input":"Create /workspace/outputs/report.md about this repo."}'
```

**It is all or nothing.** A `201` means the session exists *and* the message was
accepted. If the message cannot be sent, the session is destroyed and you get
the send's error — so a non-2xx always means nothing exists and there is nothing
to clean up.

`input` takes the same shapes as `input.message` content: a plain string, or the
content-part array. The steps below then apply unchanged; skip step 4.

## 4. Send work

```bash
curl -s -X POST $GOBARE_API/v1/sessions/$SESSION/events \
  -H "Authorization: Bearer $GOBARE_TOKEN" \
  -H 'content-type: application/json' \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"events":[{"type":"input.message",
       "content":[{"type":"input_text","text":"Create /workspace/report.md summarising this repo, then tell me what you found."}]}]}'
```

```json
{"object":"input.accepted","session_id":"3f9c1b60-4e2a-4d18-9a77-6c0b2e5d81af","type":"input.message",
 "queued":false,"queue_position":null}
```

`202`, not `200`: the agent has the work, not the answer. `queued: true` means
a turn was already running and yours will follow it — accepted, not rejected.

`content` also accepts a plain string. Send one event per request.

## 5. Wait for the turn

A turn is one run of the agent. Poll it, or read [events.md](events.md) and
stream instead.

```bash
curl -s "$GOBARE_API/v1/sessions/$SESSION/turns?limit=1" \
  -H "Authorization: Bearer $GOBARE_TOKEN"
```

```json
{"object":"list","data":[{"object":"turn","id":"turn_9d41c7e0a8b24f36","session_id":"3f9c1b60-4e2a-4d18-9a77-6c0b2e5d81af",
  "status":"working","created_at":1789…,"started_at":1789…,"completed_at":null,
  "subagent_id":null,"error":null}],"has_more":false,"last_id":"turn_9d41c7e0a8b24f36"}
```

`status` moves `queued` → `working` → `completed`, or to `failed` or
`cancelled`. `waiting` means the turn has stopped and needs you — see
[required-actions.md](required-actions.md).

A cold sandbox makes the first turn minutes rather than seconds.

## 6. Read what happened

```bash
curl -s "$GOBARE_API/v1/sessions/$SESSION/items?limit=100" \
  -H "Authorization: Bearer $GOBARE_TOKEN"
```

Items are the durable record: `message`, `tool_call`, `command_execution`,
`file_change`, `approval`, `question`. A `message` carries `role` and
`content`; the rest carry a type-specific `detail`.

This is the transcript, and it outlives the sandbox.

## 7. Collect the output

Anything the agent writes to `/workspace/outputs` is published when the turn
settles, and stays readable after the sandbox is gone.

```bash
curl -s $GOBARE_API/v1/sessions/$SESSION/artifacts -H "Authorization: Bearer $GOBARE_TOKEN"
curl -s $GOBARE_API/v1/sessions/$SESSION/artifacts/$ARTIFACT/content \
  -H "Authorization: Bearer $GOBARE_TOKEN" -o report.md
```

## 8. Clean up

```bash
curl -s -X DELETE $GOBARE_API/v1/sessions/$SESSION -H "Authorization: Bearer $GOBARE_TOKEN"
```

Deleting a session destroys its sandbox. Concurrent sessions are capped — see
[limits.md](limits.md) — so a client that creates and never deletes will stop
being able to create.

## The whole thing, in TypeScript

```ts
const API = "https://api.gobare.dev";
const TOKEN = process.env.GOBARE_TOKEN!;

const call = async (path: string, init: RequestInit = {}) => {
  const response = await fetch(API + path, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...init.headers },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`${body.error.code}: ${body.error.message} (${body.error.request_id})`);
  return body;
};

const session = await call("/v1/sessions", {
  method: "POST",
  body: JSON.stringify({ agent: { model: "MiniMax-M3" } }),
});

await call(`/v1/sessions/${session.id}/events`, {
  method: "POST",
  headers: { "idempotency-key": crypto.randomUUID() },
  body: JSON.stringify({
    events: [{ type: "input.message", content: "Create /workspace/outputs/report.md about this repo." }],
  }),
});

// Poll until the turn settles. Streaming is nicer; see events.md.
const SETTLED = ["completed", "failed", "cancelled", "waiting"];
let turn;
do {
  await new Promise((r) => setTimeout(r, 5000));
  [turn] = (await call(`/v1/sessions/${session.id}/turns?limit=1`)).data;
} while (!turn || !SETTLED.includes(turn.status));

if (turn.status !== "completed") throw new Error(`turn ${turn.status}: ${JSON.stringify(turn.error)}`);

const { data: items } = await call(`/v1/sessions/${session.id}/items?limit=100`);
console.log(items.filter((i) => i.type === "message" && i.role === "assistant").at(-1)?.content);

const { data: artifacts } = await call(`/v1/sessions/${session.id}/artifacts`);
console.log(artifacts.map((a) => `${a.path} (${a.size_bytes} bytes)`));

await call(`/v1/sessions/${session.id}`, { method: "DELETE" });
```

Note the error handling. Every failure carries `error.code`, `error.message` and
`error.request_id`; branch on the code, and quote the request id when you ask us
about one. See [errors.md](errors.md).

## Paging

Every collection pages the same way, so learning it once is enough:

| Parameter | |
| --- | --- |
| `limit` | 1–100, default 20. Out of range is a `400`, not a silent clamp |
| `order` | `asc` or `desc`, default `desc` |
| `after` | The previous page's `last_id` |

```json
{"object":"list","data":[…],"has_more":true,"last_id":"turn_9d41c7e0a8b24f36"}
```

`has_more` is decided by looking one row further rather than by counting,
because these collections are written to while they are read. Page with
`?after=<last_id>` until `has_more` is false.

## Reusing a configuration

If every session you create should start the same way, save the configuration
once and name it:

```bash
curl -s -X POST $GOBARE_API/v1/environment-templates   -H "Authorization: Bearer $GOBARE_TOKEN" -H 'content-type: application/json'   -d '{"name":"support-bot","tools":[…],"text":{…}}'

curl -s -X POST $GOBARE_API/v1/sessions   -H "Authorization: Bearer $GOBARE_TOKEN" -H 'content-type: application/json'   -d '{"agent":{"model":"MiniMax-M3"},"environment":{"template_id":"envt_2b7d5e91c0a34f68"}}'
```

The create call answers with the template, including the id it was given:
`{"object":"environment_template","id":"envt_2b7d5e91c0a34f68","name":"support-bot",…}`.

`name` is a slug you choose — lowercase letters, digits, dot, dash or
underscore, up to 64 characters — and `id` is ours. **A session references the
id, not the name.** Posting the same name again replaces that template in place
and keeps its id, so a name is a stable handle to re-save against.

The template is **copied, not referenced**. A session keeps working the way it
was created even after the template changes or is deleted — which is what makes
a template a starting point rather than remote control over work already
running. Inline `agent.tools` wins outright over a template rather than merging,
because a half-merged tool list is ambiguous about which half won.

## Next

- [events.md](events.md) — stream instead of polling, and resume where you dropped
- [required-actions.md](required-actions.md) — let the agent call your code
- [webhooks.md](webhooks.md) — be told instead of watching
