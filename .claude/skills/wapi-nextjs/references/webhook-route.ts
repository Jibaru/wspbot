import { createHmac, timingSafeEqual } from "node:crypto";
import { after } from "next/server";

/**
 * wapi webhook receiver.
 *
 * Copy to `src/app/api/wapi/webhook/route.ts`.
 *
 * Two properties this handler exists to get right:
 *
 * 1. It reads the **raw body** and verifies before parsing. `req.json()` would consume the
 *    stream, leaving nothing to compute an HMAC over, and would parse attacker-controlled JSON
 *    before establishing that it came from wapi.
 * 2. It **acknowledges immediately** and does the work in `after()`. Delivery retries with
 *    backoff on any non-2xx, so a slow handler turns one event into several.
 */

export const runtime = "nodejs"; // node:crypto, and no need for edge here.
export const dynamic = "force-dynamic";

const secret = process.env["WAPI_WEBHOOK_SECRET"];

type WebhookBody = {
  event: string;
  sessionId: number;
  timestamp: number;
  data: Record<string, unknown>;
};

const safeEqual = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  // Compare lengths first: timingSafeEqual throws on a mismatch rather than returning false.
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * Accepts either signing scheme.
 *
 * wapi's default is a plain string compare of the header against the secret — that is
 * WasenderAPI's scheme, reproduced for drop-in compatibility. Enabling `webhook_hmac` on the
 * session switches it to HMAC-SHA256 over the raw body, which is what you want. Accepting both
 * means turning the flag on does not require redeploying this handler.
 */
const verify = (raw: string, signature: string | null): boolean => {
  if (!secret || !signature) return false;
  if (safeEqual(signature, secret)) return true;
  return safeEqual(signature, createHmac("sha256", secret).update(raw).digest("hex"));
};

export async function POST(req: Request) {
  const raw = await req.text();

  if (!verify(raw, req.headers.get("x-webhook-signature"))) {
    return new Response("invalid signature", { status: 401 });
  }

  let body: WebhookBody;
  try {
    body = JSON.parse(raw) as WebhookBody;
  } catch {
    // Malformed but authenticated: 400 rather than 401, and do not retry it forever.
    return new Response("invalid payload", { status: 400 });
  }

  // Acknowledge now; process after the response is sent.
  after(async () => {
    await handle(body);
  });

  return Response.json({ received: true });
}

async function handle({ event, data }: WebhookBody) {
  switch (event) {
    case "messages.received": {
      const key = data["key"] as { remoteJid?: string; remoteJidAlt?: string } | undefined;
      const message = data["message"] as Record<string, unknown> | undefined;

      /**
       * `remoteJid` is often a LID (`…@lid`) rather than a phone number, with the number in
       * `remoteJidAlt` when known. A phone number cannot be derived from a LID, so treat the
       * LID as the identity and the number as an optional attribute.
       */
      const from = key?.remoteJid;
      const text =
        (message?.["conversation"] as string | undefined) ??
        ((message?.["extendedTextMessage"] as { text?: string } | undefined)?.text);

      console.log("inbound", { from, text });

      /**
       * `key` here is exactly what `wapi.react()` wants — this is the normal way to get one,
       * since a message someone else sent has no msgId.
       *
       *   await wapi.react(data.key as MessageKey, "👍");
       */

      /**
       * Inbound media arrives encrypted: the payload carries a CDN URL and a `mediaKey`, and
       * the bytes are useless without decryption. Pass the message node to
       * `wapi.decryptMedia(message)` to get a URL valid for one hour.
       */
      break;
    }

    case "session.status":
      console.log("session status", data["status"]);
      break;

    default:
      // Events are added over time; ignoring an unknown one must not fail the delivery.
      break;
  }
}
