/**
 * Getting the bytes out, and knowing when there are bytes to get.
 *
 * Two of these are hand-written because they do not answer with JSON: an
 * artifact's content carries the artifact's own recorded type, and the archive
 * is a tar. The third is hand-written because it is not an endpoint at all —
 * it is the state machine that stands between "the turn finished" and "the
 * files are fetchable", and getting it wrong is the single most reported way
 * to see an empty artifact list.
 */
import type { Transport } from "../transport.ts";
import type { Turn } from "../generated/resources.ts";
import { errorFrom, GobareError } from "./errors.ts";

/** Everything a turn can say about its files. `null` predates the field. */
export type ArtifactState = NonNullable<Turn["artifacts"]>;

export class ArtifactsNotReadyError extends GobareError {
  readonly state: ArtifactState | null;
  constructor(turnId: string, state: ArtifactState | null, waitedMs: number) {
    super({
      status: 0,
      code: "unknown",
      message: `turn ${turnId} still reports artifacts=${state} after ${Math.round(waitedMs / 1000)}s`,
      requestId: null,
      rateLimit: null,
    });
    this.name = "ArtifactsNotReadyError";
    this.state = state;
  }
}

export interface WaitForArtifactsOptions {
  /** Default 90 seconds, which is the ceiling publication is held to plus room. */
  timeoutMs?: number;
  pollMs?: number;
  signal?: AbortSignal;
}

/**
 * Block until a turn's files are fetchable, and say which way it ended.
 *
 * ```ts
 * const state = await waitForArtifacts(gobare.transport, sessionId, turnId);
 * if (state === "partial") {
 *   // Some files were left behind. `turn.artifacts_skipped` says which and why.
 * }
 * ```
 *
 * **`completed` does not mean the files are there.** Publication runs after
 * settlement so a storage problem cannot fail a turn that did good work, which
 * means there is a window where `GET /artifacts` answers with an empty list —
 * indistinguishable from a turn that produced nothing. Every caller has to wait
 * for this, so it lives here rather than in every caller.
 *
 * Returns `ready`, `partial` or `failed`; throws only on timeout. `partial` is
 * returned rather than thrown because the turn did publish — silently treating
 * it as success is what the separate value exists to prevent, and treating it
 * as failure would throw away files that are there.
 *
 * Returns **`null`** for a settled turn that reports no state at all: one from
 * before the field existed. That is a third answer rather than a guess, because
 * both guesses are wrong — `ready` would promise files nobody checked, and
 * `failed` would condemn a turn that very likely published fine.
 */
export async function waitForArtifacts(
  transport: Transport,
  sessionId: string,
  turnId: string,
  options: WaitForArtifactsOptions = {},
): Promise<ArtifactState | null> {
  const timeoutMs = options.timeoutMs ?? 90_000;
  const pollMs = options.pollMs ?? 1000;
  const deadline = Date.now() + timeoutMs;
  let last: ArtifactState | null = null;

  for (;;) {
    const turn = await transport.request<Turn>({
      method: "GET",
      path: `/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}`,
      options: { signal: options.signal },
    });
    last = turn.artifacts ?? null;

    if (last !== null && last !== "pending") return last;

    // A settled turn reporting no state at all predates the field, and will
    // never report one — so waiting is waiting for something that cannot
    // arrive. The first version of this had the comment but not the check: it
    // fell through to the poll loop and spun to the timeout, reporting a stall
    // that was really a turn from before we could tell. Caught by the test
    // written for the comment.
    const settled = turn.status === "completed" || turn.status === "failed" || turn.status === "cancelled";
    if (last === null && settled) return null;
    if (turn.status === "failed" || turn.status === "cancelled") return last ?? "failed";

    if (Date.now() + pollMs > deadline) throw new ArtifactsNotReadyError(turnId, last, timeoutMs);
    await sleep(pollMs, options.signal);
  }
}

/**
 * Download one artifact's bytes.
 *
 * Returns the response so the caller chooses what to do with a file that may be
 * 200 MiB: `.body` to stream it to disk, `.text()` for a small one. Buffering
 * it here would make the largest legal artifact an out-of-memory error inside
 * the library.
 */
export async function downloadArtifact(
  transport: Transport,
  sessionId: string,
  artifactId: string,
  options: { signal?: AbortSignal } = {},
): Promise<Response> {
  return raw(
    transport,
    `/sessions/${encodeURIComponent(sessionId)}/artifacts/${encodeURIComponent(artifactId)}/content`,
    undefined,
    options.signal,
  );
}

/**
 * Download every artifact as one tar.
 *
 * Without `turnId` each entry is prefixed with the turn that published it,
 * because the same path published by two turns is two files and a flat archive
 * would extract as one — silently the last.
 *
 * An artifact whose stored copy is gone is omitted and named in a
 * `gobare-omitted.txt` entry inside the archive. Look for it: the status line
 * went out with the first byte, so that file is the only place the omission can
 * be reported.
 */
export async function downloadArchive(
  transport: Transport,
  sessionId: string,
  options: { turnId?: string; signal?: AbortSignal } = {},
): Promise<Response> {
  return raw(
    transport,
    `/sessions/${encodeURIComponent(sessionId)}/artifacts/archive`,
    options.turnId === undefined ? undefined : { turn_id: options.turnId },
    options.signal,
  );
}

async function raw(transport: Transport, path: string, query: object | undefined, signal?: AbortSignal): Promise<Response> {
  const response = await transport.http(transport.url(path, query), { method: "GET", headers: transport.headers(), signal });
  if (!response.ok) {
    // A refusal here *is* JSON, even though a success is not — so the error
    // path parses and the success path deliberately does not.
    const text = await response.text().catch(() => "");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    throw errorFrom(response, parsed, text);
  }
  return response;
}

/** Awaited between polls, so not `unref`'d — see the note in `events.ts`. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
