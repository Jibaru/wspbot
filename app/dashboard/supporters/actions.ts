"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import * as supporters from "@/lib/supporters";

/**
 * Every change clears the handle cache, so a new supporter is starred on the rate-limit page at
 * once rather than whenever the minute happens to be up.
 */
const touched = () => {
  supporters.forget();
  revalidatePath("/dashboard/supporters");
  revalidatePath("/dashboard/limits");
};

export async function addSupporter(formData: FormData): Promise<void> {
  const name = String(formData.get("name") ?? "").trim();
  const via = String(formData.get("via") ?? "other");
  if (!name) return;

  await supporters.add({
    name,
    handles: String(formData.get("handles") ?? "").trim() || null,
    via: (["yape", "coffee", "code", "other"].includes(via) ? via : "other") as supporters.Via,
    note: String(formData.get("note") ?? "").trim() || null,
    coffees: Number(formData.get("coffees")) || 1,
  });
  touched();
}

export async function updateSupporter(formData: FormData): Promise<void> {
  const id = Number(formData.get("id"));
  const name = String(formData.get("name") ?? "").trim();
  if (!Number.isInteger(id) || !name) return;

  await supporters.update(id, {
    name,
    handles: String(formData.get("handles") ?? "").trim() || null,
    note: String(formData.get("note") ?? "").trim() || null,
    coffees: Number(formData.get("coffees")) || 1,
  });
  touched();
}

export async function removeSupporter(formData: FormData): Promise<void> {
  const id = Number(formData.get("id"));
  if (!Number.isInteger(id)) return;

  await supporters.remove(id);
  touched();
}

/**
 * Pull from Buy Me a Coffee. The outcome goes back in the URL rather than being swallowed,
 * because "it worked and found nothing new" and "the token is wrong" look identical otherwise.
 */
export async function syncCoffee(): Promise<void> {
  let params: URLSearchParams;
  try {
    const { added, seen } = await supporters.syncCoffee();
    params = new URLSearchParams({ added: String(added), seen: String(seen) });
  } catch (err) {
    params = new URLSearchParams({
      failed: err instanceof Error ? err.message : String(err),
    });
  }
  touched();
  redirect(`/dashboard/supporters?${params.toString()}`);
}
