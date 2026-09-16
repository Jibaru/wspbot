/**
 * Checks the two pieces of logic that decide whether a WhatsApp message ever reaches the model:
 * signature verification and "is this message for me?".
 *
 * Needs no database, no WhatsApp session and no OpenAI key — run it any time with `npm run smoke`.
 */
import { createHmac } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { verify } from "../lib/signature";
import * as mentions from "../lib/mentions";
import { encodeState, decodeState } from "../lib/oauth-state";

const SECRET = "test-secret";
const BOT = {
  id: "14155550100@s.whatsapp.net",
  name: "bot",
  lid: "99887766@lid",
};
const identity = mentions.identityOf(BOT);

let failures = 0;
const check = (label: string, actual: unknown, expected: unknown) => {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) failures++;
  console.log(
    pass ? "  PASS" : "  FAIL",
    label,
    pass ? "" : `— got ${JSON.stringify(actual)}, wanted ${JSON.stringify(expected)}`,
  );
};

const groupTagged = {
  key: {
    remoteJid: "1203630@g.us",
    participant: "5215512345678:12@s.whatsapp.net",
    fromMe: false,
    id: "MSG_A",
  },
  pushName: "Ignacio",
  message: {
    extendedTextMessage: {
      text: "@99887766 record that we need to create a calendar schedule",
      contextInfo: { mentionedJid: ["99887766@lid"] },
    },
  },
};

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

const groupUntagged = clone(groupTagged);
groupUntagged.message.extendedTextMessage.text = "just chatting";
groupUntagged.message.extendedTextMessage.contextInfo = { mentionedJid: [] };

const groupReplyToBot = clone(groupTagged) as unknown as Record<string, any>;
groupReplyToBot["message"].extendedTextMessage.contextInfo = {
  participant: "14155550100@s.whatsapp.net",
  quotedMessage: { conversation: "an earlier bot reply" },
};

const dmEphemeral = {
  key: { remoteJid: "5215512345678@s.whatsapp.net", fromMe: false, id: "MSG_D" },
  pushName: "Ignacio",
  message: {
    ephemeralMessage: { message: { conversation: "hola, qué recuerdas?" } },
  },
};

const fromMe = clone(dmEphemeral);
fromMe.key.fromMe = true;

const statusUpdate = clone(dmEphemeral) as unknown as Record<string, any>;
statusUpdate["key"].remoteJid = "status@broadcast";

console.log("\nidentity:", identity);

console.log("\nsignature:");
const body = JSON.stringify({ hello: "world" });
check("plain secret accepted", verify(body, SECRET, SECRET), true);
check(
  "hmac accepted",
  verify(body, createHmac("sha256", SECRET).update(body).digest("hex"), SECRET),
  true,
);
check("wrong secret rejected", verify(body, "nope", SECRET), false);
check("missing signature rejected", verify(body, null, SECRET), false);
check(
  "hmac over a different body rejected",
  verify(body, createHmac("sha256", SECRET).update("tampered").digest("hex"), SECRET),
  false,
);

console.log("\nrouting (groups only — the shipped default):");
for (const [label, data, want] of [
  ["group + tagged", groupTagged, true],
  ["group, no tag", groupUntagged, false],
  ["group, reply to bot", groupReplyToBot, true],
  ["dm ignored", dmEphemeral, false],
] as const) {
  const parsed = mentions.parse(data as unknown as Record<string, unknown>);
  check(label, parsed ? mentions.shouldReply(parsed, identity, false) : null, want);
}

console.log("\nrouting (BOT_REPLY_TO_DMS=true):");
for (const [label, data, want] of [
  ["dm answered", dmEphemeral, true],
  // A group still needs a tag — the DM switch must not open groups up.
  ["group, no tag, still ignored", groupUntagged, false],
] as const) {
  const parsed = mentions.parse(data as unknown as Record<string, unknown>);
  check(label, parsed ? mentions.shouldReply(parsed, identity, true) : null, want);
}
check(
  "own messages ignored",
  mentions.parse(fromMe as unknown as Record<string, unknown>),
  null,
);
check(
  "status updates ignored",
  mentions.parse(statusUpdate as unknown as Record<string, unknown>),
  null,
);

