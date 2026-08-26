import "server-only";

/**
 * wapi client.
 *
 * Server-only by construction: `server-only` makes importing this from a client component a
 * build error rather than a leaked WhatsApp credential.
 *
 * Deliberately dependency-free — it is a thin wrapper over `fetch`, and the value it adds is
 * handling the parts of the API that are not guessable: five different success envelopes, two
 * different failure envelopes, and a `?paginated=true` flag that changes the response shape.
 * See `api-notes.md`.
 */

const base = process.env["WAPI_BASE_URL"] ?? "https://api.wapi.crafter.run";
const key = process.env["WAPI_API_KEY"];

/** Thrown for any non-2xx, carrying enough to act on without re-reading the response. */
export class WapiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Present on validation failures: field name to messages. */
    readonly fields?: Record<string, string[]>,
    /** Seconds, from a 429. */
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = "WapiError";
  }

  /** A wrong credential *type*, which is a config mistake rather than a bad token. */
  get isWrongCredentialType() {
    return this.status === 403;
  }
}

type Envelope = {
  success?: boolean;
  data?: unknown;
  error?: string;
  message?: string;
  errors?: Record<string, string[]>;
  retry_after?: number;
  [k: string]: unknown;
};

async function request(path: string, init: RequestInit = {}): Promise<Envelope> {
  if (!key) throw new Error("WAPI_API_KEY is not set");

  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
    // Message state changes constantly; a cached send or contact list is always wrong.
    cache: "no-store",
  });

  // 204 has no body — reading it as JSON throws.
  if (res.status === 204) return {};

  const body = (await res.json().catch(() => ({}))) as Envelope;

  if (!res.ok) {
    /**
     * Both failure envelopes, because which one arrives depends on where the failure happened:
     * route handlers set `error`, middleware sets `message`. Reading only one loses half of
     * them and produces "undefined" in logs.
     */
    const message =
      body.error ?? body.message ?? `wapi request failed with ${res.status}`;
    throw new WapiError(res.status, message, body.errors, body.retry_after);
  }

  return body;
}

/** Most routes wrap their payload in `data`; a few put it at the top level. */
const unwrap = <T>(body: Envelope): T => (body.data as T) ?? (body as T);

export type SendResult = { msgId: number; jid: string; status: string };

/**
 * A WhatsApp message key, as it arrives in a webhook payload under `data.key`.
 *
 * `remoteJid` is the chat, so reacting inside a group addresses the group; `fromMe` and
 * `participant` identify whose message it was.
 */
export type MessageKey = {
  id: string;
  remoteJid: string;
  fromMe?: boolean;
  participant?: string;
};

/**
 * One endpoint sends every message type; the field you set decides which.
 *
 * Typed as a union rather than an object of optionals so that setting two content fields is a
 * compile error, matching the server, which rejects it rather than silently preferring one.
 */
export type SendMessageInput = { to: string; replyTo?: number; mentions?: string[] } & (
  | { text: string }
  | { imageUrl: string; text?: string }
  | { videoUrl: string; text?: string }
  | { audioUrl: string }
  // `fileName` is optional server-side; required here because a document without one
  // arrives named after its URL, which is never what you want.
  | { documentUrl: string; fileName: string }
  | { stickerUrl: string }
  | { location: { latitude: number; longitude: number; name?: string; address?: string } }
  | { contact: { name: string; phone: string } }
  | { poll: { question: string; options: string[]; multiSelect?: boolean } }
);

export type Contact = {
  jid: string;
  id: string;
  name: string | null;
  notify: string | null;
  verifiedName: string | null;
  /** Always null in a list — a picture is a per-contact fetch. */
  imgUrl: string | null;
  status: string | null;
  phoneNumber: string | null;
  lid: string | null;
};

export type Group = {
  jid: string;
  id: string;
  name: string;
  subject: string;
  imgUrl: string | null;
  owner: string | null;
  creation: number | null;
  desc: string | null;
  participants: { jid: string; isAdmin: boolean; isSuperAdmin: boolean }[];
};

