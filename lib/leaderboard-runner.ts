import "server-only";
import { config } from "./config";
import { wapi } from "./wapi";
import { capture } from "./render-html";
import * as features from "./features";
import * as leaderboard from "./leaderboard";

/**
 * Telling a group when the vote leaderboard moves.
 *
 * Separate from `lib/leaderboard.ts` for the reason every runner here is separate from its data
 * layer: the dashboard imports the data, and it has no business dragging the WhatsApp client
 * along behind it.
 *
 * **This one does not go through the model, and that is the design.** `chime-runner` calls
 * `reply()` because what it says is a judgement; this sentence is a subtraction. A model in this
 * path could only add latency, cost, and the one failure that would matter — a number that is
 * almost right. So the text is built in `leaderboard.announcement` and sent as it is.
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

  const text = [moved.headline, leaderboard.announcement(standing, reading)]
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

  await leaderboard.markAnnounced(watch.chat, standing, at);
  return "sent";
};

/** The board as a picture, uploaded and ready to send. `null` if anything went wrong. */
const snapshot = async (): Promise<string | null> => {
  const url = leaderboard.siteUrl();
  if (!url) return null;
  try {
    // The fold, not the whole page: the standing and the top of the table is what people read.
    const shot = await capture(url, false);
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
