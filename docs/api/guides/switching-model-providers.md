# Switching model providers

The same agent and the same task, running on a different model tomorrow than it
did today. Because of price, because one model is better at your particular
work, because a vendor had an outage, or because someone decided the data
should not leave a region.

You change one field.

## What this relies on

Gobare is bring-your-own-key. The model bill is yours; the computer is ours.
Nine connectors are built in — Anthropic, OpenAI, xAI, OpenRouter, MiniMax,
DeepSeek, Qwen, Kimi, GLM — plus `custom`, which takes any endpoint speaking
Anthropic Messages or OpenAI Chat Completions.

## See what you have connected

```bash
curl -s "$GOBARE_API/v1/model-credentials" -H "Authorization: Bearer $GOBARE_TOKEN"
```

```json
{
  "object": "list",
  "data": [
    { "object": "model_credential", "id": "kl5yieo4ne9zhy2", "label": "MiniMax",
      "connector": "minimax", "model": "MiniMax-M3", "is_default": true },
    { "object": "model_credential", "id": "ixwugzpk3pyt8cb", "label": "MiniMax via OpenAI protocol",
      "connector": "custom", "model": "MiniMax-M3", "is_default": false }
  ]
}
```

Names, models and ids. Never a key, and never a base URL — one is a secret, and
the other is deployment detail you should not build against.

Connections are created in the Console. Creating one through the API would mean
accepting a provider key over the API, which is a different permission model and
a decision of its own.

## Run it on one connection

```bash
curl -s -X POST $GOBARE_API/v1/sessions \
  -H "Authorization: Bearer $GOBARE_TOKEN" -H 'content-type: application/json' \
  -d '{
    "agent": { "model": "MiniMax-M3", "model_credential_id": "kl5yieo4ne9zhy2" },
    "input": "Write /workspace/outputs/report.md listing the files in the current directory, one per line."
  }'
```

`agent.model` has to match the model that connection runs. A mismatch is
refused, and the refusal tells you what is actually available:

```json
{ "error": { "code": "invalid_request",
  "message": "This organization's selected connection runs MiniMax-M3, not gpt-4o. Pass agent.model_credential_id to choose a different connection, or connect gpt-4o in the Console under Settings › LLM Models." } }
```

## Run the same thing on another

```bash
curl -s -X POST $GOBARE_API/v1/sessions \
  -H "Authorization: Bearer $GOBARE_TOKEN" -H 'content-type: application/json' \
  -d '{
    "agent": { "model": "MiniMax-M3", "model_credential_id": "ixwugzpk3pyt8cb" },
    "input": "Write /workspace/outputs/report.md listing the files in the current directory, one per line."
  }'
```

**Only `model_credential_id` changed.** The task, the tools, the instructions
and the way you collect results are untouched.

The second connection takes an entirely different path: a different connector,
a different base URL, and a different protocol adapter. The agent in the
workspace knows nothing about any of it.

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

**Connections are created in the Console.** `/v1` is read-only here.

**`agent.model` must match the connection.** One connection runs one model;
moving between two models from the same vendor means two connections.

**Switching does not migrate running sessions.** A session is bound to the
connection it was created with. Changing providers affects new sessions.

**Capabilities are not normalised across providers.** One may not accept
images; another has a smaller context window. Those differences reach your
agent's behaviour unchanged. `GET /v1/model-credentials` tells you what is
connected, not what each one can do.
