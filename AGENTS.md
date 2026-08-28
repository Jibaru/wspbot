<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# wspbot

A WhatsApp bot that answers when tagged in a group. Next.js app deployed as a Docker container on
a Dokploy VPS at `wspbot.crafter.run`. Built by Jibaru of Crafter Station (jibaru.dev).

## Shape

Two ways in, and they share almost nothing. Messages arrive as a webhook push and are answered
by the model; the dashboard is a set of gated pages that configure what the model is allowed to
do. The `features` table is the only thing both halves touch.

```
WhatsApp ──▶ wapi ──POST /api/wapi/webhook──▶ this app
                                                 ├─▶ OpenAI via the Vercel AI SDK (+ web search)
                                                 ├─▶ ffmpeg (stickers, voice notes, video)
                                                 ├─▶ Postgres ◀── the dashboard writes here
                                                 └─▶ wapi, via the vendored SDK ──▶ WhatsApp

you ──▶ /login ──▶ proxy.ts ──▶ /features /limits /stickers /memory /reminders /usage
                                     │
                                     └─▶ features table ──▶ which tools a turn is given
```

**Inbound**

```
app/api/wapi/webhook/route.ts    the only entry point for messages; verify, ack, work in after()
lib/signature.ts                 webhook signature verification (plain compare or HMAC)
lib/mentions.ts                  parsing message nodes, "is this for me?"
lib/inbound-media.ts             decrypting what arrived attached
```

**The turn**

```
lib/agent.ts                     prompt + every tool; the whole model turn
lib/features.ts                  the registry: switches, tool ownership, self-description
lib/about.ts                     what the bot knows about itself
lib/memory.ts                    facts, per chat or global
lib/tasks.ts                     the per-chat checklist
lib/reminders.ts                 scheduled work; lib/reminder-runner.ts fires it
lib/rate-limit.ts                per-person quotas, checked before anything costs money
lib/summaries.ts                 scheduled digests: schedules, the log, the transcript
lib/summary-recorder.ts          writing down a recorded group; lib/summary-runner.ts fires it
lib/cron.ts                      five-field cron, evaluated as "does this minute match?"
lib/usage.ts                     token accounting, cost estimate
```

**Dashboard**

```
proxy.ts                         gates every page (Next 16 renamed middleware -> proxy)
lib/auth.ts                      bcrypt at sign-in, signed cookie thereafter
app/login/                       sign-in page and its server action
app/page.tsx                     the public landing page (the only ungated route)
app/landing.css                  its brand styles, scoped under .lp
app/crafter-mark.tsx             the real Crafter Station mark and horizontal lockup
app/dashboard/                   one route per section, each with its own actions.ts
app/dashboard/layout.tsx         shell + nav; nav.tsx is the only client component
public/                          generated icon set; rebuild from public/icon.config.json
```

**Outbound and media**

```
lib/wapi.ts                      thin facade over the SDK: server-only, identity cache, 2 clients
lib/wapi-sdk/                    the official wapi SDK, vendored (see below)
lib/stickers.ts                  the shared sticker library
lib/sticker-maker.ts             ffmpeg: anything -> 512x512 WebP
lib/audio.ts                     TTS output -> Ogg/Opus
lib/video.ts                     anything -> H.264/AAC MP4
lib/ffmpeg.ts                    shared ffmpeg runner + scratch dirs
lib/fetch-media.ts               guarded remote downloads (SSRF)
```

**Integrations and plumbing**

