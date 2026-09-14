# Pagination

> Published from the Gobare product repository. The canonical page is
> <https://docs.gobare.dev/pagination> — read it there; this copy is for offline and for tooling.

Every collection in this API pages the same way, so learning it once is enough.
This page also covers the two filters on `GET /v1/sessions`, which are what a
restarted process asks first.

## Parameters

| Parameter | |
| --- | --- |
| `limit` | 1–100, default 20. Out of range is a `400`, not a silent clamp |
| `order` | `asc` or `desc`, default `desc` |
| `after` | The previous page's `last_id` |

`order` is absent on four collections — agents, webhooks, model connections and
environment profiles — because they publish no timestamp to sort by. They take
`limit` and `after`.

```json
{"object":"list","data":[…],"has_more":true,"last_id":"turn_9d41c7e0a8b24f36"}
```

`has_more` is decided by looking one row further rather than by counting,
because these collections are written to while they are read. Page with
`?after=<last_id>` until `has_more` is false.

## A cursor that cannot be placed

**A cursor the collection cannot place answers with an empty page.** If the row
was deleted, or the cursor never came from us, you get `data: []` and
`has_more: false` rather than the first page again — so a paging loop ends
instead of quietly repeating itself. It is not an error, because a cursor
naming another organization's row must be indistinguishable from one naming
nothing.

## Filtering sessions

`GET /v1/sessions` takes two filters on top of those, and they are the two
questions a process asks after losing its own state:

```bash
# What is waiting on my code right now?
curl -s "$GOBARE_API/v1/sessions?status=requires_action" -H "Authorization: Bearer $GOBARE_TOKEN"

# Which session was job 8842?
curl -s "$GOBARE_API/v1/sessions?metadata=job:8842" -H "Authorization: Bearer $GOBARE_TOKEN"
```

Each listed session carries its own `required_actions`, so a restarted worker
can find everything it owes an answer to in one call and answer without a
second one.

## Unknown parameters

**A query parameter an endpoint does not read is refused**, the same as an
unknown field in a body, and for a sharper reason: the thing people invent in a
query string is a filter, and an ignored filter hands back the whole collection
looking exactly like a filter that matched everything. Every parameter each
endpoint accepts is in `GET /v1/openapi.json`.

## Next

- [reference](reference.md) — every endpoint, and which of these each takes
- [sessions.md](sessions.md) — what `metadata` is for, and how to set it
- [errors.md](errors.md) — the shape of the `400` an out-of-range `limit` returns
