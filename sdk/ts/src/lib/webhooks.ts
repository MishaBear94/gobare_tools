/**
 * Verifying a delivery.
 *
 * The only thing in this library with no endpoint behind it — nothing in the
 * route table describes an inbound request — which is exactly why it belongs
 * here rather than anywhere a generator could reach. It is also the trap with
 * the worst failure mode: get it wrong and every delivery is rejected, looking
 * identical to a wrong secret.
 *
 * Three rules, each of which has its own way of being got wrong:
 *
 * 1. **Verify the raw bytes.** Frameworks hand you a parsed object; parsing and
 *    re-serialising changes key order and whitespace. A verifier written that
 *    way passes every test against its own serialiser and fails against ours.
 * 2. **The timestamp is inside the signed material**, as `{timestamp}.{body}`.
 *    Beside it rather than inside, a captured delivery stays valid forever.
 * 3. **The timestamp is milliseconds** — `Date.now()` units. Dividing by 1000,
 *    which a seconds-shaped example invites, rejects every delivery and fails
 *    looking exactly like a bad signature.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export interface WebhookEvent {
  object: "event";
  type:
    | "session.created"
    | "session.action_required"
    | "session.working"
    | "session.idle"
    | "session.failed"
    | "turn.completed"
    | "turn.failed"
    | (string & {});
  created_at: number;
  /** Names the object; never embeds it. Read the object for current truth. */
  data: { session_id: string; [key: string]: unknown };
}

export class WebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookVerificationError";
  }
}

/** Five minutes. Wide enough for clock skew, narrow enough to bound a replay. */
export const DEFAULT_TOLERANCE_MS = 5 * 60_000;

export interface VerifyInput {
  /** The secret from `POST /v1/webhooks`. Returned once, at creation. */
  secret: string;
  /**
   * The **raw** request body, exactly as received.
   *
   * A string is fine; an object is not, and is refused rather than serialised,
   * because serialising it here would reproduce the mistake this whole file is
   * about, silently and on our side.
   */
  body: string | Buffer | Uint8Array;
  /** `x-gobare-signature`. */
  signature: string;
  /** `x-gobare-timestamp`. Milliseconds, as the digits sent. */
  timestamp: string | number;
  /** Defaults to five minutes. Pass `Infinity` to disable, knowingly. */
  toleranceMs?: number;
  /** Injectable so a test can pin the clock rather than sleep. */
  now?: () => number;
}

/**
 * True if this delivery is genuine and recent. Never throws.
 *
 * Use `unwrap` unless you have a reason to want a boolean — the reason a
 * verification failed is usually the thing you needed to know.
 */
export function verify(input: VerifyInput): boolean {
  try {
    unwrap(input);
    return true;
  } catch {
    return false;
  }
}

/**
 * Verify and parse, or throw saying which rule failed.
 *
 * ```ts
 * app.post("/hooks/gobare", express.raw({ type: "application/json" }), (req, res) => {
 *   const event = unwrap({
 *     secret: process.env.GOBARE_WEBHOOK_SECRET!,
 *     body: req.body,                                  // Buffer, not req.body parsed
 *     signature: req.header("x-gobare-signature")!,
 *     timestamp: req.header("x-gobare-timestamp")!,
 *   });
 *   res.sendStatus(200);                               // answer first, work after
 *   handle(event);
 * });
 * ```
 */
export function unwrap(input: VerifyInput): WebhookEvent {
  if (typeof input.body === "object" && !Buffer.isBuffer(input.body) && !(input.body instanceof Uint8Array)) {
    throw new WebhookVerificationError(
      "body must be the raw bytes or string, not a parsed object. Parsing and re-serialising changes key order and whitespace, and the signature will not match. In Express use express.raw(); in Flask request.get_data(); in Next.js await req.text().",
    );
  }
  if (!input.signature) throw new WebhookVerificationError("no x-gobare-signature header");
  if (input.timestamp === undefined || input.timestamp === null || input.timestamp === "") {
    throw new WebhookVerificationError("no x-gobare-timestamp header");
  }

  // Signed as the exact digits sent, so the string is used rather than a number
  // converted and converted back — `1789305457283.0` is not what was signed.
  const timestamp = String(input.timestamp);
  const millis = Number(timestamp);
  if (!Number.isFinite(millis)) throw new WebhookVerificationError(`x-gobare-timestamp is not a number: ${JSON.stringify(timestamp)}`);

  const tolerance = input.toleranceMs ?? DEFAULT_TOLERANCE_MS;
  const now = (input.now ?? Date.now)();
  if (Number.isFinite(tolerance) && Math.abs(now - millis) > tolerance) {
    const drift = Math.round((now - millis) / 1000);
    throw new WebhookVerificationError(
      `x-gobare-timestamp is ${Math.abs(drift)}s ${drift > 0 ? "old" : "in the future"}, past the ${Math.round(tolerance / 1000)}s tolerance. ` +
        `The timestamp is in milliseconds — if you divided it by 1000, that is this error.`,
    );
  }

  const body = typeof input.body === "string" ? Buffer.from(input.body, "utf8") : Buffer.from(input.body);
  const expected = createHmac("sha256", input.secret).update(`${timestamp}.`).update(body).digest("hex");

  // Length-checked first: timingSafeEqual throws on a mismatch rather than
  // returning false, and an exception here would be indistinguishable from a
  // bug in the caller's handler.
  if (expected.length !== input.signature.length) throw new WebhookVerificationError("signature does not match");
  if (!timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(input.signature, "hex"))) {
    throw new WebhookVerificationError("signature does not match");
  }

  try {
    return JSON.parse(body.toString("utf8")) as WebhookEvent;
  } catch {
    throw new WebhookVerificationError("the signature is valid but the body is not JSON");
  }
}
