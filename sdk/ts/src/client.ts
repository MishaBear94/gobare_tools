/**
 * The client: generated resources, plus the hand-written parts.
 *
 * `Resources` is regenerated wholesale, so nothing may be added to it. This
 * class is where the two halves meet — it extends the generated tree with the
 * things `lib/` provides, which is the only place the two are allowed to know
 * about each other.
 */
import { Transport, type ClientOptions } from "./transport.ts";
import { Resources } from "./generated/resources.ts";
import { watch, type GobareEvent, type WatchOptions } from "./lib/events.ts";
import {
  waitForArtifacts,
  downloadArtifact,
  downloadArchive,
  type ArtifactState,
  type WaitForArtifactsOptions,
} from "./lib/artifacts.ts";

export class Gobare extends Resources {
  readonly transport: Transport;

  constructor(options: ClientOptions) {
    const transport = new Transport(options);
    super(transport);
    this.transport = transport;
  }

  /** Where this client is pointed. Useful in a log line when it is not where you thought. */
  get baseUrl(): string {
    return this.transport.baseUrl;
  }

  /**
   * Watch one session's events, or every session the organization owns.
   *
   * ```ts
   * for await (const event of gobare.watch(session.id)) {
   *   if (event.type === "turn.ended") break;
   * }
   * ```
   *
   * **Start this before you send the input you want to watch.** The other order
   * drops the opening events whenever the agent starts quickly — which is to
   * say, only in production.
   */
  watch(sessionId: string | null = null, options: WatchOptions = {}): AsyncGenerator<GobareEvent> {
    return watch(this.transport, sessionId, options);
  }

  /**
   * Block until a turn's files are fetchable. Returns `ready`, `partial` or
   * `failed`.
   *
   * `completed` does not mean the files are there; see the note in
   * `lib/artifacts.ts`. `null` means the turn predates the field and cannot
   * say — a third answer rather than a guess, because both guesses are wrong.
   */
  waitForArtifacts(sessionId: string, turnId: string, options?: WaitForArtifactsOptions): Promise<ArtifactState | null> {
    return waitForArtifacts(this.transport, sessionId, turnId, options);
  }

  /** One artifact's bytes, as a `Response` so you choose whether to buffer it. */
  downloadArtifact(sessionId: string, artifactId: string, options?: { signal?: AbortSignal }): Promise<Response> {
    return downloadArtifact(this.transport, sessionId, artifactId, options);
  }

  /** Every artifact as one tar, as a `Response`. */
  downloadArchive(sessionId: string, options?: { turnId?: string; signal?: AbortSignal }): Promise<Response> {
    return downloadArchive(this.transport, sessionId, options);
  }
}