const groupSticker = {
  key: {
    remoteJid: "1203630@g.us",
    participant: "5215512345678@s.whatsapp.net",
    fromMe: false,
    id: "MSG_STICKER",
  },
  pushName: "Ignacio",
  message: {
    stickerMessage: {
      url: "https://mmg.whatsapp.net/enc",
      mediaKey: "abc123",
      mimetype: "image/webp",
    },
  },
};

// Same sticker inside a disappearing-message wrapper — must still be seen.
const ephemeralSticker = {
  key: { remoteJid: "1203630@g.us", fromMe: false, id: "MSG_STICKER_EPH" },
  pushName: "Ignacio",
  message: { ephemeralMessage: { message: clone(groupSticker.message) } },
};

console.log("\nstickers:");
const sticker = mentions.parse(groupSticker as unknown as Record<string, unknown>);
check("sticker is parsed at all", Boolean(sticker), true);
check("sticker node captured", sticker?.media?.kind, "sticker");
// Collected, not answered: a bare sticker has nothing to reply to.
check(
  "sticker does not trigger a reply",
  sticker ? mentions.shouldReply(sticker, identity, true) : null,
  false,
);
const eph = mentions.parse(ephemeralSticker as unknown as Record<string, unknown>);
check("sticker inside ephemeral wrapper found", eph?.media?.kind, "sticker");
check(
  "plain text carries no media",
  Boolean(mentions.parse(groupTagged as unknown as Record<string, unknown>)?.media),
  false,
);

/**
 * Sticker sources. The animated flag is the subtle one: WhatsApp sends a "GIF" as an mp4 with
 * gifPlayback, so it cannot be inferred from the mimetype.
 */
const withMedia = (message: Record<string, unknown>) => ({
  key: {
    remoteJid: "1203630@g.us",
    participant: "5215512345678@s.whatsapp.net",
    fromMe: false,
    id: `MSG_${Math.floor(Math.random() * 1e9)}`,
  },
  pushName: "Ignacio",
  message,
});

console.log("\nsticker sources:");
for (const [label, message, wantKind, wantAnimated] of [
  [
    "photo with a tag",
    {
      imageMessage: {
        mimetype: "image/jpeg",
        caption: "@99887766 make this a sticker",
        contextInfo: { mentionedJid: ["99887766@lid"] },
      },
    },
    "image",
    false,
  ],
  [
    "WhatsApp GIF (mp4 + gifPlayback)",
    { videoMessage: { mimetype: "video/mp4", gifPlayback: true, caption: "@99887766" } },
    "video",
    true,
  ],
  ["plain video", { videoMessage: { mimetype: "video/mp4" } }, "video", true],
  [
    "real .gif sent as a file",
    { documentMessage: { mimetype: "image/gif", fileName: "cat.gif" } },
    "document",
    true,
  ],
  ["png", { imageMessage: { mimetype: "image/png" } }, "image", false],
] as const) {
  const p = mentions.parse(withMedia(message as Record<string, unknown>) as unknown as Record<string, unknown>);
  check(`${label} → kind`, p?.media?.kind, wantKind);
  check(`${label} → animated`, p?.media?.animated, wantAnimated);
}

// A tagged photo must still reach the model, since that is what triggers make_sticker.
const taggedPhoto = mentions.parse(
  withMedia({
    imageMessage: {
      mimetype: "image/jpeg",
      caption: "@99887766 sticker please",
      contextInfo: { mentionedJid: ["99887766@lid"] },
    },
  }) as unknown as Record<string, unknown>,
);
check(
  "tagged photo triggers a reply",
  taggedPhoto ? mentions.shouldReply(taggedPhoto, identity, false) : null,
  true,
);
// An untagged photo is just someone sharing a picture; the bot stays out of it.
const untaggedPhoto = mentions.parse(
  withMedia({ imageMessage: { mimetype: "image/jpeg", caption: "look at this" } }) as unknown as Record<string, unknown>,
);
check(
  "untagged photo ignored",
  untaggedPhoto ? mentions.shouldReply(untaggedPhoto, identity, false) : null,
  false,
);

/**
 * Replies. Tagging the bot in a reply is how someone points at something, so the quoted message
 * has to survive parsing — text and media alike.
 */
