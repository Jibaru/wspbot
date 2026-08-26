import "server-only";
import {
  generateText,
  generateSpeech,
  stepCountIs,
  tool,
  type ModelMessage,
} from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";
import { config } from "./config";
import { query } from "./db";
import { wapi } from "./wapi";
import * as memory from "./memory";
import { about } from "./about";
import * as usage from "./usage";
import * as stickers from "./stickers";
import { toVoiceNote, VOICE_NOTE_MIMETYPE, VOICE_NOTE_FILENAME } from "./audio";
import type { Media } from "./mentions";

/**
 * The brain: one model turn per tagged message, with web search, memory, and the ability to
 * put things other than text into the chat.
 *
 * Memory is handled two ways on purpose. The chat's facts are rendered into the system prompt
 * so recall costs nothing and never depends on the model deciding to look — and `remember` /
 * `forget` are tools so the model can write. Reading via prompt, writing via tools.
 *
 * The sending tools deliver into the chat as they run, rather than returning something for the
 * caller to send afterwards. That is what lets the model send a poll and then say nothing, or
 * send three images in one turn — neither of which fits a single-reply return value.
 */

/**
 * Steps, not tokens: one step is a model call, so this bounds a search-then-send-then-answer
 * chain rather than the answer's length.
 */
const MAX_STEPS = 10;

/** Turns of conversation replayed per chat. Enough for follow-ups without a runaway prompt. */
const HISTORY_TURNS = 20;

/** OpenAI's current small TTS model; overridable for the same reason as the chat model. */
const SPEECH_MODEL = "gpt-4o-mini-tts";

/**
 * Lossless out of the TTS model: it is re-encoded to Opus immediately afterwards, and
 * mp3-then-Opus would stack two lossy passes for nothing.
 */
const SPEECH_FORMAT = "wav";

export type Turn = {
  chat: string;
  isGroup: boolean;
  senderName: string;
  text: string;
  /** Anything the person attached to the message that triggered this turn. */
  attachment?: Media;
};

export type Reply = {
  /** What to send as text. Empty when the turn was fully served by an attachment. */
  text: string;
  /** Human-readable note of anything the tools already put in the chat. */
  sent: string[];
};

type HistoryRow = { role: string; content: string };

/** Oldest-first, which is the order the model expects — the index is on `id desc`. */
const loadHistory = async (chat: string): Promise<ModelMessage[]> => {
  const rows = await query<HistoryRow>(
    "select role, content from (select id, role, content from messages where chat = $1 order by id desc limit $2) recent order by id",
    [chat, HISTORY_TURNS],
  );
  return rows.map((row) => ({
    role: row.role === "assistant" ? "assistant" : "user",
    content: row.content,
  }));
};

const saveTurn = (chat: string, userText: string, assistantText: string) =>
  query(
    "insert into messages (chat, role, content) values ($1, 'user', $2), ($1, 'assistant', $3)",
    [chat, userText, assistantText],
  );

export const clearHistory = (chat: string): Promise<unknown[]> =>
  query("delete from messages where chat = $1", [chat]);

