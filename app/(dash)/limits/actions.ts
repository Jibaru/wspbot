"use server";

import { revalidatePath } from "next/cache";
import * as rateLimit from "@/lib/rate-limit";

/**
 * Quotas are set here rather than through the bot, and that is deliberate: `lib/rate-limit.ts`
 * has no tool for changing them, because a bot that raises your limit when you ask nicely is not
 * a rate limiter. This page is on the other side of a sign-in, which is a different thing.
 */

export async function saveQuota(formData: FormData): Promise<void> {
  const userId = String(formData.get("userId") ?? "").trim();
  const perMinute = Number(formData.get("perMinute"));
  const note = String(formData.get("note") ?? "").trim();

  /**
   * Zero would read as "no calls allowed" but the checker treats a non-positive quota as unset
   * and falls back to the default — so it would quietly do the opposite of what it looks like.
   */
  if (!userId || !Number.isFinite(perMinute) || perMinute < 1) return;

  await rateLimit.setQuota(userId, Math.floor(perMinute), note || null);
  revalidatePath("/limits");
}

export async function removeQuota(formData: FormData): Promise<void> {
  const userId = String(formData.get("userId") ?? "").trim();
  if (!userId) return;
  await rateLimit.clearQuota(userId);
  revalidatePath("/limits");
}
