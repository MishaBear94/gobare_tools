# Turn documents into structured JSON

You have a folder of invoices, contracts or reports, and you want rows in a
database. This page goes from a PDF on your disk to validated JSON, in one
script you can run now.

Here is the whole trip. This is a real invoice PDF, and real output from the run
that produced this page:

```
invoice-8842.pdf   →   {"invoice_number":"INV-8842","total":4600.00,
  (848 bytes,             "currency":"USD","issued_on":"2026-03-14"}
   binary)
```

Forty-three seconds end to end on a cold session, most of it the sandbox
starting. One API call to begin, one to collect.

## Before you start

Three things, and the [quickstart](../quickstart.md) covers all of them:

```bash
export GOBARE_API=https://api.gobare.dev
export GOBARE_TOKEN=gbr_pat_…      # Console › Settings › Developer access
```

and a model connected under **Settings › LLM models**. Check all three at once:

```bash
curl -s $GOBARE_API/v1/model-credentials -H "Authorization: Bearer $GOBARE_TOKEN"
```

If that lists a credential, you are ready. The `model` in it is what goes in
`agent.model` below.

## The whole thing

Run it against any PDF. Standard library only — no SDK, no dependencies, in
either language. The TypeScript is ESM: save it as `.mts`, or put
`"type": "module"` in your `package.json`, or the top-level `await` will not
compile.

```tab:python
import base64, json, os, time, urllib.request

API, TOKEN = os.environ["GOBARE_API"], os.environ["GOBARE_TOKEN"]
PATH = "invoice-8842.pdf"                     # your file, on your disk

def call(method, path, body=None):
    req = urllib.request.Request(
        API + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": "Bearer " + TOKEN, "content-type": "application/json"},
        method=method,
    )
    return json.load(urllib.request.urlopen(req))

# 1. Create a session with the file already inside it. The bytes are base64;
#    `path` is relative to /workspace.
session = call("POST", "/v1/sessions", {
    "agent": {
        "model": "MiniMax-M3",
        "instructions": "Extract invoice fields exactly as written. "
                        "Never infer a missing value — use null.",
        "text": {"format": {"type": "json_schema", "schema": {
            "type": "object",
            "properties": {
                "invoice_number": {"type": "string"},
                "total":          {"type": "number"},
                "currency":       {"type": "string"},
                "issued_on":      {"type": ["string", "null"]},
            },
            "required": ["invoice_number", "total", "currency"],
            "additionalProperties": False,
        }}},
    },
    "environment": {"files": [{
        "type": "inline",
        "path": "invoices/" + os.path.basename(PATH),
        "data": base64.b64encode(open(PATH, "rb").read()).decode(),
    }]},
    "metadata": {"source": os.path.basename(PATH)},
    "input": f"Extract the fields from invoices/{os.path.basename(PATH)} and "
             f"write them to /workspace/outputs/result.json.",
})
sid = session["id"]
print("session", sid)

# 2. Wait for the artifacts, not for the turn. See "Why two waits" below.
while True:
    turns = call("GET", f"/v1/sessions/{sid}/turns?limit=1")["data"]
    if turns and turns[0]["artifacts"] in ("ready", "partial", "failed"):
        break
    time.sleep(5)

# 3. Collect and validate. The schema above is a request, not a guarantee —
#    this step is where your guarantee comes from.
for art in call("GET", f"/v1/sessions/{sid}/artifacts")["data"]:
    raw = urllib.request.urlopen(urllib.request.Request(
        f"{API}/v1/sessions/{sid}/artifacts/{art['id']}/content",
        headers={"Authorization": "Bearer " + TOKEN})).read()
    row = json.loads(raw)
    assert isinstance(row["total"], (int, float)), f"total is not a number: {row['total']!r}"
    print(json.dumps(row, indent=2))
```
```tab:typescript
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

const { GOBARE_API: API, GOBARE_TOKEN: TOKEN } = process.env as Record<string, string>;
const PATH = "invoice-8842.pdf";              // your file, on your disk

async function call(method: string, path: string, body?: unknown) {
  const response = await fetch(API + path, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status} ${await response.text()}`);
  return response.json();
}

