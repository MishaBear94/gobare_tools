# Production integration

> Published from the Gobare product repository. The canonical page is
> <https://docs.gobare.dev/production-integration/> — read it there; this copy is for offline and for tooling.

The [quickstart](quickstart.md) gets one agent working. This page is the
difference between that and something you can leave running: which token to
give which process, the loop that survives a dropped connection, and how to
take files out when a turn produced more than one.

Nothing here is needed to see the thing work. All of it is needed before a
second person depends on it.

## Which token for which process

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

A call missing its scope is `403 permission_denied`, and the message names the
scope it wanted — so you never have to guess which one you left out.

## Reading one turn

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

## The session loop

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

## Taking many files at once

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

## What to reach for next

The pieces this page assumes, each on its own page:

- [input.md](input.md) — the four things you can send a session, and what each refuses
- [events.md](events.md) — stream instead of polling, and resume where you dropped
- [webhooks.md](webhooks.md) — be told rather than watch, and verify the delivery
- [required-actions.md](required-actions.md) — let the agent call your code
- [idempotency.md](idempotency.md) — a retry that does not act twice
- [pagination.md](pagination.md) — collections longer than one page
- [limits.md](limits.md) — every ceiling, with its number
- [troubleshooting.md](troubleshooting.md) — a symptom you can look up, and [errors.md](errors.md) for the shape every refusal arrives in

And the [guides](guides/README.md) put them together: six complete programs,
each one a scenario rather than an endpoint.
