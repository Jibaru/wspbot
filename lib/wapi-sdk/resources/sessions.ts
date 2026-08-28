import { data, type Transport } from "../http";
import type {
  GetApiWhatsappSessionsResponse,
  GetApiWhatsappSessionsWhatsappSessionMessageLogsResponse,
  GetApiWhatsappSessionsWhatsappSessionQrcodeResponse,
  GetApiWhatsappSessionsWhatsappSessionResponse,
  PostApiWhatsappSessionsBody,
  PostApiWhatsappSessionsResponse,
  PostApiWhatsappSessionsWhatsappSessionConnectResponse,
  PostApiWhatsappSessionsWhatsappSessionDisconnectResponse,
  PostApiWhatsappSessionsWhatsappSessionRegenerateKeyResponse,
  PostApiWhatsappSessionsWhatsappSessionRestartResponse,
  PutApiWhatsappSessionsWhatsappSessionBody,
  PutApiWhatsappSessionsWhatsappSessionResponse,
} from "../types.gen";

export type Session = GetApiWhatsappSessionsResponse["data"][number];
export type SessionDetail = GetApiWhatsappSessionsWhatsappSessionResponse["data"];

/**
 * Connecting and disconnecting a session.
 *
 * A sub-object because these four are a lifecycle, not four unrelated verbs — grouping them
 * makes `sessions.connection.` list exactly the things you can do to a live socket.
 */
class SessionConnection {
  constructor(private readonly http: Transport) {}

  /**
   * Begin linking, or reconnect from stored credentials.
   *
   * Returns immediately with a status that may be `NEED_SCAN` plus a `qrCode`. Note the status
   * is SCREAMING_CASE here and lowercase everywhere else — an inherited inconsistency, not a
   * bug. Poll `status()` until it reads `connected`; the QR rotates while you wait.
   */
  async connect(sessionId: number) {
    return data(
      await this.http.request<PostApiWhatsappSessionsWhatsappSessionConnectResponse>(
        "POST",
        `/api/whatsapp-sessions/${sessionId}/connect`,
      ),
    );
  }

  /** Close the socket without unlinking the device. Credentials survive. */
  async disconnect(sessionId: number) {
    return data(
      await this.http.request<PostApiWhatsappSessionsWhatsappSessionDisconnectResponse>(
        "POST",
        `/api/whatsapp-sessions/${sessionId}/disconnect`,
      ),
    );
  }

  /** Reconnect a live session using its stored credentials. */
  async restart(sessionId: number): Promise<string> {
    // `message` at the top level, not under `data` — one of five success envelopes.
    const body = await this.http.request<PostApiWhatsappSessionsWhatsappSessionRestartResponse>(
      "POST",
      `/api/whatsapp-sessions/${sessionId}/restart`,
    );
    return body.message;
  }

  /** The current QR string for a session awaiting a scan. */
  async qrCode(sessionId: number) {
    return data(
      await this.http.request<GetApiWhatsappSessionsWhatsappSessionQrcodeResponse>(
        "GET",
        `/api/whatsapp-sessions/${sessionId}/qrcode`,
      ),
    );
  }
}

/** Credential management for one session. */
class SessionKeys {
  constructor(private readonly http: Transport) {}

  /**
   * Issue a new API key for this session.
   *
   * **The previous key stops working immediately.** Anything still using it starts getting
   * `401` — a deployed app, a script, a webhook consumer. There is no grace period and no way
   * back.
   *
   * Returns the new key, which is at the *top level* of the response rather than under `data`.
   */
  async regenerate(sessionId: number): Promise<string> {
    const body =
      await this.http.request<PostApiWhatsappSessionsWhatsappSessionRegenerateKeyResponse>(
        "POST",
        `/api/whatsapp-sessions/${sessionId}/regenerate-key`,
      );
    return body.api_key;
  }
}

/** Logs recorded for one session. */
class SessionLogs {
  constructor(private readonly http: Transport) {}

  /**
   * Messages sent through this session.
   *
   * Uses Laravel's length-aware paginator — `current_page`, `data`, `per_page`, `total` — which
   * is a *different* shape from the `?paginated=true` mode on contacts and groups. Two
   * pagination styles in one API is not a design anyone chose; it is what is being reproduced.
   */
  async messages(sessionId: number, options: { page?: number } = {}) {
    return data(
      await this.http.request<GetApiWhatsappSessionsWhatsappSessionMessageLogsResponse>(
        "GET",
        `/api/whatsapp-sessions/${sessionId}/message-logs`,
        { query: { page: options.page } },
      ),
    );
  }
}

/**
 * Sessions — one per linked WhatsApp number.
 *
 * **These are the account-level routes.** They need a Personal Access Token, not a session API
 * key; passing the wrong kind returns `403`, which `WapiAuthError.isWrongCredentialType`
 * distinguishes from a bad secret.
 */
export class SessionsResource {
  readonly connection: SessionConnection;
  readonly keys: SessionKeys;
  readonly logs: SessionLogs;

  constructor(private readonly http: Transport) {
    this.connection = new SessionConnection(http);
    this.keys = new SessionKeys(http);
    this.logs = new SessionLogs(http);
  }

  /** Every session on the account. Keys are **not** included — use `get()` for one. */
  async list(): Promise<Session[]> {
    return data(
      await this.http.request<GetApiWhatsappSessionsResponse>("GET", "/api/whatsapp-sessions"),
    );
  }

  /** One session, including its API key and webhook secret in plaintext. */
  async get(sessionId: number): Promise<SessionDetail> {
    return data(
      await this.http.request<GetApiWhatsappSessionsWhatsappSessionResponse>(
        "GET",
        `/api/whatsapp-sessions/${sessionId}`,
      ),
    );
  }

  /** Create a session and issue its API key. The key is returned once, here. */
  async create(input: PostApiWhatsappSessionsBody): Promise<SessionDetail> {
    return data(
      await this.http.request<PostApiWhatsappSessionsResponse>(
        "POST",
        "/api/whatsapp-sessions",
        { body: input },
      ),
    );
  }

  /** Update settings, webhook configuration or proxy. */
  async update(
    sessionId: number,
    input: PutApiWhatsappSessionsWhatsappSessionBody,
  ): Promise<SessionDetail> {
    return data(
      await this.http.request<PutApiWhatsappSessionsWhatsappSessionResponse>(
        "PUT",
        `/api/whatsapp-sessions/${sessionId}`,
        { body: input },
      ),
    );
  }

  /**
   * Delete a session.
   *
   * **This revokes its API key and discards its stored WhatsApp credentials.** The number will
   * have to scan a QR code again to relink. Answers `204` with no body.
   */
  async delete(sessionId: number): Promise<void> {
    // No response type is generated for this one: it answers 204 with no body.
    await this.http.request<void>("DELETE", `/api/whatsapp-sessions/${sessionId}`);
  }
}
