/**
 * `runSession()` — the loop you would otherwise write yourself.
 *
 * This is the code the documentation hands to a reader, and it is real code
 * rather than a fenced block in a markdown file. `pnpm e2e:v1:minimax` runs
 * against production through this exact file, and `published-docs.test.ts`
 * checks both that the e2e still imports it and that every option and result
 * field the quickstart's snippet reaches for is one declared below. An example
 * that cannot compile is worse than no example, and the only reliable way to
 * know an example compiles is to compile it.
 *
 * It is published by scripts/publish-api-docs.sh, which copies this file next
 * to the pages that link to it.
 *
 * ── Why this exists now that there *is* an SDK ──
 * It used to say "we decided not to publish a client package". That decision
 * (07-HARDENING-PLAN §N4.3) has been reversed — `sdk/ts` is the client library
 * — and the obvious next thought, that this file should move into it, is
 * wrong.
 *
 * The two artifacts have different readers. `@gobare/api` is for someone who
 * has already chosen us and will add a dependency. This file is for someone
 * deciding, who wants to read the whole loop in one screen and run it with
 * `node run-session.ts`. That is why it imports nothing — see the note on the
 * error class below, which avoids TypeScript that Node cannot strip. Give it
 * an `import { Transport } from "../transport.ts"` and it stops being the
 * thing it is for.
 *
 * So it stays, and stays dependency-free. Where they overlap, the SDK is the
 * one to change first: this file is an example, and an example that grows
 * features stops being readable in one screen.
 *
 * The three things the loop has to get right, all of which fail silently:
 *
 *   1. Subscribe before you send. Reversed, you miss the opening events — and
 *      only when the agent is fast, which is to say only sometimes.
 *   2. Answer required actions, or the turn sits in `waiting` until its
 *      deadline and then fails for a reason that looks unrelated.
 *   3. Never send a thrown error's text to the model. A stack trace is an
 *      excellent way to put your database host in a model's context.
 *
 * The third is a safe default, not advice. Advice in a document is followed by
 * the people who read that paragraph.
 *
 * ── What it does that a generated client would not ──
 * Resumes. Our event stream replays from `Last-Event-ID`, so a dropped
 * connection continues from the last persisted event instead of starting over
 * or silently losing the middle. That is our strongest difference from the API
 * this one is measured against, and leaving a reader to discover it would
 * waste it.
 */

/** What the model may see when your handler throws. Deliberately fixed. */
export const HANDLER_FAILURE_MESSAGE = "The tool failed. Ask the user how to proceed.";

export interface RunSessionOptions {
  /** `https://api.gobare.dev`, or your own deployment. */
  baseUrl: string;
  /** A `gbr_pat_` token with `sessions:read`, `sessions:write`, `tools:respond`. */
  token: string;
  /** The first thing to ask the agent. */
  input: string;
  /** Anything `POST /v1/sessions` accepts: agent, environment, metadata. */
  session?: Record<string, unknown>;
  /**
   * Run this turn on a session that already exists, instead of creating one.
   *
   * The second and later turns of a conversation. `session` is ignored when
   * this is set — a session's configuration is fixed at creation, and quietly
   * accepting settings that would not be applied is worse than ignoring them
   * loudly, which is what this sentence is for.
   */
  existingSessionId?: string;
  /**
   * Your own functions, by name. Return a string; it is handed to the model
   * as the tool's output. Throwing is safe — see HANDLER_FAILURE_MESSAGE.
   */
  handlers?: Record<string, (args: unknown) => Promise<string> | string>;
  /** Every published event, in order, including replayed ones after a drop. */
  onEvent?: (event: ApiEvent) => void;
  /** Stop waiting after this long. Default 15 minutes. */
  timeoutMs?: number;
  /** Injected in tests. Defaults to global fetch. */
  fetch?: typeof globalThis.fetch;
}

export interface ApiEvent {
  type: string;
  session_id: string;
  seq: number | null;
  created_at: number;
  payload: Record<string, unknown>;
}

export interface RunSessionResult {
  sessionId: string;
  /** `completed`, `failed` or `cancelled`. */
  status: string;
  turnId: string | null;
  /** The agent's last assistant message, when there was one. */
  text: string | null;
  error: { code: string; message: string } | null;
}

/**
 * The idempotency key a turn's send goes out under.
 *
 * Exported because a caller who retries a send by hand — outside this helper,
 * from a queue or a job runner — needs the same key, and deriving it from the
 * session id alone would make two different turns look like retries of each
 * other. Stable for one turn, different between two.
 */
export function turnIdempotencyKey(sessionId: string, input: string): string {
  return `run-${sessionId}-${hash(input)}`;
}

