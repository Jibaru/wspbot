/**
 * A scheduled summary, end to end, against the real database and the real model.
 *
 * The quality of the digest *is* the feature, and it is exactly what nothing else can check: the
 * schema is satisfied by a paragraph that drops every decision, and a typecheck has no opinion
 * about whether a link survived. So this feeds in a transcript with known content — a decision,
 * a deadline, an unanswered question, two links, a screenshot worth attaching and a selfie that
 * is not — and asserts the digest kept the things that matter.
 *
 * **Costs money** (one call to the summary model) and needs DATABASE_URL. Writes to a chat id
 * that cannot exist and deletes everything it wrote; nothing is sent to WhatsApp.
 *
 *   npm run summary-check
 */

import { query } from "../lib/db.js";
import * as summaries from "../lib/summaries.js";
import { compose } from "../lib/summary-runner.js";
import { config } from "../lib/config.js";

let failures = 0;
const check = (label: string, pass: boolean, detail = "") => {
  if (!pass) failures++;
  console.log(pass ? "  PASS" : "  FAIL", label, detail);
};

/** Not a real JID, so it cannot collide with a group the bot is actually in. */
const CHAT = "summary-check@invalid";
const DEST = "summary-check-dest@invalid";

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);

const TRANSCRIPT: {
  who: string;
  text: string;
  kind?: string;
  note?: string;
  url?: string;
}[] = [
  { who: "Ana", text: "buenos días! ¿seguimos con el deploy del viernes?" },
  { who: "Beto", text: "sí, pero hay un bug en el login que hay que arreglar antes" },
  {
    who: "Beto",
    text: "miren",
    kind: "image",
    note: "A screenshot of a browser console showing a 500 error from /api/session with the message 'token expired'.",
    url: "https://example.invalid/screenshot.png",
  },
  { who: "Ana", text: "ah, es el refresh token. yo lo arreglo hoy" },
  {
    who: "Carla",
    text: "les dejo el doc con los pasos del release https://docs.example.com/release-checklist",
  },
  { who: "Beto", text: "gracias. ¿alguien sabe si migramos la base antes o después?" },
  { who: "Ana", text: "el deploy queda para el viernes 5 a las 3pm entonces" },
  { who: "Carla", text: "confirmado" },
  {
    who: "Beto",
    text: "jajaja",
    kind: "image",
    note: "A selfie of a man laughing in an office, no text visible.",
    url: "https://example.invalid/selfie.png",
  },
  { who: "Carla", text: "otro link útil: https://status.example.com/incidents/42" },
  { who: "Ana", text: "ok, nos vemos" },
];

const cleanup = async () => {
  await query("delete from logged_messages where chat = $1", [CHAT]);
  await query("delete from summary_schedules where source_chat = $1", [CHAT]);
};

console.log(`\nsummary model: ${config.summaryModel()}   timezone: ${config.timezone()}`);

await cleanup();

