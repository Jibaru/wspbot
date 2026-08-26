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

  /** Reasoning depth. Low keeps a chat bot snappy; raise it if answers feel shallow. */
  effort: () => optional("BOT_EFFORT") ?? "low",

  /**
   * Off by default: the bot is a group tool, and a one-to-one chat has no tagging convention to
   * signal when it is wanted, so it would answer everything anyone sent it.
   */
  replyToDms: () => (optional("BOT_REPLY_TO_DMS") ?? "false") === "true",
};
