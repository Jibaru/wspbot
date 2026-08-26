<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# wspbot

A WhatsApp bot that answers when tagged in a group. Next.js app deployed as a Docker container on
a Dokploy VPS at `wspbot.crafter.run`. Built by Jibaru of Crafter Station (jibaru.dev).

## Shape

```
WhatsApp ──▶ wapi ──POST /api/wapi/webhook──▶ this app
                                                 ├─▶ OpenAI via the Vercel AI SDK (+ web search)
                                                 ├─▶ ffmpeg (stickers, voice notes)
                                                 ├─▶ Postgres (memory, history, stickers, usage)
                                                 └─▶ wapi /api/send-message ──▶ WhatsApp
```

```
app/page.tsx                     status page: session, usage, stickers, memory
app/api/wapi/webhook/route.ts    the only entry point for inbound messages
instrumentation.ts               starts the session watchdog at boot
lib/agent.ts                     the model turn: prompt + every tool
lib/about.ts                     what the bot knows about itself
lib/notion.ts                    Notion OAuth + page operations
lib/oauth-state.ts               signed OAuth state (no server-only, so it is testable)
lib/memory.ts                    facts, per chat or global
lib/stickers.ts                  the shared sticker library
lib/sticker-maker.ts             ffmpeg: anything -> 512x512 WebP
lib/audio.ts                     TTS output -> Ogg/Opus
lib/ffmpeg.ts                    shared ffmpeg runner + scratch dirs
lib/fetch-media.ts               guarded remote downloads (SSRF)
lib/mentions.ts                  parsing message nodes, "is this for me?"
lib/session.ts                   reconnecting a dropped WhatsApp session
lib/usage.ts                     token accounting, cost estimate
lib/signature.ts  lib/wapi.ts  lib/db.ts  lib/config.ts
```

## Things that will be re-broken if you don't know them

Each of these cost real debugging time. They are counter-intuitive, and every one of them looks
like a simplification opportunity.

- **wapi cannot be polled.** There is no endpoint listing received messages — only a log of
  *sent* ones. Inbound exists solely as a webhook push. Nothing here polls for messages, and
  nothing can.
- **Voice notes must be Ogg/Opus, mono, 48kHz.** mp3 plays fine in WhatsApp Web and not at all in
  the mobile app, so the bug is invisible from a laptop. Do not "simplify" `lib/audio.ts`.
- **WhatsApp does not send GIFs as GIFs.** The GIF tray produces a `videoMessage` with
  `gifPlayback: true` — an mp4. A real `.gif` shared as a file arrives as a document. Never infer
  "animated" from the mimetype.
- **`format=rgba` before `pad`** in the sticker filter chain. Without it the padding encodes as
  opaque black and a portrait photo comes out letterboxed instead of transparent.
- **Inbound media is encrypted**, and `decrypt-media` returns a URL that dies after an hour.
  Anything worth keeping must be fetched and re-uploaded; storing the decrypted URL leaves a
  library of dead links by tomorrow.
- **Two wapi tokens, not interchangeable.** Session key for messaging, Personal Access Token for
  session admin (`connect`). The wrong *type* returns **403**, not 401.
- **`sslmode=require` means different things** to libpq and to `pg` 8.23+, which also verifies the
  certificate. `lib/db.ts` opts into libpq's meaning; managed Postgres usually presents a
  self-signed cert.
- **Acknowledge the webhook before doing the work.** wapi retries on any non-2xx and a model turn
  takes seconds, so a slow handler turns one message into several. Work happens in `after()`.
- **Deduplicate in Postgres, not in memory.** Deliveries retry, and an in-process `Set` survives
  neither a restart nor a second instance.
- **Never `fetch` a model-supplied URL directly.** `lib/fetch-media.ts` resolves and rejects
  private ranges before connecting and re-validates every redirect hop; a public URL can redirect
  to `169.254.169.254`.
- **A drawn sticker needs `background: "transparent"`.** Without it the image comes back on a
  white card and looks broken beside real stickers — and nothing in a typecheck catches that.
  `npm run draw-check` generates one and verifies the alpha channel survives.
- **A reply carries a full copy of what it replies to**, in `contextInfo.quotedMessage` — keys
  included, so quoted media decrypts exactly like a top-level attachment. That copy is the whole
  point of a reply: the words rarely carry the meaning without it.
- **The Notion OAuth `state` must stay signed.** It carries which chat is connecting; forgeable,
  it would let anyone who found the callback bind their workspace to someone else's conversation.
  `lib/oauth-state.ts` is deliberately free of `server-only` so `npm run smoke` can test it.
- **Groups only, and only when tagged.** DMs are ignored by default (`BOT_REPLY_TO_DMS`).
  Stickers are the sole exception: collected untagged, silently, never answered.

## Conventions

- Tools deliver into the chat as they run, so a turn can end with nothing left to say. `reply()`
  returns `{text, sent}`, and the route skips the final send when `text` is empty.
- Tool failures are **returned to the model**, not thrown — it can explain or try another way.
  Background work (sticker capture, usage recording) swallows errors instead: it must never cost
  a reply someone is waiting for.
- Memory is read from the system prompt and written through tools, so recall never depends on the
  model deciding to look something up.
- Schema changes go in the idempotent DDL in `lib/db.ts`, which runs on first query. **A throw
  there kills every request**, so verify a migration against a real database before deploying, and
  guard destructive steps so they run exactly once.
- A new capability updates **both** feature lists: `FEATURES` in `app/page.tsx` (for people) and
  the capability sentence in `lib/about.ts` (for the model). The second is prose in a file nobody
  renders, so it rots silently — the bot then undersells itself when asked what it can do.
- `lib/about.ts` describes the deployment, so it lives in code rather than the database — it
  should change in the same commit the deployment does. Nothing secret goes in it; it is read
  aloud to whoever asks.

## Checks

```bash
npm run smoke           # signature verification + "is this for me?" — no keys needed
npm run sticker-check   # real ffmpeg conversion + the SSRF guard (needs ffmpeg)
npm run voice-check     # voice notes really are Ogg/Opus mono 48kHz, per ffprobe
npm run draw-check      # one real image generation, checks alpha survives (costs money)
npm run build           # typecheck + production build
```

Prefer verifying against the real thing over asserting. These scripts read the WebP container and
probe the audio rather than trusting a file extension, because that is the class of bug that
survives a typecheck.

## Deploying

Auto-deploys on push to `main`. **Change environment variables first, then push** — the push
triggers a build immediately, so env set afterwards needs a second redeploy to take effect.

```bash
vps compose env 2ut0ntUFzz-aGHOyjQb8r --set "$ENVSTR" --json   # env first
git push                                                       # then code
```

ffmpeg is installed in the runner stage, and the Dockerfile greps for `libwebp` and `libopus` so a
base image without them fails the build rather than the feature.
