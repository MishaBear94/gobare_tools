# Require human approval before the agent acts

> Published from the Gobare product repository. The canonical page is
> <https://docs.gobare.dev/guides/approvals-in-your-product/> — read it there; this copy is for offline and for tooling.

An agent that can restart a service or roll back a deployment should ask first,
and the asking should happen where your team already is — your dashboard, your
incident channel, your ticket queue.

What you build here: the agent stops before a dangerous action, your program
sees what it wants to do and why, a person decides, and the agent continues or
proposes something else.

```
agent decides to act  →  turn parks  →  your app shows it to a person
                                              ↓
       agent continues  ←  you send the answer  ←  they decide
```

## Before you start

A token and a model, as in the [quickstart](../quickstart.md). **You do not
need a public HTTPS endpoint** — this page uses polling, which runs on a laptop
behind a firewall. Webhooks are an optimisation, and they come last.

## The whole thing

```tab:python
import base64, json, os, time, urllib.request

API, TOKEN = os.environ["GOBARE_API"], os.environ["GOBARE_TOKEN"]

# Stand-in for whatever your agent actually operates on. The point is that the
# destructive action is real: these files exist and can genuinely be deleted.
FILES = [
    {"type": "inline", "path": f"data/export-2026-0{i}.csv",
     "data": base64.b64encode(f"id,amount\n{i},100\n".encode()).decode()}
    for i in range(1, 6)
] + [
    {"type": "inline", "path": "data/export-current.csv",
     "data": base64.b64encode(b"id,amount\n99,500\n").decode()},
]

def call(method, path, body=None):
    req = urllib.request.Request(API + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": "Bearer " + TOKEN, "content-type": "application/json"},
        method=method)
    return json.load(urllib.request.urlopen(req))

session = call("POST", "/v1/sessions", {
    "agent": {
        "model": "MiniMax-M3",
        "instructions": (
            "You maintain this workspace. You may read anything. "
            # Without this line the agent asks the user instead of acting, and an
            # API-only integration cannot answer. See "The type you did not expect".
            "Never ask the user a clarifying question: if something is ambiguous, "
            "state your assumption and continue. "
            "Before deleting or overwriting any file, call request_approval with what "
            "you intend to do and why, and wait for the answer. "
            "If you are refused, propose an alternative — do not work around it."
        ),
        "tools": [{
            "type": "function",
            "name": "request_approval",
            "description": "Ask a human to approve an action that changes production. "
                           "This tool records a decision and executes nothing.",
            "parameters": {
                "type": "object",
                "properties": {
                    "action":       {"type": "string", "description": "What you intend to do"},
                    "reason":       {"type": "string", "description": "Why it is necessary"},
                    "blast_radius": {"type": "string", "description": "What it affects if it goes wrong"},
                },
                "required": ["action", "reason", "blast_radius"],
                "additionalProperties": False,
            },
        }],
    },
    "environment": {"files": FILES},
    "input": "/workspace/data is nearly full. Delete the stale export files, "
             "keeping only export-current.csv.",
})
sid = session["id"]

while True:
    s = call("GET", f"/v1/sessions/{sid}")
    pending = s.get("required_actions") or []
    if not pending:
        if s["status"] in ("idle", "failed"):
            break
        time.sleep(5)
        continue

    action = pending[0]

    # Not every required action is yours to answer. See "The type you did not
    # expect" below — skipping this check is how a poller hangs forever.
    if action["type"] != "function_call":
        print(f"waiting on a person in the Console: {action['type']}")
        time.sleep(15)
        continue

    args = action["arguments"]
    print(f"\nAPPROVAL NEEDED\n  action: {args['action']}\n  reason: {args['reason']}"
          f"\n  blast radius: {args['blast_radius']}")
    ok = input("  approve? [y/N] ").strip().lower() == "y"

    call("POST", f"/v1/sessions/{sid}/events", {"events": [{
        "type": "input.tool_result",
        "turn_id": action["turn_id"],
        "call_id": action["call_id"],
        # True even for a refusal: your tool worked. See below.
        "success": True,
        "output": json.dumps(
            {"approved": True, "by": "dana@you.example.com"} if ok
            else {"approved": False, "reason": "peak hours; wait for the 02:00 window"}
        ),
    }]})
```
```tab:typescript
import { createInterface } from "node:readline/promises";

const { GOBARE_API: API, GOBARE_TOKEN: TOKEN } = process.env as Record<string, string>;

// Stand-in for whatever your agent actually operates on. The point is that the
// destructive action is real: these files exist and can genuinely be deleted.
const FILES = [
  ...[1, 2, 3, 4, 5].map((i) => ({
    type: "inline",
    path: `data/export-2026-0${i}.csv`,
    data: Buffer.from(`id,amount\n${i},100\n`).toString("base64"),
  })),
  { type: "inline", path: "data/export-current.csv", data: Buffer.from("id,amount\n99,500\n").toString("base64") },
];

async function call(method: string, path: string, body?: unknown) {
  const response = await fetch(API + path, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status} ${await response.text()}`);
  return response.json();
}

