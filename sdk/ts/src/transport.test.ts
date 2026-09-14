/**
 * What the client does that no endpoint description could tell it.
 *
 * The generated resources are checked by `generated/drift.test.ts`, which
 * proves they match the route table. Nothing there proves the client is
 * *usable* — that is this file, and the cases are the ones from the plan's
 * table of traps a curl-first caller has to answer alone.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { Gobare } from "./client.ts";
import {
  GobareError,
  GobareProjectLimitError,
  GobareRateLimitError,
  GobareAuthenticationError,
  GobareServerError,
  GobareConnectionError,
} from "./lib/errors.ts";

/** A fetch that answers once with what the test wants, and records the call. */
function stub(answer: { status: number; body?: unknown; text?: string; headers?: Record<string, string> }) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const body = answer.text ?? (answer.body === undefined ? "" : JSON.stringify(answer.body));
    return new Response(body, { status: answer.status, headers: answer.headers });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

const client = (answer: Parameters<typeof stub>[0]) => {
  const { fetch, calls } = stub(answer);
  return { gobare: new Gobare({ token: "gbr_pat_test", fetch }), calls };
};

test("a token is required, and the message says where to get one", () => {
  // The first thing anyone does wrong, and an empty string is the common shape
  // of it — `process.env.GOBARE_TOKEN` unset reads as undefined, and a caller
  // who forgot the `!` ships "Bearer undefined" to production.
  assert.throws(() => new Gobare({ token: "" }), /Mint one in the Console/);
});

test("a trailing slash on the base URL does not become a double slash", () => {
  const { fetch } = stub({ status: 200, body: {} });
  const gobare = new Gobare({ token: "t", baseUrl: "https://api.example.com/", fetch });
  assert.equal(gobare.baseUrl, "https://api.example.com");
});

test("the two 429s are different classes, because they call for opposite things", async () => {
  // The trap this whole file exists for. A retry helper that catches one status
  // spins forever on the ceiling — at full rate, with every attempt refused.
  const limited = client({
    status: 429,
    body: { error: { code: "rate_limit_exceeded", message: "slow down", request_id: "req_1" } },
    headers: { "retry-after": "7", "x-ratelimit-limit": "120", "x-ratelimit-remaining": "0", "x-ratelimit-reset": "7", "x-ratelimit-resource": "general" },
  });
  const rate = await limited.gobare.sessions.list().catch((e) => e);
  assert.ok(rate instanceof GobareRateLimitError);
  assert.equal(rate.retryAfterSeconds, 7);
  assert.equal(rate.retryable, true);
  assert.deepEqual(rate.rateLimit, { limit: 120, remaining: 0, resetSeconds: 7, resource: "general" });

  const full = client({
    status: 429,
    body: { error: { code: "project_limit_exceeded", message: "at the ceiling", request_id: "req_2" } },
  });
  const project = await full.gobare.sessions.create({} as never).catch((e) => e);
  assert.ok(project instanceof GobareProjectLimitError);
  assert.equal(project.retryable, false);
  // The assertion that matters: catching the retryable one must not catch this.
  assert.ok(!(project instanceof GobareRateLimitError));
});

test("the request id survives, from the body or the header", async () => {
  const fromBody = client({ status: 404, body: { error: { code: "not_found", message: "no", request_id: "req_body" } } });
  const a = await fromBody.gobare.sessions.retrieve("s1").catch((e) => e);
  assert.equal(a.requestId, "req_body");

  // A proxy answering with no envelope at all still leaves the header.
  const fromHeader = client({ status: 502, text: "<html>bad gateway</html>", headers: { "x-request-id": "req_hdr" } });
  const b = await fromHeader.gobare.sessions.retrieve("s1").catch((e) => e);
  assert.equal(b.requestId, "req_hdr");
  assert.ok(b instanceof GobareServerError, "a 502 with no envelope is still retryable");
  // The proxy's own words, not "Unexpected token < in JSON".
  assert.match(b.message, /bad gateway/);
});

