import { errorFor, WapiUnavailableError } from "./errors";

/**
 * Transport.
 *
 * Zero runtime dependencies — global `fetch`, available on Node 18+, Bun and Deno. An HTTP
 * client that pulls a dependency tree is a liability in something meant to be dropped into other
 * people's projects.
 */

export type WapiClientOptions = {
  /** Session API key or Personal Access Token. Which one depends on the endpoint. */
  apiKey: string;
  /** Defaults to the hosted deployment. */
  baseUrl?: string;
  /** Per-request deadline. The failure mode of a WhatsApp call is silence, not an error. */
  timeoutMs?: number;
  /** Swap in a custom fetch — a proxy agent, a test double, an instrumented wrapper. */
  fetch?: typeof globalThis.fetch;
  /** Extra headers on every request. Cannot override `Authorization`. */
  headers?: Record<string, string>;
};

export type RequestOptions = {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** Overrides the client default for one call — uploads and sends are slower than reads. */
  timeoutMs?: number;
  signal?: AbortSignal;
};

const DEFAULT_BASE_URL = "https://api.wapi.crafter.run";
const DEFAULT_TIMEOUT_MS = 30_000;

export class Transport {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly extraHeaders: Record<string, string>;

  constructor(options: WapiClientOptions) {
    if (!options.apiKey) throw new Error("wapi: apiKey is required");
    this.apiKey = options.apiKey;
    // Trailing slashes would produce `//api/...`, which some proxies redirect and others 404.
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.extraHeaders = options.headers ?? {};
  }

  /**
   * One request.
   *
   * Returns the *whole* body rather than unwrapping `data`, because this API has five different
   * success envelopes: `{success, data}` for most routes, a bare `{status}` for `/api/status`,
   * `api_key` at the top level for regenerate-key, `publicUrl` at the top level for upload and
   * decrypt-media, and `204` with no body for delete. A single `unwrap(res.data)` helper is
   * wrong for four of those, so unwrapping is the caller's decision — see `data()` below.
   */
  async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? this.timeoutMs);
    // A caller-supplied signal must still work alongside our deadline.
    options.signal?.addEventListener("abort", () => controller.abort(), { once: true });

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        headers: {
          ...this.extraHeaders,
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        method,
        signal: controller.signal,
      });
    } catch (cause) {
      const timedOut = controller.signal.aborted;
      throw new WapiUnavailableError(
        0,
        timedOut ? `wapi: request timed out after ${options.timeoutMs ?? this.timeoutMs}ms` : String(cause),
        null,
      );
    } finally {
      clearTimeout(timer);
    }

    // `204` carries no body; parsing it as JSON throws.
    if (response.status === 204) return undefined as T;

    const text = await response.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        // A non-JSON body from a proxy or gateway is still a failure worth surfacing intact.
        body = text;
      }
    }

    if (!response.ok) throw errorFor(response.status, body);
    return body as T;
  }
}

/**
 * Pull `data` out of the common envelope.
 *
 * Only for the routes that use it. The four that do not are handled explicitly at their call
 * sites, which is deliberate: making the exception visible in the resource file is better than a
 * clever helper that silently returns the wrong thing.
 */
export const data = <T>(body: { data: T }): T => body.data;
