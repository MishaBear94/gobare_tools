# Gobare Agent API

Run Gobare's coding agent from your own code. A session is a cloud computer with
an agent on it: you create one, send it work, and read what it did.

Base URL: `https://api.gobare.dev` — `https://app.gobare.dev` serves the same
API and is what the Console uses.

| Page | Read it when |
| --- | --- |
| [quickstart.md](quickstart.md) | First time. Token to completed turn, in one page |
| [events.md](events.md) | You want to watch a session instead of polling it |
| [webhooks.md](webhooks.md) | You want to be told rather than to watch |
| [required-actions.md](required-actions.md) | You want the agent to call *your* code |
| [idempotency.md](idempotency.md) | Your caller retries, and you need it not to act twice |
| [errors.md](errors.md) | Something returned a code you have not seen |
| [limits.md](limits.md) | You are planning load, or you got a 429 |
| [differences.md](differences.md) | You are porting from OpenAI's Agents API |

The machine-readable reference is `GET /v1/openapi.json` — OpenAPI 3.1, served
without authentication because it describes the API rather than holding data in
it. It is generated from the same route table the server matches against, so it
cannot describe an endpoint that does not exist.

## Where these pages live

The product repository is the source. This directory is checked against the
code it describes — ceilings against the constants that enforce them, error
codes against their statuses, both event vocabularies — so a page cannot
quietly drift from the API.

The copy published at
[gobare_tools](https://github.com/MishaBear94/gobare_tools/tree/main/docs/api)
is made by `scripts/publish-api-docs.sh`, which refuses to run if that check
does not pass.

## What this is not

Gobare brings your own model key. The API does not sell you inference — it runs
an agent against a model credential your organization has already connected, on
a sandbox Gobare provides. There is no request field for a model provider,
because the provider is a property of the credential.

There is also no sandbox-free mode. For a coding agent the workspace is the
product, not an accessory, so every session has one.
