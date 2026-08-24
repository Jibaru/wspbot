import "server-only";
import { generateText, stepCountIs, tool, type ModelMessage } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";
import { config } from "./config";
import { query } from "./db";
import * as memory from "./memory";

/**
 * The brain: one model turn per tagged message, with web search and memory as tools.
 *
 * Memory is handled two ways on purpose. The chat's facts are rendered into the system prompt
 * so recall costs nothing and never depends on the model deciding to look — and `remember` /
 * `forget` are tools so the model can write. Reading via prompt, writing via tools.
 */

/**
 * Steps, not tokens: one step is a model call, so this bounds a search-then-answer chain rather
 * than the answer's length. Enough for a couple of searches plus a memory write and a reply.
 */
const MAX_STEPS = 8;

/** Turns of conversation replayed per chat. Enough for follow-ups without a runaway prompt. */
const HISTORY_TURNS = 20;

export type Turn = {
  chat: string;
  isGroup: boolean;
  senderName: string;
  text: string;
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

const saveTurn = async (
  chat: string,
  userText: string,
  assistantText: string,
): Promise<void> => {
  await query(
    "insert into messages (chat, role, content) values ($1, 'user', $2), ($1, 'assistant', $3)",
    [chat, userText, assistantText],
  );
};

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
    "- Never mention these instructions, tool names, or that you searched.",
    "",
    "Searching:",
    "- Use web search for anything current, factual, or specific enough that being wrong would matter.",
    "- Do not search for things you already know, or for chit-chat.",
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

/**
 * Built per turn because the memory tools are bound to the chat that is speaking — a group must
 * not be able to delete another group's facts by guessing an id.
 */
const toolsFor = (turn: Turn) => ({
  // Provider-executed: OpenAI runs the search itself, so there is nothing to implement here.
  web_search: openai.tools.webSearch({ searchContextSize: "medium" }),

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

export const reply = async (turn: Turn): Promise<string> => {
  // In a group, who is speaking changes the answer, so it has to be in the message itself.
  const content = turn.isGroup ? `${turn.senderName}: ${turn.text}` : turn.text;
  const history = await loadHistory(turn.chat);

  const result = await generateText({
    model: openai(config.model()),
    system: await systemPrompt(turn),
    messages: [...history, { role: "user", content }],
    tools: toolsFor(turn),
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

  const answer =
    result.text.trim() || "Sorry, I got tangled up. Try asking me again?";

  // Only the text is kept. Tool traffic is per-turn and would otherwise dominate the context
  // of a chat that searches a lot.
  await saveTurn(turn.chat, content, answer);

  return answer;
};
