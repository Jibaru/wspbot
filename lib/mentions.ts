/**
 * Deciding whether an inbound message is for us.
 *
 * The payload is WhatsApp's own message node, so the text and the mention list live at
 * different depths depending on the message type, and identities may be LIDs rather than
 * phone numbers. Everything awkward about that is contained in this file.
 */
import type { WapiUser } from "./wapi";

export type Inbound = {
  /** The chat: a group JID (`…@g.us`) or a one-to-one JID. */
  chat: string;
  /** Who spoke. In a group this is the participant, not the chat. */
  sender: string;
  senderName: string;
  text: string;
  isGroup: boolean;
  /** The raw key, needed to mark the message read. */
  key: Record<string, unknown>;
  messageId: string;
  mentionedJids: string[];
  quotedSender?: string;
  /**
   * The unwrapped message node, present only when this message is a sticker. Handed to
   * `decrypt-media` as-is — inbound media is encrypted, and the node carries the key.
   */
  stickerNode?: Record<string, unknown>;
};

type Node = Record<string, unknown> | undefined;

const asNode = (v: unknown): Node =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;

/** Disappearing and view-once messages wrap the real node one or two levels down. */
const unwrapMessage = (message: Node): Node => {
  let node = message;
  for (let depth = 0; depth < 3 && node; depth++) {
    const inner =
      asNode(node["ephemeralMessage"]) ??
      asNode(node["viewOnceMessage"]) ??
      asNode(node["viewOnceMessageV2"]) ??
      asNode(node["documentWithCaptionMessage"]);
    if (!inner) break;
    node = asNode(inner["message"]);
  }
  return node;
};

const textOf = (node: Node): string => {
  if (!node) return "";
  const conversation = node["conversation"];
  if (typeof conversation === "string") return conversation;
  for (const key of [
    "extendedTextMessage",
    "imageMessage",
    "videoMessage",
    "documentMessage",
  ]) {
    const sub = asNode(node[key]);
    const value = sub?.["text"] ?? sub?.["caption"];
    if (typeof value === "string") return value;
  }
  return "";
};

/** `contextInfo` carries mentions and the quoted message; it hangs off whichever node is set. */
const contextOf = (node: Node): Node => {
  if (!node) return undefined;
  for (const value of Object.values(node)) {
    const context = asNode(asNode(value)?.["contextInfo"]);
    if (context) return context;
  }
  return undefined;
};

/**
 * `12345:7@s.whatsapp.net` and `12345@lid` are the same person addressed two ways: a device
 * suffix and a different namespace. Comparing the leading digits is the only reliable match —
 * a LID is never derivable from a phone number, so we compare what we have rather than convert.
 */
const numeric = (jid: string): string =>
  (jid.split("@")[0] ?? "").split(":")[0] ?? "";

export const parse = (data: Record<string, unknown>): Inbound | null => {
  const key = asNode(data["key"]);
  const chat = key?.["remoteJid"];
  if (typeof chat !== "string" || key?.["fromMe"] === true) return null;
  // Status updates arrive on the same event and are never addressed to anyone.
  if (chat === "status@broadcast" || chat.endsWith("@newsletter")) return null;

  const node = unwrapMessage(asNode(data["message"]));
  const text = textOf(node);
  const isSticker = Boolean(node && asNode(node["stickerMessage"]));

  // A sticker carries no text, so text alone can no longer decide whether there is anything
  // here worth looking at.
  if (!text.trim() && !isSticker) return null;

  const context = contextOf(node);
  const mentioned = context?.["mentionedJid"];
  const isGroup = chat.endsWith("@g.us");
  const participant = key?.["participant"] ?? key?.["participantAlt"];
  const quoted = context?.["participant"];

  return {
    chat,
    sender:
      typeof participant === "string" && participant ? participant : chat,
    senderName:
      typeof data["pushName"] === "string" && data["pushName"]
        ? data["pushName"]
        : "Someone",
    text,
    isGroup,
    key: key ?? {},
    messageId: typeof key?.["id"] === "string" ? key["id"] : "",
    mentionedJids: Array.isArray(mentioned)
      ? mentioned.filter((m): m is string => typeof m === "string")
      : [],
    ...(typeof quoted === "string" ? { quotedSender: quoted } : {}),
    ...(isSticker && node ? { stickerNode: node } : {}),
  };
};

/** Every spelling of our own identity that a mention could use. */
export const identityOf = (user: WapiUser): string[] =>
  [user.id, user.lid]
    .filter((v): v is string => typeof v === "string" && v.length > 0)
    .map(numeric)
    .filter(Boolean);

export const isTagged = (message: Inbound, identity: string[]): boolean => {
  const mine = new Set(identity);
  if (message.mentionedJids.some((jid) => mine.has(numeric(jid)))) return true;
  // Replying to one of our messages is a tag in every sense that matters.
  return message.quotedSender ? mine.has(numeric(message.quotedSender)) : false;
};

/**
 * Groups require a tag. Direct chats are ignored unless explicitly switched on — there is no
 * tagging convention in a one-to-one chat, so answering there means answering everything.
 */
export const shouldReply = (
  message: Inbound,
  identity: string[],
  replyToDms: boolean,
): boolean => {
  // Nothing to answer. A bare sticker is collected, not replied to.
  if (!message.text.trim()) return false;
  return message.isGroup ? isTagged(message, identity) : replyToDms;
};

/** `@14155550100 what's up` reads better to the model as `what's up`. */
export const stripMentions = (text: string, identity: string[]): string => {
  let out = text;
  for (const id of identity) out = out.replaceAll(`@${id}`, "");
  return out.replace(/\s+/g, " ").trim();
};
