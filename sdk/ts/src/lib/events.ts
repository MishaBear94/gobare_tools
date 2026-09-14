/**
 * The event stream, as an async iterator that survives a dropped connection.
 *
 * Hand-written because a generated method cannot be right here: the response is
 * `text/event-stream`, and the document said `application/json` for long enough
 * that a client built from it would have parsed a connection held open for the
 * life of a session.
 *
 * ── What this file knows that the endpoint description cannot ──
 *
 * 1. **No cursor and cursor `0` are different requests.** No cursor is live
 *    frames only, which is what "subscribe before you send" needs. `0` is
 *    everything, because zero is a real cursor — it is the one `let cursor = 0`
 *    starts with. A client that normalised the two would either replay a
 *    session's whole history on every subscribe, or lose a first connection's
 *    backlog. Both look like the API misbehaving.
 *
 * 2. **Only persisted events advance the cursor.** Transient frames — text
 *    deltas, thinking, progress — carry `seq: null`. Advancing on one would
 *    produce a cursor naming a row that was never written, and the resume after
 *    it would ask for history that does not exist.
 *
 * 3. **Reconnecting has to honour the server's own `retry:` hint.** It is
 *    deliberately longer than the time it takes the proxy to notice a
 *    connection has gone. A client reconnecting faster, at its stream ceiling,
 *    is refused for a stream it has already closed.
 */
import type { Transport } from "../transport.ts";
import { GobareError, errorFrom } from "./errors.ts";

export interface GobareEvent {
  object: "event";
  type: string;
  /** What our own logs call it. Quote it and we are naming the same thing. */
  internal_type?: string;
  session_id: string;
  /** Null on a transient frame. Never advances the resume cursor. */
  seq: number | null;
  created_at: number;
  payload?: unknown;
  [key: string]: unknown;
}

export interface WatchOptions {
  /**
   * Where to resume from.
   *
   * Omitted means live frames only. `0` means everything. These are different
   * requests and the difference is deliberate — see the note at the top.
   */
  lastEventId?: number;
  signal?: AbortSignal;
  /**
   * Reconnect on a dropped connection. Default true.
   *
   * The cursor is maintained across reconnects, so no persisted event is
   * missed. Transient frames sent while disconnected are gone, which is what
   * "treat them as decoration" means in practice.
   */
  reconnect?: boolean;
  /** Called before each reconnect wait. For logging; not a hook to retry from. */
  onReconnect?: (info: { attempt: number; waitMs: number; cursor: number | null }) => void;
}

const DEFAULT_RETRY_MS = 2000;

/**
 * Parse an SSE byte stream into frames.
 *
 * Written out rather than taken from a library because the whole file is
 * eleven lines of state machine and the failure mode of getting it slightly
 * wrong — a frame split across two chunks — only appears under load.
 */