console.log("\nreplies (the thing being pointed at):");

const replyTo = (quotedMessage: Record<string, unknown>, text: string) =>
  withMedia({
    extendedTextMessage: {
      text,
      contextInfo: {
        mentionedJid: ["99887766@lid"],
        participant: "5219998887777@s.whatsapp.net",
        quotedMessage,
      },
    },
  });

const quotedText = mentions.parse(
  replyTo({ conversation: "the meeting is at 4pm on Thursday" }, "@99887766 is that right?") as unknown as Record<string, unknown>,
);
check("quoted text captured", quotedText?.quoted?.text, "the meeting is at 4pm on Thursday");
check("quoted author captured", quotedText?.quoted?.sender, "5219998887777@s.whatsapp.net");
check("reply still answers", quotedText ? mentions.shouldReply(quotedText, identity, false) : null, true);

const quotedPhoto = mentions.parse(
  replyTo(
    { imageMessage: { mimetype: "image/jpeg", caption: "look" } },
    "@99887766 what is this?",
  ) as unknown as Record<string, unknown>,
);
check("quoted image captured", quotedPhoto?.quoted?.media?.kind, "image");
check("quoted image not animated", quotedPhoto?.quoted?.media?.animated, false);
// The reply itself has no attachment; the picture is only in the quoted copy.
check("reply carries no media of its own", Boolean(quotedPhoto?.media), false);

const quotedGif = mentions.parse(
  replyTo(
    { videoMessage: { mimetype: "video/mp4", gifPlayback: true } },
    "@99887766 sticker please",
  ) as unknown as Record<string, unknown>,
);
check("quoted GIF captured as animated", quotedGif?.quoted?.media?.animated, true);

// A quoted message inside a disappearing wrapper must still be readable.
const quotedInEphemeral = mentions.parse(
  replyTo(
    { ephemeralMessage: { message: { conversation: "hidden but quoted" } } },
    "@99887766 ?",
  ) as unknown as Record<string, unknown>,
);
check("quoted ephemeral unwrapped", quotedInEphemeral?.quoted?.text, "hidden but quoted");

// A plain tagged message is not a reply, and must not invent one.
check(
  "non-reply has no quoted content",
  Boolean(mentions.parse(groupTagged as unknown as Record<string, unknown>)?.quoted),
  false,
);

/**
 * The OAuth state binds a Notion connection to one chat. If it were forgeable, anyone who found
 * the callback URL could attach their workspace to someone else's conversation.
 */
console.log("\nOAuth state (which chat a Notion connection belongs to):");
{
  const SECRET = "client-secret";
  const CHAT = "1203630@g.us";
  const state = encodeState(CHAT, SECRET);

  check("round-trips the chat", decodeState(state, SECRET), CHAT);

  const rejects = (label: string, fn: () => unknown) => {
    let refused = false;
    try {
      fn();
    } catch {
      refused = true;
    }
    check(label, refused, true);
  };

  rejects("a different secret is refused", () => decodeState(state, "another-secret"));
  rejects("a tampered signature is refused", () => decodeState(`${state.split(".")[0]}.AAAA`, SECRET));
  rejects("a swapped payload is refused", () =>
    // Re-pointing the state at another chat must not survive, even with the original signature.
    decodeState(
      `${Buffer.from(JSON.stringify({ c: "999@g.us", e: Date.now() + 1000 })).toString("base64url")}.${state.split(".")[1]}`,
      SECRET,
    ),
  );
  rejects("a state with no signature is refused", () => decodeState("justpayload", SECRET));
  rejects("an expired state is refused", () =>
    // Issued sixteen minutes ago, against a fifteen-minute lifetime.
    decodeState(encodeState(CHAT, SECRET, Date.now() - 16 * 60 * 1000), SECRET),
  );

  // Two links for the same chat must differ, or one could be replayed as the other.
  check("two states differ", encodeState(CHAT, SECRET) !== encodeState(CHAT, SECRET), true);
}

