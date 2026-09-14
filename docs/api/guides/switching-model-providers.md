# Swap model providers without changing your code

> Published from the Gobare product repository. The canonical page is
> <https://docs.gobare.dev/guides/switching-model-providers/> — read it there; this copy is for offline and for tooling.

The same agent and the same task, running on a different model tomorrow than it
did today — because of price, because one model is better at your work, because
a vendor had an outage, or because someone decided the data must not leave a
region.

You change one field. Here are two runs of an identical task, on two
connections that speak **different wire protocols**:

```
 minimax  yu7u7hurzewanyl  session=b47783ab  artifacts=1
  custom  ybycd8m28v0o2yd  session=d74ab74e  artifacts=1
```

One went out as Anthropic Messages, the other as OpenAI Chat Completions. The
request bodies differed by `model_credential_id` and nothing else.

## Before you start

A token, and **two** connections to switch between — the whole point. Gobare is
bring-your-own-key: the model bill is yours, the computer is ours. Nine
connectors are built in (Anthropic, OpenAI, xAI, OpenRouter, MiniMax, DeepSeek,
Qwen, Kimi, GLM) plus `custom`, which takes any endpoint speaking Anthropic
Messages or OpenAI Chat Completions.

## See what you have connected

```bash
curl -s "$GOBARE_API/v1/model-credentials" -H "Authorization: Bearer $GOBARE_TOKEN"
```

```json
{
  "object": "list",
  "data": [
    { "object": "model_credential", "id": "yu7u7hurzewanyl", "label": "MiniMax",
      "connector": "minimax", "model": "MiniMax-M3", "is_default": true },
    { "object": "model_credential", "id": "ybycd8m28v0o2yd", "label": "MiniMax via OpenAI protocol",
      "connector": "custom", "model": "MiniMax-M3", "is_default": false }
  ]
}
```

Names, models and ids. Never a key, and never a base URL — one is a secret and
the other is deployment detail you should not build against.

To add one without opening a browser:

```bash
curl -s -X POST $GOBARE_API/v1/model-credentials \
  -H "Authorization: Bearer $GOBARE_TOKEN" -H 'content-type: application/json' \
  -d '{"key":"sk-ant-api03-…"}'
```

The provider is read from the shape of the key rather than guessed at, and the
connection is verified against that provider before it is stored — so a wrong
key fails here, not inside your first turn. Needs the `credentials:write`
scope. See [model-credentials.md](../model-credentials.md).

## The switch

```tab:python
TASK = "Write /workspace/outputs/report.md listing the files in /workspace, one per line."

for credential in call("GET", "/v1/model-credentials")["data"]:
    call("POST", "/v1/sessions", {
        "agent": {
            "model": credential["model"],
            "model_credential_id": credential["id"],   # ← the only difference
        },
        "input": TASK,
    })
```
```tab:typescript
const TASK = "Write /workspace/outputs/report.md listing the files in /workspace, one per line.";

for (const credential of (await call("GET", "/v1/model-credentials")).data) {
  await call("POST", "/v1/sessions", {
    agent: {
      model: credential.model,
      model_credential_id: credential.id,          // ← the only difference
    },
    input: TASK,
  });
}
```

**Only `model_credential_id` changed.** The task, the tools, the instructions
and the way you collect results are untouched. The second connection takes an
entirely different path — different connector, different base URL, different
protocol adapter — and the agent in the workspace knows nothing about any of it.

## Confirm they really differed

```bash
curl -s "$GOBARE_API/v1/sessions/$SID" -H "Authorization: Bearer $GOBARE_TOKEN" \
  | jq -r '.agent | "\(.model) \(.model_credential_id)"'
```

Compare `model_credential_id`, not `model`. Two connections can run the same
model, and the model name alone proves nothing about which one was used.

## Move the whole organization

Rather than naming an id on every call, set a different connection as the
default in the Console. Sessions that name none follow it:

```bash
curl -s -X POST $GOBARE_API/v1/sessions \
  -H "Authorization: Bearer $GOBARE_TOKEN" -H 'content-type: application/json' \
  -d '{"input":"the same task"}'
```

You need not even name the model. This is how you move everything at once:
change the default, and every session that does not override it follows.

## You have it working when

- `GET /v1/model-credentials` lists your connections and the response contains
  no key and no base URL
- Both sessions reach `completed` with equivalent output
- Their `agent.model_credential_id` values differ
- Nothing but that one field differed between the two requests
- An unconnected model name returns `400` naming what *is* connected

## What to know

**A running session can be moved.** `PATCH /v1/sessions/{id}` with
`agent.model` and `agent.model_credential_id` together switches the connection
in place — the workspace, the transcript and the tools all stay:

```bash
curl -s -X PATCH $GOBARE_API/v1/sessions/$SESSION \
  -H "Authorization: Bearer $GOBARE_TOKEN" -H 'content-type: application/json' \
  -d '{"agent":{"model":"MiniMax-M3","model_credential_id":"ixw…"}}'
```

Both fields or neither: one connection runs one model, so naming half of the
pair would leave the session pointing at a combination nobody checked. A
connection that does not belong to your organization, or does not offer that
model, is refused and the session does not move.

This page used to say there was no way to do it, and told you to start a new
session. That cost the workspace and the transcript, on a product whose next
guide is called "work that spans hours".

**`agent.model` must match the connection.** One connection runs one model;
moving between two models from the same vendor means two connections.

**Capabilities are not normalised across providers.** One may not accept
images; another has a smaller context window. Those differences reach your
agent's behaviour unchanged. `GET /v1/model-credentials` tells you what is
connected, not what each one can do.

## When it goes wrong

| What you see | Why | Fix |
| --- | --- | --- |
| `400` naming a model you did not ask for | `agent.model` does not match what that connection runs | The message names what *is* connected; one connection runs one model |
| `400` naming a credential id | The id is not one of this organization's | `GET /v1/model-credentials` — an id from another org reads as not found |
| The same model behaves differently after a switch | Capabilities are not normalised across providers | Context windows, image support and tool-calling fidelity differ. Re-test, do not assume |
| A running session did not move | The `PATCH` was refused, or only half the pair was sent | Read the error: it names the connection problem. Both `agent.model` and `agent.model_credential_id` are required together |
| `403 permission_denied` on `POST` | The token lacks `credentials:write` | Mint one with that scope, or connect it in the Console |