// 1. Create a session with the file already inside it. The bytes are base64;
//    `path` is relative to /workspace.
const session = await call("POST", "/v1/sessions", {
  agent: {
    model: "MiniMax-M3",
    instructions: "Extract invoice fields exactly as written. Never infer a missing value — use null.",
    text: { format: { type: "json_schema", schema: {
      type: "object",
      properties: {
        invoice_number: { type: "string" },
        total:          { type: "number" },
        currency:       { type: "string" },
        issued_on:      { type: ["string", "null"] },
      },
      required: ["invoice_number", "total", "currency"],
      additionalProperties: false,
    } } },
  },
  environment: { files: [{
    type: "inline",
    path: `invoices/${basename(PATH)}`,
    data: (await readFile(PATH)).toString("base64"),
  }] },
  metadata: { source: basename(PATH) },
  input: `Extract the fields from invoices/${basename(PATH)} and write them to /workspace/outputs/result.json.`,
});
console.log("session", session.id);

// 2. Wait for the artifacts, not for the turn. See "Why two waits" below.
for (;;) {
  const { data: turns } = await call("GET", `/v1/sessions/${session.id}/turns?limit=1`);
  if (turns[0] && ["ready", "partial", "failed"].includes(turns[0].artifacts)) break;
  await new Promise((resolve) => setTimeout(resolve, 5000));
}

