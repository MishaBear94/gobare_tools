# Agents

A named, reusable configuration to start sessions from. Save the model,
instructions and tools once, then create sessions that inherit them.

Reach for one when every session in some part of your product should start the
same way — a support bot, an extraction worker, a reviewer. A session created
from an agent gets a **copy**, so changing or deleting the agent never reaches
into work already running.

## Creating one

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

## Overrides

Anything you send inline wins over the agent. How it wins depends on the field,
and the difference is deliberate:

| Field | |
| --- | --- |
| `model`, `model_credential_id`, `instructions` | **Per field.** Overriding the model keeps the agent's instructions. Sending `null` or `""` for instructions clears them for this session rather than falling back to the agent's |
| `tools`, `text` | **Replaced whole, never merged.** A half-merged tool list is ambiguous about which half won |

## Deleting one

```bash
curl -s -X DELETE $GOBARE_API/v1/agents/$AGENT -H "Authorization: Bearer $GOBARE_TOKEN"
```

Sessions already started from it keep working, unchanged — which is the next
section, and the reason deleting is safe.

## Copied, not referenced

A session keeps working the way it was created after the agent changes or is
deleted. That is what makes an agent a starting point rather than remote
control over work already running.

The session does remember which agent made it — `agent.id` on the session, and
it stays there after that agent is deleted, because it is a record of where the
session came from rather than a link to something that must still exist.

## Migrating from `environment-templates`

`/v1/environment-templates` was the earlier name, from before environment
*profiles* arrived and left two unrelated things both called "environment".
Those paths still work, against the same rows, and `environment.template_id`
still names an agent. They are marked deprecated in the OpenAPI document and
will be removed after one release — move to `/v1/agents` and `agent.id`.

An agent with nothing behind it, a name that is not a valid slug, and an
`agent.id` that is not yours are each a `400` or `404` naming the cause — the
shape they arrive in is [errors.md](errors.md).

## Next

- [sessions.md](sessions.md) — every field an agent can hold, described in full
- [tools.md](tools.md) — the `tools` an agent carries
- [reference](reference.md) — the `/v1/agents` endpoints