test("an unrecognised error code still lands on the right side of retryable", async () => {
  const { gobare } = client({ status: 503, body: { error: { code: "something_new", message: "later", request_id: "r" } } });
  const error = await gobare.health.retrieve().catch((e) => e);
  assert.ok(error instanceof GobareServerError);
  assert.equal(error.code, "something_new");
});

test("no response at all is not a server error", async () => {
  // Different because the answer is different: no request id to quote, no code
  // to branch on, and nothing server-side to go looking for.
  const fetch = (async () => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof globalThis.fetch;
  const gobare = new Gobare({ token: "t", fetch });
  const error = await gobare.sessions.list().catch((e) => e);
  assert.ok(error instanceof GobareConnectionError);
  assert.ok(!(error instanceof GobareError));
  assert.match(error.message, /GET https:\/\/api\.gobare\.dev\/v1\/sessions did not get a response/);
});

test("401 is its own class", async () => {
  const { gobare } = client({ status: 401, body: { error: { code: "authentication_error", message: "expired", request_id: "r" } } });
  const error = await gobare.health.retrieve().catch((e) => e);
  assert.ok(error instanceof GobareAuthenticationError);
  assert.equal(error.retryable, false);
});

test("path parameters are encoded, and query parameters that were not asked for are not sent", async () => {
  const { gobare, calls } = client({ status: 200, body: { object: "list", data: [], has_more: false, last_id: null } });
  await gobare.sessions.turns.list("a/b", { limit: 5, order: undefined });
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, "/v1/sessions/a%2Fb/turns");
  assert.equal(url.searchParams.get("limit"), "5");
  // Not "undefined". The API refuses an unreadable value, and the refusal reads
  // as a bug in what the caller passed rather than in the passing of it.
  assert.equal(url.searchParams.has("order"), false);
});

test("an idempotency key rides on the request, and only when given", async () => {
  const with_ = client({ status: 201, body: {} });
  await with_.gobare.sessions.create({} as never, { idempotencyKey: "job-8842" });
  assert.equal((with_.calls[0].init.headers as Record<string, string>)["idempotency-key"], "job-8842");

  const without = client({ status: 201, body: {} });
  await without.gobare.sessions.create({} as never);
  assert.equal("idempotency-key" in (without.calls[0].init.headers as Record<string, string>), false);
});

test("a body is sent as JSON and a read carries no content-type", async () => {
  const write = client({ status: 201, body: {} });
  await write.gobare.webhooks.create({ url: "https://x.example/h", events: ["turn.failed"] } as never);
  assert.equal((write.calls[0].init.headers as Record<string, string>)["content-type"], "application/json");
  assert.equal(write.calls[0].init.body, '{"url":"https://x.example/h","events":["turn.failed"]}');

  const read = client({ status: 200, body: {} });
  await read.gobare.health.retrieve();
  assert.equal("content-type" in (read.calls[0].init.headers as Record<string, string>), false);
  assert.equal(read.calls[0].init.body, undefined);
});

test("the resource tree is the shape the documentation promises", () => {
  // Cheap, and it is the thing a reader of the quickstart will type first.
  const { gobare } = client({ status: 200, body: {} });
  for (const path of [
    "sessions.create",
    "sessions.retrieve",
    "sessions.list",
    "sessions.delete",
    "sessions.update",
    "sessions.turns.list",
    "sessions.items.list",
    "sessions.tools.replace",
    "sessions.events.create",
    "sessions.artifacts.list",
    "sessions.files.create",
    "sessions.preview.create",
    "webhooks.create",
    "agents.create",
    "modelCredentials.list",
    "environmentProfiles.list",
    "health.retrieve",
  ]) {
    const value = path.split(".").reduce<any>((node, key) => node?.[key], gobare);
    assert.equal(typeof value, "function", `client.${path} is not a method`);
  }
});
