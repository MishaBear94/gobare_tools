/**
 * Build the published client: JavaScript, with declarations beside it.
 *
 * The source imports with `.ts` extensions, which is how this repository runs
 * TypeScript directly. `tsc` refuses to emit those (TS5097), and the option
 * that rewrites them — `rewriteRelativeImportExtensions` — arrived in
 * TypeScript 5.7; this repository is on 5.6. Upgrading the compiler for every
 * other file in the product, to publish one package, is the larger change.
 *
 * So the specifiers are rewritten before the compiler sees them, in a copy.
 * Nothing under `src/` is touched.
 *
 * Why bother at all: the package first shipped raw `.ts` with `exports`
 * pointing at `src/index.ts`. That works under tsx, bun and any bundler, and
 * fails under plain `node` — which does not strip types inside `node_modules`.
 * `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` on the first import is not a first minute
 * anyone should have.
 */
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const STAGE = join(HERE, ".build-src");

function walk(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

rmSync(STAGE, { recursive: true, force: true });
rmSync(join(HERE, "dist"), { recursive: true, force: true });
cpSync(join(HERE, "src"), STAGE, { recursive: true });

for (const file of walk(STAGE)) {
  if (file.endsWith(".test.ts")) {
    // Tests are not published, and `drift.test.ts` imports the generator from
    // outside the package — it cannot compile here and is not meant to.
    rmSync(file);
    continue;
  }
  const source = readFileSync(file, "utf8");
  writeFileSync(file, source.replace(/(from\s+"\.[^"]*)\.ts"/g, '$1.js"'));
}

/**
 * The compiler, from wherever this package happens to be.
 *
 * A hard-coded `../../node_modules/.bin/tsc` works in this repository and
 * nowhere else — and `prepare` runs when somebody installs the package from a
 * directory or from git, which is exactly the case where the parent is not our
 * repository. Resolved through `require` so it is found in the package's own
 * `node_modules` first.
 */
function compiler() {
  const require_ = createRequire(import.meta.url);
  try {
    return require_.resolve("typescript/bin/tsc");
  } catch {
    const beside = join(HERE, "../../node_modules/.bin/tsc");
    if (existsSync(beside)) return beside;
    throw new Error("cannot find the TypeScript compiler; run `npm install` in this package first");
  }
}

try {
  const tsc = compiler();
  execFileSync(tsc.endsWith(".js") ? process.execPath : tsc, [
    ...(tsc.endsWith(".js") ? [tsc] : []),
    "-p",
    join(HERE, "tsconfig.build.json"),
  ], { stdio: "inherit" });
} finally {
  rmSync(STAGE, { recursive: true, force: true });
}
