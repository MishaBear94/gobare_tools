/**
 * The hand-written half.
 *
 * Every case here is one of the traps from the client-library plan's table —
 * the five a generated client cannot solve. If one of these tests were deleted,
 * the library would still compile, still typecheck, and still be wrong in the
 * way that made it worth writing.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import { Gobare } from "../client.ts";
import { watch } from "./events.ts";
import { Transport } from "../transport.ts";
import { unwrap, verify, WebhookVerificationError } from "./webhooks.ts";
import { waitForArtifacts, ArtifactsNotReadyError } from "./artifacts.ts";

// ── Events ──────────────────────────────────────────────────────────────────

/** An SSE response built from literal frames, so the parser is under test. */
function sse(...chunks: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const frame = (seq: number | null, type: string) =>
  `${seq === null ? "" : `id: ${seq}\n`}event: ${type}\ndata: ${JSON.stringify({ object: "event", type, session_id: "s1", seq, created_at: 1 })}\n\n`;

/** Captures the URLs a watch asks for, answering each with the given response. */
function watching(responses: Response[]) {
  const urls: string[] = [];
  // Injected rather than monkeypatched onto the global. The first version of
  // this file patched `globalThis.fetch`, which passed while hiding the fact
  // that `lib/` ignored an injected fetch entirely — two other tests in this
  // file made real network calls before that was noticed.
  const fetch = (async (url: string | URL) => {
    urls.push(String(url));
    return responses.shift() ?? sse();
  }) as typeof globalThis.fetch;
  return { urls, transport: new Transport({ token: "gbr_pat_t", fetch }), restore: () => {} };
}

test("no cursor and cursor 0 are different requests", async () => {
  // The one place `??` versus `||` is a product decision. `0 || null` is null,
  // which would turn "replay everything" into "live frames only" and silently
  // lose a first connection's entire backlog.
  const a = watching([sse(frame(1, "turn.started"))]);
  try {
    for await (const _ of watch(a.transport, "s1", { reconnect: false })) break;
  } finally {
    a.restore();
  }
  assert.equal(new URL(a.urls[0]).searchParams.has("last_event_id"), false, "no cursor must not send the parameter");

  const b = watching([sse(frame(1, "turn.started"))]);
  try {
    for await (const _ of watch(b.transport, "s1", { lastEventId: 0, reconnect: false })) break;
  } finally {
    b.restore();
  }
  assert.equal(new URL(b.urls[0]).searchParams.get("last_event_id"), "0", "cursor 0 must be sent, and means everything");
});

test("a transient frame does not advance the resume cursor", async () => {
  // `agent.text` carries seq: null. Advancing on it would produce a cursor
  // naming a row that was never written, and the resume after it would ask for
  // history that does not exist.
  const seen: Array<number | null> = [];
  const conn = watching([
    sse("retry: 20\n\n", frame(10, "agent.message"), frame(null, "agent.text"), frame(null, "agent.thinking")),
    sse(frame(11, "turn.ended")),
  ]);
  try {
    for await (const event of watch(conn.transport, "s1", { onReconnect: () => {} })) {
      seen.push(event.seq);
      if (event.type === "turn.ended") break;
    }
  } finally {
    conn.restore();
  }
  assert.deepEqual(seen, [10, null, null, 11]);
  // The reconnect resumed from the last *persisted* seq, not from the deltas.
  assert.equal(new URL(conn.urls[1]).searchParams.get("last_event_id"), "10");
});

test("a frame split across two chunks is still one frame", async () => {
  // Only misbehaves under load, which is why it gets a test rather than a
  // careful read.
  const whole = frame(7, "agent.message");
  const conn = watching([sse(whole.slice(0, 20), whole.slice(20))]);
  const seen: string[] = [];
  try {
    for await (const event of watch(conn.transport, "s1", { reconnect: false })) seen.push(event.type);
  } finally {
    conn.restore();
  }
  assert.deepEqual(seen, ["agent.message"]);
});

test("keep-alive comments and unparseable frames do not end the stream", async () => {
  const conn = watching([sse(": ping\n\n", "event: junk\ndata: {not json\n\n", frame(3, "turn.ended"))]);
  const seen: string[] = [];
  try {
    for await (const event of watch(conn.transport, "s1", { reconnect: false })) seen.push(event.type);
  } finally {
    conn.restore();
  }
  assert.deepEqual(seen, ["turn.ended"], "the ping and the bad frame are skipped, the good one arrives");
});

test("the server's retry hint replaces the default", async () => {
  const waits: number[] = [];
  const conn = watching([sse("retry: 40\n\n", frame(1, "turn.started")), sse(frame(2, "turn.ended"))]);
  try {
    for await (const event of watch(conn.transport, "s1", { onReconnect: (i) => waits.push(i.waitMs) })) {
      if (event.type === "turn.ended") break;
    }
  } finally {
    conn.restore();
  }
  // Not the 2000 default: reconnecting faster than the server's hint, at the
  // stream ceiling, is refused for a stream already closed.
  assert.deepEqual(waits, [40], "the hint replaced the 2000ms default");
});

// ── Webhooks ────────────────────────────────────────────────────────────────

const SECRET = "whsec_test";
const sign = (timestamp: string, body: string) => createHmac("sha256", SECRET).update(`${timestamp}.${body}`).digest("hex");

test("a genuine delivery verifies, and one changed byte does not", () => {
  const body = JSON.stringify({ object: "event", type: "turn.completed", created_at: 1, data: { session_id: "s1" } });
  const timestamp = String(Date.now());
  const event = unwrap({ secret: SECRET, body, signature: sign(timestamp, body), timestamp });
  assert.equal(event.type, "turn.completed");

  const tampered = body.replace("turn.completed", "turn.failedxx");
  assert.equal(verify({ secret: SECRET, body: tampered, signature: sign(timestamp, body), timestamp }), false);
});

test("passing a parsed object is refused, with the fix for four frameworks", () => {
  // The most common way to get this wrong, and the one that passes every test
  // written against the caller's own serialiser.
  const body = { object: "event", type: "turn.completed" };
  const timestamp = String(Date.now());
  assert.throws(
    () => unwrap({ secret: SECRET, body: body as never, signature: sign(timestamp, JSON.stringify(body)), timestamp }),
    (error: Error) => error instanceof WebhookVerificationError && /express\.raw\(\)/.test(error.message),
  );
});

test("seconds instead of milliseconds is named as the cause, not reported as a bad signature", () => {
  // Dividing by 1000 rejects every delivery and looks exactly like a wrong
  // secret. Somebody chasing that spends an afternoon on the wrong thing.
  const body = "{}";
  const seconds = String(Math.floor(Date.now() / 1000));
  assert.throws(
    () => unwrap({ secret: SECRET, body, signature: sign(seconds, body), timestamp: seconds }),
    (error: Error) => /milliseconds/.test(error.message),
  );
});

test("an old delivery is rejected even with a valid signature", () => {
  const body = "{}";
  const old = String(Date.now() - 10 * 60_000);
  assert.throws(() => unwrap({ secret: SECRET, body, signature: sign(old, body), timestamp: old }), /past the 300s tolerance/);
  // And the timestamp being inside the signed material is what makes that
  // rejection possible at all.
  assert.ok(verify({ secret: SECRET, body, signature: sign(old, body), timestamp: old, toleranceMs: Infinity }));
});

test("a signature of the wrong length does not throw out of timingSafeEqual", () => {
  // It throws on a length mismatch rather than returning false, and an
  // exception here would read as a bug in the caller's handler.
  const timestamp = String(Date.now());
  assert.throws(() => unwrap({ secret: SECRET, body: "{}", signature: "abc", timestamp }), WebhookVerificationError);
});

// ── Artifacts ───────────────────────────────────────────────────────────────

function turns(...states: Array<{ artifacts: unknown; status?: string }>) {
  let index = 0;
  const fetch = (async () => {
    const turn = states[Math.min(index++, states.length - 1)];
    return new Response(JSON.stringify({ object: "turn", id: "turn_1", status: turn.status ?? "completed", artifacts: turn.artifacts, artifacts_skipped: [] }), { status: 200 });
  }) as typeof globalThis.fetch;
  return new Gobare({ token: "t", fetch });
}

test("waiting stops at ready, and stops at partial rather than reading it as success", async () => {
  const ready = turns({ artifacts: "pending" }, { artifacts: "ready" });
  assert.equal(await ready.waitForArtifacts("s1", "turn_1", { pollMs: 1 }), "ready");

  // `partial` is returned, not thrown: the turn did publish, and treating it as
  // failure would throw away files that are there. The caller must branch.
  const partial = turns({ artifacts: "partial" });
  assert.equal(await partial.waitForArtifacts("s1", "turn_1", { pollMs: 1 }), "partial");
});

test("a turn from before the field existed does not spin to the timeout", async () => {
  // `artifacts: null` will never become ready. Polling it to the deadline would
  // report a stall that is really a turn from before we could tell.
  const legacy = turns({ artifacts: null, status: "completed" });
  const started = Date.now();
  const settled = await legacy.waitForArtifacts("s1", "turn_1", { pollMs: 1, timeoutMs: 5000 });
  // `null`, not a guess. `ready` would promise files nobody checked; `failed`
  // would condemn a turn that very likely published fine.
  assert.equal(settled, null);
  assert.ok(Date.now() - started < 1000, "it must answer at once rather than poll to the deadline");
});

test("a turn stuck on pending times out and says what it was still reporting", async () => {
  const stuck = turns({ artifacts: "pending" });
  const error = await stuck.waitForArtifacts("s1", "turn_1", { pollMs: 1, timeoutMs: 20 }).catch((e) => e);
  assert.ok(error instanceof ArtifactsNotReadyError);
  assert.equal(error.state, "pending");
});

test("downloading bytes does not parse them as JSON", async () => {
  // The whole reason this is hand-written. A generated method would have called
  // JSON.parse on this.
  const fetch = (async () => new Response("id,value\n1,2\n", { status: 200, headers: { "content-type": "text/csv" } })) as typeof globalThis.fetch;
  const gobare = new Gobare({ token: "t", fetch });
  const response = await gobare.downloadArtifact("s1", "art_1");
  assert.equal(response.headers.get("content-type"), "text/csv");
  assert.equal(await response.text(), "id,value\n1,2\n");
});

test("a refused download still raises a typed error", async () => {
  // The success is bytes and the refusal is JSON, so the two paths differ.
  const fetch = (async () =>
    new Response(JSON.stringify({ error: { code: "not_found", message: "gone", request_id: "r" } }), { status: 404 })) as typeof globalThis.fetch;
  const gobare = new Gobare({ token: "t", fetch });
  const error = await gobare.downloadArchive("s1").catch((e) => e);
  assert.equal(error.code, "not_found");
  assert.equal(error.requestId, "r");
});
