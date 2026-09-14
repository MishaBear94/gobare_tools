# Model credentials

Gobare runs an agent against a model credential your organization owns. This is
how you connect one without opening a browser.

Until this existed, you could see `agent.model_credential_id` on every session
you created and had no API route to the thing it names — the first step of using
an API-first product could only be taken in the Console.

## Connect

```bash
curl -s -X POST $GOBARE_API/v1/model-credentials \
  -H "Authorization: Bearer $GOBARE_TOKEN" -H 'content-type: application/json' \
  -d '{"key":"sk-ant-api03-…"}'
```

```json
{ "object": "model_credential", "id": "kl5yieo4ne9zhy2", "label": "anthropic",
  "connector": "anthropic", "model": "claude-sonnet-4-6", "is_default": true,
  "last4": "x9f2", "verified": true }
```

That is the whole request. Everything else has an answer we can work out:

| Field | |
| --- | --- |
| `key` | **Required.** Your provider key. It appears here and nowhere else |
| `provider` | Which vendor. Only needed when the key's prefix does not say — see below |
| `model` | Defaults to the connector's own default |
| `base_url` | Only for `custom`, and for self-hosted or proxied endpoints |
| `label` | A name for the Console's list. Defaults to the provider's |
| `default` | Whether new sessions use it, `true` or `false`. The first connection is always the default. A non-boolean is refused rather than read as `false` — this decides whose bill every future turn lands on |

Requires the `credentials:write` scope. A token minted before this endpoint
existed does not carry it — mint a new one in the Console under **Build with
API › API keys**.

## What you can connect

```bash
curl -s $GOBARE_API/v1/model-connectors
```

```json
{"object":"list","data":[
  {"object":"model_connector","id":"anthropic","display_name":"Anthropic",
   "default_model":"claude-sonnet-4-6","key_prefix":"sk-ant-",
   "key_url":"https://console.anthropic.com/settings/keys","protocol":"anthropic"}]}
```

No token: it describes what this deployment supports, not anything inside your
organization. `id` is what you send as `provider`, `default_model` is what you
get by omitting `model`, and `key_prefix` is how you work out which ids share a
prefix — before sending a secret to anyone.

## Provider detection

`sk-ant-` belongs to exactly one vendor, so nothing needs saying. `sk-` does
not — OpenAI, DeepSeek, Qwen and Kimi all issue keys that start with it — and
in that case you are asked rather than tried:

```json
{ "error": { "code": "invalid_request",
  "message": "Several providers issue keys starting with \"sk-\": deepseek, moonshot, openai, qwen. Pass \"provider\" to say which." } }
```

```bash
-d '{"key":"sk-…","provider":"deepseek"}'
```

`GET /v1/model-connectors` is where those ids come from; you do not have to
read them out of this refusal.

**We never find out by asking the vendors.** The obvious implementation of
"work out who issued this" is to try the candidates until one accepts — which
means sending your secret to vendors you never named. A failed authentication is
still a disclosure: the key has left you and its real owner and arrived
somewhere neither of you chose. One extra field is the price of that not
happening, and a test asserts this endpoint makes zero outbound calls before it
knows who the key belongs to.

## The response

The plaintext key appears in your request and nowhere afterwards: not in the
response, not in the list, not in a log line. `last4` is the only part of it
that is ever returned.

`GET /v1/model-credentials` reports ids, names and models — no key, and no
`base_url` either, because that is deployment topology rather than something to
build against.

## Verification

The key is tried against the provider once, with the model it will run, before
anything is written. A connection that does not work is worse than no connection
at all: it becomes the organization's default and every session afterwards fails
somewhere far from here.

| What happened | You get |
| --- | --- |
| The provider rejected the key | `400` — **with the provider's own words**, not ours |
| The model is not on this key | `400` naming the model you asked for |
| The provider could not be reached | `502 provider_error`. Their side; try again |
| The key, model and address are ones you already connected | `200` with the existing connection — a retry is not a second connection |

The rejection is quoted rather than rewritten because the one sentence that
matters — expired, revoked, out of quota, wrong account — is in it, and
"invalid key" throws all four away.

## Disconnect

```bash
curl -s -X DELETE "$GOBARE_API/v1/model-credentials/$CRED" \
  -H "Authorization: Bearer $GOBARE_TOKEN"
```

```json
{ "object": "model_credential.deleted", "id": "kl5…", "deleted": true,
  "sessions_moved": 2, "moved_to": "ixw…" }
```

Sessions running on it are moved to another connection — the organization's
default, then the newest — and `sessions_moved` says how many. If there is
nothing left to move them to, they are left with no model and `moved_to` is
null; their next turn will say so.

## What to know

**One connection runs one model.** Moving between two models from the same
vendor means two connections, and `agent.model` must match the one you name.

**Connecting is not switching.** A new connection does not move existing
sessions by itself — `PATCH /v1/sessions/{id}` does, in place. See
[Switching model providers](guides/switching-model-providers.md).

**Creating one needs a scope that creating sessions does not.** The powers are
not alike: a session spends sandbox minutes, while a provider key decides whose
bill every future turn lands on.

A refused connection, a model that is not the one a credential runs, and an id
that is not yours are three different refusals with three different fixes —
they are laid out side by side in
[troubleshooting.md](troubleshooting.md#refused-model-or-credential).

## Next

- [quickstart](quickstart.md) — use the connection
- [switching model providers](guides/switching-model-providers.md) — run the same task on another provider
