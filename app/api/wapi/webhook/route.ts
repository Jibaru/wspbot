import { after } from "next/server";
import { verify } from "@/lib/signature";
import { config } from "@/lib/config";
import { query } from "@/lib/db";
import { wapi } from "@/lib/wapi";
import { reply, clearHistory } from "@/lib/agent";
import * as mentions from "@/lib/mentions";
import * as stickers from "@/lib/stickers";
import { ensureConnected } from "@/lib/session";

/**
 * wapi webhook receiver — the only way inbound WhatsApp messages reach this app. wapi has no
 * endpoint that lists received messages, so nothing here polls; everything arrives as a POST.
 *
 * Two properties this handler exists to get right:
 *
 * 1. It reads the **raw body** and verifies before parsing. `req.json()` would consume the
 *    stream, leaving nothing to compute an HMAC over, and would parse attacker-controlled JSON
 *    before establishing that it came from wapi.
 * 2. It **acknowledges immediately** and does the work in `after()`. Delivery retries with
 *    backoff on any non-2xx, and a model turn takes seconds — a slow handler turns one message
 *    into several.
 */

export const runtime = "nodejs"; // node:crypto, and pg needs a real socket.
export const dynamic = "force-dynamic";

type WebhookBody = {
  event: string;
  sessionId: number;
  timestamp: number;
  data: Record<string, unknown>;
};

/**
 * Deliveries retry, so the same message can arrive twice — and separate serverless invocations
 * share no memory, so the claim has to be made somewhere both can see. An insert that loses the
 * race returns no row.
 */
const claim = async (messageId: string): Promise<boolean> => {
  if (!messageId) return false;
  const rows = await query(
    "insert into seen_messages (id) values ($1) on conflict do nothing returning id",
    [messageId],
  );
  return rows.length > 0;
};

export async function POST(req: Request) {
  const raw = await req.text();

  if (!verify(raw, req.headers.get("x-webhook-signature"), config.webhookSecret())) {
    return new Response("invalid signature", { status: 401 });
  }

  let body: WebhookBody;
  try {
    body = JSON.parse(raw) as WebhookBody;
  } catch {
    // Authenticated but malformed: 400 rather than 401, so wapi stops retrying it.
    return new Response("invalid payload", { status: 400 });
  }

  // Acknowledge now; do the slow part after the response is sent.
  after(async () => {
    try {
      await handle(body);
    } catch (err) {
      console.error("webhook handler failed", err);
    }
  });

  return Response.json({ received: true });
}

async function handle({ event, data }: WebhookBody): Promise<void> {
  /**
   * Connection changes. Subscribing to this is the only way to see *why* a session dropped —
   * wapi reports the reason here, and nothing in the REST API exposes it after the fact.
   */
  if (event === "session.status") {
    console.log("[wapi] session.status", JSON.stringify(data));
    /**
     * The fast path back from a drop. The payload shape is undocumented, so nothing here reads
     * it — `ensureConnected` re-checks `GET /api/status` itself and does nothing if the session
     * turns out to be fine.
     */
    await ensureConnected("session.status webhook");
    return;
  }

  // Events are added over time; an unknown one must not fail the delivery.
  if (event !== "messages.received") return;

  const message = mentions.parse(data);
  if (!message) return;

  const me = await wapi.meCached();
  const identity = mentions.identityOf(me);

  const willReply = mentions.shouldReply(message, identity, config.replyToDms());
  /**
   * Stickers are collected without being answered — that is the point, the bot builds a library
   * from what people already send. So the "is this for me?" gate cannot decide whether to look
   * at a message, only whether to reply to one.
   */
  const willCapture = message.media?.kind === "sticker";

  // Claimed only when there is work to do, so ignored chatter does not fill the table.
  if (!willReply && !willCapture) return;
  if (!(await claim(message.messageId))) return;

  if (willCapture) {
    await stickers.capture(message.chat, message.senderName, message.media!.node);
  }
  if (!willReply) return;

  // Best effort — blue ticks are not worth failing a reply over.
  await wapi.markRead(message.key).catch(() => {});

  const text = mentions.stripMentions(message.text, identity);

  if (/^\/reset\b/i.test(text)) {
    await clearHistory(message.chat);
    await wapi.sendText(message.chat, "Conversation cleared. Memories kept.");
    return;
  }

  const answer = await reply({
    chat: message.chat,
    isGroup: message.isGroup,
    senderName: message.senderName,
    text: text || "(no text)",
    // A sticker is collected, not raw material — everything else can become one.
    ...(message.media && message.media.kind !== "sticker"
      ? { attachment: message.media }
      : {}),
    // What they are replying to, if anything: the thing their words are about.
    ...(message.quoted ? { quoted: message.quoted } : {}),
  });

  /**
   * The sending tools deliver as they run, so a turn can be complete with no text left to send
   * — a poll on its own, for instance. Sending an empty string here would be a stray blank
   * message on top of it.
   */
  if (answer.text) {
    // Mentioning the sender makes the reply notify them in a busy group.
    await wapi.sendText(message.chat, answer.text, {
      ...(message.isGroup ? { mentions: [message.sender] } : {}),
    });
  }
}

/** A browser hitting the URL should get something friendlier than a 405. */
export function GET() {
  return new Response("wspbot webhook is up — point wapi's webhook_url here.", {
    headers: { "content-type": "text/plain" },
  });
}
