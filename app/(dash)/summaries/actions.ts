"use server";

import { revalidatePath } from "next/cache";
import * as summaries from "@/lib/summaries";
import { wapi } from "@/lib/wapi";

/**
 * Every one of these calls `forgetSources`. The recorder caches which chats to record for half a
 * minute, and without clearing it a schedule switched on here would not start recording — or,
 * worse, one switched off would keep recording — until the cache happened to expire.
 */

export async function createSchedule(formData: FormData): Promise<void> {
  const source = String(formData.get("source") ?? "");
  const destination = String(formData.get("destination") ?? "");
  const pattern = String(formData.get("cron") ?? "").trim();
  if (!source || !destination || !pattern) return;

  /**
   * Names are resolved here rather than submitted, because a `<select>` posts only its value.
   * They are stored alongside the JIDs so the page still reads sensibly when wapi is unreachable,
   * or after the bot is removed from a group and can no longer look the name up at all.
   */
  const groups = await wapi.groups().catch(() => []);
  const nameOf = (jid: string) => groups.find((g) => g.jid === jid)?.name ?? null;
  const sourceName = nameOf(source);
  const destinationName = nameOf(destination);

  await summaries.create({
    sourceChat: source,
    sourceName,
    destinationChat: destination,
    destinationName,
    cron: pattern,
  });

  summaries.forgetSources();
  revalidatePath("/summaries");
}

export async function toggleSchedule(formData: FormData): Promise<void> {
  const id = Number(formData.get("id"));
  const on = String(formData.get("on") ?? "") === "true";
  if (!Number.isInteger(id)) return;

  await summaries.setEnabled(id, on);
  summaries.forgetSources();
  revalidatePath("/summaries");
}

export async function deleteSchedule(formData: FormData): Promise<void> {
  const id = Number(formData.get("id"));
  if (!Number.isInteger(id)) return;

  await summaries.remove(id);
  summaries.forgetSources();
  revalidatePath("/summaries");
}
