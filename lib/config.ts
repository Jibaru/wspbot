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

  databaseUrl: () => required("DATABASE_URL"),

  /** Any model your account can reach on the OpenAI Responses API. */
  model: () => optional("BOT_MODEL") ?? "gpt-5.6",

  /** Reasoning depth. Low keeps a chat bot snappy; raise it if answers feel shallow. */
  effort: () => optional("BOT_EFFORT") ?? "low",

  /**
   * Off by default: the bot is a group tool, and a one-to-one chat has no tagging convention to
   * signal when it is wanted, so it would answer everything anyone sent it.
   */
  replyToDms: () => (optional("BOT_REPLY_TO_DMS") ?? "false") === "true",
};