/**
 * Do AGENTS.md and README.md still describe this repository?
 *
 * Both carry file maps and lists of commands, and both are read by people and agents deciding
 * where to look. A path that no longer exists sends them somewhere else entirely, and it is the
 * kind of rot nothing else notices — documentation compiles no matter what it claims.
 *
 * Only paths under the directories this app owns are checked, so references to `node_modules`
 * or to an external repository are left alone.
 */
{
  console.log("\ndocumentation:");
  const owned = /(?:^|[\s`("])((?:app|lib|scripts|public)\/[\w./-]*[\w/]|proxy\.ts|instrumentation\.ts|docker-compose\.yml|Dockerfile)/g;

  for (const doc of ["AGENTS.md", "README.md"]) {
    const text = readFileSync(new URL(`../${doc}`, import.meta.url), "utf8");

    const paths = new Set(
      [...text.matchAll(owned)]
        .map((m) => m[1] as string)
        .filter((p) => !p.startsWith("node_modules")),
    );
    const missing = [...paths].filter(
      (p) => !existsSync(new URL(`../${p.replace(/\/$/, "")}`, import.meta.url)),
    );
    check(`${doc}: all ${paths.size} paths it names exist`, missing, []);

    // Every `npm run x` it tells you to run has to be a script that exists.
    const scripts = new Set(
      [...text.matchAll(/npm run ([a-z-]+)/g)].map((m) => m[1] as string),
    );
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { scripts: Record<string, string> };
    const unknown = [...scripts].filter((s) => !(s in pkg.scripts));
    check(`${doc}: all ${scripts.size} npm commands it names exist`, unknown, []);
  }
}

/**
 * What the proxy matcher actually gates.
 *
 * Read out of `proxy.ts` as source and evaluated, because the bug this exists to catch lives in
 * the difference between the two: `"\."` in a TypeScript string is an invalid escape that
 * collapses to `"."`, so an exclusion meant for files with an extension quietly became "any
 * non-empty path" and left every page but the root open. It typechecked, it built, and the root
 * still redirected, so nothing looked wrong.
 */
{
  console.log("\nproxy matcher:");
  const source = readFileSync(new URL("../proxy.ts", import.meta.url), "utf8");
  // Found by shape rather than by its contents, so reordering the exclusions inside the pattern
  // cannot quietly turn this whole check into a no-op.
  const line = source.split(/\r?\n/).find((l) => l.includes('"/((?!'));
  const pattern: string = eval(line!.trim().replace(/,$/, ""));
  const gates = (path: string): boolean => new RegExp(`^${pattern}$`).test(path);

  // Pages: every one of these must be behind the sign-in.
  for (const path of [
    "/dashboard",
    "/dashboard/features",
    "/dashboard/limits",
    "/dashboard/stickers",
    "/dashboard/memory",
    "/dashboard/reminders",
    "/dashboard/usage",
    "/dashboard/summaries",
    "/dashboard/move",
    "/dashboard/supporters",
    "/dashboard/roadmap",
  ]) {
    check(`gates ${path}`, gates(path), true);
  }
  // The landing page is the one page deliberately open, and the only one.
  check("leaves the landing page open", gates("/"), false);
  // Called by wapi and by Notion with no cookie; gating either breaks the bot silently.
  check("leaves /api/wapi/webhook open", gates("/api/wapi/webhook"), false);
  check("leaves /api/notion/callback open", gates("/api/notion/callback"), false);
  check("leaves /api/coffee/webhook open", gates("/api/coffee/webhook"), false);
  check("leaves /login open", gates("/login"), false);
  // Static files, which a signed-out browser has to be able to fetch or the tab has no icon.
  check("leaves /favicon.svg open", gates("/favicon.svg"), false);
  check("leaves /site.webmanifest open", gates("/site.webmanifest"), false);
  check("leaves /_next/static/x.js open", gates("/_next/static/x.js"), false);
}

const parsed = mentions.parse(
  groupTagged as unknown as Record<string, unknown>,
)!;
console.log("\nparsed group message:");
console.log("  text     ", JSON.stringify(parsed.text));
console.log(
  "  stripped ",
  JSON.stringify(mentions.stripMentions(parsed.text, identity)),
);
console.log("  sender   ", parsed.sender, "· name", parsed.senderName);
console.log("  isGroup  ", parsed.isGroup);

console.log(failures === 0 ? "\nall checks passed\n" : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
