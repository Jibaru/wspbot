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

you ──▶ / (public) ──▶ /login ──▶ proxy.ts ──▶ /dashboard/{features,limits,stickers,
                                       │           memory,reminders,summaries,chime,
                                       │           github,supporters,roadmap,move,usage}
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
lib/transfer.ts                  moving a group's context into another group (dashboard only)
lib/supporters.ts                who chipped in; Yape by hand, Buy Me a Coffee by API
lib/roadmap.ts                   supporter-weighted voting on what to build next
lib/people.ts                    identities gathered from four tables, for the rate-limit picker
lib/chime.ts                     chiming in: which groups, how restrained, and why not now
lib/chime-runner.ts              fires it, through the ordinary turn
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
lib/render-html.ts               Chromium: the bot's own HTML -> a picture, no network at all
lib/sticker-site.ts              the sticker library as a static site, ready to commit
lib/fetch-media.ts               guarded remote downloads (SSRF)
```

**Integrations and plumbing**

```
lib/github.ts                    GitHub: the account, the permission layer, the REST client
lib/secret-box.ts                AES-256-GCM sealing for the GitHub token (and only that)
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
- **Recording is the only place the bot reads messages nobody sent it.** Two features want it
  now — a digest's source group, and a group it may chime into — so the gate is an `or` of two
  cached lists, each gated on its own feature. `systemPrompt` tells the bot when the room it is
  in is being recorded *and which reason applies*, so "are you logging this?" gets a true answer
  either way. Adding a third reason means adding it in both places, or the bot denies something
  that is happening.
- **A chime is the ordinary turn, not a second prompt.** `chime-runner` calls `reply()` with
  `unprompted: true`. Anything else would be a different bot in the same group: no memory, no
  stickers, no self-description. `unprompted` changes exactly two things — the prompt says
  nobody asked, and an empty answer stays empty instead of becoming "Sorry, I got tangled up",
  which would turn every decision to stay quiet into an apology nobody can parse.
- **Silence has to be an allowed answer, and it has to move the watermark.** A model handed a
  transcript will always find something to say, so the prompt says plainly that saying nothing is
  normal. The watermark moves anyway: a conversation it decided to sit out must not be
  reconsidered an hour later, or it will eventually talk itself into commenting.
- **`last_chime_at` moves on the claim, not on success** — the reminder bug, one table over. And
  the claim's `$2::timestamptz` cast is load-bearing: without it pg types the parameter from its
  neighbour and reads it as interval minus interval, which is a runtime error, not a build one.
- **Quiet hours wrap around midnight**, so 23→8 contains neither endpoint in the usual order.
  Getting it backwards means messaging a group at four in the morning, which is the one failure
  here nobody forgives. `npm run chime-check` asserts both directions, and the daily cap in a
  local day rather than a UTC one.
- **`new URL()` rewrites an IPv6 host, and it broke the SSRF guard.**
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
- **Voting ranks; it never switches a feature on.** `features` is keyed on `key` alone, so it is
  global — an "unlock" by one supporter would turn a feature on for every group the bot sits in.
  If that ever needs to change, it is a per-chat feature table, not a tweak.
- **A vote's weight is not stored on the vote.** It is joined from `supporters` at tally time, so
  another coffee strengthens every vote already held and a removed supporter takes their weight
  with them. Storing it would need a backfill nobody would remember to run.
- **Voting twice must not double a weight.** The primary key on `roadmap_votes (item_id, handle)`
  is the only thing preventing it, it costs nothing at write time to lose, and it corrupts every
  tally afterwards in silence. `npm run roadmap-check` asserts it directly.
- **The landing page is now `revalidate = 300`, not fully static.** The vote counts made it
  database-backed; the cache is what keeps `/` fast and keeps it serving when Postgres is not.
  A dashboard change revalidates it, so an approved item does not sit invisible for five minutes.
- **The supporter rate limit is computed, never stored.** `quotaFor` consults the supporters list.
  A row written on becoming a supporter would outlive their removal and nobody would notice.
- **One person, several WhatsApp identities.** A phone JID, a LID and a username are all the same
  human and none is derivable from the others — wapi maps phone to LID and back, nothing resolves
  a username. `supporter_handles` holds them all; `supporters.handle` was a single column and is
  migrated into it and dropped. Recording one identity means the other silently never matches.
- **Votes key on `supporter_id`, not on the handle used.** Otherwise one person backs the same
  item once as their LID and once as their username. The primary key is what enforces it.
