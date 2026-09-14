/**
 * Refusals, as classes you can branch on.
 *
 * Hand-written, and the first of the five files in `lib/`. The generated
 * resources know what each endpoint returns; none of them can know that two
 * refusals sharing a status call for opposite responses.
 *
 * ── The distinction this file exists for ──
 *
 * `429` is two different things:
 *
 *   rate_limit_exceeded      wait for Retry-After, then the retry succeeds
 *   project_limit_exceeded   **retrying never succeeds.** Delete a session,
 *                            or ask for a higher ceiling.
 *
 * A client that treats every 429 alike — which is what every retry helper does
 * by default — spins forever on the second one, at full rate, forever. The
 * published documentation says this in prose; prose is not something a caller's
 * `catch` block can read.
 */

export type GobareErrorCode =
  | "invalid_request"
  | "authentication_error"
  | "permission_denied"
  | "not_found"
  | "method_not_allowed"
  | "conflict"
  | "queue_full"
  | "rate_limit_exceeded"
  | "project_limit_exceeded"
  | "context_length_exceeded"
  | "provider_error"
  | "provider_unauthorized"
  | "sandbox_error"
  | "sandbox_unavailable"
  | "directory_unavailable"
  | "workspace_recovery_failed"
  | "bridge_incompatible"
  | "internal_error";

/** What a `/v1` response says is left in the caller's budget. */
export interface RateLimitSnapshot {
  limit: number;
  remaining: number;
  /** Whole seconds until this bucket is full again. */
  resetSeconds: number;
  /** **Which** bucket. The same token holds two, with different numbers. */
  resource: "general" | "sessions" | (string & {});
}

export class GobareError extends Error {
  readonly status: number;
  readonly code: GobareErrorCode | "unknown";
  /** Quote this when reporting a problem. Also on `x-request-id`. */
  readonly requestId: string | null;
  readonly rateLimit: RateLimitSnapshot | null;

  constructor(args: { status: number; code: GobareErrorCode | "unknown"; message: string; requestId: string | null; rateLimit: RateLimitSnapshot | null }) {
    super(args.message);
    this.name = new.target.name;
    this.status = args.status;
    this.code = args.code;
    this.requestId = args.requestId;
    this.rateLimit = args.rateLimit;
  }

  /**
   * Whether trying the same call again could ever work.
   *
   * The one question a retry wrapper needs answered, and the one it gets wrong
   * from the status alone.
   */
  get retryable(): boolean {
    return false;
  }
}

export class GobareAuthenticationError extends GobareError {}
export class GobarePermissionError extends GobareError {}
export class GobareNotFoundError extends GobareError {}
export class GobareInvalidRequestError extends GobareError {}
export class GobareConflictError extends GobareError {}

/** Retrying works, once you have waited. */
export class GobareRateLimitError extends GobareError {
  /** From `Retry-After`. Seconds. Null only if the header was absent. */
  readonly retryAfterSeconds: number | null;

  constructor(args: ConstructorParameters<typeof GobareError>[0] & { retryAfterSeconds: number | null }) {
    super(args);
    this.retryAfterSeconds = args.retryAfterSeconds;
  }

  override get retryable(): boolean {
    return true;
  }
}

/**
 * Retrying does **not** work. The organization is at its ceiling.
 *
 * Deliberately not a subclass of `GobareRateLimitError` even though both are
 * 429: a `catch (e) { if (e instanceof GobareRateLimitError) retry() }` that
 * caught this one would be the exact infinite loop this file exists to
 * prevent.
 */
export class GobareProjectLimitError extends GobareError {
  override get retryable(): boolean {
    return false;
  }
}

/** The queue for a busy session is full. Retryable once the turn moves on. */
export class GobareQueueFullError extends GobareError {
  override get retryable(): boolean {
    return true;
  }
}

/** 5xx, and the transient sandbox conditions. */
export class GobareServerError extends GobareError {
  override get retryable(): boolean {
    return true;
  }
}

/** No HTTP answer at all: DNS, refused connection, abort, timeout. */
export class GobareConnectionError extends Error {
  readonly cause: unknown;
  constructor(method: string, url: string, cause: unknown) {
    super(`${method} ${url} did not get a response: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "GobareConnectionError";
    this.cause = cause;
  }
  get retryable(): boolean {
    return true;
  }
}

function readRateLimit(headers: Headers): RateLimitSnapshot | null {
  const limit = headers.get("x-ratelimit-limit");
  const remaining = headers.get("x-ratelimit-remaining");
  if (limit === null || remaining === null) return null;
  return {
    limit: Number(limit),
    remaining: Number(remaining),
    resetSeconds: Number(headers.get("x-ratelimit-reset") ?? 0),
    resource: headers.get("x-ratelimit-resource") ?? "general",
  };
}

const BY_CODE: Partial<Record<GobareErrorCode, typeof GobareError>> = {
  authentication_error: GobareAuthenticationError,
  permission_denied: GobarePermissionError,
  not_found: GobareNotFoundError,
  invalid_request: GobareInvalidRequestError,
  conflict: GobareConflictError,
  project_limit_exceeded: GobareProjectLimitError,
  queue_full: GobareQueueFullError,
  provider_error: GobareServerError,
  sandbox_error: GobareServerError,
  sandbox_unavailable: GobareServerError,
  directory_unavailable: GobareServerError,
  workspace_recovery_failed: GobareServerError,
  internal_error: GobareServerError,
};

/** Build the right class from a refusal. */
export function errorFrom(response: Response, parsed: unknown, raw: string): GobareError {
  const body = (parsed ?? {}) as { error?: { code?: string; message?: string; request_id?: string } };
  const code = (body.error?.code ?? "unknown") as GobareErrorCode | "unknown";
  const requestId = body.error?.request_id ?? response.headers.get("x-request-id");
  const rateLimit = readRateLimit(response.headers);

  // Falls back to the raw text rather than to a generic sentence: when the
  // envelope is missing it is usually a proxy answering, and its own words are
  // the only clue to which hop refused.
  const message =
    body.error?.message ??
    (raw ? `${response.status} ${response.statusText}: ${raw.slice(0, 200)}` : `${response.status} ${response.statusText}`);

  const base = { status: response.status, code, message, requestId, rateLimit };

  if (code === "rate_limit_exceeded") {
    const header = response.headers.get("retry-after");
    return new GobareRateLimitError({ ...base, retryAfterSeconds: header === null ? null : Number(header) });
  }

  const Specific = BY_CODE[code as GobareErrorCode];
  if (Specific) return new (Specific as typeof GobareError)(base);
  // Status is the fallback, not the primary key: a code we do not know yet
  // still lands in the right half of retryable-versus-not.
  if (response.status >= 500) return new GobareServerError(base);
  return new GobareError(base);
}