const session = await call("POST", "/v1/sessions", {
  agent: {
    model: "MiniMax-M3",
    instructions:
      "You maintain this workspace. You may read anything. " +
      // Without this line the agent asks the user instead of acting, and an
      // API-only integration cannot answer. See "The type you did not expect".
      "Never ask the user a clarifying question: if something is ambiguous, state your assumption and continue. " +
      "Before deleting or overwriting any file, call request_approval with what you intend to do and why, and wait for the answer. " +
      "If you are refused, propose an alternative — do not work around it.",
    tools: [{
      type: "function",
      name: "request_approval",
      description: "Ask a human to approve an action that changes production. This tool records a decision and executes nothing.",
      parameters: {
        type: "object",
        properties: {
          action:       { type: "string", description: "What you intend to do" },
          reason:       { type: "string", description: "Why it is necessary" },
          blast_radius: { type: "string", description: "What it affects if it goes wrong" },
        },
        required: ["action", "reason", "blast_radius"],
        additionalProperties: false,
      },
    }],
  },
  environment: { files: FILES },
  input: "/workspace/data is nearly full. Delete the stale export files, keeping only export-current.csv.",
});

const ask = createInterface({ input: process.stdin, output: process.stdout });

for (;;) {
  const current = await call("GET", `/v1/sessions/${session.id}`);
  const pending = current.required_actions ?? [];
  if (!pending.length) {
    if (current.status === "idle" || current.status === "failed") break;
    await new Promise((resolve) => setTimeout(resolve, 5000));
    continue;
  }

  const action = pending[0];

  // Not every required action is yours to answer. See "The type you did not
  // expect" below — skipping this check is how a poller hangs forever.
  if (action.type !== "function_call") {
    console.log(`waiting on a person in the Console: ${action.type}`);
    await new Promise((resolve) => setTimeout(resolve, 15000));
    continue;
  }

  const args = action.arguments;
  console.log(`\nAPPROVAL NEEDED\n  action: ${args.action}\n  reason: ${args.reason}\n  blast radius: ${args.blast_radius}`);
  const ok = (await ask.question("  approve? [y/N] ")).trim().toLowerCase() === "y";

  await call("POST", `/v1/sessions/${session.id}/events`, {
    events: [{
      type: "input.tool_result",
      turn_id: action.turn_id,
      call_id: action.call_id,
      // True even for a refusal: your tool worked. See below.
      success: true,
      output: JSON.stringify(
        ok ? { approved: true, by: "dana@you.example.com" }
           : { approved: false, reason: "peak hours; wait for the 02:00 window" },
      ),
    }],
  });
}
ask.close();
```

Replace `input()` with whatever your product already uses to ask a person.
Nothing else about the loop changes.

## Three choices worth copying

**The tool executes nothing.** It records a decision; the agent carries the
action out itself once approved. That keeps the approval free of side effects,
which is what makes it safe to deliver twice.

**`blast_radius` is required.** An approval request that does not say what is at
stake cannot be judged, and a model will happily omit it if you let it.

**"If you are refused, propose an alternative" is in the instructions.** What an
agent does after a refusal is a branch you design, not a default you inherit.

## The type you did not expect

`required_actions` holds three types, and **only one of them is yours**:

| `type` | Answered by |
| --- | --- |
| `function_call` | Your code, through this API — `input.tool_result` |
| `approval` | Your code, or a person in the Console — `input.approval` |
| `question` | Your code, or a person in the Console — `input.question_answer` |

**All three are answerable through this API.** They were not: for a while only
`function_call` was, and this page said so and called it uncomfortable. The
advice below about telling the agent not to ask is still useful when nothing in
your product can answer a question — but it is now a choice rather than the
only way out.

An earlier draft of this page used an on-call scenario. Run against a real
session, the agent did not call `request_approval` — it asked a clarifying
question, which arrives in the same list as
`{"type": "question", "name": "…the sandbox is empty, how should I proceed?"}`.
Adding the log file it said it was missing did not fix it; it asked again.

So a poller that assumes every entry is a function call answers a question
wrongly and then waits forever for a turn that is still blocked. Two things
follow, and the script does both:

**Branch on `type`.** Each has its own event, and sending the wrong one is a
`400` that names the right one:

```bash
# an approval
-d '{"events":[{"type":"input.approval","call_id":"call_9a1f…","approved":true}]}'

