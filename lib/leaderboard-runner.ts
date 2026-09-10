import "server-only";
import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";
import { config } from "./config";
import { query } from "./db";
import { wapi } from "./wapi";
import { capture } from "./render-html";
import * as features from "./features";
import * as leaderboard from "./leaderboard";
import * as usage from "./usage";

/**
 * Telling a group when the vote leaderboard moves.
 *
 * Separate from `lib/leaderboard.ts` for the reason every runner here is separate from its data
 * layer: the dashboard imports the data, and it has no business dragging the WhatsApp client
 * along behind it.
 *
 * **The figures do not go through the model, and that is the design.** `chime-runner` calls
 * `reply()` because what it says is a judgement; a gap is a subtraction, and a model in that
 * path could only add latency, cost, and the one failure that would matter — a number that is
 * almost right. So the standing is built in `leaderboard.announcement` and sent as it is.
 *
 * The closing line is the exception, and it proves the rule. Asking people to vote *is* voice,
 * not arithmetic, and a fixed sentence twice a day for a week is one nobody reads by Wednesday.
 * So a model writes it — shown the bot's own recent messages in that group, so it sounds like
 * the same bot people talk to rather than a press release. It is handed the *shape* of the race
 * and never the numbers, and a line that comes back carrying a digit is thrown away for a
 * written-in one: the figures above it are already correct, and a second unchecked claim beside
 * them is exactly what this whole feature is built to avoid.
 *
 * The restraint is the other half of the feature. A watch that spoke on every firing is a watch
 * a group mutes within a day, so by default nothing is said unless the standing actually moved,
 * quiet hours are respected, and there is a daily ceiling. What a group hears is the news, not
 * the schedule.
 *
 * A picture of the board rides along, with the figures as its caption. That is not a retreat
 * from reading the JSON — every number still comes from the feed, and none is ever taken off the
 * image. It is there because a message nobody asked for has to be worth opening, and a league
 * table is a thing people want to *look* at. It costs one Chromium run per message that actually
 * goes out, which the daily cap bounds, and a capture that fails costs the picture rather than
 * the message.
 */

/** A cron pattern's finest resolution is a minute; checking oftener would only cost queries. */
const TICK_MS = 60 * 1000;

const g = globalThis as unknown as { wspbotLeaderboard?: NodeJS.Timeout };

/**
 * One watch, one firing. Returns what was done, so the caller can log something true.
 *
 * `force` is the dashboard's "send it now": a person pressing a button means now, so the change
 * test is skipped. Quiet hours and the cap are the caller's business — `holdReason` is not
 * consulted here, because the button is deliberately allowed past it.
 */
export const announce = async (
  watch: leaderboard.Watch,
  at: Date,
  force = false,
): Promise<"sent" | "unchanged"> => {
  const cfg = config.leaderboard();
  if (!cfg) throw new Error("no leaderboard is configured on this deployment");

  const reading = await leaderboard.read();
  const standing = leaderboard.standing(reading.projects, cfg.slug);
  if (!standing) {
    throw new Error(
      `"${cfg.slug}" is not on the board — ${reading.projects.length} projects were read`,
    );
  }

  const moved = leaderboard.movement(watch.last, standing);
  if (!force && watch.onChangeOnly && !moved.changed) return "unchanged";

  const written = await cheer(watch.chat, standing, watch.recentCheers, watch.note);
  const text = [moved.headline, leaderboard.announcement(standing, reading, written)]
    .filter((part): part is string => Boolean(part))
    .join("\n");

  /*
   * Best-effort, and in that order deliberately: the figures are the message, so a board that
   * would not screenshot must cost the picture and not the notification. Sent as one message
   * with the text as its caption rather than as two, which would notify the group twice for one
   * piece of news.
   */
  const hosted = watch.withPicture ? await snapshot() : null;

  if (hosted) await wapi.send({ to: watch.chat, imageUrl: hosted, text });
  else await wapi.sendText(watch.chat, text);

  /*
   * The line is remembered only once it has actually gone out, like everything else on this row:
   * a discarded generation must not count as something the group has already heard.
   */
  await leaderboard.markAnnounced(watch.chat, standing, at, written);
  return "sent";
};

