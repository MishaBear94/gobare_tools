# Differences from OpenAI's Agents API

This API is conceptually parallel to OpenAI's Agents API, not wire-compatible
with it. If you are porting, the resources will feel familiar — sessions, turns,
items, events, required actions — and the following seven things are
deliberately different.

They are listed because an undocumented divergence gets reported as a bug.

## 1. A message sent while the agent is busy queues; it does not steer

Send `input.message` during a running turn and it is **accepted and queued**.
The response says so:

```json
{"object":"input.accepted","type":"input.message","queued":true,"queue_position":1}
```

To change what a running turn is doing, say so explicitly:

```json
{"events":[{"type":"input.steer","content":"Stop and just write the tests."}]}
```

`input.steer` with no turn running is a `conflict` rather than a new turn.

**Why.** Whether a turn is in flight is decided from two signals — the live
bridge and the durable session status — because reading only one of them
swallowed messages during a sandbox wake-up. Having paid for that certainty, we
will not spend it guessing which of two different acts a caller meant.

## 2. Deleting a session destroys its sandbox

`DELETE /v1/sessions/{id}` ends the compute.

**Why.** In the Agents API a sandbox can be your own infrastructure, so deleting
a session leaves it alone. Here the sandbox belongs to the session and is billed
to us; leaving it running would bill someone for a project they deleted.

If you want the transcript without the compute, that is what the session already
is once idle — `lifecycle-worker` pauses an idle sandbox and reclaims it at a
cap, while items, turns and artifacts stay readable.

## 3. The event stream is replayable

Reconnect with `Last-Event-ID` and you get everything persisted since that
point. A cursor always names a row that exists.

This is more than the API this one is measured against offers, and it is the
reason a dropped connection is not a lost conversation. Details in
[events.md](events.md).

## 4. There is no sandbox-free mode

Every session has a workspace. There is no "just the model" configuration.

**Why.** For a coding agent the workspace is the product, not an accessory. An
agent that cannot read a file or run a test is a chat endpoint, and you already
have one of those.

## 5. Bring your own model

The API does not sell inference. A session runs against a model credential your
organization connected — Anthropic, OpenAI, xAI, OpenRouter, MiniMax, DeepSeek,
Qwen, Kimi, GLM, or any compatible endpoint.

There is no provider field, no `base_url` and no key in any request, because the
provider is a property of the credential. `agent.model` and
`agent.model_credential_id` choose *which* connected credential; they cannot
introduce a new one.

**Consequence worth stating plainly:** model spend is yours, on your account,
and we never see the key in a request. Sandbox compute is ours.

## 6. Human approval and questions are first-class

`required_actions` carries three types: `function_call` for your code, and
`approval` and `question` for a person.

An integration can therefore *see* that a human is holding up a session it cares
about, rather than watching it sit in `waiting` for no visible reason. Those two
are answered in the Console, not through this API.

**Why.** Gobare had a human-in-the-loop path before it had this API, and
hiding it from integrations would have made the API's picture of a session
incomplete.

## 7. No sub-agents

There is no API for spawning a sub-agent. `ApiTurn.subagent_id` exists in the
shape and is currently always `null`.

**Why.** The useful version of this lives in the agent runtime rather than in
the HTTP surface, and we have not convinced ourselves the API-level version
earns its complexity. It is an omission we may revisit, not a design we have
rejected.

## Smaller things

- **Errors carry a code, not a type.** Sixteen codes, listed in
  [errors.md](errors.md). Three share `429` and recover differently.
- **Ids are ours.** Session ids are UUIDs; turns are `turn_…`; artifacts are
  `art_5e2b9017c4d63a8f`; webhook subscriptions are `whsub_6c1e40b9a72d58f3`. Do not parse them.
- **Times are milliseconds since the epoch**, as numbers.
