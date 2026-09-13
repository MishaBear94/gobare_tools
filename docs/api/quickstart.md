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

### Everything a session can be given

`POST /v1/sessions` takes more than a model. Every field below is optional.

```bash
curl -s -X POST $GOBARE_API/v1/sessions \
  -H "Authorization: Bearer $GOBARE_TOKEN" -H 'content-type: application/json' \
  -d '{
    "agent": {
      "model": "MiniMax-M3",
      "instructions": "You maintain the acme/site repo. Prefer small commits. Never touch /infra.",
      "approval_mode": "read_only",
      "permission_rules": [{ "decision": "deny", "path": "/etc" }]
    },
    "environment": {
      "repo": "acme/site",
      "profiles": ["envg_2b7d5e91c0a34f68"]
    },
    "metadata": { "tenant": "acme", "run": "42" }
  }'
```

| Field | |
| --- | --- |
| `agent.model` / `agent.model_credential_id` | Which connected credential to run against. Omitted uses the organization's default |
| `agent.instructions` | Standing instructions for every turn, up to 32000 characters. Refused if longer, never truncated |
| `agent.approval_mode` | `auto`, `per_step`, `read_only` or `plan`. Default `auto`. An unknown value is refused, never defaulted |
| `agent.permission_rules` | Up to 50 rules, each `{decision, tool?, path?, command?, domain?}` where decision is `allow`, `deny` or `ask` |
| `agent.tools` / `agent.text` | Tools and output shaping — see the OpenAPI document |
| `environment.repo` | `owner/name`. Cloned when the workspace comes up |
| `environment.files` | Files to put in the workspace — see below |
| `environment.profiles` | Environment profile ids, from `GET /v1/environment-profiles` |
| `environment.template_id` | A saved configuration to start from |
| `metadata` | Your own labels: up to 16 keys, 64 characters per key, 512 per value |
| `input` | An opening message — see below |

`agent.instructions`, `agent.approval_mode`, `agent.permission_rules` and
`metadata` can also be changed later with `PATCH /v1/sessions/{id}`, which takes
any combination of those and `title`.

### Working on your own code

```json
{ "environment": { "repo": "acme/site" } }
```

Two things about this are worth knowing before you rely on it.

**A 201 does not mean the code is there.** The session is created immediately;
the clone happens when its workspace comes up, which is later. If it fails, the
session still starts with an empty workspace and the reason is on the session:

```json
{ "environment": { "repo": { "full_name": "acme/site", "branch": null,
                             "clone_error": "Repository not found" } } }
```

Read `environment.repo.clone_error` before concluding the agent ignored your
instructions.

**The branch is reported, not chosen.** The clone checks out the repository's
default branch and tells us which one that was; `environment.repo.branch` is
that answer. Sending `environment.branch` is refused rather than ignored,
because storing a value that changes nothing is worse than saying no.

Your organization needs a GitHub connection — Console, **Settings → App
integrations**. Without one, a request naming a repository is refused up front
rather than producing a session that can never clone.

### Handing the session files

Not every job is "work on my repo". When what you have is a CSV, a spec or a
PDF, send the bytes:

```json
{
  "environment": {
    "files": [
      { "type": "inline", "path": "/workspace/amounts.csv", "data": "YW1vdW50CjEwCjIwCg==" },
      { "type": "inline", "path": "notes.md", "data": "IyBOb3Rlcwo=" }
    ]
  }
}
```

`data` is base64 of the file's bytes. `path` may be absolute under
`/workspace` or relative to it — `notes.md` above lands at
`/workspace/notes.md`. A path that resolves outside the workspace is refused,
and the refusal tells you where it resolved to.

Ceilings are in [limits.md](limits.md): 5 MiB a file, 10 MiB a request, 50
files. Each applies to the decoded bytes, not the base64.

**A 201 does not mean the files are there** — same as the clone. They are
written when the workspace comes up, after the clone, so you can drop a config
file into a repository you also asked for.

**They are written only if not already present.** A sandbox that was paused and
woken keeps whatever the agent did to those files; one that had to be rebuilt
gets them again, because they are part of how the session was defined.

