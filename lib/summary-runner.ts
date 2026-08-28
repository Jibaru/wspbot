import "server-only";
import { generateObject } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";
import { config } from "./config";
import { wapi } from "./wapi";
import * as summaries from "./summaries";
import * as features from "./features";
import * as usage from "./usage";

/**
 * Firing scheduled summaries.
 *
 * Separate from `lib/summaries.ts` for the same reason the reminder runner is separate from
 * `lib/reminders.ts`: the dashboard imports the data layer, and it should not drag the model
 * and the WhatsApp client in behind it.
 *
 * A digest goes out even when almost nothing was said — silence is information in a group people
 * are watching, and a schedule that quietly produces nothing is indistinguishable from one that
 * is broken.
 */

/** Every minute, because a cron pattern's finest resolution is a minute. */
const TICK_MS = 60 * 1000;

/** How many pictures a digest may carry. Past a handful it stops being a digest. */
const MAX_IMAGES = 4;

const g = globalThis as unknown as { wspbotSummaries?: NodeJS.Timeout };

const SummarySchema = z.object({
  summary: z
    .string()
    .describe(
      "The digest itself, ready to post into WhatsApp. Use *bold* for section headings and hyphens for bullets — WhatsApp renders no markdown beyond *bold*, _italic_ and ```code```. No headings with #, no tables, no [text](link) links.",
    ),
  images: z
    .array(z.number())
    .max(MAX_IMAGES)
    .describe(
      "Ids of pictures from the transcript worth attaching, most useful first. Use the number after # on an [image #123: ...] line. Empty when none of them carry information on their own.",
    ),
});

/**
 * What makes a digest worth reading rather than a list of who spoke.
 *
 * Written as instructions about substance rather than length, because the failure mode of a
 * chat summary is not verbosity — it is a neutral paraphrase that omits the decision everyone
 * needs and keeps the small talk.
 */
const INSTRUCTIONS = [
  "You are writing a digest of a WhatsApp group for people who were not reading it.",
  "",
  "What matters, in order:",
  "- **Decisions and commitments.** Who agreed to do what, by when. These are the reason anyone reads a digest, and they must never be dropped.",
  "- **Questions still open.** Anything asked and not answered, named with who asked it.",
  "- **Anything shared.** Links, documents and pictures. Give every link in full — a digest that says 'someone shared an article' is useless. Group them if there are many.",
  "- **What was actually discussed**, in a few lines. Themes, not a transcript.",
  "",
  "How to write it:",
  "- Answer in the language the group is speaking. If they mix, follow the majority.",
  "- Attribute things to people by name. 'Ana will send the invoice' beats 'the invoice will be sent'.",
  "- Times are given in the transcript; use them when they matter (a deadline, a meeting) and leave them out otherwise.",
  "- Be concise but do not compress away specifics. Numbers, names, dates and links are the content.",
  "- Say plainly when a stretch was just chatter, rather than inflating it.",
  "- Never invent anything that is not in the transcript. If something is ambiguous, say so.",
  "- Do not open with a preamble about being a summary. Start with the substance.",
  "",
  "Pictures appear as `[image #123: description]`. The description is all you know about them — you cannot see the picture itself. Reference one in the text when it matters, and list its id under `images` if seeing it would tell the reader something the words do not (a screenshot, a chart, a document, a photo of a whiteboard). A picture that is just a joke or a selfie does not need attaching.",
].join("\n");

const header = (schedule: summaries.Schedule, window: summaries.Window): string => {
  const when = (d: Date) =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone: config.timezone(),
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    }).format(d);
  const where = schedule.sourceName ?? schedule.sourceChat;
  return `*${where}* · ${when(window.from)} → ${when(window.to)}`;
};

/**
 * Write the digest, without sending it.
 *
 * Exported so `npm run summary-check` can read one before it goes anywhere near a chat. The
 * quality of this text is the whole feature, and it is not something a typecheck has an opinion
 * about.
 */
export const compose = async (
  schedule: summaries.Schedule,
  window: summaries.Window,
): Promise<{ text: string; images: number[] }> => {
  const result = await generateObject({
    model: openai(config.summaryModel()),
    schema: SummarySchema,
    system: INSTRUCTIONS,
    prompt: [
      `Group: ${schedule.sourceName ?? schedule.sourceChat}`,
      `Covering: ${header(schedule, window)}`,
      `${window.messages.length} messages.`,
      "",
      "Transcript:",
      summaries.render(window).transcript,
    ].join("\n"),
  });

  await usage.record({
    kind: "summary",
    model: config.summaryModel(),
    chat: schedule.sourceChat,
    usage: result.usage,
  });

  return {
    text: result.object.summary.trim(),
    images: result.object.images.slice(0, MAX_IMAGES),
  };
};

/** One schedule, one firing. */
const run = async (schedule: summaries.Schedule): Promise<void> => {
  const until = new Date();
  const window = await summaries.windowFor(schedule, until);

  if (window.messages.length === 0) {
    await wapi.sendText(
      schedule.destinationChat,
      `${header(schedule, window)}\n\nNothing was said.`,
    );
    await summaries.markSummarised(schedule.id, until);
    return;
  }

  const { text, images } = await compose(schedule, window);

  await wapi.sendText(
    schedule.destinationChat,
    `${header(schedule, window)}\n\n${text}`,
  );

  /**
   * Pictures go after the text, so the digest reads first and the attachments illustrate it.
   * Failures here are logged and swallowed: a summary that arrived without its screenshots is
   * far better than one that threw halfway and gets sent again tomorrow.
   */
  const attachable = summaries.render(window).images;
  for (const id of images) {
    const url = attachable.get(id);
    if (!url) continue;
    await wapi
      .send({ to: schedule.destinationChat, imageUrl: url })
      .catch((err) =>
        console.warn(
          `[summaries] could not attach image ${id}:`,
          err instanceof Error ? err.message : err,
        ),
      );
  }

  await summaries.markSummarised(schedule.id, until);
};

const tick = async (): Promise<void> => {
  try {
    /*
     * Switched off means nothing is claimed. As with reminders, an overdue window is covered by
     * the next firing rather than being consumed and dropped — the watermark only moves on a
     * summary that actually went out.
     */
    if (!(await features.enabled()).has("summaries")) return;

    const due = await summaries.claimDue(new Date());
    // Sequential: several digests firing on the same minute should not race each other's sends.
    for (const schedule of due) {
      try {
        await run(schedule);
        console.log(`[summaries] sent digest for ${schedule.sourceChat}`);
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        console.error(`[summaries] ${schedule.sourceChat} failed:`, why);
        await summaries.markFailed(schedule.id, why);
      }
    }
  } catch (err) {
    console.error("[summaries] tick failed:", err instanceof Error ? err.message : err);
  }
};

/** Hourly is plenty for a fortnight's retention, and keeps it off the per-minute path. */
const PRUNE_EVERY_TICKS = 60;
let ticks = 0;

export const startSummaries = (): void => {
  if (g.wspbotSummaries) return;
  console.log(`[summaries] checking every ${TICK_MS / 1000}s`);
  const timer = setInterval(() => {
    void tick();
    if (++ticks % PRUNE_EVERY_TICKS === 0) void summaries.prune();
  }, TICK_MS);
  timer.unref?.();
  g.wspbotSummaries = timer;
};
