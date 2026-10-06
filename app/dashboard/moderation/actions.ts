"use server";

import { revalidatePath } from "next/cache";
import * as moderation from "@/lib/moderation";
import { wapi } from "@/lib/wapi";

/**
 * `forget` after every change, for the same reason as every other per-chat cache here: a group
 * switched off on this page has to stop being a group the bot can act in on the next message,
 * not in thirty seconds. On this feature that difference is somebody being removed.
 */

export async function saveModeration(formData: FormData): Promise<void> {
  const chat = String(formData.get("chat") ?? "");
  if (!chat) return;

  const on = (key: string) => formData.get(key) === "on";
  const groups = await wapi.groups().catch(() => []);

  await moderation.save({
    chat,
    chatName: groups.find((g) => g.jid === chat)?.name ?? null,
    onRequest: on("onRequest"),
    onOwnJudgement: on("onOwnJudgement"),
    warnFirst: on("warnFirst"),
    warnWindowHours: Number(formData.get("warnWindowHours") ?? 24),
    maxPerDay: Number(formData.get("maxPerDay") ?? 2),
    note: String(formData.get("note") ?? ""),
  });

  moderation.forget();
  revalidatePath("/dashboard/moderation");
}

export async function toggleModeration(formData: FormData): Promise<void> {
  const chat = String(formData.get("chat") ?? "");
  const on = String(formData.get("on") ?? "") === "true";
  if (!chat) return;

  await moderation.setEnabled(chat, on);
  moderation.forget();
  revalidatePath("/dashboard/moderation");
}

export async function deleteModeration(formData: FormData): Promise<void> {
  const chat = String(formData.get("chat") ?? "");
  if (!chat) return;

  await moderation.remove(chat);
  moderation.forget();
  revalidatePath("/dashboard/moderation");
}
