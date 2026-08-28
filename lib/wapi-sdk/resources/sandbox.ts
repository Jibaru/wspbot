import type { Transport } from "../http";
import { data } from "../http";
import type {
  PostApiSandboxInboundResponse,
  PostApiSandboxScanResponse,
  PostApiSandboxSessionsResponse,
} from "../types.gen";

/**
 * The sandbox — a fake number on a fake WhatsApp.
 *
 * **A wapi extension**, not part of the WasenderAPI interface. It exists because linking a real
 * number is the highest-friction step in this product and the one that carries a ban risk, so
 * you should not have to do it to find out whether your integration works.
 *
 * A sandbox session goes through the same routes and the same code as a real one: it pairs
 * itself after a few seconds, has a small deterministic directory, accepts sends and can be made
 * to receive them. Its number lives under ITU country code 999, which is unassigned and cannot
 * route anywhere.
 *
 * Two differences from production, deliberate and worth knowing before you tune anything against
 * them: `account_protection` pacing is ignored, so sends return immediately where production
 * would wait five seconds; and `decrypt-media` returns a fixed PNG rather than real media.
 */
export class SandboxResource {
  constructor(private readonly http: Transport) {}

  /**
   * Create a sandbox session. Requires a **Personal Access Token**, like any session creation.
   *
   * The number is not yours to choose — it is derived from the session id, so it cannot collide
   * with a real one. The response carries the session's own API key, which is what every other
   * call below uses.
   */
  async createSession(name: string) {
    const body = await this.http.request<PostApiSandboxSessionsResponse>(
      "POST",
      "/api/sandbox/sessions",
      { body: { name } },
    );
    return data(body);
  }

  /**
   * Fabricate an inbound message, as if somebody had written to this number.
   *
   * This is the reason the sandbox exists. The message travels the ordinary pipeline, so the
   * webhook that reaches your handler is signed exactly as a real one and indistinguishable from
   * it. Use a **session key** for this, not a PAT.
   *
   * `from` defaults to the session's first derived contact, so the common case needs no sender.
   */
  async inbound(text: string, from?: string) {
    const body = await this.http.request<PostApiSandboxInboundResponse>(
      "POST",
      "/api/sandbox/inbound",
      { body: from === undefined ? { text } : { from, text } },
    );
    return data(body);
  }

  /**
   * Finish pairing immediately rather than waiting for the fake QR to resolve itself.
   *
   * Only useful if you are deliberately testing the waiting state — a sandbox session connects on
   * its own a few seconds after `sessions.connection.connect`.
   */
  async scan() {
    const body = await this.http.request<PostApiSandboxScanResponse>(
      "POST",
      "/api/sandbox/scan",
      { body: {} },
    );
    return data(body);
  }
}