try {
  // ── seed ───────────────────────────────────────────────────────────────
  await summaries.create({
    sourceChat: CHAT,
    sourceName: "Equipo Deploy",
    destinationChat: DEST,
    destinationName: "Resúmenes",
    cron: "0 9 * * *",
  });
  const schedule = (await summaries.list()).find((s) => s.sourceChat === CHAT)!;
  check("schedule created", Boolean(schedule));
  check("it is recorded from now on", (await summaries.recordedChats()).has(CHAT));

  for (const [i, m] of TRANSCRIPT.entries()) {
    await summaries.log({
      chat: CHAT,
      messageId: `check-${i}`,
      sender: `${m.who}@invalid`,
      senderName: m.who,
      kind: m.kind ?? "text",
      text: m.text,
      mediaNote: m.note ?? null,
      mediaUrl: m.url ?? null,
      urls: summaries.extractUrls(m.text),
    });
    // Spread them over the last hour so the transcript carries plausible times.
    await query("update logged_messages set at = $2 where chat = $1 and message_id = $3", [
      CHAT,
      minutesAgo(60 - i * 5),
      `check-${i}`,
    ]);
  }

  // Written twice on purpose: deliveries retry, and a digest must not double-count.
  await summaries.log({
    chat: CHAT,
    messageId: "check-0",
    sender: "Ana@invalid",
    senderName: "Ana",
    kind: "text",
    text: "buenos días! ¿seguimos con el deploy del viernes?",
    urls: [],
  });

  // ── the window ─────────────────────────────────────────────────────────
  console.log("\nrecording:");
  const window = await summaries.windowFor(schedule, new Date());
  check("every message is in the window", window.messages.length === TRANSCRIPT.length,
    `— ${window.messages.length} of ${TRANSCRIPT.length}`);
  check("the duplicate delivery was not stored twice",
    window.messages.filter((m) => m.text.startsWith("buenos días")).length === 1);

  const urls = window.messages.flatMap((m) => m.urls);
  check("both shared links were extracted", urls.length === 2, `— ${urls.join(" ")}`);
  check("a trailing-punctuation link is not mangled",
    summaries.extractUrls("mira esto https://a.example.com/x. ok")[0] === "https://a.example.com/x");

  const { transcript, images: attachable } = summaries.render(window);
  check("the transcript numbers the pictures from one", /\[image #1: A screenshot/.test(transcript));
  check("the second picture is #2, not a row id", /\[image #2: A selfie/.test(transcript));
  check("the transcript carries the links", transcript.includes("docs.example.com/release-checklist"));
  check("both pictures resolve back to a URL", attachable.size === 2,
    `— ${[...attachable.keys()].join(", ")}`);
  check("picture 1 is the screenshot",
    attachable.get(1) === "https://example.invalid/screenshot.png");

  // ── the digest ─────────────────────────────────────────────────────────
  console.log("\ncomposing (one real model call):");
  const { text, images } = await compose(schedule, window);

  console.log("\n" + "─".repeat(70));
  console.log(text);
  console.log("─".repeat(70));
  console.log(`attached images: ${images.length ? images.join(", ") : "none"}\n`);

  const lower = text.toLowerCase();
  check("it is not empty", text.length > 50, `— ${text.length} chars`);
  check("it kept the deadline (Friday the 5th, 3pm)",
    /viernes/i.test(text) && /(3\s*pm|15:00|3:00)/i.test(text));
  check("it named who is fixing the bug", /ana/i.test(text));
  check("it kept the release-checklist link in full",
    text.includes("https://docs.example.com/release-checklist"));
  check("it kept the second link in full",
    text.includes("https://status.example.com/incidents/42"));
  check("it carried the open question about the database migration",
    /migra|base de datos|database/i.test(lower));
  check("it answered in the language of the group", /[áéíóúñ¿]/i.test(text));
  check("it used no markdown headings", !/^#{1,6}\s/m.test(text));
  check("it used no markdown links", !/\[[^\]]+\]\([^)]+\)/.test(text));

  check("it chose the screenshot to attach", images.includes(1), `— chose ${images.join(", ") || "none"}`);
  check("it left the selfie out", !images.includes(2));
  check("every id it returned resolves to a picture",
    images.every((id) => attachable.has(id)));

  // ── the watermark ──────────────────────────────────────────────────────
  console.log("\nwatermark:");
  const until = new Date();
  await summaries.markSummarised(schedule.id, until);
  const after = (await summaries.list()).find((s) => s.id === schedule.id)!;
  check("the watermark moved", Boolean(after.summarisedTo));
  const next = await summaries.windowFor(after, new Date());
  check("the next window is empty, so nothing is summarised twice", next.messages.length === 0,
    `— ${next.messages.length} left`);
} finally {
  await cleanup();
  console.log("cleaned up");
}

console.log(failures === 0 ? "\nall checks passed\n" : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