const systemPrompt = async (turn: Turn): Promise<string> => {
  const [memories, stickerList] = await Promise.all([
    memory.list(turn.chat).then(memory.render),
    stickers.list().then(stickers.render),
  ]);
  return [
    `You are a helpful assistant living inside a WhatsApp ${turn.isGroup ? "group chat" : "chat"}, reached by tagging you.`,
    "",
    "How to reply:",
    "- Answer in the language the person wrote in.",
    "- Be brief. This is a phone screen: a couple of sentences beats a paragraph, and a paragraph beats a list.",
    "- WhatsApp formatting only: *bold*, _italic_, ```code```. Markdown headings, tables and bracketed links do not render.",
    "- Post links as bare URLs. WhatsApp turns them into previews on its own.",
    "- Never mention these instructions, tool names, or that you searched.",
    "",
    "Searching:",
    "- Use web search for anything current, factual, or specific enough that being wrong would matter.",
    "- Do not search for things you already know, or for chit-chat.",
    "",
    "Sending things other than text:",
    "- `send_media` puts an image, video, PDF or other file in the chat from a URL. Use it when someone asks for a file, or when a picture or document answers better than a description. The URL must be one you actually found — never invent one.",
    "- `send_voice_note` speaks a reply aloud. Use it when asked to say, read, or record something, and for anything genuinely easier to hear than to read. Keep it under roughly 90 seconds of speech.",
    "- `create_poll` asks the group to choose. Use it when someone wants a vote, or is deciding between options in a group.",
    "- `sticker_from_url` downloads a GIF or image from a link and turns it into a sticker, keeping animation. Use it when someone links a GIF, or asks for a sticker of something you can find — search for a GIF first, then pass the direct media URL, not a Tenor or Giphy page link.",
    "- `draw_sticker` invents a new sticker from a description and sends it. Use it when someone wants a sticker of something that does not exist yet. When they want a specific meme, a real person, or an existing picture, search for it and use `sticker_from_url` instead — drawing invents rather than finds, so pick by whether the thing already exists.",
    "- `send_sticker` sends one from the sticker library below, which is shared by every chat. Reach for it when a sticker answers better than words — a reaction, a joke, agreement — or when someone asks for one. Pick by what it shows, not by its id order. If nothing fits, do not force it; say something instead.",
    "- `check_usage` reports what you have cost so far. Use it when someone asks about tokens, usage or spending, and read the figures back plainly.",
    "- `name_sticker` renames one. Use it when someone says what a sticker should be called, so it can be asked for by that name later.",
    "- After a tool has put something in the chat, add at most one short line of text — or none at all. Do not describe what you just sent; everyone can see it.",
    "",
    "Remembering:",
    "- When someone asks you to record, remember or note something, call `remember` and confirm in one short line.",
    "- Also remember durable facts about this chat that were clearly meant to stick (decisions, deadlines, preferences). Do not remember passing chatter.",
    "- When someone asks you to forget or drop something, call `forget` with the matching id.",
    "- The facts below are already in front of you. Answer from them directly — do not announce that you are checking your memory.",
    "- Facts marked (everywhere) are known in every chat, and survive restarts and redeploys. Save one that way — scope 'everywhere' — only when it holds no matter who is talking: a standing instruction about how you should behave, or something about you rather than about this room. Anything about the people here stays in this chat.",
    "",
    ...(turn.attachment && turn.attachment.kind !== "sticker"
      ? [
          `They attached ${turn.attachment.animated ? "an animated GIF or video" : "an image"}. \`make_sticker\` turns it into a sticker — animation is kept, and it joins the shared library. If they tagged you with it and did not ask for something else, a sticker is almost certainly what they want; just make it.`,
          "",
        ]
      : []),
    about(),
    "",
    `Today is ${new Date().toISOString().slice(0, 10)}.`,
    "",
    "Remembered:",
    memories,
    "",
    "Sticker library (shared by every chat):",
    stickerList,
  ].join("\n");
};

