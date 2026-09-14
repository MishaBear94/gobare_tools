# Gobare Agent API

Run a coding agent from your own code. A session is a cloud computer with an
agent on it: you create one, send it work, and read what it did — and what it
built can be left running at a public URL.

```bash
curl -s -X POST https://api.gobare.dev/v1/sessions \
  -H "Authorization: Bearer $GOBARE_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"agent":{"model":"MiniMax-M3"},
       "input":"Write /workspace/outputs/hello.txt saying hello, then tell me you did."}'
```

That is a complete request. The agent gets a workspace, does the work, and the
file it wrote is downloadable afterwards — see the
[quickstart](quickstart.md) for the token, the wait, and the download.

## Common tasks

| | |
| --- | --- |
| **Run one task and collect the result** | [quickstart.md](quickstart.md) |
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
