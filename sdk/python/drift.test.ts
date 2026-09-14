/**
 * The generated Python client must be what the generator would write today.
 *
 * The counterpart of `sdk/ts/src/generated/drift.test.ts`, and a Node test
 * rather than a Python one on purpose: the generator is TypeScript, the route
 * table it reads is TypeScript, and this check has to run on every change to
 * either. Making it a Python test would put the one guard that catches a stale
 * client behind an interpreter the rest of the suite does not need.
 *
 * What Python does test, in `tests/`, is the hand-written half — the part no
 * generator can produce and no comparison can check.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { generate } from "../../scripts/sdk/generate-py.ts";
import { generate as generateTs } from "../../scripts/sdk/generate-ts.ts";
import { routeTable, HAND_WRITTEN, checkExclusions, nameFor } from "../../scripts/sdk/generate-ts.ts";

const FILE = join(import.meta.dirname, "gobare/_generated/resources.py");

test("the generated Python client is current", () => {
  assert.equal(
    readFileSync(FILE, "utf8"),
    generate(),
    "sdk/python/gobare/_generated/resources.py is stale or was edited by hand. Run `pnpm sdk:generate`.",
  );
});

test("the two clients cover exactly the same operations", () => {
  // The property that makes "parity" mean something. Both emitters read the
  // same table and the same exclusion list, so a difference here is a bug in
  // one emitter rather than a decision anyone made — and a Python caller
  // finding a method a TypeScript caller does not have is how "the SDK" stops
  // being one thing.
  const python = readFileSync(FILE, "utf8");
  const typescript = generateTs();

  for (const route of routeTable()) {
    if (HAND_WRITTEN.has(`${route.method} ${route.path}`)) continue;
    const { namespace, method } = nameFor(route);
    const resource = namespace.map((s) => s[0].toUpperCase() + s.slice(1)).join("");

    const inPython = new RegExp(`class ${resource}Resource:[\\s\\S]*?\\n    def ${method}\\(`).test(python);
    const inTypeScript = new RegExp(`class ${resource}Resource \\{[\\s\\S]*?\\n  ${method}\\(`).test(typescript);

    assert.equal(
      inPython,
      inTypeScript,
      `${route.method} /v1${route.path} is ${inPython ? "only in Python" : "only in TypeScript"} (${resource}.${method})`,
    );
    assert.ok(inPython, `${route.method} /v1${route.path} is in neither client`);
  }
});

test("every hand-written exclusion still has its reason", () => {
  // Shared with the TypeScript generator rather than restated, so the two
  // clients cannot disagree about which routes a generator must not emit.
  assert.deepEqual(checkExclusions(routeTable()), []);
});

test("no streaming path leaks into the generated Python", () => {
  const python = readFileSync(FILE, "utf8");
  for (const [excluded] of HAND_WRITTEN) {
    const path = excluded.slice(excluded.indexOf(" ") + 1);
    // `/events` is a prefix of `/sessions/{id}/events`, and the POST to the
    // latter *is* generated — so the check is for the method definition, not
    // for the string appearing anywhere in the file.
    const literal = path.replace(/\{([a-z_]+)\}/g, "{quote($1, safe='')}");
    const generatedCall = new RegExp(`f"${literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}",\\n\\s+idempotency_key`);
    assert.ok(
      !generatedCall.test(python),
      `${excluded} is hand-written but a generated method calls it — it would read a stream as JSON`,
    );
  }
});

test("the Python client takes no third-party dependency", () => {
  // The promise its README makes. A client for an API is not a reason to pull
  // a dependency into someone's service, and the moment one appears the
  // guarantee is gone whether or not anyone notices.
  const pyproject = readFileSync(join(import.meta.dirname, "pyproject.toml"), "utf8");
  const declared = /dependencies\s*=\s*\[([^\]]*)\]/.exec(pyproject);
  assert.ok(declared, "pyproject.toml no longer declares a dependencies list");
  assert.equal(declared[1].trim(), "", `sdk/python declares dependencies: ${declared[1].trim()}`);
});
