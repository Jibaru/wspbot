import "server-only";
import { query } from "./db";
import * as supporters from "./supporters";

/**
 * Everyone this deployment has a name or an identifier for.
 *
 * It exists so the rate-limit page can offer a list to pick from instead of a box to paste a raw
 * JID into. Nothing here is a source of truth — it is four existing tables gathered up and
 * de-duplicated on the normalised handle, so somebody who appears as a supporter, a caller and a
 * quota is one entry rather than three.
 */

export type Person = {
  /** The normalised identity, which is what `rate_limits.user_id` holds. */
  handle: string;
  /** A name if anything knows one, otherwise the handle itself. */
  label: string;
  supporter: boolean;
  /** Where this identity turned up, for the label under the picker. */
  seen: string[];
};

export const directory = async (): Promise<Person[]> => {
  const [known, quotas, callers, owners] = await Promise.all([
    supporters.list(),
    query<{ user_id: string }>("select user_id from rate_limits"),
    // Pruned to the last hour, so this is who is active rather than who ever was.
    query<{ user_id: string }>("select distinct user_id from bot_calls where kind = 'call'"),
    query<{ user_id: string; asked_by: string | null }>(
      "select distinct user_id, asked_by from reminders",
    ),
  ]);

  const people = new Map<string, Person>();

  /** First writer wins on the label, so a real name beats a raw identifier. */
  const note = (raw: string, label: string | null, where: string, isSupporter = false) => {
    const handle = supporters.normalise(raw);
    if (!handle) return;

    const existing = people.get(handle);
    if (existing) {
      if (!existing.seen.includes(where)) existing.seen.push(where);
      if (isSupporter) existing.supporter = true;
      if (label && existing.label === existing.handle) existing.label = label;
      return;
    }
    people.set(handle, {
      handle,
      label: label ?? handle,
      supporter: isSupporter,
      seen: [where],
    });
  };

  for (const s of known) for (const h of s.handles) note(h, s.name, "supporter", true);
  for (const q of quotas) note(q.user_id, null, "has a quota");
  for (const c of callers) note(c.user_id, null, "recently active");
  for (const o of owners) note(o.user_id, o.asked_by, "has a reminder");

  return [...people.values()].sort(
    (a, b) => Number(b.supporter) - Number(a.supporter) || a.label.localeCompare(b.label),
  );
};
