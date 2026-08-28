"use server";

import { revalidatePath } from "next/cache";
import * as stickers from "@/lib/stickers";

/**
 * Ids stay strings the whole way. `lib/stickers.ts` parses both `12` and the `s12` form the
 * model uses, so handing it the id verbatim keeps one parser rather than two that can disagree.
 */

export async function renameSticker(formData: FormData): Promise<void> {
  const id = String(formData.get("id") ?? "");
  const label = String(formData.get("label") ?? "").trim();
  if (!id || !label) return;

  await stickers.rename(id, label);
  revalidatePath("/dashboard/stickers");
}

/**
 * Permanent, and the stored bytes go with it — once a wapi upload URL has expired the library
 * is the only copy. The confirmation is on the form, in the browser.
 */
export async function deleteSticker(formData: FormData): Promise<void> {
  const id = String(formData.get("id") ?? "");
  if (!id) return;

  await stickers.remove(id);
  revalidatePath("/dashboard/stickers");
  revalidatePath("/dashboard");
}
