"use server";

import { revalidatePath } from "next/cache";
import * as memory from "@/lib/memory";

/**
 * Deleting a fact from here passes no chat, which is the unscoped form: the dashboard is
 * already above any one conversation, and scoping it would make global facts undeletable.
 */
export async function forgetMemory(formData: FormData): Promise<void> {
  const id = String(formData.get("id") ?? "");
  if (!id) return;

  await memory.remove(id);
  revalidatePath("/memory");
  revalidatePath("/");
}
