# Gobare Agent API

> Published from the Gobare product repository. The canonical page is
> <https://docs.gobare.dev/> — read it there; this copy is for offline and for tooling.


**Run a coding agent from your own code.** Not a model that writes code back to
you — an agent with a computer, that writes files, runs them, and leaves what it
built at a URL you can open.

```
Your application
     │  one API call
     ▼
   Gobare ──► coding agent ──► a cloud computer
                                ├── a real workspace
                                ├── a shell it installs and runs in
                                ├── your tools: functions, MCP
                                └── a public URL for what it built
```

**You bring the model key.** Gobare does not sell you inference — it runs an
agent against a connection your organization owns, on a sandbox Gobare provides.
You pay your model provider for tokens and Gobare for the computer.

## A minute, start to finish

This asks for something to be built, waits, and prints an address. Nothing is
elided — it is the whole program.

```tab:bash
SESSION=$(curl -s -X POST https://api.gobare.dev/v1/sessions \
  -H "Authorization: Bearer $GOBARE_TOKEN" -H 'content-type: application/json' \
  -d '{"agent":{"model":"MiniMax-M3"},
       "input":"Build a small expense tracker web page — a form to add an expense, a running total, saved in localStorage. Serve it on port 8000 and keep the server running."}' \
  | jq -r .id)

until [ "$(curl -s "https://api.gobare.dev/v1/sessions/$SESSION/turns?limit=1" \
  -H "Authorization: Bearer $GOBARE_TOKEN" | jq -r '.data[0].status // "pending"')" != "working" ]; do sleep 5; done

curl -s -X POST "https://api.gobare.dev/v1/sessions/$SESSION/preview" \
  -H "Authorization: Bearer $GOBARE_TOKEN" -H 'content-type: application/json' -d '{}' | jq -r .url
```
```tab:typescript
const API = "https://api.gobare.dev";
const AUTH = { Authorization: `Bearer ${process.env.GOBARE_TOKEN}`, "content-type": "application/json" };

const call = async (method: string, path: string, body?: unknown) =>
  (await fetch(API + "/v1" + path, { method, headers: AUTH, body: body && JSON.stringify(body) })).json();

const session = await call("POST", "/sessions", {
  agent: { model: "MiniMax-M3" },
  input: "Build a small expense tracker web page — a form to add an expense, a running " +
         "total, saved in localStorage. Serve it on port 8000 and keep the server running.",
});

for (;;) {
  const [turn] = (await call("GET", `/sessions/${session.id}/turns?limit=1`)).data;
  if (turn && turn.status !== "working") break;
  await new Promise((resolve) => setTimeout(resolve, 5000));
}

console.log((await call("POST", `/sessions/${session.id}/preview`, {})).url);
```
```tab:python
import json, os, time, urllib.request

API, TOKEN = "https://api.gobare.dev", os.environ["GOBARE_TOKEN"]
AUTH = {"Authorization": "Bearer " + TOKEN, "content-type": "application/json"}

def call(method, path, body=None):
    return json.load(urllib.request.urlopen(urllib.request.Request(
        API + "/v1" + path, data=json.dumps(body).encode() if body is not None else None,
        headers=AUTH, method=method)))

session = call("POST", "/sessions", {
    "agent": {"model": "MiniMax-M3"},
    "input": "Build a small expense tracker web page — a form to add an expense, a running "
             "total, saved in localStorage. Serve it on port 8000 and keep the server running.",
})

while True:
    turns = call("GET", f"/sessions/{session['id']}/turns?limit=1")["data"]
    if turns and turns[0]["status"] != "working":
        break
    time.sleep(5)

print(call("POST", f"/sessions/{session['id']}/preview", {})["url"])
```

```
https://s-a23a2eb878db4d8bbefd.gobare.dev
```

Open it. There is a working page there, served from the computer the agent was
given — a form, a running total, saved in the browser. **Forty-nine seconds on
one run of this, a hundred and eleven on another**; the difference is how long
the sandbox took to come up.

You need a token for this. It takes a minute and the
[quickstart](quickstart.md) has it.

## What just happened

Five nouns, and they nest:

```
Agent      a named configuration: model, instructions, tools
  │        (optional — a session can carry its own)
  ▼
Session    one cloud computer. Its workspace persists between
  │        rounds and survives being paused
  ▼
Turn       one piece of work, from your message until it settles
  │
  ├──► Items      the record: messages, tool calls, file changes
  ├──► Events     the same, as it happens: streamable, resumable
  ├──► Artifacts  files it published — they outlive the computer
  └──► Preview    a port it serves, optionally at a public URL
```