# a question
-d '{"events":[{"type":"input.question_answer","call_id":"call_9a1f…","answer":"Use the staging bucket."}]}'
```

`approved` must be `true` or `false` — it is not defaulted either way, because
denying something you meant to allow is a mistake and the other direction is
worse. `answer` reaches the model as written.

If nothing was waiting on that `call_id` — already answered, or the turn moved
on — you get `202` with `"outcome": "no_longer_pending"` rather than a refusal,
because that is what a retry after a dropped connection looks like.

**Tell the agent not to ask.** One line in `instructions` —

```
Never ask the user a clarifying question: if something is ambiguous,
state your assumption and continue.
```

— is what turned the question into work in the run above. If nothing in your
product can answer a `question`, the agent must not be allowed to raise one.

## Refusing is not failing

```tab:python
{"success": True, "output": json.dumps({"approved": False, "reason": "peak hours"})}
```
```tab:typescript
const answer = { success: true, output: JSON.stringify({ approved: false, reason: "peak hours" }) };
```

`success` describes **your tool**, not the decision. A refusal is your tool
working perfectly and returning "no".

`success: False` means your approval system itself broke — and the agent will
try to recover from a fault that did not happen, usually by retrying the call
you meant to deny.

Include who approved and when. The transcript then holds the audit trail
instead of it living only in your logs.

## Answering twice

A dropped connection during `POST /events` leaves you not knowing whether the
answer landed. Send it again: the second one comes back

```json
{"object":"input.accepted","type":"input.tool_result","outcome":"already_resolved"}
```

rather than being applied twice. The three outcomes are `accepted`,
`already_resolved` and `not_delivered` — the last meaning the call timed out
while you were deciding. All three are normal; see [input.md](../input.md).

## Swapping polling for webhooks

Once you have a public HTTPS endpoint, stop polling:

```bash
curl -s -X POST $GOBARE_API/v1/webhooks \
  -H "Authorization: Bearer $GOBARE_TOKEN" -H 'content-type: application/json' \
  -d '{ "url":"https://you.example.com/hooks/gobare",
        "events":["session.action_required","turn.completed","turn.failed"] }'
```

The response carries a `secret`, once. Store it; it is not shown again, and
verifying the signature before trusting a body is not optional —
[webhooks.md](../webhooks.md) has the formula.

**Read the session when the webhook arrives; do not act on its payload.**
Deliveries are at-least-once and may arrive out of order. The notification tells
you to look; `GET /v1/sessions/{session_id}` is what is true. The loop above is
already written that way, which is why moving to webhooks changes only what
wakes it.

## When it goes wrong

| What you see | Why | Fix |
| --- | --- | --- |
| The agent never calls your tool | The brief was too vague and it asked a question instead | Check `required_actions[].type`; give it the context it is missing |
| Your poller hangs forever | It answered a `question` as if it were a function call | Branch on `type` |
| `404 No pending action` | The `call_id` or `turn_id` is not from this session, or it already expired | Copy both from `required_actions` verbatim |
| `outcome: "not_delivered"` | The call timed out while a person was deciding | Set `timeout_seconds` on the tool to match human speed |
| The agent works around a refusal | Nothing told it what to do when denied | Put it in `instructions`, as above |
| A decision needs to wait overnight | A workspace lives two hours | Answer "queued for review" and start a fresh session tomorrow |

## You have it working when

- The agent stops before acting, and `required_actions` names your tool with all
  three fields filled in
- A refusal makes it propose something else rather than proceed
- Sending the same `call_id` twice reports `already_resolved`
- A `question` in the list does not break your loop

## Next

- [required-actions.md](../required-actions.md) — the full object, deadlines, expiry
- [input.md](../input.md) — the other three things you can send a session
- [Stream the agent's progress into your UI](showing-the-agents-work.md) — showing the investigation, not just the question
