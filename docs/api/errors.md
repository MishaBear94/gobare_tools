# Errors

> Published from the Gobare product repository. The canonical page is
> <https://docs.gobare.dev/errors/> — read it there; this copy is for offline and for tooling.

Every failure has the same shape:

```json
{"error":{"code":"permission_denied",
          "message":"This token does not have the \"sessions:read\" scope.",
          "request_id":"859ae087"}}
```

**Branch on `code`, not on the HTTP status and not on the message.** The status
is what a proxy needs; the code is what your integration needs. Messages are
written for people and may be reworded.

`request_id` is also on the `x-request-id` header. Quote it when you ask us
about a call — it is how we find that exact request in our logs.

**Every `/v1` response carries `x-request-id`, not only the failures** — a 200,
a 202, an SSE stream. The calls worth asking about are often the ones that
succeeded and did something surprising, and those need a handle too. Log the
header next to whatever your integration records about the call; it costs
nothing until the day it is the only thing that helps.

## The codes

A `401` also carries `WWW-Authenticate: Bearer realm="gobare", error="…"` —
the standard challenge, so an HTTP client learns the scheme without being
configured for it.

**The `Retry` column is also on the wire.** Every code marked retryable carries
a `Retry-After` header; the ones marked `no` carry none, and the absence is the
signal — `project_limit_exceeded` is a 429 and `provider_unauthorized` is a 502,
and neither is a wait. A client that honours `Retry-After` and gives up without
one is doing the right thing on every row below without knowing any of them.

The numbers are a floor on politeness rather than a prediction. Where we can
compute the real wait — the rate limiter, the stream ceiling — we send that
instead.

| Code | Status | Retry | Meaning |
| --- | --- | --- | --- |
| `invalid_request` | 400 | no | The request is malformed, or a field is wrong. Includes a body over the size ceiling |
| `context_length_exceeded` | 400 | no | The conversation is too long for the model |
| `authentication_error` | 401 | no | No token, or one we do not recognise. A revoked or expired token lands here |
| `permission_denied` | 403 | no | The token is valid and lacks the scope, which the message names |
| `not_found` | 404 | no | No such session, turn, artifact, template — or no such endpoint |
| `method_not_allowed` | 405 | no | The path exists; this verb does not. The `Allow` header lists the ones that do |
| `conflict` | 409 | maybe | The session is not in a state that allows this. `input.steer` with no turn running is the common one |
| `queue_full` | 429 | after a wait | This session already holds the maximum queued messages |
| `rate_limit_exceeded` | 429 | after `Retry-After` | Too many requests, or too many open streams |
| `project_limit_exceeded` | 429 | **no** | Your organization is at its concurrent-session ceiling. Waiting does not help; delete a session or ask us to raise it |
| `internal_error` | 500 | yes | We broke. The message is deliberately fixed; the real one is in our logs under your `request_id` |
| `sandbox_error` | 500 | yes | The workspace failed during the operation |
| `workspace_recovery_failed` | 500 | no | A workspace could not be restored. The session needs attention rather than a retry |
| `bridge_incompatible` | 500 | no | The session's sandbox predates a capability you asked for. Create a new session |
| `provider_error` | 502 | yes | Your model provider failed |
| `provider_unauthorized` | 502 | no | Your model provider rejected the credential. Fix it in the Console |
| `sandbox_unavailable` | 503 | yes | The workspace is not reachable right now |
| `directory_unavailable` | 503 | yes | We could not reach the service that knows what your organization owns |

## Refusals worth recognising

Several `invalid_request` refusals exist specifically so a value is never
accepted and then ignored. Each names what to do:

| Sending | Answer |
| --- | --- |
| `environment.repo` with no GitHub connection on the organization | Connect GitHub in the Console, then create the session again |
| `environment.repo` as a URL | Send `owner/name`; the message shows the corrected form |
| `environment.branch` | The branch is reported by the clone, not chosen. Read `environment.repo.branch` |
| An unknown `agent.approval_mode` | Use one of `auto`, `per_step`, `read_only`, `plan`. It is never defaulted for you |
| A `permission_rules` entry with no valid `decision` | Every rule needs `allow`, `deny` or `ask` |
| `metadata` past its ceilings, or a non-string value | Nothing is truncated or coerced; fix the value |
| A `PATCH` with no recognised field | Send `title`, `metadata`, `agent.instructions`, `agent.approval_mode` or `agent.permission_rules` |
| `agent.instructions` longer than 32000 characters | Refused with both numbers. Never truncated — half a set of instructions looks like a model ignoring them |
| `agent.instructions` on a workspace older than the feature | `bridge_incompatible`. Delete the session and create a new one |

An `environment.profiles` id belonging to another organization answers
`not_found`, not `permission_denied` — an id cannot be probed for existence.

## The three 429s

They share a status and recover differently, which is exactly why the code
matters more than the status:

- `rate_limit_exceeded` — you are asking too fast. `Retry-After` says how long
  to wait, and honouring it works. See [limits.md](limits.md).
- `queue_full` — this *session* is saturated. Wait for its turns to drain, or
  use another session.
- `project_limit_exceeded` — you are at the ceiling for concurrent sessions.
  **Retrying never succeeds.** Delete something or talk to us.

A client that retries all 429s identically will spin forever on the third.

## Internal errors

An unexpected failure is reported as `internal_error` with a fixed message.
Internal errors routinely carry file paths, SQL and provider responses, and none
of that belongs in an external response. The real message is in our logs,
findable by the `request_id` you were handed.

If you see one, it is worth reporting.

## Errors from outside the API

`/v1` always answers JSON in this envelope, including `404` for an unknown path
— so a JSON parse failure means you did not reach `/v1` at all. Check the host
and the `/v1` prefix.

A `413` from an intermediate proxy is likewise not us; our own body ceiling
answers `invalid_request` with `400`.

## Next

- [input](input.md) — what each input event accepts, and when each refusal happens
- [troubleshooting](troubleshooting.md) — a symptom rather than a code
- [limits](limits.md) — the ceilings behind the 429s