async function* frames(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<{ id?: string; event?: string; data: string; retry?: number }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const abort = () => reader.cancel().catch(() => {});
  signal?.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // A frame ends at a blank line. Chunk boundaries fall anywhere, so the
      // remainder is kept rather than parsed — this is the part that only
      // misbehaves when the network is busy.
      let split: number;
      while ((split = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const frame: { id?: string; event?: string; data: string; retry?: number } = { data: "" };
        const data: string[] = [];
        for (const line of block.split("\n")) {
          // `: ping` every fifteen seconds. Not a frame.
          if (line.startsWith(":") || line === "") continue;
          const colon = line.indexOf(":");
          const field = colon === -1 ? line : line.slice(0, colon);
          const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
          if (field === "data") data.push(value);
          else if (field === "id") frame.id = value;
          else if (field === "event") frame.event = value;
          else if (field === "retry") frame.retry = Number(value);
        }
        frame.data = data.join("\n");
        if (frame.data || frame.retry !== undefined) yield frame;
      }
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}

/**
 * Watch a session's events, or the whole organization's when `sessionId` is null.
 *
 * ```ts
 * for await (const event of watch(gobare.transport, sessionId)) {
 *   if (event.type === "turn.ended") break;
 * }
 * ```
 *
 * Breaking out of the loop closes the connection and frees the stream slot.
 */
export async function* watch(
  transport: Transport,
  sessionId: string | null,
  options: WatchOptions = {},
): AsyncGenerator<GobareEvent> {
  const path = sessionId === null ? "/events" : `/sessions/${encodeURIComponent(sessionId)}/events`;
  // Null and 0 are kept apart all the way down. `?? null` rather than `|| null`
  // deliberately: `0 || null` is null, which would turn "everything" into
  // "live only" and lose a first connection's whole backlog.
  let cursor: number | null = options.lastEventId ?? null;
  let retryMs = DEFAULT_RETRY_MS;
  let attempt = 0;

  // Tracked so the generator can cancel it on the way out. Breaking out of a
  // `for await` calls the generator's `return()`, which resumes it at whatever
  // `yield` it was parked on and runs the `finally` below — without this, the
  // response body stays open, its pending read keeps a promise unsettled, and
  // the caller has no handle with which to close a stream they have already
  // stopped reading. That also costs a stream slot until the proxy notices.
  let open: Response | null = null;
  try {
  for (;;) {
    if (options.signal?.aborted) return;

    const response = await fetch_(transport, path, cursor, options.signal);
    open = response;
    attempt = 0;

    try {
      for await (const frame of frames(response.body!, options.signal)) {
        if (frame.retry !== undefined && Number.isFinite(frame.retry)) retryMs = frame.retry;
        if (!frame.data) continue;

        let event: GobareEvent;
        try {
          event = JSON.parse(frame.data) as GobareEvent;
        } catch {
          // A frame we cannot read is skipped rather than fatal: the stream is
          // an allowlist that grows, and one unparseable frame is not a reason
          // to drop a session's whole feed.
          continue;
        }

        // Only a persisted event carries an `id:` line, and only a persisted
        // event may move the cursor. Advancing on a transient frame would name
        // a row that was never written.
        if (frame.id !== undefined && frame.id !== "") {
          const seq = Number(frame.id);
          if (Number.isInteger(seq)) cursor = seq;
        }

        yield event;
      }
    } catch (error) {
      if (options.signal?.aborted) return;
      if (options.reconnect === false) throw error;
    }

    if (options.reconnect === false || options.signal?.aborted) return;

    open = null;
    attempt += 1;
    options.onReconnect?.({ attempt, waitMs: retryMs, cursor });
    await sleep(retryMs, options.signal);
  }
  } finally {
    // Cancel rather than merely drop it. An unread body is a live socket and an
    // unsettled read; `cancel()` is the documented way to say "I am done", and
    // it is safe on a body that has already ended.
    await open?.body?.cancel().catch(() => {});
  }
}

async function fetch_(transport: Transport, path: string, cursor: number | null, signal?: AbortSignal): Promise<Response> {
  const response = await transport.http(transport.url(path, cursor === null ? undefined : { last_event_id: cursor }), {
    method: "GET",
    headers: transport.headers({ accept: "text/event-stream" }),
    signal,
  });
  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => "");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    // Refused before a byte of the stream: at the stream ceiling this is
    // `rate_limit_exceeded` with `Retry-After`, and it is not a request to
    // close anything.
    throw response.ok ? new GobareError({ status: 200, code: "unknown", message: "the stream opened with no body", requestId: null, rateLimit: null }) : errorFrom(response, parsed, text);
  }
  return response;
}

/**
 * Wait, and keep the process alive while waiting.
 *
 * **Deliberately not `unref`'d.** This timer is awaited: a caller is parked in
 * `for await (const event of watch(...))` expecting the stream to come back.
 * Unref'd, it is not a reason for Node to stay alive, so with nothing else
 * pending the loop drains, the await never resolves, and the caller neither
 * reconnects nor errors — it simply stops. An unattended integration whose only
 * work is watching a session is exactly the shape that hits this, and it is the
 * shape least able to notice.
 *
 * That is not a theory. It shipped: CI reported fourteen tests cancelled with
 * "Promise resolution is still pending but the event loop has already
 * resolved", while the same file passed locally because other handles happened
 * to hold the loop open.
 *
 * The reasoning that put `unref` here was an analogy to the server's SSE
 * keep-alive, where it is right. The two are opposites — a server's heartbeat
 * must not hold the process up, a client's reconnect must. `signal` is how a
 * caller gets out early; that is what it is for.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
