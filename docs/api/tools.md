# Tools

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
out from under it, however long you take — but the turn does have a deadline,
and the session has the ceiling in [limits.md](limits.md).

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
you get an error rather than a confused answer.

> **Choose deliberately.** `required: false` and a broken URL is the one
> combination that produces no signal anywhere a caller can see it. If you are
> not sure, `required: true` is the safer default for anything the task
> actually depends on.

---

## Reading back what is set

```bash
curl https://api.gobare.dev/v1/sessions/$SESSION/tools \
  -H "Authorization: Bearer $GOBARE_TOKEN"
```

Returns the configuration as stored. Secrets you supplied in `authorization`
and `headers` are **not** returned.

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

Every refusal carries `{ error: { code, message, request_id } }` — see
[errors.md](errors.md).
