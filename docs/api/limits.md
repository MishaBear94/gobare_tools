# Limits

> Published from the Gobare product repository. The canonical page is
> <https://docs.gobare.dev/limits> — read it there; this copy is for offline and for tooling.

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

### What you have left, before you run out

Every authenticated `/v1` response carries your current budget, so you can pace
rather than discover the wall:

```
x-ratelimit-limit: 120
x-ratelimit-remaining: 117
x-ratelimit-reset: 2
x-ratelimit-resource: general
```

| Header | |
| --- | --- |
| `x-ratelimit-limit` | The ceiling for this bucket |
| `x-ratelimit-remaining` | Whole requests you can make right now. Never rounded up — a request that would be refused is not one you have |
| `x-ratelimit-reset` | Whole seconds until this bucket is full again. `0` means it already is |
| `x-ratelimit-resource` | `general` or `sessions` — **which** bucket these numbers describe |

`resource` matters more than it looks. The same token legitimately holds 9 of
one bucket and 119 of the other at the same instant; without a name for which
is which, one of those numbers reads as a bug.

The 429 carries them too, alongside `Retry-After`, so a caller that has been
refused can see the whole shape in one response rather than inferring it.

## Request body

**1 MiB.** Every field this API accepts is text — a prompt, a title, a tool
configuration, a webhook URL — and past a megabyte of JSON the request is a
mistake. Over it you get `invalid_request` with `400`.

One exception, for the one request that legitimately carries bytes rather than
text: `POST /v1/sessions` reads up to **16 MiB**, because `environment.files`
is base64 and base64 is a third larger than what it encodes.

If you need the agent to work on something larger than that, put it in the
workspace rather than in the request: clone a repository into the session, or
have the agent fetch it.

## Files you send

`environment.files` at creation, and `POST /v1/sessions/{id}/files` afterwards.
The same ceilings apply to both.

| | Limit |
| --- | --- |
| One file | 5 MiB |
| One request's total | 10 MiB |
| Files per request | 50 |

Each ceiling applies to the *decoded* bytes, not the base64 string. Over any of
them the request is refused with `invalid_request` — nothing is truncated, and
no session is left behind for you to clean up.

A file that could not be written is reported: the session still opens, and an
`error` item says which file and why, because a seeded file is part of how the
session was defined and one going missing quietly is worse than the session
failing. Before that it went to our logs alone, and the transcript's "wrote N
files" counted only the ones that landed — which reads as success.

Seeded files are written into the workspace when it comes up, **if they are not
already there**. A sandbox that was paused and woken keeps the agent's edits; a
sandbox that had to be rebuilt gets the files again, because they are part of
how the session was defined. They are deleted with the session.

## Event streams

| | Limit |
| --- | --- |
| Open streams per token | 5 |
| Open streams per organization | 20 |

Past either you get `rate_limit_exceeded` **before** the stream opens, so you
receive a readable JSON error rather than a connection that dies. It carries
`Retry-After`, because it is often temporary — see below.

Both ceilings exist: the per-token one alone is no bound at all, because an
organization can mint tokens.

A stream you hold open but do not read backs up: past ~1 MiB of unread frames
the transient ones are dropped, past 8 MiB the connection is closed. Reconnect
with your cursor and nothing persisted is lost — see [events.md](events.md).

Close streams you are not reading. A slot is freed when the connection ends, by
any means — but **not instantly**. Behind a proxy we learn a connection is gone
when the proxy tells us, which takes a few seconds. A caller at its ceiling
that loses a stream and immediately opens a replacement can therefore be
refused for a stream it has already closed.

The thing that makes it survivable is that **the stream's own `retry:` hint is
longer than the window**, so a client following our instruction is not racing
us. Measured against production: a slot behind the proxy is released about four
and a half seconds after the client goes away, and the hint is eight.

If you do get the refusal anyway — because you reconnect on your own schedule
rather than ours — it carries `Retry-After`. Honour it and reconnect. It is not
a request to close anything.

## Concurrent sessions

**25 per organization by default.** A session is a cloud computer, so this is a
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

**And it tells you.** A turn that left something behind reports
`artifacts: "partial"` rather than `"ready"`, and carries `artifacts_skipped`
naming each file and why:

```json
{"artifacts":"partial",
 "artifacts_skipped":[{"path":"outputs/build.tar","reason":"larger than 209715200 bytes"}]}
```

Before that existed the turn said `ready`, the file was simply not in the list,
and the obvious conclusion — that the agent never wrote it — was the wrong one.

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

## Model connections

**25 per organization**, the same ceiling as environment templates. Past it,
`POST /v1/model-credentials` is refused and names the endpoint that frees one.
Re-connecting a key you already connected is not a new connection and does not
count against it.

## Environment templates

**25 per organization.** Posting a name that already exists replaces it rather
than adding one, so re-saving the same template forever is free.

## Tokens

Access tokens expire in 7, 30 or 90 days, chosen when you mint one. There is no
refresh — mint a new one and revoke the old. `GET /v1/health` reports a token's
scopes, which is the cheapest way to check one is still good.

## Workspace lifetime

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

## Next

- [idempotency](idempotency.md) — retrying safely
- [troubleshooting](troubleshooting.md) — you hit one and are not sure why