```
lib/notion.ts                    Notion OAuth + page operations
lib/oauth-state.ts               signed OAuth state (no server-only, so it is testable)
lib/sheets.ts                    Google Sheets read and write
lib/session.ts                   reconnecting a dropped WhatsApp session
instrumentation.ts               starts the session watchdog and the reminder tick at boot
lib/db.ts                        Postgres pool + the idempotent DDL
lib/config.ts                    environment, validated at the point of use
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
- **Usage is billed in three different units** — language calls per token, speech per character,
  images per image — so `lib/usage.ts` groups by kind. Lumping them together let an unpriced
  image model void the entire cost estimate, which read as "cost unknown" for everything.
- **The rate-limit check must stay before the model call**, not after. It exists to avoid
  spending money on the eleventh message in a minute, so moving it later defeats it entirely.
  Refused calls are not recorded, or the window never drains.
- **Video must be re-encoded, not forwarded.** H.264 baseline / yuv420p / AAC in MP4 is what
  plays; VP9, HEVC and AV1 show a thumbnail that never starts, on every client. Same class as the
  voice-note bug and equally invisible locally. `npm run video-check` asserts it with ffprobe.
- **A claimed one-off reminder must have its `next_at` moved forward**, not left alone. Left
  alone the row is still due while it runs, and any run slower than the tick fires it twice —
  caught only by claiming the same row twice against a real database.
- **`public/` must be copied into the runner stage by hand.** `output: "standalone"` traces
  imports, and nothing imports a favicon, so the directory is not in the trace. Everything in it
  then 404s in production while `next start` serves it locally — the icons were live in the
  HTML and missing from the image.
- **`bigserial` comes back from `pg` as a string.** `logged_messages.id` compared `=== 3` is
  false for the row whose id is `"3"`, so the digest silently attached no pictures at all while
  every type checked out. Coerced at the boundary in `windowFor`. Suspect it wherever an id is
  compared rather than interpolated.
- **A picture is described when it arrives, never later.** Inbound media is encrypted and the
  decrypted URL dies within the hour, so a digest that runs tomorrow can only know what was
  written down today. That is also why the recorder re-uploads: that URL does not expire, and it
  is the only way the digest can still attach the image.
- **The model gets picture numbers, not row ids.** Asked to cite `#4821` it answers `3`, meaning
  the third picture. `summaries.render` numbers them 1..n per digest and returns the mapping in
  the same call, so the numbering and the lookup cannot drift apart.
- **Recording is the only place the bot reads messages nobody sent it.** Gated on the feature
  *and* on the chat being the source of an enabled schedule, cached for 30s because it is
  consulted for every message in every group. `systemPrompt` tells the bot when the room it is
  in is being recorded, so "are you logging this?" gets a true answer.
