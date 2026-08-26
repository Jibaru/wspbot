import "server-only";

const optional = (name: string): string | undefined =>
  process.env[name]?.trim() || undefined;

const required = (name: string): string => {
  const value = optional(name);
  if (!value) throw new Error(`${name} is not set — see .env.example`);
  return value;
};

export const config = {
  wapiBaseUrl: () => optional("WAPI_BASE_URL") ?? "https://api.wapi.crafter.run",

  /** Session key: messaging, contacts, groups. Not interchangeable with the PAT. */
  wapiApiKey: () => required("WAPI_API_KEY"),

  webhookSecret: () => required("WAPI_WEBHOOK_SECRET"),

  /**
   * Account-level token, needed only to reconnect a dropped session — `connect` is a
   * session-admin route and the session key gets a 403 there. Optional: without it the bot
   * still works, it just cannot heal itself when the session drops.
   */
  wapiPatOptional: () => optional("WAPI_PAT"),
  sessionId: () => optional("WAPI_SESSION_ID"),

  databaseUrl: () => required("DATABASE_URL"),

  /**
   * A Google service account, for writing to Sheets. Reading a public sheet needs nothing, but
   * an API key cannot write — Google allows key auth for public reads only — so writes need
   * this. Accepts the whole downloaded JSON, which is what you actually have in your hand.
   */
  googleServiceAccount: (): { clientEmail: string; privateKey: string } | null => {
    const raw = optional("GOOGLE_SERVICE_ACCOUNT_JSON");
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as { client_email?: string; private_key?: string };
      if (!parsed.client_email || !parsed.private_key) return null;
      return {
        clientEmail: parsed.client_email,
        // Env vars keep the newlines escaped; the key is unusable until they are real again.
        privateKey: parsed.private_key.replace(/\\n/g, "\n"),
      };
    } catch {
      console.warn("[config] GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON — ignoring it");
      return null;
    }
  },

  /** Where this app is reachable, used to build the Notion OAuth redirect. */
  appUrl: () => (optional("APP_URL") ?? "https://wspbot.crafter.run").replace(/\/$/, ""),

  /**
   * Notion is optional. With no credentials the Notion tools are not offered at all, rather
   * than being offered and failing — a tool that cannot work is worse than one that is absent.
   */
  notion: (): { clientId: string; clientSecret: string } | null => {
    const clientId = optional("NOTION_CLIENT_ID");
    const clientSecret = optional("NOTION_CLIENT_SECRET");
    return clientId && clientSecret ? { clientId, clientSecret } : null;
  },

  /** Any model your account can reach on the OpenAI Responses API. */
  model: () => optional("BOT_MODEL") ?? "gpt-5.6",

  /** Image model for drawing stickers. gpt-image-* supports transparent backgrounds. */
  imageModel: () => optional("BOT_IMAGE_MODEL") ?? "gpt-image-1",

  /**
   * Model for looking at a sticker and naming it. A narrow, bounded task, so it is worth
   * pointing at something cheaper than the conversational model. Falls back to that model when
   * unset, which is the safe default rather than the cheap one.
   */
  visionModel: () => optional("BOT_VISION_MODEL") ?? optional("BOT_MODEL") ?? "gpt-5.6",

  /** Reasoning depth. Low keeps a chat bot snappy; raise it if answers feel shallow. */
  effort: () => optional("BOT_EFFORT") ?? "low",

  /**
   * Calls one person may make per minute before being turned away. Per-person overrides live in
   * the `rate_limits` table; this is only the fallback for anyone not listed there.
   */
  defaultRateLimit: () => {
    const value = Number(optional("BOT_RATE_LIMIT_PER_MINUTE"));
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 1;
  },

  /**
   * Off by default: the bot is a group tool, and a one-to-one chat has no tagging convention to
   * signal when it is wanted, so it would answer everything anyone sent it.
   */
  replyToDms: () => (optional("BOT_REPLY_TO_DMS") ?? "false") === "true",
};
