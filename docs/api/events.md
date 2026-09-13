# Events

Server-sent events, resumable. Two streams:

| | |
| --- | --- |
| `GET /v1/sessions/{session_id}/events` | One session |
| `GET /v1/events` | Every session the organization owns |

Both need `sessions:read`.

```bash
curl -N $GOBARE_API/v1/events -H "Authorization: Bearer $GOBARE_TOKEN"
```

Each frame is the SSE `event:` name plus a JSON `data:`:

```
id: 4812
event: agent.message
data: {"object":"event","type":"agent.message","internal_type":"agent.message",
       "session_id":"3f9c1b60-4e2a-4d18-9a77-6c0b2e5d81af","seq":4812,"created_at":1789…,"payload":{…}}
```

`internal_type` travels alongside `type` so that when you ask us about
something, you and our logs are naming the same thing.

## Resuming

**An `id:` line is written only for a persisted event.** Reconnect with
`Last-Event-ID: <seq>` (or `?last_event_id=<seq>`) and you get everything
persisted after that point, then live frames.

```bash
curl -N "$GOBARE_API/v1/sessions/$SESSION/events?last_event_id=4812" \
  -H "Authorization: Bearer $GOBARE_TOKEN"
```

Transient events — text deltas, command output, progress — stream live and
carry `seq: null`. They do not advance the cursor and are not replayed.

So a reconnecting caller misses deltas but not facts: `agent.text` is the
token-by-token stream and is transient, while `agent.message` is its settled
form and is persisted. **Build on the persisted events; treat the transient ones
as decoration.** A cursor always names a row that exists, which is what makes
resuming safe rather than approximate.

## The vocabulary

An allowlist. Gobare's internal event vocabulary has fifty-odd members and grows
with the Console's needs; publishing all of it would make every rendering detail
a promise we could not withdraw.

| Event | Persisted | Meaning |
| --- | --- | --- |
| `turn.started` | yes | A run began |
| `turn.ended` | yes | A run finished. Whether it succeeded is a property of the turn — read `turn_id` |
| `agent.text` | no | Token delta |
| `agent.message` | yes | A settled assistant message |
| `agent.thinking` | no | Reasoning delta |
| `agent.tool_call` | yes | The agent called a tool |
| `agent.tool_result` | yes | A tool answered |
| `agent.compaction` | yes | Context was compacted |
| `agent.error` | yes | Something went wrong inside the run |
| `agent.todos` | yes | The agent's task list changed |
| `user.message` | yes | Input was recorded |
| `message.queued` | yes | Input arrived while a turn was running |
| `message.dequeued` | yes | A queued message started |
| `file.changed` | yes | A workspace file was created, modified or deleted |
| `approval.requested` | yes | The agent wants permission |
| `approval.resolved` | yes | Permission was granted or refused |
| `question.asked` | yes | The agent asked a person something |
| `question.answered` | yes | It was answered |
| `tool.required` | yes | Your code must answer — see [required-actions.md](required-actions.md) |
| `tool.resolved` | yes | It was answered |
| `sandbox.created` / `sandbox.paused` / `sandbox.resumed` | yes | Workspace lifecycle |
| `preview.ready` | yes | A service the agent started is reachable |
| `workspace.recovery_failed` | yes | A workspace could not be restored |
| `artifact.created` | yes | A turn published a file |

`turn.ended` is deliberately neutral. The run finished; whether it succeeded is
a property of the turn resource, which the same event names. Calling it
`turn.completed` would be a guess made at the wrong moment.

## Operational notes

- A comment frame (`: ping`) every 15 seconds keeps the connection open. Ignore it.
- `retry: 2000` is sent on open; honour it rather than reconnecting instantly.
- Concurrent streams are capped per token and per organization. See
  [limits.md](limits.md).
- The organization-wide stream re-checks ownership per event, so a session
  created after you connected still appears on it.

## Polling instead

Streaming is not required. `GET /v1/sessions/{id}/turns` and
`GET /v1/sessions/{id}/items` are the same facts, and a poll every few seconds
is a perfectly reasonable integration — it just costs more requests, and
requests are rate limited.

## `mcp.unavailable`

An MCP server you declared would not connect and was skipped. Carries `server`
and `reason`. Not an error: the turn continues without that server's tools,
which is what `required: false` asks for. See [tools.md](tools.md) if you would
rather it failed.
