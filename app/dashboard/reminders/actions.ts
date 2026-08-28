"use server";

import { revalidatePath } from "next/cache";
import * as reminders from "@/lib/reminders";

/**
 * One reminder per person per chat, so the pair is the whole identity — there is no id to pass
 * and nothing to disambiguate.
 */
export async function cancelReminder(formData: FormData): Promise<void> {
  const chat = String(formData.get("chat") ?? "");
  const userId = String(formData.get("userId") ?? "");
  if (!chat || !userId) return;

  await reminders.cancel(chat, userId);
  revalidatePath("/dashboard/reminders");
  revalidatePath("/dashboard");
}
