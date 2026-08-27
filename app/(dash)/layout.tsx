import { signOut } from "../login/actions";
import { Nav } from "./nav";

/**
 * The dashboard shell: title, section nav, sign-out.
 *
 * A route group rather than a path segment, so every page here is still at its own top-level
 * URL — `/features`, not `/dash/features`. The sign-in page sits outside the group and so keeps
 * none of this chrome.
 *
 * Nothing here checks the session. `proxy.ts` does that for every page in one place, which is
 * the only way to be sure a page added later cannot forget to.
 */
export default function DashboardLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <main>
      <div className="masthead">
        <h1>wspbot</h1>
        <form action={signOut}>
          <button type="submit" className="signout">
            Sign out
          </button>
        </form>
      </div>
      <Nav />
      {children}
    </main>
  );
}
