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

/** mp3 over opus: every WhatsApp client plays it, and wapi re-encodes for voice notes anyway. */
const SPEECH_FORMAT = "mp3";

export type Turn = {
  chat: string;
  isGroup: boolean;
  senderName: string;
  text: string;
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
  const memories = memory.render(await memory.list(turn.chat));
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
    "- After a tool has put something in the chat, add at most one short line of text — or none at all. Do not describe what you just sent; everyone can see it.",
    "",
    "Remembering:",
    "- When someone asks you to record, remember or note something, call `remember` and confirm in one short line.",
    "- Also remember durable facts about this chat that were clearly meant to stick (decisions, deadlines, preferences). Do not remember passing chatter.",
    "- When someone asks you to forget or drop something, call `forget` with the matching id.",
    "- The facts below are already in front of you. Answer from them directly — do not announce that you are checking your memory.",
    "",
    `Today is ${new Date().toISOString().slice(0, 10)}.`,
    "",
    "Remembered for this chat:",
    memories,
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

        // wapi fetches media by URL at send time, so the bytes need a home first.
        const url = await wapi.upload({
          base64: speech.audio.base64,
          mimetype: speech.audio.mediaType,
          fileName: "voice.mp3",
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

  remember: tool({
    description:
      "Store one fact for this chat so it can be recalled in later conversations. One fact per call. Write it as a self-contained sentence — it will be read back with no surrounding context.",
    inputSchema: z.object({
      text: z
        .string()
        .describe("The fact to remember, phrased so it still makes sense weeks later."),
    }),
    execute: async ({ text }) => {
      const saved = await memory.add(turn.chat, text, turn.senderName);
      console.log(`remembered [${saved.id}] ${saved.text}`);
      return `Saved as ${saved.id}.`;
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
