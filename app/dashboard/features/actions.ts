"use server";

import { revalidatePath } from "next/cache";
import * as features from "@/lib/features";
import { config } from "@/lib/config";

/**
 * Flipping a switch.
 *
 * `setEnabled` rejects a key that is not in the registry, so a hand-crafted form post cannot
 * write a row that nothing will ever read — and the next turn's tool list is built from the
 * registry either way, so a stray row could not enable anything that does not exist.
 */
export async function toggleFeature(formData: FormData): Promise<void> {
  const key = String(formData.get("key") ?? "");
  const on = String(formData.get("on") ?? "") === "true";

  await features.setEnabled(key, on);

  /**
   * The overview counts how many are on, so it goes stale too. Nothing else needs it: the bot
   * reads the table per turn rather than from a cache.
   */
  revalidatePath("/dashboard/features");
  revalidatePath("/dashboard");
}

/** Whether the deployment can actually back a feature that needs outside credentials. */
export async function configured(): Promise<{ notion: boolean; sheets: boolean }> {
  return {
    notion: Boolean(config.notion()),
    sheets: Boolean(config.googleServiceAccount()),
  };
}
