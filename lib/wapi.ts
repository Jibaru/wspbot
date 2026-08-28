import "server-only";
import { WapiClient, WapiError } from "./wapi-sdk/index";
import type { SendMessageInput as SdkSendMessageInput } from "./wapi-sdk/index";
import { config } from "./config";

/**
 * wapi, through the official TypeScript SDK.
 *
 * The SDK is vendored into `lib/wapi-sdk/` rather than installed: it is not published to npm,
 * and the documented way to take it is `giget` from the source repository. See AGENTS.md for the
 * commit this copy came from and how to refresh it.
 *
 * What remains here is the part that is ours rather than the API's: `server-only`, so importing
 * this from a client component is a build error rather than a leaked WhatsApp credential; the
 * identity cache; and the two clients, since a client holds exactly one credential.
 *
 * The surface is unchanged from the hand-rolled client it replaces, so nothing else in the app
 * had to move. Everything the SDK does better — the envelope handling, the typed errors, the
 * request timeout — it now does instead of us.
 */

/**
 * `WapiError` carries `status` and `body`; `WapiAuthError.isWrongCredentialType` distinguishes
 * a 403 (the wrong *kind* of token, a config mistake) from a 401 (a bad one).
 */
export { WapiError, WapiAuthError, WapiValidationError, WapiRateLimitError } from "./wapi-sdk/index";
export type { MessageKey } from "./wapi-sdk/index";

/**
 * Cached on `globalThis` so a dev hot-reload does not build a new client per edit, and so the
 * credential is read from the environment once rather than on every call.
 */
const g = globalThis as unknown as {
  wspbotWapi?: WapiClient;
  wspbotWapiAdmin?: WapiClient;
};

/** The session key: messaging, media, contacts, groups. */
const client = (): WapiClient =>
  (g.wspbotWapi ??= new WapiClient({
    apiKey: config.wapiApiKey(),
    baseUrl: config.wapiBaseUrl(),
  }));

/**
 * A second client for the Personal Access Token, because the two credentials are not
 * interchangeable and a client holds exactly one. `connect` is a session-admin route: the
 * session key gets a 403 there, not a 401.
 */
const admin = (): WapiClient => {
  const pat = config.wapiPatOptional();
  if (!pat) throw new WapiError(0, "WAPI_PAT is not set");
  return (g.wspbotWapiAdmin ??= new WapiClient({
    apiKey: pat,
    baseUrl: config.wapiBaseUrl(),
  }));
};

export type SendResult = { msgId: number; jid: string; status: string };

/**
 * What we send, which is the SDK's union plus one deliberate widening: it does not allow a
 * caption alongside a document, and we send one.
 *
 * `PostApiSendMessageBody` has `text` and `documentUrl` as independent optional fields, so the
 * endpoint accepts the pair — the SDK's union is a stricter opinion than the API rather than a
 * restriction it enforces. Kept because narrowing to match would silently drop the caption from
 * every PDF the bot sends, which is a behaviour change disguised as a refactor.
 */
export type SendMessageInput =
  | SdkSendMessageInput
  | {
      to: string;
      mentions?: string[];
      documentUrl: string;
      fileName: string;
      text?: string;
    };

/** The WhatsApp identity behind the session key. `id` is a JID, `lid` the newer LID form. */
export type WapiUser = { id: string; name: string | null; lid: string | null };

/** Identity changes only when the session is relinked, so an hour is comfortably safe. */
const IDENTITY_TTL_MS = 60 * 60 * 1000;
let cachedUser: { user: WapiUser; at: number } | undefined;

export const wapi = {
  /** Connection state of the session this key belongs to. Lowercase, unlike `connect`. */
  status(): Promise<string> {
    return client().status();
  },

  /**
   * Reconnect a session from its stored credentials.
   *
   * Asynchronous: it answers with a status right away, and `NEED_SCAN` means the credentials
   * are gone and a human has to scan a QR. The status is SCREAMING_CASE here and lowercase from
   * `status()` — an inherited inconsistency, not a bug.
   */
  connect(
    sessionId: string | number,
  ): Promise<{ status: string; qrCode?: string; message?: string }> {
    return admin().sessions.connection.connect(Number(sessionId));
  },

  me(): Promise<WapiUser> {
    return client().user();
  },

  /**
   * The session's own identity, cached.
   *
   * Every inbound message needs this to answer "was I tagged?", but it only changes when the
   * session is relinked to a different number. Fetching it per message put one wapi call on
   * every message in every group the bot sits in, including the ones it ignores.
   */
  async meCached(): Promise<WapiUser> {
    const now = Date.now();
    if (cachedUser && now - cachedUser.at < IDENTITY_TTL_MS) return cachedUser.user;
    const user = await wapi.me();
    cachedUser = { user, at: now };
    return user;
  },

  sendText(
    to: string,
    text: string,
    opts: { mentions?: string[] } = {},
  ): Promise<SendResult> {
    return client().messages.send({ to, text, ...opts });
  },

  /** The general form. `sendText` is the common case; this covers media, polls and locations. */
  send(input: SendMessageInput): Promise<SendResult> {
    return client().messages.send(input as SdkSendMessageInput);
  },

  /**
   * Upload bytes and get a permanent URL to pass back to `send`. The link does not expire,
   * which is what makes it usable as a send input afterwards.
   */
  upload(file: {
    base64: string;
    mimetype: string;
    fileName?: string;
  }): Promise<string> {
    return client().messages.media.upload(file);
  },

  /**
   * Turn an inbound encrypted media node into a URL.
   *
   * Inbound media is not fetchable as it arrives: the payload carries a CDN link and a
   * `mediaKey`, and the bytes are useless without decryption. Pass the message node straight
   * from the webhook. **The returned URL expires after an hour**, so anything worth keeping
   * must be fetched and re-uploaded rather than stored as-is.
   */
  decryptMedia(message: Record<string, unknown>): Promise<string> {
    return client().messages.media.decrypt(message);
  },

  /**
   * React to a message, or clear the reaction with an empty string.
   *
   * Takes the WhatsApp `key`, not a `msgId`: you mostly react to messages someone *else* sent,
   * and those have no `msgId` — that number is assigned by wapi when *it* sends something.
   */
  react(
    key: Parameters<WapiClient["messages"]["react"]>[0],
    emoji: string,
  ): Promise<{ id: string | null; emoji: string }> {
    return client().messages.react(key, emoji);
  },

  /** Blue ticks. Best-effort — a failure here must never stop a reply. */
  async markRead(
    key: Parameters<WapiClient["messages"]["markRead"]>[0],
  ): Promise<void> {
    await client().messages.markRead(key);
  },
};