The session is the thing to hold on to. Everything else is reached through it,
and a session you created yesterday still answers today — its computer may have
been reclaimed and rebuilt, and the conversation does not restart.

## Why this and not a model API

A model API returns text. You would still be writing the part that actually
runs: a sandbox and its lifecycle, an agent loop, tool dispatch, file capture,
streaming, resumption after a dropped connection, and somewhere for a person to
approve something before it happens.

That list is the product. It is also why there is
[no sandbox-free mode](design-decisions.md) — for a coding agent the workspace
is not an accessory.

What Gobare deliberately does **not** do: sell you inference, choose your model,
or hold your conversation state in your process. The first is why you connect
your own key; the last is why a session is a URL you can come back to rather
than an object you keep in memory.

Coming from another Agents API? [design-decisions.md](design-decisions.md) lists
where this one diverges and why — queueing versus steering, durable versus
transient events, and what `completed` does not mean.

## Common tasks

| | |
| --- | --- |
| **Run one task and collect the result** | [quickstart.md](quickstart.md) |
| **Put it in a service and keep it running** | [production-integration.md](production-integration.md) |
| **Call it from TypeScript, with types** | [typescript.md](typescript.md) |
| **Call it from Python, with types** | [python.md](python.md) |
| **Let the agent call your own code** | [required-actions.md](required-actions.md) |
| **Be told when it finishes, rather than waiting** | [webhooks.md](webhooks.md) |
| **Put what it built on a public URL** | [preview.md](preview.md) |
| **Look up a field or an endpoint** | [objects.md](objects.md) · [reference.md](reference.md) |
| **Work out why something looks wrong** | [troubleshooting.md](troubleshooting.md) |

Base URL: `https://api.gobare.dev` — `https://app.gobare.dev` serves the same
API and is what the Console uses.

## Every page

| Page | Read it when |
| --- | --- |
| [quickstart.md](quickstart.md) | First time. Token to completed turn, in one page |
| [production-integration.md](production-integration.md) | It works, and now it has to keep working |
| [typescript.md](typescript.md) | You are past `curl` and putting this in a service |
| [python.md](python.md) | The same, in Python |
| [model-credentials.md](model-credentials.md) | You want to connect a model without opening the Console |
| [sessions.md](sessions.md) | You want a session to hold your repo, files, secrets or limits |
| [agents.md](agents.md) | You want every session in one part of your product to start the same way |
| [input.md](input.md) | You want to send the agent a message, a result, a steer or a stop |
| [events.md](events.md) | You want to watch a session instead of polling it |
| [webhooks.md](webhooks.md) | You want to be told rather than to watch |
| [preview.md](preview.md) | You want what the agent built to be reachable by other people |
| [tools.md](tools.md) | You want to give the agent your functions, or an MCP server |
| [required-actions.md](required-actions.md) | You want the agent to call *your* code |
| [idempotency.md](idempotency.md) | Your caller retries, and you need it not to act twice |
| [pagination.md](pagination.md) | A collection has more rows than one page, or you need to find a session by your own id |
| [troubleshooting.md](troubleshooting.md) | Something looks wrong and you want it by symptom, not by endpoint |
| [errors.md](errors.md) | Something returned a code you have not seen |
| [limits.md](limits.md) | You are planning load, or you got a 429 |
| [changelog.md](changelog.md) | You want to know what changed, and when |
| [design-decisions.md](design-decisions.md) | You want to know why the API behaves as it does |

Those pages describe the parts. [Guides](guides/README.md) put them together:
six scenarios — long-running work, structured extraction, approvals, dispatch
from your own service, showing the agent's work live, and moving between model
providers — each written as a sequence you can copy.

The machine-readable reference is `GET /v1/openapi.json` — OpenAPI 3.1, served
without authentication because it describes the API rather than holding data in
it. It is generated from the same route table the server matches against, so it
cannot describe an endpoint that does not exist.

## How these pages stay true

The product repository is the source. This directory is checked against the
code it describes — ceilings against the constants that enforce them, error
codes against their statuses, both event vocabularies — so a page cannot
quietly drift from the API.

These pages are published as a site at
[docs.gobare.dev](https://docs.gobare.dev), built from this directory by
`deploy/publish-docs-site.sh`. A copy of the markdown also goes to
[gobare_tools](https://github.com/MishaBear94/gobare_tools/tree/main/docs/api)
via `scripts/publish-api-docs.sh`, which refuses to run if the check above does
not pass.

## Scope

Gobare brings your own model key. The API does not sell you inference — it runs
an agent against a model credential your organization has already connected, on
a sandbox Gobare provides. There is no request field for a model provider,
because the provider is a property of the credential.

There is also no sandbox-free mode. For a coding agent the workspace is the
product, not an accessory, so every session has one.
