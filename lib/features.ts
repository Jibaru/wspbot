import "server-only";
import { query } from "./db";

/**
 * Which of the bot's abilities are switched on.
 *
 * One registry, three consumers: the dashboard renders it as a list of switches, `lib/agent.ts`
 * uses it to decide which tools and which prompt sections a turn gets, and `lib/about.ts` builds
 * the bot's own account of itself from it. Before this existed the same list was written out in
 * three places and drifted — the prose one silently, since nothing renders it.
 *
 * A switch has to reach the model to mean anything. Turning something off removes its tools
 * *and* the instructions that describe them: leaving the prompt in place would have the bot
 * offering to do things it no longer can, which is worse than not having the switch at all.
 */

export type Feature = {
  key: string;
  /** For the dashboard, and for people. */
  title: string;
  detail: string;
  /**
   * How the bot describes this ability when asked what it can do. Folded into one sentence in
   * `lib/about.ts`, so it is a fragment rather than a sentence.
   */
  claim?: string;
  /** Tool names withdrawn when this is off. Some features are prompt- or handler-only. */
  tools: string[];
  /** Also needs deployment configuration; the dashboard says so rather than lying about it. */
  needs?: "notion" | "sheets";
};

/**
 * Always on, and not offered as a switch: without them there is no bot left to configure.
 * Listed anyway so the dashboard shows the whole picture rather than only the parts that move.
 */
export const ALWAYS: { title: string; detail: string }[] = [
  {
    title: "Answers when tagged",
    detail:
      "In groups only, when @-mentioned or when you reply to one of its messages. Direct chats are ignored, and so is everything else.",
  },
  {
    title: "Knows what it is",
    detail: "Ask how it works, what it runs on, or who built it, and it answers from fact.",
  },
  {
    title: "Reconnects itself",
    detail:
      "Watches its own WhatsApp session and brings it back when it drops, so a restart underneath it goes unnoticed.",
  },
];

export const FEATURES: Feature[] = [
  {
    key: "quoted",
    title: "Follows what you point at",
    detail:
      "Reply to any message and tag it, and it reads what you replied to — the text, and the picture if there is one. “What does this mean?” works.",
    tools: [],
  },
  {
    key: "reactions",
    title: "Reacts with emoji",
    detail:
      "Weighs up whether each message deserves a reaction, and picks one that fits, rather than defaulting to a thumbs-up.",
    tools: ["react"],
  },
  {
    key: "web_search",
    title: "Searches the web",
    detail:
      "For anything current or specific enough that being wrong would matter — not for things it already knows.",
    claim: "search the web",
    tools: ["web_search"],
  },
  {
    key: "reminders",
    title: "Schedules reminders",
    detail:
      "“Remind me at 9”, or “every morning, check if it will rain and tell me”. One per person per chat; change or cancel it any time.",
    tools: ["set_reminder", "cancel_reminder"],
  },
  {
    key: "tasks",
    title: "Keeps a checklist",
    detail:
      "Each chat has its own pending list. Add items, tick them off, take them back off the list — in whatever words you use for it.",
    tools: ["add_tasks", "complete_tasks", "remove_tasks"],
  },
  {
    key: "memory",
    title: "Remembers",
    detail:
      "“Record that…” keeps a fact for the chat; some facts can be saved for every chat. Both survive restarts, and “forget that” removes them.",
    claim: "remember and forget things, for one chat or for every chat",
    tools: ["remember", "forget"],
  },
  {
    key: "media",
    title: "Sends files",
    detail:
      "Images, video, PDFs and other documents, found by searching or from a link you give it.",
    claim: "send images, video, PDFs and other files",
    tools: ["send_media"],
  },
  {
    key: "voice",
    title: "Speaks",
    detail:
      "Generates a voice note when something is easier to hear than to read, or when you ask it to read something out.",
    claim: "record voice notes",
    tools: ["send_voice_note"],
  },
  {
    key: "polls",
    title: "Runs polls",
    detail:
      "Puts a WhatsApp poll in the chat, two to twelve options, single or multiple choice.",
    claim: "create polls",
    tools: ["create_poll"],
  },
  {
    key: "stickers_collect",
    title: "Collects stickers",
    detail:
      "Every sticker sent in any chat it is in is kept, silently and without replying. One shared library, described automatically so it can be found later.",
    claim: "collect the stickers people send",
    tools: [],
  },
  {
    key: "stickers_send",
    title: "Sends stickers",
    detail:
      "Picks one out of the shared library when a sticker answers better than words do.",
    claim: "send stickers from that library",
    tools: ["send_sticker"],
  },
  {
    key: "stickers_make",
    title: "Makes stickers",
    detail:
      "Tag it with an image, GIF or short video, or give it a GIF link. Animation is preserved.",
    claim: "make stickers from a picture or a GIF link",
    tools: ["make_sticker", "sticker_from_url"],
  },
  {
    key: "stickers_draw",
    title: "Draws stickers",
    detail:
      "Ask for a sticker of something that does not exist and it draws one, on a transparent background.",
    claim: "draw new stickers from a description",
    tools: ["draw_sticker"],
  },
  {
    key: "stickers_name",
    title: "Names stickers",
    detail:
      "Tell it what one should be called and it can be asked for by that name afterwards.",
    claim: "name stickers so they can be asked for later",
    tools: ["name_sticker"],
  },
  {
    key: "sheets",
    title: "Reads and writes spreadsheets",
    detail:
      "Share a Google Sheets link and ask what is missing, or have it fill something in. Reading a public sheet needs no setup.",
    tools: ["sheet_read", "sheet_info", "sheet_update", "sheet_append"],
    needs: "sheets",
  },
  {
    key: "notion",
    title: "Connects to Notion",
    detail:
      "Ask it to connect and it sends a link. You choose which pages it may reach; after that it can search, read, write, work with databases and leave comments.",
    tools: [
      "connect_notion",
      "disconnect_notion",
      "notion_search",
      "notion_read",
      "notion_add",
      "notion_find_database",
      "notion_read_database",
      "notion_add_row",
      "notion_comments",
      "notion_create",
    ],
    needs: "notion",
  },
  {
    key: "summaries",
    title: "Summarises a group on a schedule",
    detail:
      "Reads one group and posts a digest into another on a cron — decisions, open questions, links and pictures. The source group is recorded in full while this is on, including messages that do not tag the bot; nothing else is, and it is kept for a fortnight.",
    tools: [],
  },
  {
    key: "supporters",
    title: "Knows who chipped in",
    detail:
      "Somebody asks who supports this bot and it reads out the list — names and how they helped, never amounts. The list is kept on the dashboard.",
    claim: "say who has chipped in towards running you",
    tools: ["list_supporters"],
  },
  {
    key: "render",
    title: "Draws its own HTML",
    detail:
      "Anything it can lay out in HTML — a table, a card, a summary with real formatting — it can render and send as a picture, since WhatsApp shows none of that as text. Rendered with no network access at all, so nothing the page references can be fetched.",
    claim: "render a table or a card as a picture",
    tools: ["render_html"],
  },
  {
    key: "screenshot",
    title: "Takes a picture of a web page",
    detail:
      "Give it a link and it opens the page in a real browser and sends back a screenshot — the top of it, or the whole thing. It never opens an address inside the private network, and it carries none of the bot's own logins.",
    claim: "screenshot a web page you link",
    tools: ["screenshot_page"],
  },
  {
    key: "roadmap",
    title: "Takes votes on what to build next",
    detail:
      "Anyone can ask what is being built; supporters can back items and suggest new ones. A vote is weighted by how much somebody has chipped in, capped so nobody can own the list, and a suggestion waits for approval before it becomes votable. Voting ranks things — it never switches a feature on.",
    claim: "say what is on the roadmap, and take votes on it from supporters",
    tools: ["list_roadmap", "vote_roadmap", "propose_roadmap"],
  },
  {
    key: "usage_report",
    title: "Reports its usage",
    detail: "Tokens and estimated spend for today, the last week and all time.",
    claim: "report what you have cost so far",
    tools: ["check_usage"],
  },
];

