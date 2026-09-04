import "server-only";
import { wapi } from "./wapi";
import { reply } from "./agent";
import * as chime from "./chime";
import * as features from "./features";

/**
 * Firing chime-ins.
 *
 * Separate from `lib/chime.ts` for the reason every runner here is separate from its data layer:
 * the dashboard imports the data, and it has no business dragging the model and the WhatsApp
 * client along with it.
 *
 * **It goes through `reply()`, the ordinary turn.** That is the design, not a shortcut. A chime
 * written by a second, smaller prompt would be a different bot living in the same group — no
 * memory of what it was told, no stickers, no idea what it is. Going through the normal turn
 * means the thing that speaks unprompted is the same thing people talk to: it remembers, it can
 * send a sticker or a voice note if that is the natural move, and the conversation it joins is
 * the one it is already part of.
 *
 * What is different is the invitation. The turn is handed a stage direction rather than a
 * message from a person, and the prompt is told plainly that nobody asked it anything — so
 * saying nothing at all is a correct outcome, and the most common one.
 */

/** Every minute. Cadence is per chat and measured in minutes, so finer would only cost queries. */
const TICK_MS = 60 * 1000;

/** A person sends two or three short lines, not an essay. Past this it is a monologue. */
const MAX_MESSAGES = 3;

/** Long enough to read as typing rather than as a paste. */
const BETWEEN_MS = 1_200;

const g = globalThis as unknown as { wspbotChime?: NodeJS.Timeout };

/**
 * The stage direction.
 *
 * Written as a note to the bot rather than as a message from anyone, because that is what it is.
 * The instruction that matters most is the permission to stay silent: without it a model given a
 * transcript will always find something to say, and a bot that always has something to say is
 * the thing nobody wants in their group.
 */
const invitation = (transcript: string, note: string | null): string =>
  [
    "[Nobody has tagged you. You have been reading along in this group, and enough has been said that a person might have chimed in by now.]",
    "",
    "Here is what has been said since you last spoke:",
    "",
    transcript,
    "",
    ...(note ? [`About this group: ${note}`, ""] : []),
    "Say something, or say nothing. Both are normal.",
    "",
    "Reply with the message you would send, exactly as you would send it — no preamble, no explanation of why you are speaking. If you would send two or three short messages instead of one, separate them with a blank line. If there is genuinely nothing worth adding, reply with nothing at all.",
  ].join("\n");

/**
 * Split what came back into the messages to send.
 *
 * A blank line is the separator because that is how the model was asked for it, and because a
 * single newline is what a normal multi-line message uses. Capped: a model that ignores the
 * instruction must not turn one chime into eight notifications.
 */
export const split = (text: string): string[] =>
  text
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, MAX_MESSAGES);

/** One chat, one chime. Returns what was said, or null if it decided to stay quiet. */
const run = async (settings: chime.Settings, now: Date): Promise<string | null> => {
  const window = await chime.windowFor(settings, now);
  const transcript = chime.render(window);

  const result = await reply({
    chat: settings.chat,
    isGroup: true,
    // There is no speaker. `unprompted` is what stops the turn reading this as somebody talking.
    senderName: "",
    text: invitation(transcript, settings.note),
    unprompted: true,
  });

  const parts = split(result.text);

  /*
   * Nothing to say is a real outcome, and the watermark still moves: those messages have been
   * considered, and re-reading them in an hour would only make it likelier to force a comment on
   * a conversation it already decided to sit out.
   */
  if (parts.length === 0 && result.sent.length === 0) {
    await chime.markChimed(settings.chat, window.to);
    return null;
  }

  for (const [index, part] of parts.entries()) {
    await wapi.sendText(settings.chat, part);
    if (index < parts.length - 1) await new Promise((r) => setTimeout(r, BETWEEN_MS));
  }

  const said = parts.join("\n\n") || `(${result.sent.join(", ")})`;
  await chime.record(settings.chat, said, now);
  await chime.markChimed(settings.chat, window.to);
  return said;
};

const tick = async (): Promise<void> => {
  try {
    if (!(await features.enabled()).has("chime")) return;

    const now = new Date();
    const all = await chime.list();

    // Sequential: two groups due on the same minute must not race each other's sends.
    for (const settings of all) {
      try {
        /*
         * Everything cheap is checked before the claim, and the claim is what makes the cadence
         * safe against two ticks overlapping. `holdReason` covers the rest — quiet hours, the
         * daily cap, whether anything was even said — and is the same function the dashboard
         * shows, so what a person reads there is exactly what the runner decided.
         */
        if (await chime.holdReason(settings, now)) continue;
        if (!(await chime.claim(settings.chat, now))) continue;

        const said = await run(settings, now);
        console.log(
          said
            ? `[chime] said something in ${settings.chatName ?? settings.chat}`
            : `[chime] nothing worth saying in ${settings.chatName ?? settings.chat}`,
        );
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        console.error(`[chime] ${settings.chat} failed:`, why);
        await chime.markFailed(settings.chat, why);
      }
    }
  } catch (err) {
    console.error("[chime] tick failed:", err instanceof Error ? err.message : err);
  }
};

export const startChimes = (): void => {
  if (g.wspbotChime) return;
  console.log(`[chime] checking every ${TICK_MS / 1000}s`);
  const timer = setInterval(() => void tick(), TICK_MS);
  timer.unref?.();
  g.wspbotChime = timer;
};
