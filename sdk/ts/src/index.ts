/**
 * The Gobare Agent API client.
 *
 * ```ts
 * import { Gobare } from "@gobare/api";
 *
 * const gobare = new Gobare({ token: process.env.GOBARE_TOKEN! });
 * const session = await gobare.sessions.create({ agent: { model: "MiniMax-M3" }, input: "…" });
 * ```
 *
 * ── What is generated and what is not ──
 *
 * `generated/resources.ts` holds every operation that answers with JSON. It is
 * rewritten from the server's own route table on every build and must never be
 * edited by hand.
 *
 * `lib/` is hand-written and the generator never touches it. Each file there
 * exists because of something a generated client cannot know: that two 429s
 * mean opposite things, that an event stream is not JSON, that `completed` does
 * not mean the artifacts are fetchable, that a webhook signature covers the raw
 * bytes — and that the very first call has to be made in the right order.
 */
export { Gobare } from "./client.ts";
export type { ClientOptions, RequestOptions } from "./transport.ts";
export * from "./generated/resources.ts";
export * from "./lib/errors.ts";
export * from "./lib/events.ts";
export * from "./lib/artifacts.ts";

// Renamed on the way out. `verify` and `unwrap` are clear inside
// `lib/webhooks.ts` and say nothing at the top level of a package that also
// talks about sessions, tokens and artifacts.
export {
  verify as verifyWebhook,
  unwrap as unwrapWebhook,
  WebhookVerificationError,
  DEFAULT_TOLERANCE_MS as WEBHOOK_TOLERANCE_MS,
} from "./lib/webhooks.ts";
export type { WebhookEvent, VerifyInput as WebhookVerifyInput } from "./lib/webhooks.ts";
