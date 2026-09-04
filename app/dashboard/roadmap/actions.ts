"use server";

import { revalidatePath } from "next/cache";
import * as roadmap from "@/lib/roadmap";

/**
 * The roadmap is public on the landing page, so every change revalidates it too — otherwise an
 * approved item would sit invisible for up to the five minutes that page is cached for.
 */
const touched = () => {
  revalidatePath("/dashboard/roadmap");
  revalidatePath("/");
};

export async function addItem(formData: FormData): Promise<void> {
  const title = String(formData.get("title") ?? "").trim();
  if (!title) return;

  await roadmap.add({
    title,
    detail: String(formData.get("detail") ?? "").trim() || null,
    // Added from the dashboard, so it is votable straight away — there is nobody to approve it past.
    state: "open",
  });
  touched();
}

export async function setItemState(formData: FormData): Promise<void> {
  const id = Number(formData.get("id"));
  const state = String(formData.get("state") ?? "");
  if (!Number.isInteger(id)) return;
  if (!["proposed", "open", "shipped", "declined"].includes(state)) return;

  await roadmap.setState(id, state as roadmap.State);
  touched();
}

export async function removeItem(formData: FormData): Promise<void> {
  const id = Number(formData.get("id"));
  if (!Number.isInteger(id)) return;

  // The votes go with it: the foreign key cascades, so no orphan rows are left behind.
  await roadmap.remove(id);
  touched();
}
