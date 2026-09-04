import "server-only";

const optional = (name: string): string | undefined =>
  process.env[name]?.trim() || undefined;

const required = (name: string): string => {
  const value = optional(name);
  if (!value) throw new Error(`${name} is not set — see .env.example`);
  return value;
};

/**
 * A complete bcrypt hash: `$2b$12$` followed by 53 characters of salt and digest.
 */
const BCRYPT = /^\$2[aby]?\$\d{2}\$[./A-Za-z0-9]{53}$/;

/**
 * The hash, accepted either raw or base64-encoded — and base64 is what deployment should use,
 * for a mundane but vicious reason.
 *
 * A bcrypt hash contains `$`, and Docker Compose interpolates `$NAME` in environment values.
 * `$2b` and `$12` survive, because a variable name cannot begin with a digit — but a salt
 * usually starts with a letter, so the rest of the hash is read as a variable name and replaced
 * with nothing. The container is then handed `$2b$12`: long enough to look configured, useless
 * to compare against. Every sign-in fails as "wrong password" and nothing says why.
 *
 * So the shape is checked here. An unusable value is treated as no value at all, which surfaces
 * as "no credentials are configured" — wrong, but wrong in a way that can be diagnosed.
 */
const adminPasswordHash = (): string | undefined => {
  const raw = optional("ADMIN_PASSWORD_HASH");
  if (!raw) return undefined;
  if (BCRYPT.test(raw)) return raw;

  const decoded = Buffer.from(raw, "base64").toString("utf8");
  if (BCRYPT.test(decoded)) return decoded;

  console.warn(
    "[config] ADMIN_PASSWORD_HASH is not a usable bcrypt hash — nobody can sign in. " +
      "If it looks truncated to `$2b$12`, Docker Compose ate the rest: store it base64-encoded " +
      "(`base64 -w0`) rather than raw.",
  );
  return undefined;
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

  /**
   * The model that writes a scheduled summary. A digest is read by people who were not there,
   * so it is the one job here worth the top tier: it is infrequent, it runs on a long transcript,
   * and a summary that drops the decision everyone needed is worse than no summary.
   */
  summaryModel: () => optional("BOT_SUMMARY_MODEL") ?? "gpt-5.6-sol",

  /**
   * A Buy Me a Coffee personal access token, issued from developers.buymeacoffee.com. Optional:
   * without it, coffee supporters are simply added by hand like the Yape ones, and the sync
   * button says so rather than failing.
   */
  coffeeToken: () => optional("BUYMEACOFFEE_TOKEN"),

  /**
   * The signing secret of one Buy Me a Coffee webhook, from the same portal. Each webhook has
   * its own, and removing and re-adding the webhook is how it is regenerated. Without it the
   * receiver refuses everything rather than accepting unverified writes.
   */
  coffeeWebhookSecret: () => optional("BUYMEACOFFEE_WEBHOOK_SECRET"),

  /** Reasoning depth. Low keeps a chat bot snappy; raise it if answers feel shallow. */
  effort: () => optional("BOT_EFFORT") ?? "low",

  /**
   * Who may open the dashboard. The password is stored only as a bcrypt hash, so the plaintext
   * exists nowhere on the server — not in the environment, not in a log, not in a backup.
   */
  admin: (): { username: string; passwordHash: string } | null => {
    const username = optional("ADMIN_USER");
    const passwordHash = adminPasswordHash();
    return username && passwordHash ? { username, passwordHash } : null;
  },

  /** Signs the session cookie. Changing it signs everyone out, which is the emergency lever. */
  authSecret: () => required("AUTH_SECRET"),

  /**
   * The timezone people in these chats live in. Reminders are the reason it exists: "nine in the
   * morning" means nothing without it, and a bot on a UTC server would fire five hours early.
   */
  timezone: () => optional("BOT_TIMEZONE") ?? "UTC",

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