export type Page<T> = {
  items: T[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
};

export const wapi = {
  /** Connection state of the session this key belongs to. Bare `{status}`, no envelope. */
  async status(): Promise<string> {
    const body = await request("/api/status");
    return body["status"] as string;
  },

  async sendMessage(input: SendMessageInput): Promise<SendResult> {
    const body = await request("/api/send-message", {
      method: "POST",
      body: JSON.stringify(input),
    });
    return unwrap<SendResult>(body);
  },

  /**
   * `msgId` is wapi's integer, not WhatsApp's string id (that is `key.id`).
   *
   * Note `messageTimestamp` is a string and `status` a number here: this returns the WhatsApp
   * record, whose types differ from a send's response.
   */
  async messageInfo(msgId: number) {
    const body = await request(`/api/messages/${msgId}/info`);
    return unwrap<{
      remoteJid: string | null;
      id: string | null;
      msgId: number;
      key: Record<string, unknown>;
      message: unknown;
      messageTimestamp: string;
      status: number;
    }>(body);
  },

  /**
   * React to a message, or clear a reaction with an empty string.
   *
   * A wapi extension — WasenderAPI reports reactions over webhooks but has no endpoint to send
   * one, so feature-detect if you also target them.
   *
   * Takes the WhatsApp `key`, not a `msgId`: you mostly react to messages someone *else* sent,
   * and those have no `msgId`. Pass `data.key` straight from the webhook payload.
   */
  async react(key: MessageKey, emoji: string): Promise<{ id: string | null; emoji: string }> {
    const body = await request("/api/messages/react", {
      method: "POST",
      body: JSON.stringify({ key, emoji }),
    });
    return unwrap<{ id: string | null; emoji: string }>(body);
  },

  /** Remove a reaction. The empty string is WhatsApp's convention, not a separate endpoint. */
  async unreact(key: MessageKey): Promise<void> {
    await this.react(key, "");
  },

  async contacts(): Promise<Contact[]> {
    return unwrap<Contact[]>(await request("/api/contacts"));
  },

  async groups(): Promise<Group[]> {
    return unwrap<Group[]>(await request("/api/groups"));
  },

  /**
   * The paginated forms return a different shape — `data.items`, not `data`. Kept as separate
   * methods so a caller cannot read `data` and silently get `undefined`.
   */
  async contactsPage(page = 1, limit = 20): Promise<Page<Contact>> {
    return unwrap<Page<Contact>>(
      await request(`/api/contacts?paginated=true&page=${page}&limit=${limit}`),
    );
  },

  async groupsPage(page = 1, limit = 20): Promise<Page<Group>> {
    return unwrap<Page<Group>>(
      await request(`/api/groups?paginated=true&page=${page}&limit=${limit}`),
    );
  },

  async groupMetadata(groupJid: string): Promise<Group> {
    return unwrap<Group>(await request(`/api/groups/${encodeURIComponent(groupJid)}/metadata`));
  },

  /** `404` here means "no mapping known", which is normal rather than an error to retry. */
  async phoneFromLid(lid: string): Promise<string | null> {
    try {
      const body = await request(`/api/pn-from-lid/${encodeURIComponent(lid)}`);
      return unwrap<{ pn: string }>(body).pn;
    } catch (err) {
      if (err instanceof WapiError && err.status === 404) return null;
      throw err;
    }
  },

  /**
   * Upload bytes and get a permanent URL to pass to `sendMessage`.
   *
   * `publicUrl` is at the top level, not under `data`. The link does not expire, which is what
   * makes it usable as a send input later.
   */
  async upload(file: { base64: string; mimetype: string; fileName?: string }): Promise<string> {
    const body = await request("/api/upload", {
      method: "POST",
      body: JSON.stringify(file),
    });
    return body["publicUrl"] as string;
  },

  /**
   * Turn an inbound encrypted media node into a URL valid for one hour.
   *
   * Pass the `message` object straight from the webhook payload.
   */
  async decryptMedia(message: Record<string, unknown>): Promise<string> {
    const body = await request("/api/decrypt-media", {
      method: "POST",
      body: JSON.stringify({ data: { messages: { message } } }),
    });
    return body["publicUrl"] as string;
  },
};