- **The wapi SDK is vendored, not installed, and needs one edit on the way in.** It is not
  published to npm; `npm run vendor-wapi-sdk` fetches it with `giget` and then strips the `.js`
  suffix from its relative imports. That second step is not cosmetic: the SDK is written for
  Node's ESM rules, TypeScript resolves `./http.js` back to `.ts` under `moduleResolution:
  "bundler"`, and **Turbopack does not** — so `tsc --noEmit` passes while `next build` fails.
  Current copy: `crafter-station/wapi@5f407fd`.
- **The SDK's send union forbids a caption on a document; the API allows one.**
  `PostApiSendMessageBody` has `text` and `documentUrl` as independent optional fields, so
  `lib/wapi.ts` widens the type deliberately. Narrowing to match the SDK would drop the caption
  from every PDF the bot sends — a behaviour change wearing a refactor's clothes.
- **A feature switch that owns no tools must be read by hand somewhere.** Tools are withdrawn
  automatically; a prompt- or handler-only feature (`quoted`, `stickers_collect`) is inert
  unless something checks it. `npm run features-check` fails when one is not.
- **`ADMIN_PASSWORD_HASH` is base64, not the raw hash.** Docker Compose interpolates `$NAME` in
  env values, and a bcrypt hash is full of `$`. A raw hash arrives as `$2b$12` and every sign-in
  fails as "wrong password". `lib/config.ts` checks the shape and refuses a mangled one loudly.
- **A colour set on a class can lose to the link reset.** `.lp a` is specificity (0,1,1) and
  beats a bare `.lp-btn` at (0,1,0), so the primary button kept its gold background and
  inherited near-white text — 1.4:1, unreadable, with correct-looking CSS three lines below.
  Anything with a background states its colour at `.lp a.<class>`. `npm run contrast-check`
  resolves the cascade and measures it, because reading the file is what missed it twice.
- **The Crafter Station mark is reproduced, never redrawn.** `app/crafter-mark.tsx` carries the
  real path from brand.crafter.run; the brand's forbidden list ends with "replace with similar
  marks". Each instance needs a unique gradient id, which is why callers pass one.
- **The landing page is the only ungated route, and it is excluded by `$`, not by an
  allowlist.** The matcher still gates everything by default and names the exceptions, so a page
  added tomorrow is behind the sign-in unless somebody deliberately opens it. Inverting that to
  "gate `/dashboard`" would make the default open, which is the wrong way round for a gate.
- **The `proxy.ts` matcher must keep excluding `/api/` and anything with a file extension.**
  wapi calls the webhook and Notion the OAuth callback; neither carries a session cookie, so
  gating them stops the bot receiving messages — quietly, since the dashboard would still look
  fine. Static files need the same exemption: naming `favicon.ico` alone left the rest of the
  icon set answering a signed-out browser with a redirect, so the tab icon and the manifest
  simply never loaded.
- **That matcher's `\\.` needs both backslashes.** `"\\."` in a TypeScript string is an invalid
  escape that collapses to a plain `"."`, so the exclusion above becomes *any non-empty path* and
  every page but the root falls out of the gate. It typechecks, it builds, and `/` still
  redirects, so nothing looks wrong. `npm run smoke` asserts what the string actually matches.
- **`next start` does not serve this app.** `output: "standalone"` means the built server is
  `.next/standalone/server.js`; `next start` prints a warning and then behaves differently enough
  to mislead. Test a production build with `node .next/standalone/server.js`, or in Docker.
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
- A new capability is **one entry in `FEATURES` in `lib/features.ts`**, and nothing else. That
  registry is what the dashboard renders as switches, what withdraws the tools, and what
  `lib/about.ts` builds the bot's own account of itself from. It exists because the same list
  used to be written out in three places, and the prose one rotted silently — nothing renders it,
  so the bot went on offering abilities it no longer had.
- **A switch has to move the prompt as well as the tools.** Withdrawing `send_voice_note` while
  leaving the paragraph that describes it just makes the bot promise something the turn cannot
  deliver, which reads as broken rather than as switched off. `systemPrompt` gates every section
  on the same key the tools use.
- `lib/about.ts` describes the deployment, so it lives in code rather than the database — it
  should change in the same commit the deployment does. Nothing secret goes in it; it is read
  aloud to whoever asks.
- Dashboard pages are server components that read their own data and mutate through Server
  Actions in a sibling `actions.ts`, ending in `revalidatePath`. Forms post to the action
  directly, so every control works with JavaScript off — which is also what makes them testable
  with `curl`.
- **No page checks the session.** `proxy.ts` gates all of them in one place, which is the only
  way to be sure a page added later cannot forget to.

## Checks

```bash
npm run smoke           # signatures, "is this for me?", what the gate covers, and whether
                        # these two files still point at things that exist
npm run features-check  # every tool belongs to a switch, and every switch does something
npm run cron-check      # the cron evaluator, including both daylight-saving transitions
npm run contrast-check  # resolves the landing CSS cascade and measures what is readable
npm run summary-check   # one real digest end to end: does it keep the decision, the deadline,
                        # the links, and the right picture? (costs money, needs DATABASE_URL)
npm run wapi-check      # the vendored SDK against the real API: envelopes, both error types,
                        # and one real send into a throwaway sandbox session (needs WAPI_PAT)
npm run sticker-check   # real ffmpeg conversion + the SSRF guard (needs ffmpeg)
npm run voice-check     # voice notes really are Ogg/Opus mono 48kHz, per ffprobe
npm run draw-check      # one real image generation, checks alpha survives (costs money)
npm run video-check     # video really is H.264/yuv420p/AAC in MP4, per ffprobe
npm run models-check    # run after ANY model change: does the tier accept tools, vision,
                        # effort, verbosity and a transparent background? (costs money)
npm run build           # typecheck + production build
```

`npm run vendor-wapi-sdk` is not a check — it refreshes `lib/wapi-sdk` from upstream, with the
import fixup that Turbopack needs. Run `wapi-check` afterwards.

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

**A new environment variable needs adding in two places**: the Dokploy compose env *and* the
`environment:` block in `docker-compose.yml`. Setting only the first leaves the container never
seeing it, and the symptom is a feature that behaves exactly as if it were unconfigured.

ffmpeg is installed in the runner stage, and the Dockerfile greps for `libwebp` and `libopus` so a
base image without them fails the build rather than the feature.
