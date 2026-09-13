# Extracting structured data

You have a pile of documents and you want rows. The agent reads each one,
writes JSON, and you load the result — over and over, safely enough that a
retried batch does not do the work twice.

## Define the agent once

```bash
curl -s -X POST $GOBARE_API/v1/agents \
  -H "Authorization: Bearer $GOBARE_TOKEN" -H 'content-type: application/json' \
  -d '{
    "name": "invoice-extractor",
    "model": "MiniMax-M3",
    "instructions": "Extract invoice fields exactly as written. Never infer a missing value — use null. Write one JSON object per input to /workspace/outputs/<input-name>.json.",
    "text": {
      "format": {
        "type": "json_schema",
        "schema": {
          "type": "object",
          "properties": {
            "invoice_number": { "type": "string" },
            "total":          { "type": "number" },
            "currency":       { "type": "string" },
            "issued_on":      { "type": ["string", "null"] }
          },
          "required": ["invoice_number", "total", "currency"],
          "additionalProperties": false
        }
      }
    }
  }'
```

A named agent is configuration you reuse. Sessions created from it inherit
everything and may override any field individually; what they get is a copy, so
editing or deleting the agent later does not reach into work already running.

## Run a batch

One session per input, each carrying its own bytes and an idempotency key
derived from the input:

```bash
curl -s -X POST $GOBARE_API/v1/sessions \
  -H "Authorization: Bearer $GOBARE_TOKEN" -H 'content-type: application/json' \
  -H "Idempotency-Key: extract-invoice-8842" \
  -d '{
    "agent": { "id": "invoice-extractor" },
    "environment": {
      "files": [{ "type": "inline", "path": "invoices/invoice-8842.txt", "data": "'"$(base64 < invoice-8842.txt)"'" }]
    },
    "metadata": { "batch": "2026-09", "source": "invoice-8842.txt" },
    "input": "Extract the fields from invoices/invoice-8842.txt."
  }'
```

Re-running the batch after a crash re-sends the same keys and gets the original
sessions back rather than doing the work twice. Keys live for 24 hours; after
that the same key starts fresh.

## Wait for the artifacts, not the turn

```bash
until [ "$(curl -s "$GOBARE_API/v1/sessions/$SID/turns?limit=1" \
  -H "Authorization: Bearer $GOBARE_TOKEN" | jq -r '.data[0].artifacts')" != "pending" ]; do sleep 1; done

curl -s "$GOBARE_API/v1/sessions/$SID/artifacts" -H "Authorization: Bearer $GOBARE_TOKEN"
```

Publishing happens after the turn settles, so `status: "completed"` is not yet a
promise that the artifact list has anything in it. The turn's `artifacts` field
tells you which case you are in:

| Value | Meaning |
| --- | --- |
| `pending` | Settled; publishing still running. An empty list means *not yet* |
| `ready` | Publishing finished. An empty list means the turn produced nothing |
| `failed` | Publishing could not run. Quote the turn id when reporting it |

## Validate on your side

```bash
curl -s "$GOBARE_API/v1/sessions/$SID/artifacts/$AID/content" \
  -H "Authorization: Bearer $GOBARE_TOKEN" | jq -e '.invoice_number and .total and .currency'
```

For a turn that wrote many rows at once, take them in one request instead of
one call per file:

```bash
curl -s "$GOBARE_API/v1/sessions/$SID/artifacts/archive?turn_id=$TID" \
  -H "Authorization: Bearer $GOBARE_TOKEN" | tar -x -C ./rows
```

**Do not skip this step.** `json_schema` is composed into the model's
instructions; it is not parsed, validated or retried on your behalf. Models
follow it most of the time. If your pipeline needs a guarantee, this line is
where it comes from.

## You have it working when

- One session per input, each reaching `completed`
- Every artifact parses as JSON and passes your own schema check
- Re-running the batch with the same keys creates no new sessions
- `metadata` on each session ties it back to the input that produced it

## What to know

**`json_schema` is a request, not a contract.** It is composed into the prompt.
No post-parse validation, no retry on failure. Validate it yourself — which is
why the step above is not optional.

**Inputs come in one of two ways.** A repository the session clones, or
`environment.files` — base64 bytes you hand the session when you create it, up
to 5 MiB a file and 10 MiB a request. Anything larger belongs in a repository.

**Artifacts have size ceilings** — per file and per turn. Something too large
is skipped while the turn still succeeds, so check the `skipped` list in the
publish result rather than assuming everything made it.

**Batches meet the concurrency ceiling.** An organization runs a limited number
of sessions at once. A hundred inputs is a queue you drain, not a hundred
simultaneous calls — see [An agent behind your API](an-agent-behind-your-api.md)
for handling the two `429` codes correctly.
