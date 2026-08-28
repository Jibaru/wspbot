"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { compare } from "bcryptjs";
import { config } from "@/lib/config";
import { SESSION_COOKIE, SESSION_MAX_AGE_SECONDS, createSession } from "@/lib/auth";

/**
 * Signing in.
 *
 * The only place bcrypt runs. It is slow on purpose — a few hundred milliseconds — which is what
 * makes it a good password hash and why the session afterwards is a cheap signed cookie instead.
 */

/**
 * The same failure for a wrong name and a wrong password, so the form cannot be used to discover
 * which usernames exist. And bcrypt is run either way: returning early on an unknown user makes
 * the response measurably faster, which says the same thing in timing.
 */
const WRONG = "Wrong username or password.";

/** Compared against, so a bad username costs the same time as a bad password. */
const DUMMY_HASH = "$2b$12$" + "z".repeat(53);

export async function signIn(
  _previous: { error?: string } | undefined,
  formData: FormData,
): Promise<{ error?: string }> {
  const username = String(formData.get("username") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const next = String(formData.get("next") ?? "/dashboard");

  const admin = config.admin();
  if (!admin) {
    return { error: "No credentials are configured on this deployment." };
  }

  const nameMatches = username === admin.username;
  const passwordMatches = await compare(
    password,
    nameMatches ? admin.passwordHash : DUMMY_HASH,
  ).catch(() => false);

  if (!nameMatches || !passwordMatches) return { error: WRONG };

  const store = await cookies();
  store.set(SESSION_COOKIE, await createSession(config.authSecret()), {
    httpOnly: true,
    // Not readable by script, not sent cross-site, and HTTPS-only in production.
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });

  // Only ever within this site: an open redirect would turn sign-in into a phishing vector.
  redirect(next.startsWith("/") && !next.startsWith("//") ? next : "/dashboard");
}

export async function signOut(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
  redirect("/login");
}
