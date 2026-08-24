/**
 * Checks the two pieces of logic that decide whether a WhatsApp message ever reaches the model:
 * signature verification and "is this message for me?".
 *
 * Needs no database, no WhatsApp session and no OpenAI key — run it any time with `npm run smoke`.
 */
import { createHmac } from "node:crypto";
import { verify } from "../lib/signature";
import * as mentions from "../lib/mentions";

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

console.log("\nrouting:");
for (const [label, data, want] of [
  ["group + tagged", groupTagged, true],
  ["group, no tag", groupUntagged, false],
  ["group, reply to bot", groupReplyToBot, true],
  ["dm (ephemeral wrapper)", dmEphemeral, true],
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