- **`parseHandles` splits on commas, not spaces.** `+51 999 888 777` is one identity written the
  way people write it; splitting on whitespace turned it into four that matched nothing.
- **A check must never use a real identity.** `tie` moves a handle on conflict — right for the
  dashboard, where the case is fixing a typo — so a check written with a genuine one steals it and
  then destroys it on cleanup. It did exactly that once.
- **A supporter's handle must normalise to what the webhook derives.** A sender arrives as
  `51999888777:12@s.whatsapp.net` and `mentions.identityKey` reduces it to bare digits, so
  `supporters.normalise` has to land on the same string from `+51 999 888 777` or the star never
  appears — silently, since both rows exist and simply never meet. `npm run supporters-check`
  asserts that equality directly.
- **Buy Me a Coffee paginates Laravel-style, five to a page.** `/api/v1/supporters` answers
  `data` plus `next_page_url`, so reading only the first page silently stops at five supporters.
  Verified against the live account. `/subscriptions` and `/extras` answer **200** with
  `{"error": "No subscriptions"}` when empty — a state, not a failure.
- **The coffee webhook signs with HMAC-SHA256 over the raw body**, hex, in `x-signature-sha256`.
  Verify before parsing, and note `timingSafeEqual` **throws** on a length mismatch — a truncated
  signature has to be refused, not crash the route. A `live_mode: false` delivery is their test
  button: accept it, do not store it.
- **An unauthenticated call there redirects rather than 401ing**, so the client sets
  `redirect: "manual"` — following it would turn a bad token into a page of HTML parsed as JSON.
- **Moving context between groups is dashboard-only, and there is no tool for it.** Same reason
  as rate limits: anything the bot can do, anyone in a chat can ask it to do, and "move that
  group's notes into this one" is not a call the bot can make. Adding a tool for it would let one
  room pull another's context across on request.
- **A reminder cannot be moved onto one that already exists.** The primary key is the pair of
  chat and person, so an unguarded update would replace somebody's own reminder without a word.
  `lib/transfer.ts` checks first and refuses with a reason.
- **A Notion connection moves, never copies.** Copying leaves the grant in the source *and* gives
  it to the destination, turning one person's consent into access from two rooms. Moving keeps it
  at one.
- **One theme, not two.** `app/globals.css` used to carry a light palette and a dark one behind
  `prefers-color-scheme`. It is now the brand's obsidian resting state only, shared with the
  landing page, so the dashboard and the front door are the same product. `color-scheme: dark`
  is set so form controls follow.
- **A colour set on a class can lose to the link reset.** `.lp a` is specificity (0,1,1) and
  beats a bare `.lp-btn` at (0,1,0), so the primary button kept its gold background and
  inherited near-white text — 1.4:1, unreadable, with correct-looking CSS three lines below.
  Anything with a background states its colour at `.lp a.<class>`. `npm run contrast-check`
  resolves the cascade and measures it, because reading the file is what missed it twice. It
  covers both stylesheets, and it honours `:not()` — stripping it made
  `.panel button[type="submit"]:not(.linky)` match a `.linky` button and report the wrong
  colour, which is a resolver that passes while lying.
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
- **satori cannot render a table, and says nothing.** `next/og` is already in the tree and was
  the obvious way to draw HTML. Given `<table><tr><td>Ana</td><td>3</td></tr>…` it emits
  `Ana3Beto1` on one line — its CSS subset has no table layout, and there is no error. A table is
  the likeliest thing anyone asks to be drawn, so `lib/render-html.ts` is Chromium.
  `npm run render-check` measures a table against the same rows stacked, because "it rendered
  something" is exactly what this bug looks like.
- **The render browser fetches nothing, and reports what it refused.** That HTML is
  model-authored and shaped by whatever was typed in a group, so anything but a `data:` URI is
  aborted — same threat as `lib/fetch-media.ts`, enforced by request interception instead.
  Blocked URLs go back to the model: a page whose stylesheet never arrived still renders, just
  unstyled, and nothing else distinguishes that from its own bad markup.
- **One render at a time.** Chromium spikes a couple of hundred megabytes and this box also runs
  Postgres and the wapi stack. The promise queue in `lib/render-html.ts` is not tidiness; two
  concurrent renders is how a WhatsApp bot causes an OOM kill somewhere else.