There is no `type: "file_id"` and no `type: "url"`. Gobare has no file store to
reference, and does not fetch addresses on your behalf. For a large input, use
`environment.repo`.

### Adding files later

The same shape, against a session that is already running:

```bash
curl -s -X POST $GOBARE_API/v1/sessions/$SESSION/files \
  -H "Authorization: Bearer $GOBARE_TOKEN" -H 'content-type: application/json' \
  -d "{\"files\":[{\"type\":\"inline\",\"path\":\"data/second.csv\",\"data\":\"$(base64 < second.csv)\"}]}"
```

The answer is what was written, not an acknowledgement — your next move is
usually to tell the agent to read it, and you need to know that is safe.

Two differences from `environment.files`:

**It overwrites.** A path that is already there is replaced, because that is
what you asked for. Seeded files are the opposite: they never overwrite.

**It is not remembered.** A live write is working state, not part of how the
session was defined, so a sandbox rebuilt from nothing will not have it. A
paused sandbox keeps it — and a paused session is woken to serve this call
rather than refusing it.

### Secrets the agent should have

Environment profiles are named groups of variables, managed in the Console.
Bind them by id:

```bash
curl -s $GOBARE_API/v1/environment-profiles -H "Authorization: Bearer $GOBARE_TOKEN"
```

```json
{"object":"list","data":[
  {"object":"environment_profile","id":"envg_2b7d5e91c0a34f68","name":"staging",
   "is_default":false,"variable_count":4}],"has_more":false,"last_id":"envg_2b7d5e91c0a34f68"}
```

```json
{ "environment": { "profiles": ["envg_2b7d5e91c0a34f68"] } }
```

**Values are never returned by this API**, and there is no endpoint to set
them. `variable_count` is there so you can recognise the profile you meant.
Omitting `profiles` inherits the organization's default group; sending an empty
list binds nothing.

A profile belonging to another organization answers `not_found` rather than a
permission error, so an id cannot be probed for existence.

### Telling the agent how you work

```json
{ "agent": { "instructions": "Prefer small commits. Never touch /infra." } }
```

These sit on top of the product's own rules rather than replacing them, and
they apply to every turn. Where your instructions and our safety rules
disagree, ours win — so `instructions` is how you shape an agent's behaviour,
and `approval_mode` and `permission_rules` below are how you constrain what it
may actually do. Two different jobs; instructions are not a permission system.

Two things worth knowing before you rely on them:

- **They take effect on the session's next workspace, not mid-turn.** The
  system prompt is fixed when the agent's session is built. A `PATCH` during a
  running turn is not ignored — it applies from the next one.
- **A session older than this feature refuses them.** Setting instructions on a
  workspace whose runtime predates them answers `bridge_incompatible` rather
  than accepting the field and running without it. Deleting the session and
  creating a new one gets you a current workspace.

Send `null` or `""` to clear them.

### How restricted the agent is

```json
{ "agent": { "approval_mode": "read_only" } }
```

| Mode | |
| --- | --- |
| `auto` | Acts without asking. The default, and what an unattended integration wants |
| `per_step` | Asks before each step. The approval arrives as a `required_action` of type `approval` |
| `read_only` | May read and reason, may not write |
| `plan` | Produces a plan without carrying it out |

`permission_rules` narrows further, and applies in every mode:

```json
{ "agent": { "permission_rules": [
  { "decision": "deny",  "path": "/etc" },
  { "decision": "ask",   "tool": "bash" },
  { "decision": "allow", "domain": "api.acme.com" }
] } }
```

Both are readable back on the session, so what a session enforces is never
something you have to remember having sent.

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

When a turn produced more than one file, take them all at once:

```bash
curl -s "$GOBARE_API/v1/sessions/$SESSION/artifacts/archive" \
  -H "Authorization: Bearer $GOBARE_TOKEN" | tar -x -C ./out
```

