import { after } from "next/server";
import { config } from "@/lib/config";
import * as supporters from "@/lib/supporters";

/**
 * Buy Me a Coffee webhook receiver.
 *
 * Somebody buys a coffee and they appear on the supporters page by themselves — no polling, no
 * button. This route is deliberately shaped like the wapi one, because the same two facts hold:
 *
 * 1. The signature is verified over the **raw body**, before anything parses it. `req.json()`
 *    would consume the stream and leave nothing to hash, and would parse attacker-controlled
 *    JSON before establishing where it came from.
 * 2. It **acknowledges first** and does the work in `after()`. Buy Me a Coffee retries a failed
 *    delivery up to four more times with exponential delays, so a slow handler turns one coffee
 *    into five.
 *
 * Their scheme, from the published documentation: HMAC-SHA256 over the raw body, keyed with the
 * per-webhook signing secret, hex-encoded, in `x-signature-sha256`.
 */

export const runtime = "nodejs"; // node:crypto, and pg needs a real socket.
export const dynamic = "force-dynamic";

/** The events that mean somebody has just supported this. */
const CREATES = new Set([
  "donation.created",
  "extra_purchase.created",
  "commission_order.created",
  "wishlist_payment.created",
  "membership.started",
  "recurring_donation.started",
]);

/** A refund is the money coming back, so the thank-you goes with it. */
const REMOVES = new Set(["donation.refunded"]);

type Envelope = {
  event_id?: number;
  type?: string;
  live_mode?: boolean;
  created?: number;
  attempt?: number;
  data?: Record<string, unknown>;
};

export async function POST(req: Request) {
  const secret = config.coffeeWebhookSecret();
  if (!secret) {
    // Refusing beats accepting unverified writes into the supporters list.
    return new Response("no signing secret configured", { status: 503 });
  }

  const raw = await req.text();
  if (!supporters.verifySignature(raw, req.headers.get("x-signature-sha256"), secret)) {
    return new Response("invalid signature", { status: 401 });
  }

  let body: Envelope;
  try {
    body = JSON.parse(raw) as Envelope;
  } catch {
    // Authenticated but malformed: 400, so they stop retrying it.
    return new Response("invalid payload", { status: 400 });
  }

  after(async () => {
    try {
      await handle(body);
    } catch (err) {
      console.error("[coffee] webhook handler failed", err);
    }
  });

  return Response.json({ received: true });
}

async function handle(body: Envelope): Promise<void> {
  const type = body.type ?? "";
  const data = body.data ?? {};

  /*
   * The "Send test event" button in their dashboard sets `live_mode: false`. Accepting it proves
   * the endpoint and the secret are right, which is the whole point of the button — but writing
   * an invented supporter into the list would not be, so it stops here.
   */
  if (body.live_mode === false) {
    console.log(`[coffee] test event ${type} — verified, not stored`);
    return;
  }

  const parsed = supporters.fromWebhook(type, data);
  if (!parsed) {
    console.warn(`[coffee] ${type} carried nothing identifiable`);
    return;
  }

  if (REMOVES.has(type)) {
    await supporters.removeByExternalId(parsed.externalId.replace(/^[^:]+:/, "donation.created:"));
    supporters.forget();
    console.log(`[coffee] ${type} — ${parsed.name} removed`);
    return;
  }

  if (!CREATES.has(type)) {
    // Updates and cancellations change nothing about having supported this at some point.
    console.log(`[coffee] ${type} — nothing to do`);
    return;
  }

  await supporters.add({
    name: parsed.name,
    via: "coffee",
    externalId: parsed.externalId,
    ...(body.created ? { since: new Date(body.created * 1000) } : {}),
  });
  supporters.forget();
  console.log(`[coffee] ${type} — ${parsed.name} added`);
}

/** A browser hitting the URL should get something friendlier than a 405. */
export function GET() {
  return new Response(
    "wspbot's Buy Me a Coffee webhook is up — point a webhook here and set BUYMEACOFFEE_WEBHOOK_SECRET.",
    { headers: { "content-type": "text/plain" } },
  );
}