- **`--single-process` crashes on a real page load.** It halves the memory and it survives
  `setContent` with no network perfectly, so it looked correct right up until the first website
  was captured: `Session closed` mid-screenshot, every time, on anything that navigates and runs
  JavaScript. Serialising is what bounds the memory instead.
- **`capture` reaches the internet, and that is why it is not `render` with a flag.** They have
  opposite network stances and must not become one path with a boolean deciding whether the SSRF
  guard runs. `capture` applies `assertPublic` to the page *and every subresource* — a public
  page can pull an `<img>` from `169.254.169.254` — and then re-checks the address Chromium
  actually reached, off `response.remoteAddress()`. That second check is the only thing that sees
  DNS rebinding: Chromium resolves the name itself, separately, after the first check looked.
- **A single-page app is "loaded" while its body is still empty.** DOMContentLoaded fires on
  `<div id="root">` and nothing else, so screenshotting there returns a blank picture that looks
  like a bug in the renderer rather than a page that had not drawn. `painted()` waits for text or
  an image, bounded, before the scroll.
- **`navigator.webdriver` is what gets a challenge page instead of the site.** It is true for any
  browser driven over CDP and plenty of sites read it. Hiding it evades no login and no paywall —
  the capture signs in nowhere — it is the difference between a picture of the site and a picture
  of "checking your browser".
- **`new URL()` rewrites an IPv6 host, and it broke the SSRF guard.**
  `http://[::ffff:169.254.169.254]/` normalises to `::ffff:a9fe:a9fe`, so a pattern matching the
  dotted spelling passed the metadata endpoint through as public — in every feature taking a URL,
  stickers included. `isPrivateIPv6` now expands the address into eight groups; every embedded
  form (mapped, compatible, NAT64) has to reach the same answer, and `sticker-check` names each.
- **GitHub is the REST API on purpose — not `gh`, not an MCP server.** Both are wrappers over
  the same endpoints, and neither knows which repositories this bot may write to. The feature is
  the layer in front of the call: allowlist, per-operation switch, daily ceiling. Swapping the
  client for `gh` would move that decision nowhere useful and add a process spawn per call.
- **A fine-grained token cannot be granted a repository its account does not own.** Not "granted
  read-only" — absent from the picker entirely, while still reading it happily when it is public.
  That is a bot answering questions about a repository all day and refusing to open an issue on
  it, with a valid token, the right switches and the repository allowlisted. Everything on this
  side was correct. `explain()` says the rule now, `statuses()` puts the verdict on the dashboard
  before anyone tries from a chat, and `github-check` asserts that exact case.
- **A classic token needs no write access to open an issue on a public repository.** Any account
  may. Treating `permissions.push === false` as "cannot write" would refuse the one arrangement
  that works for somebody else's public repository, so `verdict()` splits on visibility and scope
  rather than on push.
- **GitHub is the one feature that is also scoped per chat**, and it is done by deleting the key
  from the switch set in `reply()` rather than by gating each tool. The prompt section, the tool
  withdrawal and the self-description all read that set, so a chat it is off in never hears the
  feature exists — the difference between "off" and "offers it, then refuses". `features` itself
  is still global; a general per-chat table is still a rewrite, not a tweak.
- **"Only these groups" with no groups means nowhere.** The inverse would be an integration that
  became available everywhere the moment somebody cleared the list. `github-check` states it.
  It is also the state somebody saves by accident, and the symptom is a bot answering "I do not
  have access" in every chat while the dashboard shows every permission ticked — because a chat
  it is off in is never told GitHub exists. The page now says so before it can be wondered about.
- **A new `github_settings` column has to be added in four places**, and the compiler catches
  only two of them: the DDL, `Settings`/`COLUMNS`/`setPermissions` in `lib/github.ts`, the
  dashboard form, and `github-check`'s restore. That restore reads the real row and puts it back,
  so a column missing there is silently reset to its default — `chat_mode` was, which turned
  "only these groups" back into "everywhere" on every run of the check.
- **Files go in as one commit, through the git data API.** The contents endpoint is one `PUT`
  per file, which is one commit per file, a half-published site when the fourth fails, and a Pages
  build for each. `putFiles` reads the branch head, makes a blob per file, builds a tree on
  `base_tree` — so unnamed files survive — commits once and moves the ref. Blobs go up
  sequentially: GitHub's own guidance is to avoid concurrent mutating requests.
- **The sticker site commits bytes, never wapi links.** A wapi URL dies with the session that
  uploaded it, so a gallery of those links is a gallery of broken images the day the number
  changes. The bytes in Postgres exist for this.
