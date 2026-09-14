# Tools

> Published from the Gobare product repository. The canonical page is
> <https://docs.gobare.dev/tools> — read it there; this copy is for offline and for tooling.


Two kinds, and they differ in where the code runs.

| | Runs where | Use it for |
| --- | --- | --- |
| **function** | **Your process.** The agent asks; you answer. | Anything only your system knows — an order's status, a customer record, a price |
| **mcp** | **A server the sandbox connects to.** | An MCP server you host, or a hosted one from a vendor |

Both are set with one call, which **replaces** the whole configuration:

```
PUT /v1/sessions/{session_id}/tools
```

At most **32** tools per session; each name is **1–64** characters.

---

## Function tools

You declare the shape; the agent calls it; the turn stops until you answer.

```bash
curl -X PUT https://api.gobare.dev/v1/sessions/$SESSION/tools \
  -H "Authorization: Bearer $GOBARE_TOKEN" \
  -H "content-type: application/json" \
  -d '{
    "tools": [{
      "type": "function",
      "name": "lookup_order",
      "description": "Look up the delivery status of an order by id.",
      "parameters": {
        "type": "object",
        "properties": { "order_id": { "type": "string" } },
        "required": ["order_id"]
      }
    }]
  }'
```

When the agent calls it, the session reports a required action and waits.
Answering is [required-actions.md](required-actions.md); the loop is written
for you in [`run-session.ts`](run-session.ts).

**A turn waiting on you is still in flight.** The workspace is not reclaimed
out from under it, however long you take. There is no deadline on the answer
unless you set one — `timeout_seconds` on the tool, see
[required-actions.md](required-actions.md) — and the only ceiling either way is
the workspace's two hours, in [limits.md](limits.md).

---

## MCP servers

Exactly one of `url` or `command`:

- **`url`** — a server already running, which the sandbox connects out to.
- **`command`** — a process started inside the sandbox, spoken to over stdio.

```bash
curl -X PUT https://api.gobare.dev/v1/sessions/$SESSION/tools \
  -H "Authorization: Bearer $GOBARE_TOKEN" \
  -H "content-type: application/json" \
  -d '{
    "tools": [{
      "type": "mcp",
      "name": "docs",
      "url": "https://mcp.example.com/mcp",
      "headers": { "x-api-key": "…" },
      "allowed_tools": ["search", "fetch"],
      "required": true
    }]
  }'
```

| Field | Meaning |
| --- | --- |
| `name` | What the agent sees this server called. Unique within the session |
| `url` | An MCP endpoint over streamable HTTP |
| `authorization` / `headers` | Sent on connect. Use these for the server's own credentials |
| `command` / `args` / `env_refs` | For a stdio server started in the sandbox |
| `allowed_tools` | Narrow the server to these tools. Omit to allow all of them |
| `required` | See below. **Defaults to `false`** |

**The connection is made from the sandbox, not from us.** Your tool traffic does
not pass through our control plane — which is what lets an MCP server on your
private network be reachable at all, and keeps our egress out of your blast
radius. A server reachable only from your VPC works if the sandbox is in it;
one behind your office firewall does not.

### When a server cannot be reached

**By default it is skipped, and the agent simply has fewer tools.** Nothing
fails. The agent will usually say it cannot do the thing you asked — which
looks like the model being unhelpful, when the real cause is a server that
never answered.

That default is deliberate: one optional server being down should not destroy a
session that could still do most of its work. But it is only right when the
server really is optional.

**You will be told, though.** A skipped server produces an `mcp_unavailable`
item in the session's transcript and an `mcp.unavailable` event on the stream:

```jsonc
{ "type": "mcp_unavailable", "server": "docs", "reason": "fetch failed" }
```

So when an agent says it could not do something, check the items before you
conclude the model was weak — that is the mistake this item exists to prevent.

**If the session is pointless without that server, say so:**

```jsonc
{ "type": "mcp", "name": "docs", "url": "…", "required": true }
```

With `required: true` the session fails loudly instead of running crippled, and
you get an error rather than a confused answer. It arrives on the first call
that needs the workspace — sending a message, writing a file — and it names the
server and what went wrong:

```json
{"error":{"code":"invalid_request",
  "message":"This session cannot start: required MCP server(s) failed to initialise — docs: fetch failed. That server is configured with `required: true`, so the session refuses to run without it — fix the server, or set `required: false` to let the agent continue with fewer tools."}}
```

`invalid_request` rather than a retryable code, deliberately: waiting will not
make the server reachable. This is a configuration to change, not a state to
wait out.

> **Choose deliberately.** `required: false` and a broken URL is the one
> combination that produces no signal anywhere a caller can see it. If you are
> not sure, `required: true` is the safer default for anything the task
> actually depends on.

`required` must be `true` or `false`. A string — `"required": "yes"` — is
refused rather than read as `false`, because `false` is a real choice here and
not one you would have made by writing the word required.

---

## Reading the configuration back

```bash
curl https://api.gobare.dev/v1/sessions/$SESSION/tools \
  -H "Authorization: Bearer $GOBARE_TOKEN"
```

```json
{"object":"session.tools","session_id":"3f9c1b60-…",
 "tools":[{"type":"mcp","name":"docs","url":"https://mcp.example.com/mcp",
           "allowed_tools":["search"],"redacted":["authorization"]}],
 "text":null}
```

The answer is in the same vocabulary you sent: one `tools` array, each entry
carrying its `type`. The same shape goes back to `PUT`.

**Secrets are not returned.** `authorization` and every header value are held
back, and `redacted` names what was withheld — so a server with credentials
configured is distinguishable from one without, which an omission alone would
not tell you.

`redacted` is not a request field. If you read the configuration, change
something and `PUT` it back, you get a `400` naming `redacted` rather than a
success that quietly replaced your credentials with nothing. Re-send the
secrets, or build the body from your own source.

---

## Refusals

| You sent | You get |
| --- | --- |
| More than 32 tools | `400 invalid_request`, naming the ceiling |
| A name over 64 characters, or empty | `400 invalid_request` |
| Two MCP servers with the same name | `400 invalid_request`, naming the duplicate |
| Both `url` and `command`, or neither | `400 invalid_request` — exactly one |
| A `url` that will not parse | `400 invalid_request` |
| `POST` instead of `PUT` | `400 invalid_request` — the tool set is replaced, not appended |
| An unknown field | `400 invalid_request`, naming the field |
| An unknown field **inside a tool entry** — `allowedTools` for `allowed_tools`, `cmd` for `command`, `timeout` for `timeout_seconds` | `400 invalid_request`, naming the field and listing what the entry accepts |
| `redacted`, sent back from a read | `400 invalid_request` — re-send the secret itself |

Every refusal carries `{ error: { code, message, request_id } }` — see
[errors.md](errors.md).

## Next

- [required actions](required-actions.md) — answer a call the agent makes
- [extracting structured data](guides/extracting-structured-data.md) — shape what comes back
