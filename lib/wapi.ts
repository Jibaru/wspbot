import "server-only";
import { config } from "./config";

/**
 * wapi client.
 *
 * Server-only by construction: `server-only` makes importing this from a client component a
 * build error rather than a leaked WhatsApp credential.
 *
 * Deliberately dependency-free. The value it adds is handling the parts of the API that are not
 * guessable from the endpoint names — five success envelopes, two failure envelopes, and two
 * token types on the same header. Background:
 * `.agents/skills/wapi-nextjs/references/api-notes.md`.
 */

export class WapiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly fields?: Record<string, string[]>,
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = "WapiError";
  }

  /** 403 is the wrong credential *type*, not a bad token — a config mistake, not an auth one. */
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
  const res = await fetch(`${config.wapiBaseUrl()}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.wapiApiKey()}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
    // Message state changes constantly; a cached send or status is always wrong.
    cache: "no-store",
  });

  if (res.status === 204) return {};

  const body = (await res.json().catch(() => ({}))) as Envelope;

  if (!res.ok) {
    // Route handlers set `error`; middleware sets `message`. Reading one loses half the failures.
    const message =
      body.error ?? body.message ?? `wapi request failed with ${res.status}`;
    throw new WapiError(res.status, message, body.errors, body.retry_after);
  }

  return body;
}

const unwrap = <T>(body: Envelope): T => (body.data as T) ?? (body as T);

export type SendResult = { msgId: number; jid: string; status: string };

/** The WhatsApp identity behind the session key. `id` is a JID, `lid` the newer LID form. */
export type WapiUser = { id: string; name: string | null; lid: string | null };

export const wapi = {
  /** Bare `{status}` — this one has no `success` key at all. */
  async status(): Promise<string> {
    return (await request("/api/status"))["status"] as string;
  },

  async me(): Promise<WapiUser> {
    return unwrap<WapiUser>(await request("/api/user"));
  },

  async sendText(
    to: string,
    text: string,
    opts: { mentions?: string[] } = {},
  ): Promise<SendResult> {
    return unwrap<SendResult>(
      await request("/api/send-message", {
        method: "POST",
        body: JSON.stringify({ to, text, ...opts }),
      }),
    );
  },

  /** Blue ticks. Best-effort — a failure here must never stop a reply. */
  async markRead(key: Record<string, unknown>): Promise<void> {
    await request("/api/messages/read", {
      method: "POST",
      body: JSON.stringify({ key }),
    });
  },
};
