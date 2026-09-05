import "server-only";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { config } from "./config";

/**
 * Sealing a secret before it goes into a row.
 *
 * Used for exactly one thing: the GitHub token typed into the dashboard. It is worth explaining
 * why that one and not the Notion tokens beside it, because a half-applied encryption scheme is
 * worse than none if anyone concludes from it that "secrets in this database are encrypted".
 *
 * A Notion connection is a per-chat grant to whichever pages somebody shared on Notion's own
 * consent screen. A GitHub token is one credential for a whole account that can open issues and
 * create repositories under it. It is also never read back by a human — nothing displays it, the
 * dashboard shows four characters — so there is no cost to it being unreadable.
 *
 * The threat this addresses is the realistic one: the database is managed and lives somewhere
 * else, so a dump, a backup, or a read of that table is a different event from a compromise of
 * the container's environment. The key comes from `AUTH_SECRET`, which lives in the environment
 * and never in the database, so those two have to leak together for this to be worth nothing.
 *
 * AES-256-GCM: encrypt-then-authenticate, so a tampered ciphertext fails to open rather than
 * decrypting into something else.
 */

/**
 * SHA-256 of `AUTH_SECRET` rather than the bytes of it, so the key is 32 bytes whatever the
 * secret's length or encoding happens to be. Not a KDF: the input is a high-entropy random
 * secret, not a password, so stretching would buy nothing.
 */
const key = (): Buffer => createHash("sha256").update(config.authSecret()).digest();

/** `v1` is a marker, not a version negotiation — it exists so a later scheme is recognisable. */
const PREFIX = "v1";

export const seal = (plaintext: string): string => {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [PREFIX, iv.toString("base64"), tag.toString("base64"), body.toString("base64")].join(":");
};

/**
 * Returns null rather than throwing when the value cannot be opened. A rotated `AUTH_SECRET`
 * makes every stored token unreadable, and the right behaviour then is "GitHub is not
 * configured, connect it again" — not every dashboard page and every model turn throwing.
 */
export const open = (sealed: string): string | null => {
  try {
    const [prefix, iv, tag, body] = sealed.split(":");
    if (prefix !== PREFIX || !iv || !tag || !body) return null;

    const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(body, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return null;
  }
};
