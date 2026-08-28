import { signIn } from "./actions";

/**
 * The sign-in page.
 *
 * A Server Action rather than a route handler and client fetch: the form works without
 * JavaScript, and the password never exists in client state.
 */

export const dynamic = "force-dynamic";

export const metadata = { title: "wspbot — sign in" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const { next } = await searchParams;

  /**
   * The action is bound rather than wrapped, so the form posts straight to it. `useActionState`
   * would need a client component for the sake of one error line — not worth the boundary.
   */
  const submit = async (formData: FormData) => {
    "use server";
    const result = await signIn(undefined, formData);
    if (result?.error) {
      const { redirect } = await import("next/navigation");
      const params = new URLSearchParams({ error: "1" });
      if (formData.get("next")) params.set("next", String(formData.get("next")));
      redirect(`/login?${params.toString()}`);
    }
  };

  const failed = (await searchParams).error === "1";

  return (
    <main className="signin">
      <form action={submit}>
        <h1>wspbot</h1>
        <p className="lede">Sign in to see the dashboard.</p>

        <label htmlFor="username">Username</label>
        <input
          id="username"
          name="username"
          autoComplete="username"
          autoFocus
          required
        />

        <label htmlFor="password">Password</label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
        />

        <input type="hidden" name="next" value={next ?? "/dashboard"} />

        {/* One message for either mistake, so the form cannot be used to find valid usernames. */}
        {failed && <p className="bad">Wrong username or password.</p>}

        <button type="submit">Sign in</button>
      </form>
    </main>
  );
}
