import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, verifySession } from "./lib/auth";

/**
 * Gates the dashboard.
 *
 * `proxy.ts`, not `middleware.ts`: Next 16 renamed the convention and warns on the old name.
 *
 * The matcher is the load-bearing part. `/api/wapi/webhook` is called by wapi and
 * `/api/notion/callback` by Notion — neither carries a session cookie, and gating either would
 * silently stop the bot receiving messages or finishing an OAuth flow. So this covers the pages
 * only, and the API routes are explicitly excluded rather than left to a broad pattern.
 *
 * Static files are excluded by having a dot in the name, which is every icon, the manifest and
 * anything else dropped into `public/`. Naming `favicon.ico` alone was not enough: the rest of
 * the icon set answered a signed-out browser with a redirect, so the tab fell back to a blank
 * page icon and the manifest never loaded. None of it is private, and no page route here has a
 * dot in its path.
 *
 * Only the signed cookie is checked here. bcrypt lives in the sign-in action, because it is
 * deliberately slow and has no business running on every page view.
 */

export const config = {
  matcher: [
    /*
     * Everything except: the sign-in page and its action, the API routes that outside services
     * call, Next's own assets, and any path with a file extension.
     *
     * The doubled backslash is load-bearing. `"\."` in a TypeScript string is an invalid
     * escape that collapses to a plain `"."`, turning the exclusion into "any non-empty path"
     * — which silently ungated every page but the root. `npm run smoke` asserts the behaviour
     * of this string so it cannot happen again quietly.
     */
    "/((?!login|api/|_next/|.*\\.).*)",
  ],
};

export async function proxy(request: NextRequest) {
  const secret = process.env["AUTH_SECRET"];

  /**
   * With no secret configured there is no way to verify anything, so the dashboard is closed
   * rather than left open. Failing shut is the only safe direction for an auth check.
   */
  if (!secret) {
    return new NextResponse(
      "This dashboard has no AUTH_SECRET set, so sign-in is impossible.",
      { status: 503, headers: { "content-type": "text/plain" } },
    );
  }

  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (await verifySession(token, secret)) return NextResponse.next();

  const login = new URL("/login", request.url);
  // Remembered so signing in returns you where you were headed.
  if (request.nextUrl.pathname !== "/") {
    login.searchParams.set("next", request.nextUrl.pathname);
  }
  return NextResponse.redirect(login);
}