/** A short, stable fingerprint of a turn's input. Not a security boundary. */
function hash(input: string): string {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

class ApiFailure extends Error {
  // Declared and assigned rather than written as constructor parameter
  // properties. That shorthand is TypeScript that has no JavaScript to erase
  // to, so `node run-session.ts` refuses the file outright with
  // ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX — and running it directly is the whole
  // point of a file whose pitch is "copy it into your project".
  readonly status: number;
  readonly code: string;
  readonly requestId?: string;

  constructor(status: number, code: string, message: string, requestId?: string) {
    super(`${code}: ${message}${requestId ? ` (request ${requestId})` : ""}`);
    this.name = "ApiFailure";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

/**
 * Create a session, send one message, answer the agent's calls, return when
 * the turn settles.
 */
export async function runSession(options: RunSessionOptions): Promise<RunSessionResult> {
  const http = options.fetch ?? globalThis.fetch;
  // Distinguishes this turn from another on the same session, while staying
  // stable across retries of this one.
  const turnKey = options.input;
  const deadline = Date.now() + (options.timeoutMs ?? 15 * 60_000);

  const call = async (path: string, init: RequestInit = {}): Promise<any> => {
    const response = await http(options.baseUrl + path, {
      ...init,
      headers: {
        authorization: `Bearer ${options.token}`,
        "content-type": "application/json",
        ...(init.headers as Record<string, string> | undefined),
      },
    });
    const text = await response.text();
    const body = text ? JSON.parse(text) : null;
    if (!response.ok) {
      throw new ApiFailure(response.status, body?.error?.code ?? "unknown", body?.error?.message ?? text, body?.error?.request_id);
    }
    return body;
  };

  const sessionId: string = options.existingSessionId
    ? options.existingSessionId
    : (await call("/v1/sessions", { method: "POST", body: JSON.stringify(options.session ?? {}) })).id;

  // Subscribed before the message is sent. The other order drops the opening
  // events whenever the agent starts quickly, which is the hardest kind of bug
  // to reproduce because it depends on being fast.
  const events = watch(sessionId);

  await call(`/v1/sessions/${sessionId}/events`, {
    method: "POST",
    // A retry of a dropped send must not queue the message twice — but two
    // different turns on the same session are not retries of each other, so
    // the key cannot be the session id alone. It was, and a second turn would
    // have silently replayed the first turn's answer.
    headers: { "idempotency-key": turnIdempotencyKey(sessionId, turnKey) },
    body: JSON.stringify({ events: [{ type: "input.message", content: options.input }] }),
  });

  try {
    return await settle();
  } finally {
    events.stop();
  }

  /**
   * Follow the stream, resuming from the last persisted event.
   *
   * `seq` advances only on persisted events, so the cursor always names a row
   * that exists. Text deltas stream and do not advance it: a reconnect misses
   * the typing, never the transcript.
   */
  function watch(id: string) {
    let stopped = false;
    let cursor = 0;
    const controller = { current: new AbortController() };

    void (async () => {
      while (!stopped && Date.now() < deadline) {
        try {
          controller.current = new AbortController();
          const response = await http(`${options.baseUrl}/v1/sessions/${id}/events${cursor ? `?last_event_id=${cursor}` : ""}`, {
            headers: { authorization: `Bearer ${options.token}`, accept: "text/event-stream" },
            signal: controller.current.signal,
          });
          if (!response.ok || !response.body) throw new Error(`stream ${response.status}`);

          let buffer = "";
          for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
            if (stopped) break;
            buffer += new TextDecoder().decode(chunk);
            // SSE frames are separated by a blank line. A partial frame stays
            // in the buffer rather than being parsed as a whole one.
            let split: number;
            while ((split = buffer.indexOf("\n\n")) !== -1) {
              const frame = buffer.slice(0, split);
              buffer = buffer.slice(split + 2);
              const data = frame.split("\n").find((line) => line.startsWith("data:"));
              if (!data) continue;
              let event: ApiEvent;
              try {
                event = JSON.parse(data.slice(5).trim());
              } catch {
                continue;
              }
              if (typeof event.seq === "number") cursor = event.seq;
              options.onEvent?.(event);
            }
          }
        } catch {
          // Any drop resumes from `cursor`. Without the cursor this would
          // either replay from the beginning or lose whatever arrived while
          // the connection was down.
          if (!stopped) await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      }
    })();

    return { stop: () => { stopped = true; controller.current.abort(); } };
  }

  /** Poll the turn, answering anything the agent is waiting on. */
  async function settle(): Promise<RunSessionResult> {
    const SETTLED = new Set(["completed", "failed", "cancelled"]);
    while (Date.now() < deadline) {
      const current = await call(`/v1/sessions/${sessionId}`);
      for (const action of current.required_actions ?? []) {
        if (action.type === "function_call") await answer(action);
      }

      const { data } = await call(`/v1/sessions/${sessionId}/turns?limit=1`);
      const turn = data?.[0];
      if (turn && SETTLED.has(turn.status)) {
        return { sessionId, status: turn.status, turnId: turn.id, text: await lastMessage(), error: turn.error ?? null };
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    return { sessionId, status: "timeout", turnId: null, text: await lastMessage(), error: null };
  }

  /** Run one of the caller's functions and hand the result back to the agent. */
  async function answer(action: { turn_id: string; call_id: string; name: string | null; arguments: unknown }): Promise<void> {
    const handler = action.name ? options.handlers?.[action.name] : undefined;
    let result: { success: boolean; output?: string; error?: string };
    if (!handler) {
      result = { success: false, error: `No handler for ${action.name ?? "an unnamed function"}.` };
    } else {
      try {
        result = { success: true, output: await handler(action.arguments) };
      } catch {
        // The thrown message never reaches the model. A stack trace is an
        // excellent way to put your database host into a model's context, and
        // this is the default rather than a paragraph someone has to read.
        result = { success: false, error: HANDLER_FAILURE_MESSAGE };
      }
    }
    await call(`/v1/sessions/${sessionId}/events`, {
      method: "POST",
      body: JSON.stringify({
        events: [{ type: "input.tool_result", turn_id: action.turn_id, call_id: action.call_id, ...result }],
      }),
    });
  }

  async function lastMessage(): Promise<string | null> {
    const { data } = await call(`/v1/sessions/${sessionId}/items?limit=100&order=asc`);
    const messages = (data ?? []).filter((item: any) => item.type === "message" && item.role === "assistant");
    return messages.at(-1)?.content ?? null;
  }
}
