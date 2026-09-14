# Troubleshooting

> Published from the Gobare product repository. The canonical page is
> <https://docs.gobare.dev/troubleshooting> — read it there; this copy is for offline and for tooling.

Indexed by what you are looking at, not by which part of the API it belongs to.

Every entry here is something that actually happened — most of them to us, while
running this API against its own documentation. If your symptom is here, you are
not the first and the product is probably behaving as designed. If the design is
the problem, that is said too.

---

## Empty artifact list after a completed turn

**Two causes, and they look identical.**

The agent wrote somewhere that is not published. Only `/workspace/outputs` is
collected; anything else lives and dies with the workspace. Ask for the path
explicitly — `Create /workspace/outputs/report.md` — rather than hoping.

Or you looked too early. `status: "completed"` means the agent stopped working,
not that its files are fetchable. The turn carries a second field for that:

```bash
curl -s "$GOBARE_API/v1/sessions/$SESSION/turns?limit=1" \
  -H "Authorization: Bearer $GOBARE_TOKEN"
```

```json
{"data":[{"status":"completed","artifacts":"ready"}]}
```

Wait for anything that is not `pending`. The field is `null` while the turn is
still running, `pending` while its files are being collected, `failed` if that
collection did not work — and `ready` or `partial` when it has finished. An
empty list and a list that is not ready yet are the same shape, which is the
whole reason the field exists.

`partial` means publishing finished and **left something behind**. The turn
carries `artifacts_skipped`, naming each file and why:

```json
{"artifacts":"partial",
 "artifacts_skipped":[{"path":"outputs/build.tar","reason":"larger than 26214400 bytes"}]}
```

That is the answer to "the agent said it wrote the file and it is not here".
Before this existed the turn said `ready`, the file was simply absent, and the
reason lived only in our logs — so the obvious conclusion, that the agent wrote
to the wrong place, was the wrong one.

→ [quickstart.md](quickstart.md) step 7

---

## 401 on every call with a new token

The token is almost certainly **CLI import**, which carries only the `cli` scope
and is refused by every `/v1` route. That is the default in the Console, because
tokens minted before this API existed must keep doing exactly what they did.

Mint a new one and choose **Agent API · read/write** — or **read** if your
integration only watches.

```bash
curl -s $GOBARE_API/v1/health -H "Authorization: Bearer $GOBARE_TOKEN"
```

A working token names its scopes back at you. A revoked one is 401 on the very
next request — there is no cache to wait out.

→ [quickstart.md](quickstart.md) step 2

---

## `project_limit_exceeded` that retrying never clears

It never will. This is a ceiling on how many sessions an organization may hold
at once, not a rate limit, and waiting changes nothing. Delete a session you are
finished with:

```bash
curl -s -X DELETE $GOBARE_API/v1/sessions/$SESSION -H "Authorization: Bearer $GOBARE_TOKEN"
```

Both this and `rate_limit_exceeded` arrive as **429**. They are told apart by
`error.code`, and only the second is worth retrying. A client that treats every
429 the same will spin forever on the first.

If you are running many sessions in a loop, delete each one as you finish with
it rather than at the end. We filled our own ceiling this way and spent an
afternoon reading the resulting failures as product defects.

→ [limits.md](limits.md)

---

## Slow first request to a published URL

It was asleep. Publishing grants a stable address, not a permanently running
computer: an idle workspace pauses on the usual schedule and the first public
request wakes it. Your visitor waits a few seconds once.

This is deliberate — a published preview is the agent's work left reachable, not
a hosting product — but it does mean the first hit after a quiet period is slow.

→ [preview.md](preview.md)

---

## Instructions that appear to be ignored

Read the session back. If `agent.instructions` is null, the field was not
accepted; if it holds your text, the instruction reached the session.

```bash
curl -s $GOBARE_API/v1/sessions/$SESSION -H "Authorization: Bearer $GOBARE_TOKEN"
```

If it is there and the behaviour has not changed, ask the agent directly — *what
standing instruction were you given?* — rather than inferring from whether it
obeyed. A model that declines to follow an instruction and a system that never
delivered one look the same from outside, and we shipped a bug for a day that
lived in exactly that gap.

→ [sessions.md](sessions.md)

---

## `bridge_incompatible`

The workspace is running an agent runtime older than the feature you asked for —
`instructions`, host functions, or session tools, depending on which you used.

Sessions created before a sandbox release keep the runtime they started with.
Create a new session; it gets the current one.

This is a refusal on purpose. The alternative — accepting the field and running
without it — is the failure mode this error exists to prevent.

→ [errors.md](errors.md)

---

## Transport errors from an HTTP client

If you are on Node's built-in `fetch` and the body is large, the client may
raise a transport error rather than hand you our response. We answer an
oversized body with `400` and a readable message; a client that is still
uploading when the answer arrives can lose it.

