import "server-only";
import { reply } from "./agent";
import { wapi } from "./wapi";
import * as reminders from "./reminders";
import * as features from "./features";

/**
 * Firing scheduled reminders.
 *
 * Separate from `lib/reminders.ts` on purpose: the agent imports that module for its tools, and
 * this one imports the agent. Keeping the data layer free of that dependency is what stops the
 * two forming a cycle.
 *
 * A reminder is a *prompt*, run through the model with every tool available — so "remind me to
 * stretch" and "check the forecast and tell me if it will rain" go down the same path, and the
 * second one really does go and look.
 */

/** Half a minute: fine enough that "in five minutes" is not visibly late, cheap enough to ignore. */
const TICK_MS = 30 * 1000;

/** Per tick. A backlog drains over several ticks rather than stalling one for a minute. */
const BATCH = 5;

const g = globalThis as unknown as { wspbotReminders?: NodeJS.Timeout };

const run = async (reminder: reminders.Reminder): Promise<void> => {
  try {
    const answer = await reply({
      chat: reminder.chat,
      // A reminder in a group is addressed to the room, not whispered to one person.
      isGroup: reminder.chat.endsWith("@g.us"),
      senderName: reminder.askedBy ?? "someone",
      /**
       * Framed as what it is. Without this the model reads the stored words as a fresh request
       * and answers them literally — "remind me to stretch" comes back as a promise to remind
       * rather than as the reminder itself.
       */
      text: `[Scheduled reminder set earlier by ${reminder.askedBy ?? "someone"}. It is now due — carry it out and address them directly. Do not say you will do it later; this is the moment.]\n\n${reminder.prompt}`,
    });

    if (answer.text) {
      await wapi.sendText(reminder.chat, answer.text);
    }
    console.log(`[reminders] fired for ${reminder.askedBy} in ${reminder.chat}`);
  } catch (err) {
    // A failed run must not stop the schedule; the next one may well succeed.
    console.error(
      "[reminders] run failed:",
      err instanceof Error ? err.message : err,
    );
  } finally {
    // Retired here rather than at claim time, so a crash mid-run does not lose a repeat.
    await reminders.retireIfFinished(reminder).catch(() => {});
  }
};

const tick = async (): Promise<void> => {
  try {
    /*
     * Switched off means nothing is claimed, not that due rows are consumed and dropped. An
     * overdue reminder then fires when the feature comes back, which is the same behaviour as
     * the container having been down — and far better than silently eating what people asked for.
     */
    if (!(await features.enabled()).has("reminders")) return;

    const due = await reminders.claimDue(BATCH);
    // Sequential: a batch of reminders each doing web searches should not stampede the API.
    for (const reminder of due) await run(reminder);
  } catch (err) {
    console.error("[reminders] tick failed:", err instanceof Error ? err.message : err);
  }
};

/**
 * Started once from `instrumentation.ts`. A long-lived container, so an interval is a real
 * scheduler here — no cron, no external trigger.
 */
export const startReminders = (): void => {
  if (g.wspbotReminders) return;
  console.log(`[reminders] checking every ${TICK_MS / 1000}s`);
  const timer = setInterval(() => void tick(), TICK_MS);
  timer.unref?.();
  g.wspbotReminders = timer;
};