/** Guards against the model passing a data: URI, a relative path, or something invented. */
const httpUrl = z
  .string()
  .url()
  .refine((u) => /^https?:\/\//i.test(u), "must be an http(s) URL");

/**
 * Built per turn: the tools are bound to the chat that is speaking, so a group cannot delete
 * another group's memories or send into a room it is not in.
 *
 * `sent` collects what reached the chat, so the caller knows not to follow an attachment with
 * a redundant "here you go".
 */
const toolsFor = (turn: Turn, sent: string[]) => ({
  // Provider-executed: OpenAI runs the search itself, so there is nothing to implement here.
  web_search: openai.tools.webSearch({ searchContextSize: "medium" }),

  send_media: tool({
    description:
      "Send a file into this chat from a URL: an image, a video, a PDF or any other document. The URL must already exist and be publicly reachable — one you found by searching, or one the person gave you. Never guess a URL.",
    inputSchema: z.object({
      kind: z
        .enum(["image", "video", "document", "audio"])
        .describe(
          "How it should appear. Use 'document' for PDFs and any other file type.",
        ),
      url: httpUrl.describe("Direct link to the file itself, not to a page about it."),
      caption: z
        .string()
        .optional()
        .describe("A short line shown with it. Ignored for audio."),
      fileName: z
        .string()
        .optional()
        .describe(
          "Required for documents — the name the recipient sees, e.g. 'report.pdf'.",
        ),
    }),
    execute: async ({ kind, url, caption, fileName }) => {
      if (kind === "document" && !fileName) {
        // Server-side it is optional, but the file then arrives named after its URL.
        return "A document needs a fileName. Call again with one, e.g. 'guide.pdf'.";
      }
      try {
        const input =
          kind === "image"
            ? { to: turn.chat, imageUrl: url, ...(caption ? { text: caption } : {}) }
            : kind === "video"
              ? { to: turn.chat, videoUrl: url, ...(caption ? { text: caption } : {}) }
              : kind === "audio"
                ? { to: turn.chat, audioUrl: url }
                : {
                    to: turn.chat,
                    documentUrl: url,
                    fileName: fileName!,
                    ...(caption ? { text: caption } : {}),
                  };
        await wapi.send(input);
        sent.push(`${kind}${fileName ? ` (${fileName})` : ""}`);
        return `Sent the ${kind}.`;
      } catch (err) {
        // Handed back rather than thrown: the model can tell the person, or try another URL.
        const why = err instanceof Error ? err.message : String(err);
        console.error("[send_media] failed", why);
        return `Could not send it: ${why}`;
      }
    },
  }),

  send_voice_note: tool({
    description:
      "Speak a reply aloud and send it as audio. Use for anything easier to hear than to read, or when asked to say or read something out. Write the text exactly as it should be spoken.",
    inputSchema: z.object({
      text: z
        .string()
        .max(4000)
        .describe("Exactly what to say, in the language it should be spoken in."),
      voice: z
        .enum(["alloy", "echo", "fable", "onyx", "nova", "shimmer"])
        .optional()
        .describe("Which voice to use. Defaults to a neutral one."),
      instructions: z
        .string()
        .optional()
        .describe("How to deliver it, e.g. 'warm and unhurried'."),
    }),
    execute: async ({ text, voice, instructions }) => {
      try {
        const speech = await generateSpeech({
          model: openai.speech(SPEECH_MODEL),
          text,
          voice: voice ?? "alloy",
          outputFormat: SPEECH_FORMAT,
          ...(instructions ? { instructions } : {}),
        });

        /**
         * Re-encoded to Ogg/Opus, which is what a WhatsApp voice note actually is. mp3 looks
         * fine in WhatsApp Web — a browser will decode anything the OS can — while the mobile
         * app refuses to play it. So this is a correctness step, not an optimisation.
         */
        await usage.record({
          kind: "speech",
          model: SPEECH_MODEL,
          chat: turn.chat,
          characters: text.length,
        });

        const opus = await toVoiceNote(Buffer.from(speech.audio.uint8Array));

        // wapi fetches media by URL at send time, so the bytes need a home first.
        const url = await wapi.upload({
          base64: opus.toString("base64"),
          mimetype: VOICE_NOTE_MIMETYPE,
          fileName: VOICE_NOTE_FILENAME,
        });

        await wapi.send({ to: turn.chat, audioUrl: url });
        sent.push("voice note");
        return "Sent the voice note.";
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        console.error("[send_voice_note] failed", why);
        return `Could not send the voice note: ${why}`;
      }
    },
  }),

  create_poll: tool({
    description:
      "Put a poll in the chat so people can vote. Use when someone asks for a vote, or when a group is choosing between options.",
    inputSchema: z.object({
      question: z.string().describe("The question, phrased for a phone screen."),
      options: z
        .array(z.string())
        .min(2)
        .max(12)
        .describe("Between 2 and 12 answers, each a few words."),
      multiSelect: z
        .boolean()
        .optional()
        .describe("Allow picking more than one. Defaults to single choice."),
    }),
    execute: async ({ question, options, multiSelect }) => {
      // WhatsApp silently drops duplicates, which turns a 3-option poll into 2.
      const unique = [...new Set(options.map((o) => o.trim()).filter(Boolean))];
      if (unique.length < 2) return "A poll needs at least two distinct options.";
      try {
        await wapi.send({
          to: turn.chat,
          poll: { question, options: unique, multiSelect: multiSelect ?? false },
        });
        sent.push(`poll (${unique.length} options)`);
        return "Poll posted.";
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        console.error("[create_poll] failed", why);
        return `Could not post the poll: ${why}`;
      }
    },
  }),

  send_sticker: tool({
    description:
      "Send one of this chat's saved stickers, by the id shown in the sticker list. Only ids from that list exist — never invent one.",
    inputSchema: z.object({
      id: z.string().describe("The sticker id, e.g. s7."),
    }),
    execute: async ({ id }) => {
      const sticker = await stickers.byId(id);
      if (!sticker) return `There is no sticker ${id}. Pick one from the list.`;
      try {
        // Repairs the row if the upload URL died with an old session — i.e. a changed number.
        const url = await stickers.liveUrl(sticker);
        stickers.ensureStored(sticker);
        await wapi.send({ to: turn.chat, stickerUrl: url });
        sent.push(`sticker (${sticker.label})`);
        return `Sent the "${sticker.label}" sticker.`;
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        console.error("[send_sticker] failed", why);
        return `Could not send it: ${why}`;
      }
    },
  }),

  draw_sticker: tool({
    description:
      "Draw a brand-new sticker from a description, send it, and add it to the shared library. Use this when someone asks for a sticker of something that does not already exist — an idea, a character, a joke. For a specific meme, a real person, or an existing image, prefer searching and `sticker_from_url` instead: drawing invents, it does not find.",
    inputSchema: z.object({
      prompt: z
        .string()
        .min(3)
        .describe(
          "What to draw, as a plain visual description — the subject and its expression or action. Do not ask for a transparent background or a sticker style; that is applied for you.",
        ),
      label: z
        .string()
        .optional()
        .describe("A two-to-four word name for it, if the person asked for a specific one."),
    }),
    execute: async ({ prompt, label }) => {
      try {
        const made = await stickers.createFromPrompt(
          turn.chat,
          turn.senderName,
          prompt,
          label,
        );
        await wapi.send({ to: turn.chat, stickerUrl: made.url });
        sent.push(`sticker (${made.label})`);
        return `Drew and sent "${made.label}", saved as ${made.id}.`;
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        console.error("[draw_sticker] failed", why);
        return `Could not draw it: ${why}`;
      }
    },
  }),

  check_usage: tool({
    description:
      "Report how much you have cost: tokens used today, over the last week, and in total, with an estimated spend. Use it when someone asks about usage, tokens, cost or spending.",
    inputSchema: z.object({}),
    execute: async () => usage.report(),
  }),

  name_sticker: tool({
    description:
      "Rename a sticker in the library so people can ask for it by that name later. Use it when someone says what a sticker should be called.",
    inputSchema: z.object({
      id: z.string().describe("The sticker id, e.g. s7."),
      name: z.string().describe("The new name — a few words, as someone would say it."),
    }),
    execute: async ({ id, name }) => {
      const renamed = await stickers.rename(id, name);
      if (!renamed) return `There is no sticker ${id}.`;
      console.log(`[stickers] renamed ${renamed.id} to "${renamed.label}"`);
      return `Renamed ${renamed.id} to "${renamed.label}".`;
    },
  }),

  ...(turn.attachment && turn.attachment.kind !== "sticker"
    ? {
        make_sticker: tool({
          description:
            "Turn the image, GIF or video attached to this message into a WhatsApp sticker, send it, and add it to the shared library. Animated sources stay animated. Only call this when something is actually attached.",
          inputSchema: z.object({
            label: z
              .string()
              .optional()
              .describe(
                "A two-to-four word name, only if the person asked for a specific one. Leave empty and it will be named automatically.",
              ),
          }),
          execute: async ({ label }) => {
            try {
              const made = await stickers.createFrom(
                turn.chat,
                turn.senderName,
                turn.attachment!,
                label,
              );
              await wapi.send({ to: turn.chat, stickerUrl: made.url });
              sent.push(`sticker (${made.label})`);
              return `Made and sent "${made.label}", saved as ${made.id}.`;
            } catch (err) {
              const why = err instanceof Error ? err.message : String(err);
              console.error("[make_sticker] failed", why);
              return `Could not make the sticker: ${why}`;
            }
          },
        }),
      }
    : {}),

  sticker_from_url: tool({
    description:
      "Download an image or GIF from a URL and turn it into a sticker for this chat, then send it. Animated GIFs stay animated. Use it when someone links a GIF, or when they ask for a sticker of something and you found a suitable GIF or image by searching. The URL must point at the file itself, not at a page showing it.",
    inputSchema: z.object({
      url: httpUrl.describe(
        "Direct link to the .gif, .webp, .png, .jpg or .mp4 file. A tenor.com/view/... or giphy.com/gifs/... page URL will not work — use the media link.",
      ),
      label: z
        .string()
        .optional()
        .describe("A two-to-four word name, only if the person asked for a specific one."),
    }),
    execute: async ({ url, label }) => {
      try {
        const made = await stickers.createFromUrl(turn.chat, turn.senderName, url, label);
        await wapi.send({ to: turn.chat, stickerUrl: made.url });
        sent.push(`sticker (${made.label})`);
        return `Made and sent "${made.label}", saved as ${made.id}.`;
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        console.error("[sticker_from_url] failed", why);
        // Returned, not thrown: the model can explain, or try a different link.
        return `Could not make a sticker from that link: ${why}`;
      }
    },
  }),

  remember: tool({
    description:
      "Store one fact so it can be recalled in later conversations, including after a restart. One fact per call. Write it as a self-contained sentence — it will be read back with no surrounding context.",
    inputSchema: z.object({
      text: z
        .string()
        .describe("The fact to remember, phrased so it still makes sense weeks later."),
      scope: z
        .enum(["this chat", "everywhere"])
        .optional()
        .describe(
          "'this chat' (the default) keeps it to this conversation. 'everywhere' makes it known in every chat — use it only for things that are true regardless of who is talking, such as who built you or a standing instruction about how to behave.",
        ),
    }),
    execute: async ({ text, scope }) => {
      const everywhere = scope === "everywhere";
      const saved = await memory.add(
        everywhere ? memory.GLOBAL : turn.chat,
        text,
        turn.senderName,
      );
      console.log(
        `remembered [${saved.id}]${everywhere ? " (everywhere)" : ""} ${saved.text}`,
      );
      return `Saved as ${saved.id}${everywhere ? ", known in every chat" : ""}.`;
    },
  }),

  forget: tool({
    description:
      "Delete one remembered fact by its id. Ids are shown in square brackets in the remembered list.",
    inputSchema: z.object({
      id: z.string().describe("The memory id, e.g. m3."),
    }),
    execute: async ({ id }) => {
      const removed = await memory.remove(id, turn.chat);
      if (!removed) return `No memory ${id} in this chat.`;
      console.log(`forgot [${removed.id}] ${removed.text}`);
      return `Deleted ${removed.id}: "${removed.text}".`;
    },
  }),
});

export const reply = async (turn: Turn): Promise<Reply> => {
  // In a group, who is speaking changes the answer, so it has to be in the message itself.
  const content = turn.isGroup ? `${turn.senderName}: ${turn.text}` : turn.text;
  const history = await loadHistory(turn.chat);
  const sent: string[] = [];

  const result = await generateText({
    model: openai(config.model()),
    system: await systemPrompt(turn),
    messages: [...history, { role: "user", content }],
    tools: toolsFor(turn, sent),
    // Without this the run stops after the first tool call and never says anything.
    stopWhen: stepCountIs(MAX_STEPS),
    providerOptions: {
      openai: {
        reasoningEffort: config.effort(),
        // A WhatsApp reply that needs scrolling has already failed.
        textVerbosity: "low",
      },
    },
  });

  await usage.record({
    kind: "reply",
    model: config.model(),
    chat: turn.chat,
    usage: result.usage,
  });

  const text = result.text.trim();

  /**
   * Only fall back to an apology when the turn produced nothing at all. A poll with no
   * accompanying sentence is a complete answer, and "Sorry, I got tangled up" after it would
   * be both wrong and confusing.
   */
  const answer =
    text || (sent.length > 0 ? "" : "Sorry, I got tangled up. Try asking me again?");

  // History records what happened, not just what was said, so "send that again" has a referent.
  await saveTurn(
    turn.chat,
    content,
    [answer, sent.length ? `(sent: ${sent.join(", ")})` : ""]
      .filter(Boolean)
      .join(" ") || "(no reply)",
  );

  return { text: answer, sent };
};