// 3. Collect and validate. The schema above is a request, not a guarantee —
//    this step is where your guarantee comes from.
const { data: artifacts } = await call("GET", `/v1/sessions/${session.id}/artifacts`);
for (const artifact of artifacts) {
  const bytes = await fetch(`${API}/v1/sessions/${session.id}/artifacts/${artifact.id}/content`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  const row = await bytes.json();
  if (typeof row.total !== "number") throw new Error(`total is not a number: ${JSON.stringify(row.total)}`);
  console.log(JSON.stringify(row, null, 2));
}
```

```
session b56a2a80-a3d9-47cc-b904-74b9b4ce5578
{
  "invoice_number": "INV-8842",
  "total": 4600.0,
  "currency": "USD",
  "issued_on": "2026-03-14"
}
```

The rest of this page is what each part does, and what to change when your
documents are not invoices.

## Getting your files in

This is the step most pipelines get stuck on, so it is worth being exact.

```json
{ "environment": { "files": [
  { "type": "inline", "path": "invoices/invoice-8842.pdf", "data": "JVBERi0xLjQK…" }
]}}
```

| | |
| --- | --- |
| `data` | Base64 of the file's **raw bytes**. Not text, not a URL, not an upload id |
| `path` | Relative to `/workspace`, or absolute under it. `invoices/x.pdf` lands at `/workspace/invoices/x.pdf` |
| Ceilings | 5 MiB a file, 10 MiB a request, 50 files — measured on the decoded bytes, not the base64 |

Base64 from a shell, if you are not in Python:

```bash
base64 < invoice-8842.pdf | tr -d '\n'      # macOS and Linux both
```

There is no `type: "url"` and no file-store id to reference: Gobare does not
fetch addresses on your behalf. For inputs past the ceilings, put them in a
repository and set `environment.repo` — the session clones it.

To add a file to a session that is **already running**, the same shape goes to
`POST /v1/sessions/{session_id}/files`. See [sessions.md](../sessions.md).

## Binary formats

Your documents are probably not text, and you do not need to convert them.

The session is a computer, and the agent is a coding agent on it. Asked for a
PDF it cannot read directly, it writes code and reads it anyway. Both of these
are from real runs:

| Input | What the agent did | What it cost |
| --- | --- | --- |
| PDF with an uncompressed text stream | Opened it directly | 4 tool calls |
| PDF with FlateDecode streams — what almost every real PDF is | Ran `python3` with `zlib` to decompress the streams, then read them | 7 tool calls, ~15 s longer |

Nothing in the request asked for that fallback and nothing had to be installed.
The same applies to `.xlsx`, `.docx` and images: it is a sandbox with Python in
it, so "can it read my format" is usually "yes, and it costs a few seconds".

Two things follow. **Budget for the slower path** — a scanned page needing OCR
is minutes, not seconds. And **say the format in your prompt** when you know it;
"the PDF at invoices/x.pdf" saves the agent a `file` call.

## Shaping the output

`agent.text.format` composes your JSON Schema into the model's instructions.
What that is worth, measured on the same invoice:

```json
// with text.format
{"invoice_number":"INV-9001","total":12500.00,"currency":"EUR","issued_on":"2026-07-02"}

// without it — same document, same model, same prompt
{"invoice_number":"INV-9001","total":"12,500.00","currency":"EUR","issued_on":"2026-07-02"}
```

A string with a thousands separator where your loader wants a number. It will
parse in your tests and fail on the first invoice over a thousand.

So: always set it. And never trust it. **The schema is composed into a prompt;
it is not parsed, enforced or retried on your behalf.** The `assert` in the
script above is not decoration — it is the only line in this pipeline that turns
"usually correct" into "correct or loud".

## Why two waits

A turn reaching `completed` does not mean its files are fetchable. Artifacts are
published after the turn settles, so for a moment the list is legitimately
empty — and an empty list is indistinguishable from "this turn produced
nothing".

The turn's `artifacts` field is the one to poll:

| Value | Meaning |
| --- | --- |
| `pending` | Not readable yet. An empty artifact list means *not yet* |
| `ready` | Publishing finished and took everything. An empty list now means the turn really produced nothing |
| `partial` | Publishing finished and left something behind. `artifacts_skipped` says which files and why |
| `failed` | Publishing could not run. Quote the turn id |

Wait for anything that is not `pending`. Treating `partial` as "not done yet"
loops for ever; treating it as `ready` is how a dropped file becomes a file you
believe the agent never wrote.

Using [webhooks](../webhooks.md) instead? Then ignore all of this:
`turn.completed` is sent after publishing has finished.

## A batch, not one file

One session per document, each with its own idempotency key derived from the
input:

```python
call("POST", "/v1/sessions", body)   # with this header:
# Idempotency-Key: extract-invoice-8842
```

Re-running after a crash re-sends the same keys and gets the **original
sessions** back rather than doing the work twice. Keys live 24 hours.

Two ceilings shape a batch. An organization runs a limited number of sessions at
once, so a hundred documents is a queue you drain rather than a hundred
simultaneous calls; and both `429`s — `rate_limit_exceeded` and
`project_limit_exceeded` — need telling apart, because only one is worth
retrying. [An agent behind your API](an-agent-behind-your-api.md) has the loop.

For many rows from one turn, take them in a single request:

```bash
curl -s "$GOBARE_API/v1/sessions/$SID/artifacts/archive?turn_id=$TID" \
  -H "Authorization: Bearer $GOBARE_TOKEN" | tar -x -C ./rows
```

## When it goes wrong

| What you see | Why | Fix |
| --- | --- | --- |
| Artifact list empty, turn `completed` | Publishing has not finished | Poll the turn's `artifacts` field, not its `status` |
| Artifact list empty, `artifacts: ready` | The agent wrote outside `/workspace/outputs` | Name the full output path in your prompt, as the script does — and check with `GET /v1/sessions/{id}/files`, which lists the whole workspace rather than only what was published |
| A file you expected is missing, `artifacts: partial` | It was past the per-file ceiling, or the turn ran out of budget | Read `artifacts_skipped` — it names the file and the reason. Ask for a smaller output, or split the work across turns |
| `total` comes back as a string | No `text.format`, or the model ignored it | Set it, and keep the validation — both |
| `400` naming a field | A field this API does not read | The message names it; [errors.md](../errors.md) |
| `429 project_limit_exceeded` | The organization is at its session ceiling | Delete finished sessions. Retrying never clears it |
| A file larger than 5 MiB is refused | Per-file ceiling | Use `environment.repo` |
| The agent says it cannot read the file | It is usually wrong about this | Say the format and the exact path in the prompt |

## You have it working when

- One session per document, each reaching `artifacts: ready`
- Every artifact parses as JSON **and** passes your own type check
- Re-running the batch with the same keys creates no new sessions
- `metadata` on each session ties the row back to the document

## Next

- [Put an agent behind your own API](an-agent-behind-your-api.md) — draining a queue without waiting
- [sessions.md](../sessions.md) — repositories, files afterwards, environment profiles
- [limits.md](../limits.md) — every ceiling named here, with its number
