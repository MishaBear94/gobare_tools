# Preview

> Published from the Gobare product repository. The canonical page is
> <https://docs.gobare.dev/preview> — read it there; this copy is for offline and for tooling.


The agent starts a server in its workspace. You publish it, and someone who has
never heard of Gobare opens a URL and sees it.

This is the part that makes a session more than a job runner: the agent builds a
thing, and the thing is reachable. Preview and publish are two different
addresses, and the difference is who can open them.

| | Who reaches it | Lives for |
| --- | --- | --- |
| `preview.url` | You, holding a token | As long as the workspace does |
| `preview.published_url` | Anyone with the link | Until you unpublish it |

**`preview.url` opened in a browser shows the Console, not your app.** It is
scoped to a caller holding a token, and an anonymous request is not refused —
it falls through to `app.gobare.dev` and answers `200` with the Console's own
page. So a reader who copies that address out of a session, pastes it into a
tab and sees something that is plainly not what the agent built concludes the
agent built nothing.

`published_url` is the one to hand to anyone else, and it is null until you
publish. That is the next section.

## Requirements

Publishing exposes a port. The agent must have started a server on it and told
the workspace about it — in the agent's own words, `preview(3000)`.

Ask for it in the same sentence as the work:

```bash
curl -s -X POST $GOBARE_API/v1/sessions/$SESSION/events \
  -H "Authorization: Bearer $GOBARE_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"events":[{"type":"input.message","content":
       "Build the site in /workspace, serve it on port 3000, and call preview(3000)."}]}'
```

When it has, the session says so:

```bash
curl -s $GOBARE_API/v1/sessions/$SESSION -H "Authorization: Bearer $GOBARE_TOKEN"
```

```json
{"preview": {"url": "https://p-4f1c….gobare.dev", "port": 3000, "published_url": null}}
```

`port` is the signal. Until it is set there is nothing to publish, and asking
anyway is refused rather than answered with an address that returns errors —
you would hand that address to someone before discovering it was empty.

## Publishing

```bash
curl -s -X POST $GOBARE_API/v1/sessions/$SESSION/preview \
  -H "Authorization: Bearer $GOBARE_TOKEN" \
  -H 'content-type: application/json' -d '{}'
```

```json
{"object":"preview","subdomain":"s-3f9c1b604e2a4d189a77","url":"https://s-3f9c1b604e2a4d189a77.gobare.dev","port":3000}
```

You may name it instead:

```json
{"subdomain": "acme-invoices"}
```

Left out, the name is derived from the session id. That is deliberate: an
address you have to invent is an address you can lose a race for, and most
callers want a URL to hand to something else rather than a name to remember.

The reply is a Gobare origin, never the sandbox provider's. That matters
because the workspace behind it can be rebuilt and the address survives.

## Sleeping and waking

Publishing grants a stable route, not a permanently running computer. An idle
workspace is still paused on the usual schedule; the first public request wakes
it. A visitor waits a few seconds, and then sees the site.

So a published preview is not a hosting product, and it is not billed like one.
It is the agent's work, left reachable.

## Unpublishing

```bash
curl -s -X DELETE $GOBARE_API/v1/sessions/$SESSION/preview \
  -H "Authorization: Bearer $GOBARE_TOKEN"
```

The session and its workspace are untouched; only the public address goes.
Publishing again afterwards is ordinary.

**Unpublishing something already unpublished answers `200` too**, with the same
body. A teardown that runs twice, or one racing a person doing it in the
Console, has already got what it asked for — and the two answers are
indistinguishable, which is what makes the retry safe. A session id that does
not exist is still `not_found`; that refusal means something.

Deleting the session removes the address too — see
[design-decisions.md](design-decisions.md) on why `DELETE` destroys the
workspace rather than archiving it.

## Errors

| | |
| --- | --- |
| `conflict` · no preview yet | Nothing is listening on a port. Ask the agent to serve one and call `preview(port)` |
| `conflict` · already published | Unpublish first. Moving a site silently would strand whoever holds the old address |
| `conflict` · subdomain taken | Someone else has that name. Choose another, or omit it |
| `invalid_request` · unusable subdomain | 2–63 characters of `a–z`, `0–9` and hyphens, and not a name the platform reserves |
| `conflict` · could not be prepared | The workspace could not be archived, so the address could not be guaranteed to come back. Every later wake serves an anonymous visitor with no way to report a failure, so it is proved now or not promised |

Republishing to the address you already hold is not a conflict — it answers
`200` with the same URL, because that is what a retry looks like. Unpublishing
twice works the same way, for the same reason.

Both routes honour `Idempotency-Key` like every other write — see
[idempotency.md](idempotency.md).

Every refusal on this page arrives in the shape described in
[errors.md](errors.md); if you have a symptom rather than a code, start at
[troubleshooting.md](troubleshooting.md).

## Next

- [input.md](input.md) — asking the agent to serve something
- [sessions.md](sessions.md) — giving the session a repository to build from
- [guides/an-agent-behind-your-api.md](guides/an-agent-behind-your-api.md) — running this from your own backend
