# Limits

Published so you can design against them rather than discover them.

## Request rate

Two buckets, per token, because the costs are not alike. Reading a turn is a
database row; creating a session provisions a cloud computer.

| | Limit |
| --- | --- |
| `POST /v1/sessions` | 10 per minute |
| Everything else under `/v1` | 120 per minute |

The allowance refills continuously rather than resetting on the minute, so a
full allowance is available as a burst and then trickles back at the published
rate. Spending everything and waiting a minute buys one more allowance — never
two.

Past the ceiling you get `rate_limit_exceeded` with a `Retry-After` header in
seconds. Honouring it works. Hammering does not extend the wait — a refused
request is not charged — but it does not shorten it either.

The buckets are separate: exhausting session creation does not stop you reading.

## Request body

**1 MiB.** Every field this API accepts is text — a prompt, a title, a tool
configuration, a webhook URL — and past a megabyte of JSON the request is a
mistake. Over it you get `invalid_request` with `400`.

If you need the agent to work on a large input, put it in the workspace rather
than in the request: clone a repository into the session, or have the agent
fetch it.

## Event streams

| | Limit |
| --- | --- |
| Open streams per token | 5 |
| Open streams per organization | 20 |

Past either you get `rate_limit_exceeded` **before** the stream opens, so you
receive a readable JSON error rather than a connection that dies.

Both ceilings exist: the per-token one alone is no bound at all, because an
organization can mint tokens.

Close streams you are not reading. A slot is freed when the connection ends, by
any means.

## Concurrent sessions

**5 per organization by default.** A session is a cloud computer, so this is a
spend ceiling as much as a product tier.

"Concurrent" is literal: there is no archive state, so a session holds a slot
until it is deleted, and deleting one frees it immediately. A paused sandbox
still holds its slot — the workspace is still there.

Past it, `POST /v1/sessions` answers `project_limit_exceeded`. **Retrying never
succeeds.** Delete a session, or ask us to raise the ceiling — it is raised by a
conversation, not a setting.

If your integration creates sessions per unit of work, delete them when the work
is done. The most common way to hit this is a client that creates and never
cleans up.

## Message queue

**5 queued messages per session** while a turn is running. Past it,
`queue_full`. Wait for the turn to finish, or use a second session.

## Artifacts

| | Limit |
| --- | --- |
| One published file | 200 MiB |
| One turn's total | 500 MiB |

Files past either ceiling are skipped; the turn still succeeds, because a turn
that produced good work and a storage problem has still produced good work.

## Metadata

| | Limit |
| --- | --- |
| Keys per session | 16 |
| Key length | 64 characters |
| Value length | 512 characters |

Values must be strings. A number is refused rather than stringified, and an
over-long value is refused rather than truncated — a label that comes back
different from what you sent is worse than one that was never accepted.

## Permission rules

**50 per session**, each with a `decision` of `allow`, `deny` or `ask` and any
of `tool`, `path`, `command`, `domain` (500 characters each). A rule this API
cannot read is refused, so an integration never runs on fewer rules than it
sent.

## Environment templates

**25 per organization.** Posting a name that already exists replaces it rather
than adding one, so re-saving the same template forever is free.

## Tokens

Access tokens expire in 7, 30 or 90 days, chosen when you mint one. There is no
refresh — mint a new one and revoke the old. `GET /v1/health` reports a token's
scopes, which is the cheapest way to check one is still good.

## How long a workspace lives

**A workspace is reclaimed 2 hours (7200 seconds) after it starts.** Long work is the
product, so this is deliberately generous — but it is a ceiling, and a turn
still running when it arrives ends as `failed`. Artifacts already published
survive it; see [the artifacts section of the quickstart](quickstart.md).

A workspace is also **paused after five minutes with nothing happening**, and
woken by the next thing you send (5 minutes). Pausing is not an ending: the transcript
lives in the control plane, so the agent comes back knowing what it knew. Time
spent paused does not count against the 2 hours.

If you have work that genuinely needs longer than 2 hours, break it into
turns across sessions, or tell us — the number is a resource decision, not a
law of nature.

## Not limited

**How long you take to answer.** Nothing obliges you to poll, and a turn
waiting on a `required_action` waits for you rather than timing out. Do not set
an HTTP timeout on the *outcome* — send the message, get your `202`, and watch
the turn through the event stream, a webhook, or polling.

## CORS

There is none, deliberately. `/v1` is server-to-server only, because a
`gbr_pat_` token in browser JavaScript is a leaked credential. Call it from your
backend.
