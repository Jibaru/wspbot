import { Transport, type WapiClientOptions } from "./http";
import { ContactsResource, GroupsResource } from "./resources/directory";
import { MessagesResource } from "./resources/messages";
import { SandboxResource } from "./resources/sandbox";
import { SessionsResource } from "./resources/sessions";
import type { GetApiStatusResponse, GetApiUserResponse } from "./types.gen";

export * from "./errors";
export type { WapiClientOptions, RequestOptions } from "./http";
export type { MessageKey, SendMessageInput } from "./resources/messages";
export type { Page } from "./resources/directory";
export type { Session, SessionDetail } from "./resources/sessions";
export type * from "./types.gen";

/**
 * The wapi client.
 *
 * ```ts
 * const wapi = new WapiClient({ apiKey: process.env.WAPI_KEY! });
 *
 * await wapi.messages.send({ to: "+51999888777", text: "hello" });
 * await wapi.sessions.keys.regenerate(3);
 * const { items } = await wapi.contacts.page({ limit: 50 });
 * ```
 *
 * ## Two credentials, not interchangeable
 *
 * A **session API key** covers messaging, contacts, groups and media — it identifies the
 * session, which is why those endpoints carry no session id. A **Personal Access Token** covers
 * everything under `sessions.*`. Using the wrong one returns `403`, not `401`, and
 * `WapiAuthError.isWrongCredentialType` tells them apart. Construct two clients if you need
 * both; a client holds exactly one credential on purpose.
 *
 * ## Method names are hand-written
 *
 * Types come from the OpenAPI document via `scripts/generate-types.ts`, but the surface is
 * authored. Generated names would read `postApiWhatsappSessionsWhatsappSessionRegenerateKey`,
 * which is why no generator was used for this half. See that script's header for the full
 * reasoning, and `ops/check-sdk-in-sync.mjs` for what keeps the two halves honest.
 */
export class WapiClient {
  private readonly http: Transport;

  readonly sessions: SessionsResource;
  readonly messages: MessagesResource;
  readonly contacts: ContactsResource;
  readonly groups: GroupsResource;
  /** wapi extension: a fake number on a fake WhatsApp. See `SandboxResource`. */
  readonly sandbox: SandboxResource;

  constructor(options: WapiClientOptions) {
    this.http = new Transport(options);
    this.sessions = new SessionsResource(this.http);
    this.messages = new MessagesResource(this.http);
    this.contacts = new ContactsResource(this.http);
    this.groups = new GroupsResource(this.http);
    this.sandbox = new SandboxResource(this.http);
  }

  /**
   * Connection state of the session this key belongs to.
   *
   * A bare `{ status }` with **no `success` wrapper** — one of five success envelopes in this
   * API, and the reason this client does not unwrap `data` centrally.
   */
  async status(): Promise<string> {
    const body = await this.http.request<GetApiStatusResponse>("GET", "/api/status");
    return body.status;
  }

  /** The WhatsApp identity behind the session key, including its LID. */
  async user() {
    const body = await this.http.request<GetApiUserResponse>("GET", "/api/user");
    return body.data;
  }
}

export default WapiClient;
