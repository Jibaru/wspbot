"use server";

import { revalidatePath } from "next/cache";
import * as github from "@/lib/github";
import { wapi } from "@/lib/wapi";

/**
 * The token arrives in a form post and is never sent back out again. `connect` verifies it with
 * GitHub before storing it, so a typo is caught here rather than by somebody in a group being
 * told a repository does not exist.
 */

export async function connectGithub(formData: FormData): Promise<void> {
  const token = String(formData.get("token") ?? "");
  if (!token.trim()) return;

  try {
    await github.connect(token);
  } catch (err) {
    // Surfaced on the page rather than thrown: a bad token is a normal thing to type.
    console.error("[github] connect failed:", err instanceof Error ? err.message : err);
  }
  revalidatePath("/dashboard/github");
}

export async function disconnectGithub(): Promise<void> {
  await github.disconnect();
  revalidatePath("/dashboard/github");
}

export async function savePermissions(formData: FormData): Promise<void> {
  const on = (key: string) => formData.get(key) === "on";
  await github.setPermissions({
    owner: String(formData.get("owner") ?? ""),
    canOpenIssues: on("canOpenIssues"),
    canComment: on("canComment"),
    canCreateRepos: on("canCreateRepos"),
    canDeployPages: on("canDeployPages"),
    // The checkbox reads "allow public repositories", so it is the inverse of what is stored.
    reposPrivate: !on("allowPublic"),
    maxWritesPerDay: Number(formData.get("maxWritesPerDay") ?? 10),
  });
  revalidatePath("/dashboard/github");
}

/**
 * The whole set of chats, posted at once. `forgetScope` matters here for the same reason the
 * recorder's cache does: a group ticked on this page should work on the next message, not in
 * thirty seconds.
 */
export async function saveScope(formData: FormData): Promise<void> {
  const mode = String(formData.get("mode") ?? "everywhere") === "listed" ? "listed" : "everywhere";
  const picked = formData.getAll("chats").map(String).filter(Boolean);

  // The name comes from the checkbox value, which carries both, so a group the bot later leaves
  // still reads as a name rather than a JID.
  const groups = await wapi.groups().catch(() => []);
  await github.setChats(
    picked.map((chat) => ({
      chat,
      chatName: groups.find((g) => g.jid === chat)?.name ?? null,
    })),
    mode,
  );

  github.forgetScope();
  revalidatePath("/dashboard/github");
}

export async function allowRepo(formData: FormData): Promise<void> {
  const repo = String(formData.get("repo") ?? "");
  if (!repo.trim()) return;
  try {
    await github.allow(repo);
  } catch (err) {
    console.error("[github] could not add a repo:", err instanceof Error ? err.message : err);
  }
  revalidatePath("/dashboard/github");
}

export async function disallowRepo(formData: FormData): Promise<void> {
  const repo = String(formData.get("repo") ?? "");
  if (!repo.trim()) return;
  await github.disallow(repo);
  revalidatePath("/dashboard/github");
}