/**
 * The bot's own recent prose in this chat, as examples of how it talks here.
 *
 * Only messages with actual words: a stored turn that was nothing but an attachment reads as
 * `(sent: sticker (…))`, which is bookkeeping rather than voice and would teach the model to
 * write bookkeeping. Empty is a fine answer — a group the bot has never spoken in has no house
 * style to match, and the prompt says so instead of inventing one.
 */
const voiceOf = async (chat: string): Promise<string[]> => {
  const rows = await query<{ content: string }>(
    `select content from (
       select id, content from messages
        where chat = $1 and role = 'assistant'
        order by id desc limit 40
     ) recent order by id desc`,
    [chat],
  );
  return rows
    .map((r) => r.content.replace(/\(sent:[^)]*\)/g, "").trim())
    .filter((line) => line.length > 12 && !/^https?:/i.test(line))
    .slice(0, 8);
};

/** How the race looks, said in words, because the writer of the line never gets the numbers. */
const SHAPE: Record<leaderboard.Situation, string> = {
  "photo-finish": "We are a tiny number of votes behind the place above us. It is genuinely down to the wire.",
  "within-reach": "We are a little behind the place above us — close enough that the group could close it today.",
  "a-long-way": "We are well behind the place above us. Not hopeless, but no single push closes it.",
  "leading-safe": "We are in first place with a comfortable margin.",
  "leading-chased": "We are in first place but the project behind us is very close.",
};

/**
 * One line of encouragement, in this group's voice. `null` when it cannot be had.
 *
 * Deliberately cheap and deliberately fenced: no numbers reach it, nothing it returns is trusted
 * without `usableCheer`, and every failure is swallowed. It is the flourish on a message whose
 * substance is already assembled.
 */
const cheer = async (
  chat: string,
  standing: leaderboard.Standing,
  /** Lines already used in this group, so the next one is not the fourth copy of the third. */
  already: string[] = [],
  /** How to sound here, in a person's own words. Overrides the sampled register when they clash. */
  note: string | null = null,
): Promise<string | null> => {
  try {
    const examples = await voiceOf(chat);
    const result = await generateText({
      model: openai(config.model()),
      system: [
        "You write one short line of encouragement for a WhatsApp group, asking people to go and vote for the group's own project in a public contest.",
        "",
        "Rules, all of them absolute:",
        "- One line. No greeting, no sign-off, no preamble, no explanation.",
        "- **Never write a number, in digits or in words.** Not votes, not positions, not places. The message already carries every figure above your line, and repeating one is how it becomes wrong.",
        "- No links. One is added after your line.",
        "- Do not name any rival project. Your own is fine to name.",
      /*
       * It described the project as something it is not on the first try — "proyecto
       * anti-terremotos" for a thing about staying reachable with no internet. Same class of
       * failure as a wrong figure and caught the same way: this line is allowed to carry
       * enthusiasm and nothing that could be false.
       */
      "- Say nothing about what the project does or is for. You do not know, and a wrong description is worse than none. The line asks people to vote and that is all it does.",
        "- Answer in the language of the examples below. If there are none, use Spanish.",
        "- WhatsApp formatting only, and sparingly: *bold* at most. No markdown.",
        "- It has to sound like the examples: same register, same length, same appetite for slang and emoji. Not an announcer, not a brand.",
      ].join("\n"),
      prompt: [
        `Where the race stands: ${SHAPE[leaderboard.situation(standing)]}`,
        "",
        examples.length
          ? ["This is how you talk in this group. Match it:", "", ...examples.map((e) => `- ${e}`)].join("\n")
          : "You have never spoken in this group, so keep it plain, short and warm.",
        "",
        /*
         * Placed after the examples and stated as the stronger signal, because the two can
         * disagree: what the bot happens to have said in a room is evidence of the register,
         * while this is somebody saying what they actually want. A group whose sampled messages
         * read neutral gets a neutral line without it, which is right up until a person says
         * otherwise.
         */
        ...(note
          ? [
              `How this group wants you to sound, which matters more than the examples above: ${note}`,
              "",
            ]
          : []),
        /*
         * The variety lever, and it does the work a temperature setting would not: asked the same
         * question twice the model answers the same sentence twice — four near-identical lines out
         * of five, measured — and the reasoning tiers here do not reliably take a temperature. So
         * it is simply told what it has already said in this room.
         */
        ...(already.length
          ? [
              "You have already sent these lines in this group. Say something different — a different opening, a different angle, not a reshuffle of the same sentence:",
              "",
              ...already.map((line) => `- ${line}`),
              "",
            ]
          : []),
        "Write the line.",
      ].join("\n"),
    });

    // Recorded like any other spend; a failure here must not cost the message.
    void usage
      .record({ kind: "leaderboard", model: config.model(), chat, usage: result.usage })
      .catch(() => undefined);

    const line = leaderboard.usableCheer(result.text);
    if (!line) {
      console.warn(`[leaderboard] discarded an unusable cheer: ${JSON.stringify(result.text.slice(0, 120))}`);
    }
    return line;
  } catch (err) {
    console.warn("[leaderboard] could not write a cheer:", err instanceof Error ? err.message : err);
    return null;
  }
};

