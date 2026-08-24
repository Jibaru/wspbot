import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Webhook signature verification, kept out of the route so it can be tested without booting
 * Next.
 */

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
 * means turning the flag on does not require redeploying.
 */
export const verify = (
  raw: string,
  signature: string | null,
  secret: string,
): boolean => {
  if (!signature || !secret) return false;
  if (safeEqual(signature, secret)) return true;
  return safeEqual(
    signature,
    createHmac("sha256", secret).update(raw).digest("hex"),
  );
};
