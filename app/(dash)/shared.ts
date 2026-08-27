import "server-only";

/**
 * The small helpers every section needs. Not a component library — just the three formatting
 * decisions that would otherwise be made slightly differently on each page.
 */

/**
 * A section that cannot reach wapi or the database should say so and let the rest of the page
 * render, rather than taking the whole dashboard down with it. Every fetch on these pages goes
 * through this, and every reader treats `null` as "could not read".
 */
export const settle = async <T,>(p: Promise<T>): Promise<T | null> => p.catch(() => null);

export const tokens = (n: number): string => n.toLocaleString("en-US");

/** Sub-cent totals read better as "<$0.01" than as "$0.00", which looks like free. */
export const money = (usd: number | null): string =>
  usd === null ? "—" : usd < 0.01 ? "<$0.01" : `$${usd.toFixed(2)}`;

/** A JID is long and only the leading part identifies anyone; the suffix is noise in a table. */
export const shortJid = (jid: string): string => jid.replace(/@.*$/, "");

export const when = (date: Date): string =>
  date.toISOString().slice(0, 16).replace("T", " ") + "Z";
