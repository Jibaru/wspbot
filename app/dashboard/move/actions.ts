"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import * as transfer from "@/lib/transfer";

/**
 * Moving context between groups.
 *
 * The outcome of each item matters — a reminder that collided is not the same as one that
 * moved — so the result is carried back in the URL rather than swallowed. It is a redirect
 * rather than a rendered response so a refresh cannot move the same things twice.
 */
export async function moveContext(formData: FormData): Promise<void> {
  const from = String(formData.get("from") ?? "");
  const to = String(formData.get("to") ?? "");
  const mode = String(formData.get("mode") ?? "move") === "copy" ? "copy" : "move";
  const refs = formData.getAll("ref").map(String).filter(Boolean);

  if (!from || !to || from === to || refs.length === 0) {
    redirect(`/dashboard/move?from=${encodeURIComponent(from)}&error=1`);
  }

  const outcomes = await transfer.transfer(from, to, refs, mode);
  const moved = outcomes.filter((o) => o.done).length;
  const failed = outcomes.filter((o) => !o.done);

  console.log(
    `[transfer] ${mode} ${moved}/${outcomes.length} from ${from} to ${to}` +
      (failed.length ? ` — ${failed.length} refused` : ""),
  );

  revalidatePath("/dashboard/move");
  revalidatePath("/dashboard/memory");
  revalidatePath("/dashboard/reminders");
  revalidatePath("/dashboard");

  const params = new URLSearchParams({
    from,
    to,
    moved: String(moved),
    of: String(outcomes.length),
  });
  // Only the refusals need explaining; the rest is a count.
  for (const f of failed) params.append("skipped", `${f.label} — ${f.why ?? "refused"}`);

  redirect(`/dashboard/move?${params.toString()}`);
}
