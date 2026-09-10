"use server";

import { revalidatePath } from "next/cache";
import { wapi } from "@/lib/wapi";
import * as leaderboard from "@/lib/leaderboard";
import { announce } from "@/lib/leaderboard-runner";

/**
 * Scheduling a watch is a dashboard-only act, deliberately: a watch belongs to the *chat*, so
 * one person switching it on commits the whole room to recurring notifications. Asking how the
 * voting is going is a tool anybody in a group can reach; subscribing the group is not.
 *
 * Nothing here checks the session, in line with every other page: `proxy.ts` gates the whole
 * `/dashboard` tree, and a Server Action posts to its own page's path, so the gate covers the
 * POST as well. One place to be sure of, rather than one per action.
 */

const number = (form: FormData, key: string): number | undefined => {
  const raw = form.get(key);
  if (raw === null || String(raw).trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
};

export async function saveWatch(formData: FormData): Promise<void> {
  const chat = String(formData.get("chat") ?? "");
  if (!chat) return;

  /**
   * Resolved here rather than posted, since a `<select>` submits only its value. Stored so the
   * row still reads as a group name when wapi is unreachable, or after the bot is removed from
   * the group and the name cannot be looked up at all.
   */
  const groups = await wapi.groups().catch(() => []);
  const chatName = groups.find((g) => g.jid === chat)?.name ?? null;

  const endsRaw = String(formData.get("endsAt") ?? "").trim();
  const endsAt = endsRaw ? new Date(`${endsRaw}T23:59:59Z`) : null;

  await leaderboard.save({
    chat,
    chatName,
    cron: String(formData.get("cron") ?? "").trim() || undefined,
    quietFrom: number(formData, "quietFrom"),
    quietTo: number(formData, "quietTo"),
    maxPerDay: number(formData, "maxPerDay"),
    // An unchecked checkbox posts nothing at all, so absence is the "off" value.
    onChangeOnly: formData.get("onChangeOnly") !== null,
    withPicture: formData.get("withPicture") !== null,
    note: String(formData.get("note") ?? ""),
    endsAt: endsAt && !Number.isNaN(endsAt.getTime()) ? endsAt : null,
  });

  revalidatePath("/dashboard/leaderboard");
}

export async function toggleWatch(formData: FormData): Promise<void> {
  const chat = String(formData.get("chat") ?? "");
  const on = String(formData.get("on") ?? "") === "true";
  if (!chat) return;

  await leaderboard.setEnabled(chat, on);
  revalidatePath("/dashboard/leaderboard");
}

export async function deleteWatch(formData: FormData): Promise<void> {
  const chat = String(formData.get("chat") ?? "");
  if (!chat) return;

  await leaderboard.remove(chat);
  revalidatePath("/dashboard/leaderboard");
}

/**
 * Send one now, past the cron, past the change test and past the quiet hours.
 *
 * This is how the feature gets tested without waiting for a schedule, which is the difference
 * between finding a problem in a minute and finding it tomorrow. A person pressing a button
 * means now, so the restraint that exists to keep the *schedule* quiet does not apply — but it
 * still counts against the daily cap, because the group hears it either way.
 */
export async function sendNow(formData: FormData): Promise<void> {
  const chat = String(formData.get("chat") ?? "");
  if (!chat) return;

  const watch = await leaderboard.forChat(chat);
  if (!watch) return;

  // The reading is memoised for a few seconds; a person asking for it now wants the live figure.
  leaderboard.forget();

  try {
    await announce(watch, new Date(), true);
  } catch (err) {
    await leaderboard
      .markFailed(chat, err instanceof Error ? err.message : String(err))
      .catch(() => undefined);
  }

  revalidatePath("/dashboard/leaderboard");
}
