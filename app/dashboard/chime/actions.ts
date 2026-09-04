"use server";

import { revalidatePath } from "next/cache";
import * as chime from "@/lib/chime";
import { wapi } from "@/lib/wapi";

/**
 * Every one of these calls `forget`. The recorder caches which chats to record for half a
 * minute, and a group enabled here has to start being recorded now — otherwise the first
 * conversation the bot was meant to be reading is the one it missed.
 */

const number = (form: FormData, key: string): number | undefined => {
  const raw = form.get(key);
  if (raw === null || String(raw).trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
};

export async function saveChime(formData: FormData): Promise<void> {
  const chat = String(formData.get("chat") ?? "");
  if (!chat) return;

  /**
   * The name is resolved here rather than posted, since a `<select>` submits only its value. It
   * is stored so the page still reads sensibly when wapi is unreachable, or after the bot is
   * removed from the group and the name can no longer be looked up at all.
   */
  const groups = await wapi.groups().catch(() => []);
  const chatName = groups.find((g) => g.jid === chat)?.name ?? null;

  await chime.save({
    chat,
    chatName,
    everyMinutes: number(formData, "everyMinutes"),
    minMessages: number(formData, "minMessages"),
    quietFrom: number(formData, "quietFrom"),
    quietTo: number(formData, "quietTo"),
    maxPerDay: number(formData, "maxPerDay"),
    note: String(formData.get("note") ?? ""),
  });

  chime.forget();
  revalidatePath("/dashboard/chime");
}

export async function toggleChime(formData: FormData): Promise<void> {
  const chat = String(formData.get("chat") ?? "");
  const on = String(formData.get("on") ?? "") === "true";
  if (!chat) return;

  await chime.setEnabled(chat, on);
  chime.forget();
  revalidatePath("/dashboard/chime");
}

export async function deleteChime(formData: FormData): Promise<void> {
  const chat = String(formData.get("chat") ?? "");
  if (!chat) return;

  await chime.remove(chat);
  chime.forget();
  revalidatePath("/dashboard/chime");
}
