/**
 * Who may look at the dashboard.
 *
 * The page shows the chats' memories, the sticker library, the WhatsApp identity behind the
 * session and what it has all cost — none of which should be readable by anyone who happens to
 * know the URL.
 *
 * Two separate things, deliberately:
 *
 * - **bcrypt** verifies the password, and runs *only* at sign-in. It is slow by design, which is
 *   what makes it a good password hash and a terrible thing to run on every page view.
 * - **A signed cookie** carries the session afterwards. HMAC-SHA256 over the expiry, verified in
 *   microseconds, so the cost is paid once rather than per request.
 *
 * No `server-only` here: the middleware imports the cookie half, and that runs in a different
 * place. Nothing in this file touches the database or reads a secret at import time.
 */

export const SESSION_COOKIE = "wspbot_session";

/** A week. Long enough not to be a nuisance on a dashboard checked occasionally. */
export const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

const encoder = new TextEncoder();

/**
 * Web Crypto rather than `node:crypto`, so the same code verifies in middleware and in a route
 * handler without caring which runtime it landed in.
 */
const key = async (secret: string): Promise<CryptoKey> =>
  crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );

const toBase64Url = (bytes: ArrayBuffer): string =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

/** `<expiry>.<signature>` — the expiry is in the signed payload, so it cannot be edited. */
export const createSession = async (
  secret: string,
  now = Date.now(),
): Promise<string> => {
  const expiresAt = String(now + SESSION_MAX_AGE_SECONDS * 1000);
  const signature = await crypto.subtle.sign(
    "HMAC",
    await key(secret),
    encoder.encode(expiresAt),
  );
  return `${expiresAt}.${toBase64Url(signature)}`;
};

/** Returns the ArrayBuffer rather than the view: `subtle.verify` wants a plain BufferSource. */
const fromBase64Url = (value: string): ArrayBuffer => {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
};

export const verifySession = async (
  token: string | undefined,
  secret: string,
  now = Date.now(),
): Promise<boolean> => {
  if (!token) return false;
  const [expiresAt, signature] = token.split(".");
  if (!expiresAt || !signature) return false;

  // Checked first: an expired token must not be usable however well it is signed.
  const expiry = Number(expiresAt);
  if (!Number.isFinite(expiry) || now > expiry) return false;

  try {
    // `subtle.verify` rather than comparing strings — constant time, and already at hand.
    return await crypto.subtle.verify(
      "HMAC",
      await key(secret),
      fromBase64Url(signature),
      encoder.encode(expiresAt),
    );
  } catch {
    // A malformed signature throws on decode; that is a failed check, not an error to surface.
    return false;
  }
};