Check the same call with `curl`. If curl shows a clean `400`, the refusal is
ours and correct, and what you are seeing is your client.

→ [errors.md](errors.md)

---

## Rejected `limit`

The maximum page size is **100**. Asking for more is a `400` rather than a
silent clamp, because a caller asking for 500 has a paging bug and quietly
handing back 100 lets it ship.

The refusal has no `data` field. A client that reads `body.data` without
checking the status will see an empty collection and conclude the session
produced nothing — which is a mistake we made twice against our own API.

→ [limits.md](limits.md)

---

## Refused model or credential

Three different refusals, and the difference decides what you do next:

| What it says | What to do |
| --- | --- |
| This organization's selected connection runs *X*, not *Y* | Pass `agent.model_credential_id` for the connection that runs *Y*, or connect it |
| This organization has no model connection with id *Z* | The id is wrong. `GET /v1/model-credentials` lists the real ones |
| This organization has no model connected | There genuinely are none. Connect one |

The middle one used to be reported as the last one, which sent people to connect
a model they already had.

→ [model-credentials.md](model-credentials.md)

---

## `conflict` on `POST /files`: "the workspace is not ready yet"

```json
{"error":{"code":"conflict","message":"This session's workspace is not ready yet — it is starting, or restarting to pick up a configuration change. Retry in a few seconds; nothing was written."}}
```

The usual cause is the sequence immediately before it: `PUT /tools` restarts
the session's bridge so it can pick up the new configuration, and for some
seconds afterwards the workspace cannot be written to. Retry; nothing was
written, so there is nothing to undo.

This used to answer `internal_error`, which means *we broke* — so nobody
retried a state that passes on its own.

**If retrying does not help**, the cause is probably not the workspace at all:
an MCP server configured with `required: true` that cannot be reached refuses
the session, and that answers `invalid_request` naming the server. See
[tools.md](tools.md).

→ [errors.md](errors.md)

---

## A session says `failed` and there are no turns

A run that could not start never opens a turn, so `GET /turns` is empty and
`status` is all `GET /sessions/{id}` will tell you. The reason is an item:

```bash
curl -s "$GOBARE_API/v1/sessions/$SESSION/items?limit=50" \
  -H "Authorization: Bearer $GOBARE_TOKEN"
```

```json
{"object":"item","type":"error",
 "detail":{"message":"required MCP server(s) failed to initialise — docs: fetch failed","origin":"sandbox"}}
```

The usual causes are a `required: true` MCP server that cannot be reached (see
[tools.md](tools.md)) and a workspace that could not be provisioned.

→ [sessions](sessions.md)

---

## A session stays `working` and never finishes

Read its `required_actions`. If one has `type: "question"` or `"approval"`, the
agent is waiting on a **person**, and your integration cannot answer it —
those are resolved in the Console. An API caller polling for `function_call`
alone waits forever.

Answering one through this API is refused, naming the reason. It was worse
before: the answer was accepted, closed the action, and left the session
reporting `working` with an empty `required_actions` while the agent stayed
blocked — nothing anywhere said a human was needed.

If nothing in your product can answer a question, stop the agent asking:

```
Never ask the user a clarifying question: if something is ambiguous,
state your assumption and continue.
```

An agent asks when it cannot act. A brief that names no files, no repository
and no allowed assumptions is the usual cause.

→ [required-actions.md](required-actions.md) · [approvals guide](guides/approvals-in-your-product.md)

---

## The event stream prints nothing, but events are arriving

The streaming text frame carries `payload.delta`. The settled message carries
`payload.text`. Reading `text` on an `agent.text` frame yields `undefined`,
which most renderers print as an empty string — so the stream looks silent
while the durable frames beside it arrive normally.

```
agent.text     → payload.delta   transient, seq: null, never replayed
agent.message  → payload.text    durable,  has an id:, replayed on reconnect
```

Branch on the type. One parser for every frame is the shape of this mistake.

→ [events.md](events.md) · [streaming guide](guides/showing-the-agents-work.md)

---

## `400` naming `redacted` when you send tools back

You read the tool configuration, changed something, and sent it back. The
read-back withholds MCP secrets and names what it withheld in `redacted`, which
is not a request field — so the round trip is refused rather than silently
replacing your credentials with nothing.

Re-send the secret itself, or build the body from your own source instead of
from the read.

→ [tools.md](tools.md)

---

## Anything else

Every error carries a `request_id`:

```json
{"error":{"code":"internal_error","message":"…","request_id":"6ba06aaa"}}
```

Quote it. It is the one thing that lets us find the exact request in our logs,
and an `internal_error` is always worth reporting — that code means we failed,
not that you did.

→ [errors.md](errors.md)
