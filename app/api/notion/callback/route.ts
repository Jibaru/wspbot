import { config } from "@/lib/config";
import { wapi } from "@/lib/wapi";
import { completeConnection, NotionError } from "@/lib/notion";
import { decodeState, StateError } from "@/lib/oauth-state";

/**
 * Where Notion sends people back after they choose what to share.
 *
 * The `state` decides which chat this connection belongs to, and it is signed — without that,
 * anyone who found this URL could bind their own workspace to someone else's conversation.
 *
 * Whoever lands here is a person in a browser, so failures are explained in plain words rather
 * than returned as a status code they will never see.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const page = (title: string, message: string, tone: "ok" | "bad") => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; min-height:100dvh; display:grid; place-items:center;
         font:16px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
         background:#fbfbfa; color:#1b1b19; padding:2rem; }
  @media (prefers-color-scheme: dark){ body{ background:#161613; color:#edece7; } }
  .card { max-width:26rem; text-align:center; }
  h1 { font-size:1.25rem; margin:0 0 .5rem; color:${tone === "ok" ? "#1f7a4d" : "#a8560f"}; }
  p { margin:0; color:#6f6d66; }
</style></head>
<body><div class="card"><h1>${title}</h1><p>${message}</p></div></body></html>`;

const html = (body: string, status: number) =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });

export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  // Notion sends `error` when someone declines, which is a normal outcome, not a failure.
  if (error) {
    return html(page("Not connected", `Notion said: ${error}. Nothing was changed.`, "bad"), 200);
  }

  const notion = config.notion();
  if (!notion) {
    return html(page("Not configured", "This bot has no Notion credentials set.", "bad"), 500);
  }
  if (!code || !state) {
    return html(page("Something is missing", "That link was incomplete.", "bad"), 400);
  }

  let chat: string;
  try {
    chat = decodeState(state, notion.clientSecret);
  } catch (err) {
    // StateError carries the reason worth showing: expired, or not issued by this bot.
    const why = err instanceof StateError ? err.message : "that link is not valid";
    return html(page("Link not valid", why, "bad"), 400);
  }

  try {
    const connection = await completeConnection(code, chat);
    const where = connection.workspaceName ? ` to ${connection.workspaceName}` : "";

    /**
     * Told in the chat as well as in the browser: the person who authorised may not be the one
     * watching, and everyone in the room should know the bot just gained access.
     */
    await wapi
      .sendText(
        chat,
        `Connected to Notion${where}. I can now read and write the pages you shared with me.`,
      )
      .catch((err) => console.error("[notion] could not confirm in chat", err));

    return html(
      page("Connected", `This chat is now linked${where}. You can close this tab.`, "ok"),
      200,
    );
  } catch (err) {
    const why = err instanceof NotionError ? err.message : "the exchange failed";
    console.error("[notion] callback failed:", err);
    return html(page("Could not connect", why, "bad"), 502);
  }
}
