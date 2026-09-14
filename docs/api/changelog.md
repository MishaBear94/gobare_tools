# Changelog

> Published from the Gobare product repository. The canonical page is
> <https://docs.gobare.dev/changelog/> — read it there; this copy is for offline and for tooling.

What changed in `/v1`, newest first. Additions only unless a line says
otherwise — a field appearing is not a breaking change, and nothing here has
removed one.

Dates are when the change reached production.

## 2026-09-14

**A backend we cannot reach is `503`, not `401`.** A lookup that failed — a
restarting directory, a network blip — was swallowed into "no such token" and
answered `401 This access token is not recognized`, the same code and the same
sentence a deleted token gets. That is the expensive direction to be wrong in:
`401` tells a well-behaved integration to stop, alarm and audit its
credentials, over a condition that clears in seconds. It is now
`503 directory_unavailable` with `Retry-After`, and the message says the
problem is not yours. A token that genuinely does not exist is still `401`.

**`read_only` allows MCP tools the server declares read-only.** It refused all
of them, on the stated grounds that MCP does not describe a tool's side
effects. The protocol does — `readOnlyHint` in `tools/list` — and we were
dropping the annotation while mapping. Unannotated tools are still refused.
See [sessions.md](sessions.md).

**A blocked tool call says what it blocked.** `approval.resolved` carried a
`toolCallId` and a code, with no tool name and no preceding
`approval.requested` to match it to — so an agent saying "I could not reach
the runbook" was indistinguishable from a model that never tried. It now
carries `name`, and the reason the agent was given.


**A session can choose which networked tools it gets.** `tools` now accepts
`web_search`, `web_fetch`, `image_search`, `browse`, `browser_act` and
`screenshot` by type — the sandbox tools that reach outside the workspace.
Naming any of them narrows the session to exactly those; `[]` means none, which
is the shape for running code you have not read. You can only narrow: a tool
this deployment has turned off does not come back by being named. Saying
nothing keeps what every session had before. See [tools.md](tools.md).


**The four endpoints that do not answer with JSON now say so in
`GET /v1/openapi.json`.** Both event streams were published as
`application/json` rather than `text/event-stream`, the artifact archive as
JSON rather than `application/x-tar`, and an artifact's bytes as JSON rather
than `application/octet-stream`. The schemas said the right thing in their
prose — `EventStream` described itself as "text/event-stream, not JSON" — but a
generated client reads the media type, not the description, so a client built
from this document would have called `JSON.parse` on a connection that stays
open for the life of a session. **If you generated a client, regenerate it.**
Nothing about the responses themselves changed; they always carried these
types.

**`GET /v1/sessions/{id}/tools`.** Reading a session's tool configuration back.
This page and [tools.md](tools.md) had documented the call, with an example,
since they were written; only `PUT` existed, so the example answered `404`.

**The tool configuration comes back in the vocabulary you sent it in.** Both
that call and `GET /v1/agents` used to answer with the *stored* object — 
`mcpServers`, `cmd`, `allowedTools`, `hostFunctions`, `jsonSchema` — on an API
that is snake_case everywhere else, and none of those are fields you can send.
It is now one `tools` array, each entry carrying its `type`, exactly as `PUT`
takes it. This is a breaking change to those two responses.

**Agents no longer return MCP credentials.** `GET /v1/agents` published the
`authorization` header and header values of every MCP server configured on an
agent, to any token with `sessions:read`. Secrets are now withheld, and
`redacted` names what was held back. **If you configured an MCP server with a
credential through an agent, rotate it.**

**Unknown fields inside a tool entry are refused.** `allowedTools` for
`allowed_tools`, `cmd` for `command`, `timeout` for `timeout_seconds` — each
was accepted and dropped, leaving a caller believing they had restricted a
server they had not. Stricter than before, deliberately, and the refusal lists
what the entry accepts. See [tools.md](tools.md).

## 2026-09-13

**Model connections through the API.** `GET /v1/model-credentials` lists what
the organization has connected, and `POST` connects a new one. Before this both
were Console-only, so the first two steps of any integration involved a browser.
See [model-credentials.md](model-credentials.md).

**Published previews.** `POST /v1/sessions/{id}/preview` puts what the agent is
serving at a public URL, and `DELETE` takes it down. The address was readable on
the session object long before there was any way to create one — an API caller
could see the capability and not use it. See [preview.md](preview.md).

**Files in and out.** `POST /v1/sessions/{id}/files` puts bytes into a running
workspace, `environment.files` seeds them at creation, and
`GET /v1/sessions/{id}/artifacts/archive` takes everything out at once.

**`instructions` on agents and sessions.** Standing instructions that apply to
every turn. A workspace whose runtime predates the feature refuses with
`bridge_incompatible` rather than accepting the field and ignoring it.

**A skipped MCP server says so.** An optional server that will not connect now
produces an `mcp.unavailable` event and an `mcp_unavailable` item, instead of
the agent quietly having fewer tools and explaining that it cannot do the thing.
See [tools.md](tools.md).

**`turn.artifacts`.** `completed` never meant the files were fetchable, and an
empty artifact list was indistinguishable from a turn that produced nothing.
Wait for `ready`. See [troubleshooting.md](troubleshooting.md).

**Unknown fields are refused.** A request body carrying a field this API does
not read is a `400` naming the field, rather than a `201` that silently dropped
it. This is stricter than before: a caller who was sending something ignored
will now see an error — which is the point, because they believed they were
configuring something.

**Better refusals.** Asking for a model the organization has not connected was a
`500`; it is now a `400` naming the model. A credential id that is not one of
yours said "this organization has no model connected", which was advice to do
something already done; it now names the id and points at
`GET /v1/model-credentials`.

**A full project quota is `429 project_limit_exceeded`,** not a `500`. It shares
a status with `rate_limit_exceeded` and is told apart by `error.code` — only one
of the two is worth retrying. See [limits.md](limits.md).

## 2026-09-12

**Session shape filled in.** `metadata`, `agent.approval_mode`,
`agent.permission_rules`, `environment.repo`, `environment.profiles`, and
`environment.repo.clone_error` — the last because a `201` means the clone is
owed, not that it happened.

**Create and prompt in one call.** `input` on `POST /v1/sessions`, all or
nothing: if the message cannot be accepted, the session is not created either.

**[`input.steer`](input.md).** Changing course while a turn runs. A plain message sent to a
busy session still queues — steering has to be asked for by name. See
[design-decisions.md](design-decisions.md).

**A ceiling on concurrent event streams** per caller, so one client cannot hold
every connection. See [limits.md](limits.md).

## Before that

`/v1` opened with sessions, turns, items, artifacts, events, webhooks, tools and
required actions. The shape of those has not changed since.

---

Every change here is visible in [`GET /v1/openapi.json`](https://api.gobare.dev/v1/openapi.json),
which is generated from the route table the server matches against — so it
describes what is running, not what was intended.

## Next

- [reference](reference.md) — the current surface
- [objects](objects.md) — the current shapes