- **Choose what fits from sizes, not from pictures.** `stickers.sizes()` then `bytesFor()`. The
  first version selected every `bytes` column to decide which 20MB of 49MB to publish, and that
  query is heavy enough to be cancelled outright — which surfaces as a Postgres error in the
  middle of an export, not as slowness.
- **`reposPrivate` is a ceiling, not a default.** Reading it as both made every repository
  private even with public allowed — the tool had no visibility argument at all — and a private
  repository cannot have a Pages site on a free plan, so the whole publish-a-website path failed
  one step later with a message about billing. The dashboard decides what is *possible*; the
  request decides within that.
- **"Your current plan does not support GitHub Pages for this repository" means "make it
  public".** It is a 403, so the general permission branch of `explain()` swallowed it and
  produced a paragraph about fine-grained tokens instead; the plan case has to be tested first.
- **Making a repository public is gated by the same setting as creating public ones**, and going
  private is not. They are not symmetrical: one publishes every commit ever made to the world
  from a chat message, the other tidies up.
- **`github_pages` has to be idempotent, and 409 is an answer.** "Deploy it" and "what is the
  URL?" are the same question asked twice. It reads first, enables only when there is nothing
  there, and requests a build otherwise — and that build request is allowed to fail, since a
  repository built by a workflow rather than from a branch refuses that endpoint while its site
  is perfectly fine.
- **A Pages URL exists before the site does.** GitHub answers with `html_url` the moment Pages is
  on; the first build takes a minute or two, so a link handed over immediately 404s. The status
  is returned with it and the prompt tells the bot to say which it is, or the feature reads as
  broken on its first use.
- **The publishing branch is the repository's default, not "main".** Guessing is a 422 that reads
  as nothing in particular, so `deployPages` looks the default branch up when none is given.
- **Writes fail closed.** An empty `github_repos` means no repository may be written to, not
  "any". A default of "anywhere" would be one migration away from a bot that opens issues on
  strangers' repositories because somebody in a group asked it to.
- **`/repos/{repo}/issues` returns pull requests too.** Three of the three newest rows on
  `vercel/next.js` are PRs. Reporting them as issues is a wrong answer nobody would question, so
  `toIssue` marks each one and the tool tells the model to say which is which.
- **Only the GitHub token is sealed, and that is deliberate.** `lib/secret-box.ts` exists for one
  credential: it can create repositories on an account, and no person ever reads it back. Notion's
  per-chat tokens are stored as text because they are grants to whichever pages somebody shared.
  Do not conclude from the one that this database encrypts secrets generally.
- **`github-check` reads the real settings row and puts it back.** That row holds this
  deployment's actual token; a check that clobbered it would silently disconnect GitHub, which is
  worse than a failing assertion. It never performs a write against GitHub — every assertion
  stops at the decision, because the decision is the feature.
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
npm run features-check  # every tool belongs to a switch, every switch does something, and the
                        # README's figures still match the code
npm run cron-check      # the cron evaluator, including both daylight-saving transitions
npm run contrast-check  # resolves the landing CSS cascade and measures what is readable
npm run github-check    # every GitHub refusal — the allowlist, each switch, the daily ceiling,
                        # and that nothing works before an account is connected
npm run chime-check     # chime-in restraint: the cadence, the daily cap, quiet hours across
                        # midnight, and that claiming twice cannot double-fire
npm run summary-check   # one real digest end to end: does it keep the decision, the deadline,
                        # the links, and the right picture? (costs money, needs DATABASE_URL)
npm run transfer-check  # moves real rows between two throwaway groups, including every refusal
npm run supporters-check # identity matching, the coffee webhook signature, and the live API
npm run roadmap-check   # the weighting, the vote cap, that voting twice cannot double, and that
                        # one person's several identities resolve to one supporter and one vote
npm run wapi-check      # the vendored SDK against the real API: envelopes, both error types,
                        # and one real send into a throwaway sandbox session (needs WAPI_PAT)
npm run sticker-check   # real ffmpeg conversion + the SSRF guard (needs ffmpeg)
npm run voice-check     # voice notes really are Ogg/Opus mono 48kHz, per ffprobe
npm run draw-check      # one real image generation, checks alpha survives (costs money)
npm run render-check    # a real Chromium render: a PNG, a table that stays a table, no network
                        # (needs a browser; set CHROMIUM_PATH outside Docker)
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
