/**
 * Typed errors, one per failure envelope the API actually emits.
 *
 * There are three, and which one arrives tells you *where* the failure happened — a route
 * handler, middleware, or the throttler short-circuiting before the envelope was applied. A
 * client that reads only `error` or only `message` loses half of them and logs `undefined`,
 * which is the single most common mistake against this API.
 *
 * Every error carries `status` and `body`, so nothing is hidden behind the abstraction: if the
 * SDK has not modelled something, the raw response is still there.
 */

export class WapiError extends Error {
  override readonly name: string = "WapiError";

  constructor(
    /** HTTP status. `0` when the request never completed. */
    readonly status: number,
    message: string,
    /** The parsed response body, exactly as received. */
    readonly body: unknown = null,
  ) {
    super(message);
  }

  /**
   * The session is not connected to WhatsApp.
   *
   * A `409` rather than a `5xx` because nothing is broken — the number needs linking or
   * reconnecting. Worth branching on: retrying will not help until someone acts.
   */
  get isSessionNotConnected(): boolean {
    return this.status === 409;
  }
}

/** `401`/`403` — missing, invalid, or the wrong *kind* of credential. */
export class WapiAuthError extends WapiError {
  override readonly name = "WapiAuthError";

  /**
   * `403` means the token was valid but of the wrong kind — a session key on an account-level
   * route, or a Personal Access Token on a session-scoped one. That is a configuration mistake,
   * not a bad secret, and it is worth telling them apart.
   */
  get isWrongCredentialType(): boolean {
    return this.status === 403;
  }
}

/** `422` — request validation. `fields` maps each rejected field to its messages. */
export class WapiValidationError extends WapiError {
  override readonly name = "WapiValidationError";

  constructor(
    status: number,
    message: string,
    body: unknown,
    readonly fields: Record<string, string[]> = {},
  ) {
    super(status, message, body);
  }
}

/**
 * `429` — throttled.
 *
 * Note this body carries no `success` key at all, because the throttler short-circuits before
 * the response envelope is applied. Reproducing that omission is deliberate.
 */
export class WapiRateLimitError extends WapiError {
  override readonly name = "WapiRateLimitError";

  constructor(
    status: number,
    message: string,
    body: unknown,
    /** Seconds to wait, from `retry_after`. */
    readonly retryAfter: number | null = null,
  ) {
    super(status, message, body);
  }
}

/** `5xx`, or a transport failure that never reached the server. */
export class WapiUnavailableError extends WapiError {
  override readonly name = "WapiUnavailableError";

  /**
   * Whether the request may have been applied despite the failure.
   *
   * A timeout on a send is genuinely ambiguous — it says the *request* failed, not that the
   * message was not delivered. Retrying blindly sends twice. Reconcile with
   * `messages.info(msgId)` instead of assuming.
   */
  get isAmbiguous(): boolean {
    return this.status === 0 || this.status === 504;
  }
}

type Envelope = {
  success?: boolean;
  error?: string;
  message?: string;
  errors?: Record<string, string[]>;
  retry_after?: number;
};

/** Build the right error for a non-2xx response. */
export function errorFor(status: number, body: unknown): WapiError {
  const envelope = (body ?? {}) as Envelope;
  // Both keys, always: handlers set `error`, middleware sets `message`.
  const message = envelope.error ?? envelope.message ?? `wapi request failed (${status})`;

  if (status === 401 || status === 403) return new WapiAuthError(status, message, body);
  if (status === 422) return new WapiValidationError(status, message, body, envelope.errors ?? {});
  if (status === 429) {
    return new WapiRateLimitError(status, message, body, envelope.retry_after ?? null);
  }
  if (status === 0 || status >= 500) return new WapiUnavailableError(status, message, body);
  return new WapiError(status, message, body);
}
