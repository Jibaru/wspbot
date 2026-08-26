import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * The signed `state` that survives an OAuth round trip.
 *
 * It carries which chat is connecting. Unsigned, anyone who found the callback URL could bind
 * their own workspace to someone else's conversation — or to a chat they are not even in — so
 * the chat id has to be unforgeable rather than merely opaque. The expiry means an intercepted
 * link is useless a quarter of an hour later.
 *
 * Kept out of `lib/notion.ts` and free of `server-only` so it can be tested without a database,
 * credentials, or Next — the same reason `lib/signature.ts` is its own file.
 */

export class StateError extends Error {}

/** Long enough to walk through a consent screen, short enough to limit a leaked link. */
export const STATE_TTL_MS = 15 * 60 * 1000;

const sign = (payload: string, secret: string): string =>
  createHmac("sha256", secret).update(payload).digest("base64url");

const safeEqual = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  // timingSafeEqual throws on a length mismatch rather than returning false.
  return x.length === y.length && timingSafeEqual(x, y);
};

export const encodeState = (
  chat: string,
  secret: string,
  now = Date.now(),
): string => {
  const payload = Buffer.from(
    // A nonce so two links for the same chat in the same millisecond still differ.
    JSON.stringify({ c: chat, e: now + STATE_TTL_MS, n: randomBytes(8).toString("hex") }),
  ).toString("base64url");
  return `${payload}.${sign(payload, secret)}`;
};

/** Returns the chat the state belongs to, or throws with something worth showing a person. */
export const decodeState = (
  state: string,
  secret: string,
  now = Date.now(),
): string => {
  const [payload, signature] = state.split(".");
  if (!payload || !signature) throw new StateError("that link is incomplete");

  // Verified before parsing: never hand attacker-controlled JSON to the parser first.
  if (!safeEqual(signature, sign(payload, secret))) {
    throw new StateError("that link was not issued by this bot");
  }

  let parsed: { c?: string; e?: number };
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw new StateError("that link is not readable");
  }

  if (!parsed.c || !parsed.e) throw new StateError("that link is incomplete");
  if (now > parsed.e) throw new StateError("that link has expired — ask for a new one");
  return parsed.c;
};
