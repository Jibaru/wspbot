import "server-only";
import {
  generateText,
  generateSpeech,
  stepCountIs,
  tool,
  type ModelMessage,
  type UserContent,
  type TextPart,
  type ImagePart,
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
import * as notion from "./notion";
import { toVoiceNote, VOICE_NOTE_MIMETYPE, VOICE_NOTE_FILENAME } from "./audio";
import { fetchDecrypted } from "./inbound-media";
import type { Media, Quoted } from "./mentions";

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
  /**
   * The message being replied to, when this was a reply. Tagging the bot in a reply is how
   * someone points at something, and the words alone rarely carry it: "@bot what does this
   * mean?" means nothing without the thing.
   */
  quoted?: Quoted;
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
  const [memories, stickerList, notionConnection] = await Promise.all([
    memory.list(turn.chat).then(memory.render),
    stickers.list().then(stickers.render),
    config.notion() ? notion.connectionFor(turn.chat) : Promise.resolve(null),
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
    ...(config.notion()
      ? [
          "Notion:",
          notionConnection
            ? `- This chat is connected to Notion${notionConnection.workspaceName ? ` (${notionConnection.workspaceName})` : ""}. You can only see pages that were explicitly shared with you, so if something is missing, say that rather than assuming it does not exist.`
            : "- This chat is not connected to Notion. If someone asks you to connect it, or wants you to read or write something there, use `connect_notion` and send them the link.",
          "- Always find a page with `notion_search` before reading or writing. Page ids come from there and nowhere else — never invent one.",
          "- Writing to someone's notes is not reversible from here. When a request is vague about where something should go, ask which page first.",
          "",
        ]
      : []),
    "Remembering:",
    "- When someone asks you to record, remember or note something, call `remember` and confirm in one short line.",
    "- Also remember durable facts about this chat that were clearly meant to stick (decisions, deadlines, preferences). Do not remember passing chatter.",
    "- When someone asks you to forget or drop something, call `forget` with the matching id.",
    "- The facts below are already in front of you. Answer from them directly — do not announce that you are checking your memory.",
    "- Facts marked (everywhere) are known in every chat, and survive restarts and redeploys. Save one that way — scope 'everywhere' — only when it holds no matter who is talking: a standing instruction about how you should behave, or something about you rather than about this room. Anything about the people here stays in this chat.",
    "",
    ...(turn.quoted
      ? [
          "They are replying to an earlier message, and it is included above their own. That is what they are pointing at — read their words as being about it. If they attached a picture to the reply, that message is quoted for you too, and any image in it is shown to you directly.",
          "",
        ]
      : []),
    ...(stickerSource(turn)
      ? [
          `There is ${stickerSource(turn)!.animated ? "an animated GIF or video" : "an image"} here — ${turn.attachment ? "attached to their message" : "in the message they are replying to"}. \`make_sticker\` turns it into a sticker, keeping any animation, and adds it to the shared library. If they tagged you with it and did not ask for something else, a sticker is almost certainly what they want; just make it.`,
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

/**
 * What a sticker could be made from this turn: the message's own attachment, or failing that
 * the message it replies to. Something already a sticker is skipped — it is collected
 * automatically, and re-encoding it would only make a worse copy.
 */
const stickerSource = (turn: Turn): Media | undefined => {
  const own = turn.attachment;
  if (own && own.kind !== "sticker") return own;
  const quoted = turn.quoted?.media;
  if (quoted && quoted.kind !== "sticker") return quoted;
  return undefined;
};

/**
 * Returned rather than thrown, so the model tells the person what to do instead of the turn
 * dying. Being unconnected is by far the commonest reason a Notion tool cannot proceed.
 */
const NOT_CONNECTED =
  "This chat is not connected to Notion yet. Offer to connect it with `connect_notion`.";

/** Notion's own message is usually the useful part — "page not found", "unauthorized". */
const notionFailure = (err: unknown): string => {
  const why = err instanceof Error ? err.message : String(err);
  console.error("[notion] tool failed:", why);
  return `Notion said: ${why}`;
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

  /**
   * Offered only when this deployment has Notion credentials. A tool that cannot work is worse
   * than one that is absent: the model would promise things and then fail.
   */
  ...(config.notion()
    ? {
        connect_notion: tool({
          description:
            "Give this chat a link to connect a Notion workspace. Use it when someone asks to connect, link or set up Notion. They choose on Notion's own screen which pages to share.",
          inputSchema: z.object({}),
          execute: async () => {
            const existing = await notion.connectionFor(turn.chat);
            const link = notion.authorizeUrl(turn.chat);
            return [
              existing
                ? `This chat is already connected${existing.workspaceName ? ` to ${existing.workspaceName}` : ""}. Opening this link again replaces that connection.`
                : "Send them this link.",
              link,
              "It lasts 15 minutes. Tell them to pick the pages they want you to reach — you get access to those and nothing else.",
            ].join("\n");
          },
        }),

        disconnect_notion: tool({
          description:
            "Forget this chat's Notion connection. Use it when someone asks to disconnect, unlink or revoke Notion.",
          inputSchema: z.object({}),
          execute: async () => {
            const had = await notion.disconnect(turn.chat);
            return had
              ? "Disconnected. Tell them to also remove the connection in Notion's settings if they want the access itself revoked."
              : "This chat was not connected to Notion.";
          },
        }),

        notion_search: tool({
          description:
            "Find pages in the connected Notion workspace by title. Start here — every other Notion tool needs a page id, and this is where ids come from. An empty query lists what is reachable.",
          inputSchema: z.object({
            query: z.string().describe("Words from the page title. Empty lists everything shared."),
          }),
          execute: async ({ query: q }) => {
            const connection = await notion.connectionFor(turn.chat);
            if (!connection) return NOT_CONNECTED;
            try {
              const pages = await notion.search(connection, q);
              if (pages.length === 0) {
                return "Nothing matched. Only pages explicitly shared with the integration are visible.";
              }
              return pages.map((p) => `- ${p.title} (id: ${p.id})`).join("\n");
            } catch (err) {
              return notionFailure(err);
            }
          },
        }),

        notion_read: tool({
          description:
            "Read the contents of a Notion page. Get the id from `notion_search` first — never guess one.",
          inputSchema: z.object({
            pageId: z.string().describe("The page id from notion_search."),
          }),
          execute: async ({ pageId }) => {
            const connection = await notion.connectionFor(turn.chat);
            if (!connection) return NOT_CONNECTED;
            try {
              return await notion.readPage(connection, pageId);
            } catch (err) {
              return notionFailure(err);
            }
          },
        }),

        notion_add: tool({
          description:
            "Append text to the end of a Notion page. Use it to add a note, a decision or an item someone asked you to record there. Blank lines separate paragraphs.",
          inputSchema: z.object({
            pageId: z.string().describe("The page id from notion_search."),
            text: z.string().min(1).describe("What to write, as it should appear."),
          }),
          execute: async ({ pageId, text }) => {
            const connection = await notion.connectionFor(turn.chat);
            if (!connection) return NOT_CONNECTED;
            try {
              await notion.appendToPage(connection, pageId, text);
              return "Added to the page.";
            } catch (err) {
              return notionFailure(err);
            }
          },
        }),

        notion_create: tool({
          description:
            "Create a new page inside an existing Notion page. Use it when someone wants a new document rather than a note added to an existing one.",
          inputSchema: z.object({
            parentPageId: z
              .string()
              .describe("The page it should live inside, from notion_search."),
            title: z.string().min(1).describe("The new page's title."),
            body: z.string().optional().describe("Optional opening text."),
          }),
          execute: async ({ parentPageId, title, body }) => {
            const connection = await notion.connectionFor(turn.chat);
            if (!connection) return NOT_CONNECTED;
            try {
              const page = await notion.createPage(connection, parentPageId, title, body);
              return `Created "${page.title}".${page.url ? ` ${page.url}` : ""}`;
            } catch (err) {
              return notionFailure(err);
            }
          },
        }),
      }
    : {}),

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

  /**
   * Available when there is a picture to work from, whether attached to this message or to the
   * one being replied to. "@bot make this a sticker" as a reply to someone else's photo is the
   * commoner of the two, and the media lives in the quoted copy there.
   */
  ...(stickerSource(turn)
    ? {
        make_sticker: tool({
          description:
            "Turn the image, GIF or video into a WhatsApp sticker, send it, and add it to the shared library. Works on whatever is attached to this message, or on the message being replied to. Animated sources stay animated.",
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
                stickerSource(turn)!,
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

/**
 * Builds the user turn, folding in whatever is being pointed at.
 *
 * A quoted image is fetched and passed as an actual image part rather than described, because
 * "@bot what does this say?" about a screenshot is unanswerable from a description. Fetching it
 * is best-effort: a failure downgrades to a mention of what was there, which still beats losing
 * the reply.
 */
const buildUserContent = async (turn: Turn): Promise<UserContent> => {
  // In a group, who is speaking changes the answer, so it has to be in the message itself.
  const said = turn.isGroup ? `${turn.senderName}: ${turn.text}` : turn.text;
  if (!turn.quoted) return said;

  const { text, media } = turn.quoted;
  const parts: Array<TextPart | ImagePart> = [];
  const describe =
    media && !text.trim()
      ? `(replying to ${media.kind === "sticker" ? "a sticker" : `${media.animated ? "an animated " : "a "}${media.kind}`})`
      : `(replying to: "${text.trim()}")`;

  parts.push({ type: "text", text: `${describe}\n\n${said}` });

  // Only stills can be shown to the model; a video or a document is named, not opened.
  if (media && (media.kind === "image" || media.kind === "sticker") && !media.animated) {
    try {
      const bytes = await fetchDecrypted(media.node);
      parts.push({
        type: "image",
        image: bytes,
        mediaType: media.mimetype ?? "image/jpeg",
      });
    } catch (err) {
      console.warn(
        "[quoted] could not fetch the quoted image:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  return parts;
};

export const reply = async (turn: Turn): Promise<Reply> => {
  const content = await buildUserContent(turn);
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

  /**
   * History records what happened, not just what was said, so "send that again" has a referent.
   * Only the text of the turn is kept — replaying a quoted image on every later turn would
   * re-bill it forever, and the answer it produced is already in the transcript.
   */
  await saveTurn(
    turn.chat,
    typeof content === "string"
      ? content
      : content
          .map((p) => (p.type === "text" ? p.text : "[image]"))
          .join(" "),
    [answer, sent.length ? `(sent: ${sent.join(", ")})` : ""]
      .filter(Boolean)
      .join(" ") || "(no reply)",
  );

  return { text: answer, sent };
};
