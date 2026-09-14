# Put an agent behind your own API

Your service takes a request, hands the work to an agent, and answers
immediately. Minutes later the agent finishes, your code collects the result,
and whoever asked gets told.

The whole problem is that your HTTP handler cannot wait, and an agent takes
minutes. So the work is split in two:

```
POST /reports  →  create session  →  return 202 + job id     (milliseconds)
                                     ↓
        your worker  ←  collect  ←  agent works, calls your functions
```

## Before you start

A token and a model, as in the [quickstart](../quickstart.md). Nothing here
needs a public HTTPS endpoint — the worker polls. [Webhooks](#replacing-the-poll-with-webhooks)
are the upgrade, and they come last.

## Dispatch: the half that must be fast

```tab:python
import json, os, urllib.request

API, TOKEN = os.environ["GOBARE_API"], os.environ["GOBARE_TOKEN"]

def call(method, path, body=None, headers=None):
    req = urllib.request.Request(API + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": "Bearer " + TOKEN, "content-type": "application/json",
                 **(headers or {})},
        method=method)
    return json.load(urllib.request.urlopen(req))

def dispatch(job_id, tenant, question):
    """Called from your request handler. Returns in milliseconds."""
    session = call("POST", "/v1/sessions", {
        "agent": {
            "model": "MiniMax-M3",
            "instructions": (
                "Answer with a short written summary. Put any tables or files in "
                "/workspace/outputs. "
                "Never ask the user a clarifying question: state your assumption and continue."
            ),
            "tools": [{
                "type": "function",
                "name": "lookup_order",
                "description": "Fetch an order from the billing system by id.",
                "parameters": {
                    "type": "object",
                    "properties": {"order_id": {"type": "string"}},
                    "required": ["order_id"],
                    "additionalProperties": False,
                },
                # How long the agent waits for *your* service. Per tool, because
                # patience is a property of the function.
                "timeout_seconds": 30,
            }],
        },
        "metadata": {"tenant": tenant, "job": job_id},
        "input": question,
    }, headers={"Idempotency-Key": f"job-{job_id}"})
    return session["id"]        # store it against your job, and return 202
```
```tab:typescript
const { GOBARE_API: API, GOBARE_TOKEN: TOKEN } = process.env as Record<string, string>;

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(API + path, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const failure: any = new Error(`${method} ${path} → ${response.status}`);
    failure.status = response.status;
    failure.code = (await response.json().catch(() => ({})))?.error?.code;
    throw failure;
  }
  return response.json();
}

/** Called from your request handler. Returns in milliseconds. */
async function dispatch(jobId: string, tenant: string, question: string) {
  const session = await call("POST", "/v1/sessions", {
    agent: {
      model: "MiniMax-M3",
      instructions:
        "Answer with a short written summary. Put any tables or files in /workspace/outputs. " +
        "Never ask the user a clarifying question: state your assumption and continue.",
      tools: [{
        type: "function",
        name: "lookup_order",
        description: "Fetch an order from the billing system by id.",
        parameters: {
          type: "object",
          properties: { order_id: { type: "string" } },
          required: ["order_id"],
          additionalProperties: false,
        },
        // How long the agent waits for *your* service. Per tool, because
        // patience is a property of the function.
        timeout_seconds: 30,
      }],
    },
    metadata: { tenant, job: jobId },
    input: question,
  }, { "idempotency-key": `job-${jobId}` });
  return session.id;                    // store it against your job, and return 202
}
```

Three things doing real work:

**`Idempotency-Key`** — your own job id, so a retried dispatch returns the
*same* session instead of creating a second one. Keys live 24 hours;
[idempotency.md](../idempotency.md).

**`metadata`** — how you match a result back to the request that caused it. It
is yours; nothing interprets it. Without it you are joining on session id
alone, which is fine until you need to find every job for one tenant.

**`timeout_seconds`** — how long the agent waits for your function before
giving up. Set it to what your service actually does, not to a default.

**The instruction against questions is not optional here.** A batch worker has
no one to ask. Without that line an agent that hits ambiguity parks on a
`question`, which your code cannot answer — see
[Require human approval](approvals-in-your-product.md#the-type-you-did-not-expect).

## Collect: the half that runs elsewhere

```tab:python
import time

def work_on(session_id):
    """Your worker. Answers the agent's calls; returns when the job is done."""
    while True:
        s = call("GET", f"/v1/sessions/{session_id}")

        for action in s.get("required_actions") or []:
            if action["type"] != "function_call":
                continue                      # not yours; a person answers it
            result = run_my_function(action["name"], action["arguments"])
            call("POST", f"/v1/sessions/{session_id}/events", {"events": [{
                "type": "input.tool_result",
                "turn_id": action["turn_id"], "call_id": action["call_id"],
                "success": True,
                "output": json.dumps(result),
            }]})

        if s["status"] == "failed":
            return {"ok": False, "error": "the turn failed"}

        if s["status"] == "idle" and not (s.get("required_actions") or []):
            turn = call("GET", f"/v1/sessions/{session_id}/turns?limit=1")["data"][0]
            if turn["artifacts"] == "pending":
                time.sleep(2)                 # settled, but files not published yet
                continue
            return {
                "ok": True,
                "answer": final_answer(session_id),
                "artifacts": call("GET", f"/v1/sessions/{session_id}/artifacts")["data"],
            }

        time.sleep(3)

def final_answer(session_id):
    """The agent's written reply: the newest assistant message."""
    items = call("GET", f"/v1/sessions/{session_id}/items?limit=20")["data"]
    for item in items:                        # newest first
        if item["type"] == "message" and item.get("role") == "assistant":
            return item["content"]
    return None

def run_my_function(name, args):
    if name == "lookup_order":
        return {"status": "shipped", "carrier": "DHL", "order_id": args["order_id"]}
    raise ValueError(f"no such function: {name}")
```
```tab:typescript
/** Your worker. Answers the agent's calls; returns when the job is done. */
async function workOn(sessionId: string) {
  for (;;) {
    const session = await call("GET", `/v1/sessions/${sessionId}`);

    for (const action of session.required_actions ?? []) {
      if (action.type !== "function_call") continue;   // not yours; a person answers it
      const result = await runMyFunction(action.name, action.arguments);
      await call("POST", `/v1/sessions/${sessionId}/events`, {
        events: [{
          type: "input.tool_result",
          turn_id: action.turn_id,
          call_id: action.call_id,
          success: true,
          output: JSON.stringify(result),
        }],
      });
    }

    if (session.status === "failed") return { ok: false, error: "the turn failed" };

    if (session.status === "idle" && !(session.required_actions ?? []).length) {
      const [turn] = (await call("GET", `/v1/sessions/${sessionId}/turns?limit=1`)).data;
      if (turn.artifacts === "pending") {             // settled, but files not published yet
        await new Promise((resolve) => setTimeout(resolve, 2000));
        continue;
      }
      return {
        ok: true,
        answer: await finalAnswer(sessionId),
        artifacts: (await call("GET", `/v1/sessions/${sessionId}/artifacts`)).data,
      };
    }

    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}

/** The agent's written reply: the newest assistant message. */
async function finalAnswer(sessionId: string) {
  const { data: items } = await call("GET", `/v1/sessions/${sessionId}/items?limit=20`);
  for (const item of items) {                          // newest first
    if (item.type === "message" && item.role === "assistant") return item.content;
  }
  return null;
}

async function runMyFunction(name: string, args: any) {
  if (name === "lookup_order") return { status: "shipped", carrier: "DHL", order_id: args.order_id };
  throw new Error(`no such function: ${name}`);
}
```

```
session caba0de9-a982-4e37-a80a-6c7ff4381893
result: {"ok": true,
         "answer": "Order **A-4471** is currently **shipped via DHL**. No errors
                    or issues are flagged — status is healthy (\"shipped\").",
         "artifacts": []}
```

That is the whole round trip: the agent called `lookup_order`, this worker
answered it over the API, and the agent used the answer in its reply.

**Two ways a result comes back, and you usually want both.** Prose is the
newest assistant message in `/items`; files are artifacts. A question like the
one above produces only prose, so an empty artifact list here is correct — not a
symptom. Ask for a table or a CSV and you get both.

Two subtleties, both of which cost an afternoon if you meet them by accident.

**`idle` does not mean finished.** It means no turn is running. A session
parked on your function is `requires_action`, and one waiting to be collected is
`idle` — so check `required_actions` before you conclude anything.

**`completed` does not mean fetchable.** Artifacts publish after the turn
settles; `turn.artifacts` leaving `pending` is the real signal. The loop above
waits for it.

## Never put an exception in `error`

```tab:python
try:
    result = run_my_function(...)
except Exception:
    log.exception("lookup failed")            # to your logs
    body = {"success": False, "error": "The lookup service is unavailable."}
```
```tab:typescript
try {
  result = await runMyFunction(name, args);
} catch (error) {
  log.error({ error }, "lookup failed");        // to your logs
  body = { success: false, error: "The lookup service is unavailable." };
}
```

`error` goes to the model, and the model may quote it to your end user. A stack
trace is an efficient way to put your database host in a prompt. Send a fixed
sentence; log the real one.

## Running many at once

An organization runs a limited number of sessions concurrently, so a hundred
jobs is a queue you drain — not a hundred simultaneous `POST`s.

Two different `429`s come back, and **only one is worth retrying**:

| `error.code` | Meaning | What to do |
| --- | --- | --- |
| `rate_limit_exceeded` | Too many requests, too fast | Back off and retry. Honour `Retry-After` |
| `project_limit_exceeded` | The organization is at its session ceiling | **Retrying never clears this.** Delete finished sessions, or raise the ceiling |

```tab:python
import urllib.error

def dispatch_with_backoff(*args, delay=1.0):
    while True:
        try:
            return dispatch(*args)
        except urllib.error.HTTPError as e:
            if e.code != 429:
                raise
            body = json.loads(e.read())
            if body["error"]["code"] == "project_limit_exceeded":
                raise RuntimeError(body["error"]["message"])   # a queue, not a retry
            time.sleep(delay)
            delay = min(delay * 2, 30)
```
```tab:typescript
async function dispatchWithBackoff(jobId: string, tenant: string, question: string, delay = 1000) {
  for (;;) {
    try {
      return await dispatch(jobId, tenant, question);
    } catch (error: any) {
      if (error.status !== 429) throw error;
      // Only one of the two is worth retrying. Branching on the status alone is
      // the mistake: a worker that retries project_limit_exceeded hammers a
      // wall until someone notices the bill.
      if (error.code === "project_limit_exceeded") throw error;
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, 30_000);
    }
  }
}
```

Telling them apart on status alone is the mistake: a worker that retries
`project_limit_exceeded` hammers a wall until someone notices the bill.

Finished sessions hold their slot until deleted. `DELETE /v1/sessions/{session_id}`
when you have collected the artifacts you need — they outlive the session.

## Replacing the poll with webhooks

Once you have a public HTTPS endpoint, stop polling. One subscription serves
every session:

```bash
curl -s -X POST $GOBARE_API/v1/webhooks \
  -H "Authorization: Bearer $GOBARE_TOKEN" -H 'content-type: application/json' \
  -d '{ "url":"https://you.example.com/hooks/gobare",
        "events":["turn.completed","turn.failed","session.action_required"] }'
```

The `secret` comes back once. Verify every delivery's signature before trusting
it — [webhooks.md](../webhooks.md).

**Deliveries are at-least-once and may arrive out of order.** So the handler
does not act on the payload; it reads the session, exactly as the loop above
does. That is why moving to webhooks changes what wakes your worker and nothing
else — and why `turn.completed` is safe to act on directly: it is sent *after*
artifacts are published.

## When it goes wrong

| What you see | Why | Fix |
| --- | --- | --- |
| Your worker never returns | The session parked on a `question` it cannot answer | Branch on `type`; add the anti-question instruction |
| Empty artifacts on a `completed` turn | Publishing had not finished | Wait for `turn.artifacts != "pending"` |
| A retried dispatch made two sessions | No `Idempotency-Key`, or a key older than 24 hours | Use your job id |
| `429` that never clears | `project_limit_exceeded` | Delete finished sessions; it is a ceiling, not a rate |
| The agent answers without calling your function | It was not told the function is the only source | Say so in `instructions` |
| Duplicate webhook deliveries | At-least-once, by design | Make the handler idempotent; read the session |

## You have it working when

- Your endpoint returns in milliseconds and never blocks on the agent
- A retried dispatch with the same job id yields one session
- The worker answers function calls and collects artifacts without human help
- A `project_limit_exceeded` queues rather than spins
- Killing the worker mid-job and restarting it resumes cleanly

## Next

- [Require human approval before the agent acts](approvals-in-your-product.md) — when a person must decide
- [Stream the agent's progress into your UI](showing-the-agents-work.md) — showing the work, not a spinner
- [limits.md](../limits.md) — every ceiling, with its number
