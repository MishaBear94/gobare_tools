/**
 * One HTTP call, and the rules every call obeys.
 *
 * Hand-written and small on purpose. The generated resources know paths,
 * methods and types; everything a caller can get wrong that is *not* specific
 * to one endpoint lives here, once.
 */
import { errorFrom, GobareConnectionError } from "./lib/errors.ts";

export interface RequestOptions {
  /**
   * Retrying with this key replays the first answer instead of acting again.
   *
   * Only meaningful on writes. Choose a key that identifies the *work*, not the
   * attempt — `job-8842`, not a fresh uuid per try, which is the same as
   * sending no key at all.
   */
  idempotencyKey?: string;
  signal?: AbortSignal;
  /** Merged over the defaults. Cannot remove `authorization`. */
  headers?: Record<string, string>;
}

export interface ClientOptions {
  /** A `gbr_pat_` access token. */
  token: string;
  /** Defaults to `https://api.gobare.dev`. */
  baseUrl?: string;
  /** Injectable for tests and for runtimes with their own fetch. */
  fetch?: typeof globalThis.fetch;
}

export interface RequestSpec {
  method: string;
  /** Below `/v1`, already interpolated and encoded. */
  path: string;
  body?: unknown;
  /**
   * `object` rather than `Record<string, unknown>`: the generated query types
   * are interfaces, and an interface has no index signature, so the tighter
   * annotation rejected every generated call site that passed one.
   */
  query?: object;
  options?: RequestOptions;
}

export const DEFAULT_BASE_URL = "https://api.gobare.dev";

export class Transport {
  readonly baseUrl: string;
  private readonly token: string;
  /**
   * Public because `lib/` needs it.
   *
   * It was private, and the streaming helpers reached for `globalThis.fetch`
   * instead — so an injected fetch was honoured by every generated
   * operations and silently ignored by the four hand-written ones. Two tests
   * meant to run offline made real network calls before this was noticed, and
   * a caller on a runtime that supplies its own fetch (a proxy, a Worker) would
   * have found the same hole in production.
   */
  readonly http: typeof globalThis.fetch;

  constructor(options: ClientOptions) {
    if (!options.token) throw new Error("A token is required. Mint one in the Console under Build.");
    this.token = options.token;
    // Trailing slash removed once here rather than guarded at every call site;
    // `https://api.gobare.dev/` + `/v1/sessions` is a path that 404s in a way
    // that reads like the endpoint does not exist.
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.http = options.fetch ?? globalThis.fetch;
  }

  /** The headers every request carries, exposed so `lib/` streams match. */
  headers(extra?: Record<string, string>): Record<string, string> {
    return { authorization: `Bearer ${this.token}`, ...extra };
  }

  url(path: string, query?: object): string {
    const url = new URL(`${this.baseUrl}/v1${path}`);
    for (const [name, value] of Object.entries(query ?? {})) {
      // Undefined means "not asked for". Sending it as the string "undefined"
      // is refused by the API, which reads to the caller as a bug in the value
      // they passed rather than in the passing of it.
      if (value === undefined || value === null) continue;
      url.searchParams.set(name, String(value));
    }
    return url.toString();
  }

  async request<T>(spec: RequestSpec): Promise<T> {
    const { options } = spec;
    const headers = this.headers({
      ...(spec.body === undefined ? {} : { "content-type": "application/json" }),
      ...(options?.idempotencyKey ? { "idempotency-key": options.idempotencyKey } : {}),
      ...options?.headers,
    });

    let response: Response;
    try {
      response = await this.http(this.url(spec.path, spec.query), {
        method: spec.method,
        headers,
        body: spec.body === undefined ? undefined : JSON.stringify(spec.body),
        signal: options?.signal,
      });
    } catch (cause) {
      // A DNS failure, a refused connection, an abort. Separated from every
      // HTTP status because the answer is different: there is no request id to
      // quote and no error code to branch on, and treating it as a 500 sends
      // callers looking for a server-side cause that does not exist.
      throw new GobareConnectionError(spec.method, this.url(spec.path, spec.query), cause);
    }

    const text = await response.text();
    // Parsed leniently: a proxy between us and you can answer with HTML, and
    // "Unexpected token < in JSON" is a worse thing to hand someone than the
    // status and the first line of what actually came back.
    let parsed: unknown = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
    }

    if (!response.ok) throw errorFrom(response, parsed, text);
    return parsed as T;
  }
}
