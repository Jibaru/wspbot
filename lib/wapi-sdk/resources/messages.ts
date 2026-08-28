import { data, type Transport } from "../http";
import type {
  GetApiMessagesMsgIdInfoResponse,
  PostApiDecryptMediaResponse,
  PostApiMessagesReactBody,
  PostApiMessagesReactResponse,
  PostApiMessagesReadResponse,
  PostApiSendMessageBody,
  PostApiSendMessageResponse,
  PostApiUploadResponse,
} from "../types.gen";

/**
 * A WhatsApp message key, as it arrives in a webhook payload under `data.key`.
 *
 * This — not `msgId` — is how you address a message someone *else* sent. `msgId` is our own
 * sequence and only ever exists for messages this session sent.
 */
export type MessageKey = PostApiMessagesReactBody["key"];

/** Uploading and decrypting media. */
class MessageMedia {
  constructor(private readonly http: Transport) {}

  /**
   * Upload bytes and get a permanent URL to pass to `send()`.
   *
   * The link does not expire, which is what makes it usable as a send input later — media is
   * fetched server-side at send time, so a short-lived URL would have stopped working by then.
   *
   * `publicUrl` is at the top level of the response, not under `data`.
   */
  async upload(file: { base64: string; mimetype: string; fileName?: string }): Promise<string> {
    const body = await this.http.request<PostApiUploadResponse>("POST", "/api/upload", {
      body: file,
      // Uploads are up to 16 MB and slower than a read; the default deadline is too tight.
      timeoutMs: 120_000,
    });
    return body.publicUrl;
  }

  /**
   * Turn an inbound encrypted media node into a URL valid for one hour.
   *
   * Inbound media arrives encrypted: the payload carries a CDN link and a `mediaKey`, and the
   * bytes are useless without decryption. Pass the `message` object straight from the webhook.
   */
  async decrypt(message: Record<string, unknown>): Promise<string> {
    const body = await this.http.request<PostApiDecryptMediaResponse>(
      "POST",
      "/api/decrypt-media",
      { body: { data: { messages: { message } } }, timeoutMs: 120_000 },
    );
    return body.publicUrl;
  }
}

/**
 * Messages.
 *
 * Session-scoped: these take a session API key, not a Personal Access Token.
 */
export class MessagesResource {
  readonly media: MessageMedia;

  constructor(private readonly http: Transport) {
    this.media = new MessageMedia(http);
  }

  /**
   * Send a message. One endpoint for every type — which field you set decides what is sent.
   *
   * Setting two content fields is an error rather than a silent preference, so the union below
   * makes that a compile error too.
   *
   * **A failed send is not safely retryable.** A timeout tells you the request failed, not that
   * the message was undelivered; retrying blindly sends twice. Reconcile with `info(msgId)`.
   */
  async send(input: SendMessageInput) {
    return data(
      await this.http.request<PostApiSendMessageResponse>("POST", "/api/send-message", {
        body: input,
        // A send round-trips to WhatsApp; account protection can pace it to 1 per 5s.
        timeoutMs: 60_000,
      }),
    );
  }

  /**
   * Fetch a sent message by its integer `msgId`.
   *
   * Two fields here follow WhatsApp's own record rather than this API's conventions:
   * `messageTimestamp` is a **string** (a protobuf int64, which JSON cannot hold as a number)
   * and `status` is a **number** — the ack enum, `0` error through `4` read — not the word a
   * send returns.
   */
  async info(msgId: number) {
    return data(
      await this.http.request<GetApiMessagesMsgIdInfoResponse>(
        "GET",
        `/api/messages/${msgId}/info`,
      ),
    );
  }

  /** Mark a received message as read. Takes the WhatsApp key, not a `msgId`. */
  async markRead(key: MessageKey) {
    return data(
      await this.http.request<PostApiMessagesReadResponse>("POST", "/api/messages/read", {
        body: { key },
      }),
    );
  }

  /**
   * React to a message.
   *
   * **A wapi extension**, not part of the WasenderAPI interface — they report reactions over
   * webhooks but have no endpoint to send one. Feature-detect if you target both.
   */
  async react(key: MessageKey, emoji: string) {
    return data(
      await this.http.request<PostApiMessagesReactResponse>("POST", "/api/messages/react", {
        body: { emoji, key },
      }),
    );
  }

  /** Remove a reaction. An empty emoji is WhatsApp's convention, not a separate endpoint. */
  async unreact(key: MessageKey) {
    return this.react(key, "");
  }
}

/**
 * Send input, as a union rather than an object of optionals.
 *
 * The server rejects a request carrying two content fields; modelling it this way makes that a
 * compile error instead of a 422 discovered at runtime.
 */
export type SendMessageInput = Pick<PostApiSendMessageBody, "to"> &
  Partial<Pick<PostApiSendMessageBody, "replyTo" | "mentions" | "viewOnce">> &
  (
    | { text: string }
    | { imageUrl: string; text?: string }
    | { videoUrl: string; text?: string }
    | { audioUrl: string }
    | { documentUrl: string; fileName: string }
    | { stickerUrl: string }
    | { location: { latitude: number; longitude: number; name?: string; address?: string } }
    | { contact: { name: string; phone: string } }
    | { poll: { question: string; options: string[]; multiSelect?: boolean } }
  );
