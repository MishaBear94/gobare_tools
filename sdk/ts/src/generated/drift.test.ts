/**
 * The generated client must be what the generator would write today.
 *
 * `stainless-bot` opens a pull request when OpenAI's specification moves. We
 * have no bot, so the equivalent is a test: regenerate, compare, fail on any
 * difference. Without it the generated directory is a copy of the route table
 * as it was on the day someone last remembered, which is the state every
 * hand-maintained client ends up in.
 *
 * Running in this repository rather than in the published package is
 * deliberate. The client is generated from the **local** route table, so a
 * route change and its client change land in the same commit and the same
 * review. Generating from the deployed `openapi.json` instead would mean the
 * client could only catch up after a release — and a client that lags the API
 * by one deploy is a client that is wrong exactly when the API is newest.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { generate, routeTable, checkExclusions, HAND_WRITTEN, nameFor } from "../../../../scripts/sdk/generate-ts.ts";

const FILE = join(import.meta.dirname, "resources.ts");

test("the generated client is current", () => {
  const onDisk = readFileSync(FILE, "utf8");
  assert.equal(
    onDisk,
    generate(),
    "sdk/ts/src/generated/resources.ts is stale or was edited by hand. Run `pnpm sdk:generate`; " +
      "if you meant to change behaviour, change the route table or scripts/sdk/generate-ts.ts.",
  );
});

test("every hand-written exclusion still has its reason", () => {
  // Deleting `responseContentType` from a streaming route would quietly move it
  // into the generated set, and the generated method would call `JSON.parse` on
  // a connection that stays open for the life of a session. That is the bug the
  // media types were fixed to prevent, arriving by a different door.
  assert.deepEqual(checkExclusions(routeTable()), []);
});

test("every route is either generated or hand-written, and no route is both", () => {
  // The claim the whole split rests on. Without it a route can be silently
  // absent from both halves — served by the API, reachable from no client, and
  // named in no failing test.
  const routes = routeTable();
  const generated = routes.filter((r) => !HAND_WRITTEN.has(`${r.method} ${r.path}`));
  assert.equal(generated.length + HAND_WRITTEN.size, routes.length);
  assert.ok(generated.length > 30, `only ${generated.length} operations generated; the table looks truncated`);

  const source = readFileSync(FILE, "utf8");
  for (const route of generated) {
    const { namespace, method } = nameFor(route);
    const className = `${namespace.map((s, i) => (i === 0 ? s[0].toUpperCase() + s.slice(1) : s[0].toUpperCase() + s.slice(1))).join("")}Resource`;
    assert.ok(source.includes(`export class ${className} `), `${route.method} ${route.path} should be on ${className}, which is not in the file`);
    assert.ok(source.includes(`  ${method}(`), `${route.method} ${route.path} should produce a \`${method}(\` method`);
  }
});

test("no hand-written path leaks into the generated file", () => {
  // The other direction. A generated method for the event stream would type a
  // `text/event-stream` body as a parsed object, and the caller would find out
  // at runtime, once, in production.
  const source = readFileSync(FILE, "utf8");
  for (const key of HAND_WRITTEN.keys()) {
    const path = key.split(" ")[1];
    if (path === "/openapi.json") continue;
    const literal = path.replace(/\{([a-z_]+)\}/g, "${encodeURIComponent(");
    assert.ok(!source.includes(`path: \`${literal}`), `${key} is hand-written but appears in the generated file`);
  }
});