/** The board as a picture, uploaded and ready to send. `null` if anything went wrong. */
const snapshot = async (): Promise<string | null> => {
  const cfg = config.leaderboard();
  if (!cfg) return null;
  try {
    /*
     * The fold rather than the whole page, and cut off after the podium when the deployment says
     * where that is: ten rows of a league table on a phone is a wall, and the three that decide
     * anything are at the top. `cutAfter` is a selector from configuration because this code has
     * no business knowing how somebody else's board is marked up, and a selector that stops
     * matching costs the crop rather than the picture.
     */
    const shot = await capture(cfg.url, {
      ...(cfg.cutAfter ? { cutAfter: cfg.cutAfter } : {}),
    });
    return await wapi.upload({
      base64: shot.png.toString("base64"),
      mimetype: "image/png",
      fileName: "leaderboard.png",
    });
  } catch (err) {
    console.warn(
      "[leaderboard] could not attach a picture:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
};

const tick = async (): Promise<void> => {
  try {
    // Switched off, or not set up: nothing is read and nothing is claimed.
    if (!(await features.enabled()).has("leaderboard")) return;
    if (!leaderboard.configured()) return;

    const now = new Date();
    const watches = await leaderboard.list(now);
    if (watches.length === 0) return;

    // Sequential: two groups due on the same minute must not race each other's sends.
    for (const watch of watches) {
      try {
        /*
         * Everything cheap first, then the minute, then the claim. The board is only read once
         * a watch has got past all three — a group in its quiet hours costs no network at all.
         */
        if (leaderboard.holdReason(watch, now)) continue;
        if (!leaderboard.dueNow(watch, now)) continue;
        if (!(await leaderboard.claim(watch.chat, now))) continue;

        const outcome = await announce(watch, now);
        if (outcome === "sent") {
          console.log(`[leaderboard] told ${watch.chatName ?? watch.chat}`);
        }
      } catch (err) {
        /*
         * The group never hears about a failure. A board that would not load is not worth a
         * message, and a daily apology is how a useful notification becomes noise.
         */
        const why = err instanceof Error ? err.message : String(err);
        console.error(`[leaderboard] ${watch.chat} failed:`, why);
        await leaderboard.markFailed(watch.chat, why).catch(() => undefined);
      }
    }
  } catch (err) {
    console.error("[leaderboard] tick failed:", err instanceof Error ? err.message : err);
  }
};

export const startLeaderboard = (): void => {
  if (g.wspbotLeaderboard) return;
  console.log(`[leaderboard] checking every ${TICK_MS / 1000}s`);
  const timer = setInterval(() => void tick(), TICK_MS);
  timer.unref?.();
  g.wspbotLeaderboard = timer;
};