A tar, streamed. Add `?turn_id=…` to narrow it to one turn, and the entries
carry the workspace's own paths. Without it you get the whole session, and each
entry is prefixed with the turn that published it — two turns writing
`report.md` are two files, and a flat archive would extract as one.

## 8. Clean up

```bash
curl -s -X DELETE $GOBARE_API/v1/sessions/$SESSION -H "Authorization: Bearer $GOBARE_TOKEN"
```

Deleting a session destroys its sandbox. Concurrent sessions are capped — see
[limits.md](limits.md) — so a client that creates and never deletes will stop
being able to create.

## The whole thing, in TypeScript

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
  input: "Create /workspace/outputs/report.md about this repo.",
  session: { agent: { model: "MiniMax-M3" }, environment: { repo: "acme/site" } },
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

Three things it does that are easy to get wrong by hand, and wrong silently:

- **Subscribes before sending.** The other order loses the opening events
  whenever the agent starts quickly — which is to say sometimes.
- **Answers required actions.** Left unanswered, a turn sits in `waiting` until
  its deadline and then fails for a reason that looks unrelated.
- **Never sends a thrown handler's message to the model.** A stack trace is an
  excellent way to put your database host into a model's context, so a failing
  handler yields a fixed string instead.

And one thing a generated client would not: it **resumes**. A dropped
connection continues from `Last-Event-ID` rather than starting over or losing
the middle. See [events.md](events.md).

## Collecting what a turn produced

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

## Agents: a configuration you can name

If every session should start the same way, save that configuration once and
give it a name:

```bash
curl -s -X POST $GOBARE_API/v1/agents \
  -H "Authorization: Bearer $GOBARE_TOKEN" -H 'content-type: application/json' \
  -d '{
    "name": "support-bot",
    "model": "MiniMax-M3",
    "instructions": "You answer support tickets. Never promise a refund.",
    "tools": [],
    "text": { "verbosity": "low" }
  }'

curl -s -X POST $GOBARE_API/v1/sessions \
  -H "Authorization: Bearer $GOBARE_TOKEN" -H 'content-type: application/json' \
  -d '{ "agent": { "id": "support-bot" } }'
```

The create call answers with the agent and the id it was given:
`{"object":"agent","id":"agt_2b7d5e91c0a34f68","name":"support-bot",…}`.

`name` is a slug you choose — lowercase letters, digits, dot, dash or
underscore, up to 64 characters, lowercased for you. `id` is ours. A session
can name either one. Posting the same name again **replaces that agent in
place** and keeps its id, so a name is a stable handle to re-save against —
and a replacement really replaces: a field you leave out is removed, not
carried over from the version before.

An agent needs at least one of `model`, `model_credential_id`, `instructions`,
`tools` or `text`. A name with nothing behind it would apply as a no-op.

### What an agent overrides, and what overrides an agent

Anything you send inline wins over the agent. How it wins depends on the field,
and the difference is deliberate:

| Field | |
| --- | --- |
| `model`, `model_credential_id`, `instructions` | **Per field.** Overriding the model keeps the agent's instructions. Sending `null` or `""` for instructions clears them for this session rather than falling back to the agent's |
| `tools`, `text` | **Replaced whole, never merged.** A half-merged tool list is ambiguous about which half won |

### Copied, not referenced

A session keeps working the way it was created after the agent changes or is
deleted. That is what makes an agent a starting point rather than remote
control over work already running.

The session does remember which agent made it — `agent.id` on the session, and
it stays there after that agent is deleted, because it is a record of where the
session came from rather than a link to something that must still exist.

### If you integrated against `environment-templates`

`/v1/environment-templates` was the earlier name, from before environment
*profiles* arrived and left two unrelated things both called "environment".
Those paths still work, against the same rows, and `environment.template_id`
still names an agent. They are marked deprecated in the OpenAPI document and
will be removed after one release — move to `/v1/agents` and `agent.id`.

## Next

- [events.md](events.md) — stream instead of polling, and resume where you dropped
- [required-actions.md](required-actions.md) — let the agent call your code
- [webhooks.md](webhooks.md) — be told instead of watching