const BY_KEY = new Map(FEATURES.map((f) => [f.key, f]));

/** Tool name to the feature that owns it. A tool owned by nothing is never withdrawn. */
const OWNER = new Map<string, string>(
  FEATURES.flatMap((f) => f.tools.map((t) => [t, f.key] as [string, string])),
);

/**
 * Absence of a row means on. Only deviations are stored, so a feature added in a later release
 * arrives switched on without needing a migration, and the table stays a list of decisions
 * somebody actually made rather than a copy of the registry.
 */
export const enabled = async (): Promise<Set<string>> => {
  const rows = await query<{ key: string; enabled: boolean }>(
    "select key, enabled from features",
  );
  const off = new Set(rows.filter((r) => !r.enabled).map((r) => r.key));
  return new Set(FEATURES.filter((f) => !off.has(f.key)).map((f) => f.key));
};

/** Every feature with its state, for the dashboard. Registry order, which is deliberate. */
export const list = async (): Promise<(Feature & { on: boolean })[]> => {
  const on = await enabled();
  return FEATURES.map((f) => ({ ...f, on: on.has(f.key) }));
};

export const setEnabled = async (key: string, on: boolean): Promise<void> => {
  if (!BY_KEY.has(key)) throw new Error(`unknown feature: ${key}`);
  await query(
    `insert into features (key, enabled) values ($1, $2)
     on conflict (key) do update set enabled = excluded.enabled, updated_at = now()`,
    [key, on],
  );
};

/**
 * Drop the tools of every switched-off feature. Filtering the assembled object rather than
 * building it conditionally keeps one definition per tool: a tool cannot be defined in the
 * enabled branch and quietly forgotten in the other.
 */
export const withdraw = <T extends Record<string, unknown>>(
  tools: T,
  on: Set<string>,
): Partial<T> => {
  const kept: Record<string, unknown> = {};
  for (const [name, definition] of Object.entries(tools)) {
    const owner = OWNER.get(name);
    if (owner === undefined || on.has(owner)) kept[name] = definition;
  }
  return kept as Partial<T>;
};

/** The capability sentence in `lib/about.ts`, built from whatever is actually switched on. */
export const claims = (on: Set<string>): string[] =>
  FEATURES.filter((f) => f.claim && on.has(f.key)).map((f) => f.claim as string);
