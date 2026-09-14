# Sessions

Everything `POST /v1/sessions` accepts, and what each field is for.

The [quickstart](quickstart.md) creates a session with a model and nothing
else, which is the right way to see the thing work. This page is for the
second session — the one that needs your repository, your files, your secrets,
or a limit on what the agent may do without asking.

Nothing here is required. A session with only a model is a complete session.

## The fields

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
| `agent.id` | An [agent](agents.md) to inherit from. Any field you also pass overrides it; `instructions: null` uses the agent without its instructions |
| `agent.model` / `agent.model_credential_id` | Which connected credential to run against. Omitted uses the organization's default |
| `agent.instructions` | Standing instructions for every turn, up to 32000 characters. Refused if longer, never truncated |
| `agent.approval_mode` | `auto`, `per_step`, `read_only` or `plan`. Default `auto`. An unknown value is refused, never defaulted |
| `agent.permission_rules` | Up to 50 rules, each `{decision, tool?, path?, command?, domain?}` where decision is `allow`, `deny` or `ask` |
| `agent.tools` | Functions the agent may call and MCP servers it may reach — see [tools.md](tools.md) |
| `agent.text` | Output shaping: `verbosity` of `low`, `medium` or `high`, and `format` for a JSON schema to answer in. Asked for, not enforced — see [design-decisions.md](design-decisions.md) |
| `environment.repo` | `owner/name`. Cloned when the workspace comes up |
| `environment.files` | Files to put in the workspace — see below |
| `environment.profiles` | Environment profile ids, from `GET /v1/environment-profiles` |
| `environment.template_id` | A saved configuration to start from |
| `metadata` | Your own labels: up to 16 keys, 64 characters per key, 512 per value |
| `title` | A label for people. Nothing derives one |
| `input` | An opening message — see below |

`agent.instructions`, `agent.approval_mode`, `agent.permission_rules` and
`metadata` can also be changed later with `PATCH /v1/sessions/{id}`, which takes
any combination of those and `title`.

## Reading a session back

Everything you can set, you can read. `GET /v1/sessions/{id}` reports the
model, the credential, the approval mode, the permission rules, the
instructions — and the tools, with any secrets removed:

```json
{ "agent": { "model": "MiniMax-M3", "approval_mode": "auto",
             "tools": [{ "type": "function", "name": "lookup_order", "parameters": { … } }] } }
```

**On the single read only.** A page of sessions does not carry it: reading one
session's tools is a second lookup, and twenty of them to answer a question
about one is not a trade worth making.

That matters after a restart. Before answering a
[required action](required-actions.md) you can check the session is configured
with the function you are about to answer for, rather than assuming it.

## Repository

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

## Files at creation

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

**A file that could not be written says so.** The session still opens — one
unwritable path must not cost you the other forty-nine — and an `error` item
names the file and the reason. See [troubleshooting.md](troubleshooting.md).

**A 201 does not mean the files are there** — same as the clone. They are
written when the workspace comes up, after the clone, so you can drop a config
file into a repository you also asked for.

**They are written only if not already present.** A sandbox that was paused and
woken keeps whatever the agent did to those files; one that had to be rebuilt
gets them again, because they are part of how the session was defined.

There is no `type: "file_id"` and no `type: "url"`. Gobare has no file store to
reference, and does not fetch addresses on your behalf. For a large input, use
`environment.repo`.

## Files afterwards

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

## Forking

```bash
curl -s -X POST $GOBARE_API/v1/sessions/$SESSION/fork \
  -H "Authorization: Bearer $GOBARE_TOKEN"
```

```json
{"object":"session","id":"7b2e…","forked_from":"3f9c1b60-…","workspace_copied":true}
```

A new session that starts where the original **is**, not where it began: the
workspace and the transcript come with it. That is the point — trying two
approaches from a state worth keeping, without paying for the setup twice or
losing the first attempt. The original is untouched.

**It spends a session slot**, so it is refused by the same ceiling with the
same `project_limit_exceeded` as creating one.

**`workspace_copied` is worth reading.** A fork whose workspace could not be
copied is still a useful session, and believing the files are there when they
are not means finding out from the agent — the worst place to find out.

A session mid-turn, or with queued messages, is refused with `conflict`: fork
it when the work in flight has finished.

### Reading it back

```bash
curl -s "$GOBARE_API/v1/sessions/$SESSION/files" -H "Authorization: Bearer $GOBARE_TOKEN"
curl -s "$GOBARE_API/v1/sessions/$SESSION/files/content?path=src/app.ts" -H "Authorization: Bearer $GOBARE_TOKEN"
```

**A read is of the last snapshot, not the live sandbox.** `captured_at` says
which moment, and `state: "missing"` means none has been taken yet — which is
not the same as an empty workspace. `POST /files/refresh` takes a fresh one; it
is a separate call, and needs `sessions:write`, because it wakes a paused
sandbox and that costs money and seconds.

Environment files and key material are withheld, and say so — `permission_denied`
rather than a `404` that would read as "not there". Directories and withheld
paths are marked `readable: false` in the listing.

This is what answers "the agent said it wrote that, did it?" — a question the
artifact list cannot, because artifacts only ever cover `/workspace/outputs`.

**It is not remembered.** A live write is working state, not part of how the
session was defined, so a sandbox rebuilt from nothing will not have it. A
paused sandbox keeps it — and a paused session is woken to serve this call
rather than refusing it.

## Environment profiles

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

## Instructions

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
  workspace whose runtime predates them answers
  [`bridge_incompatible`](errors.md) rather than accepting the field and running
  without it. Deleting the session and creating a new one gets you a current
  workspace.

Send `null` or `""` to clear them.

## Approval mode and permission rules

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

## Opening message

Pass `input` and the session starts working immediately:

```bash
curl -s -X POST $GOBARE_API/v1/sessions \
  -H "Authorization: Bearer $GOBARE_TOKEN" -H 'content-type: application/json' \
  -d '{"agent":{"model":"MiniMax-M3"},"input":"Create /workspace/outputs/report.md about this repo."}'
```

**It is all or nothing.** A `201` means the session exists *and* the message was
accepted. If the message cannot be sent, the session is destroyed and you get
the send's error — so a non-2xx means nothing exists and there is nothing
to clean up.

**Unless we say otherwise, in the error itself.** Destroying the session is the
one step that can also fail. When it does, the message tells you so and names
the session, because the alternative is a slot held by something you were never
given the id of:

```
The agent is already working on this session. We also could not remove the
session we had created for it, so 3f9c1b60-… still exists and still holds one
of this organization's session slots — delete it with DELETE /v1/sessions/3f9c1b60-….
```

`input` takes the same shapes as `input.message` content: a plain string, or the
content-part array. The steps below then apply unchanged; skip step 4.

## Next

- [input](input.md) — sending the session work once it exists
- [preview](preview.md) — publish what it builds
- [tools](tools.md) — give it your own functions
