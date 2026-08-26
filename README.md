# wspbot

A Next.js app that puts a bot in your WhatsApp chats. Tag it and it answers — searching the web
when the answer needs to be current, and remembering what you ask it to remember until you tell
it to forget.

```
you   → @bot record that we need to create a calendar schedule
bot   → Noted.
       …days later, after a redeploy…
you   → @bot what were we going to build?
bot   → A calendar schedule.
you   → @bot forget that
bot   → Done.
```

## How it works

```
WhatsApp ──▶ wapi ──POST /api/wapi/webhook──▶ this app
                                                 │
                                                 ├─▶ OpenAI (+ web search)
                                                 ├─▶ Postgres (memory + history)
                                                 └─▶ wapi /api/send-message ──▶ WhatsApp
```

wapi has **no endpoint that lists received messages** — inbound exists only as a webhook push.
That single fact shapes the app: there is nothing to poll, so the whole thing is one route
handler that has to be publicly reachable. Which is exactly what deploying gives you.

Two pages:

- `/` — a status page. Session linked? Who am I? What do I remember?
- `/api/wapi/webhook` — where wapi delivers messages.

## Setup

```bash
npm install
cp .env.example .env      # then fill it in
npm run dev
```

| Variable | Where it comes from |
| --- | --- |
| `OPENAI_API_KEY` | platform.openai.com/api-keys |
| `DATABASE_URL` | any Postgres. Tables are created on first request. |
| `WAPI_API_KEY` | wapi dashboard → the **session's** page |
| `WAPI_WEBHOOK_SECRET` | same page |
| `WAPI_PAT` + `WAPI_SESSION_ID` | *optional* — dashboard **Tokens** page. Only used to reconnect a dropped session. |

> The session API key and the account-level Personal Access Token both go on
> `Authorization: Bearer` and are **not** interchangeable. Messaging needs the session key;
> reconnecting a dropped session needs the PAT, which is the only reason this app takes one. If
> you see a `403` rather than a `401`, you have the wrong token *type* — that is what a 403
> means here.
>
> The PAT grants control of every session on the account, so leaving it unset is a legitimate
> choice: the bot behaves identically until the session drops, at which point it logs that it
> cannot reconnect instead of doing so.

## Staying connected

The WhatsApp session drops on its own — usually when the wapi stack it lives in restarts, which
takes the socket down with it. Until something reconnects it the bot is silently deaf: the app
is up, the webhook is registered, and nothing arrives.

Two triggers, because neither is enough alone:

- the **`session.status` webhook**, which reacts within a second — but only arrives if wapi is
  alive to send it, which is precisely not the case when wapi is what restarted;
- a **watchdog** that checks every two minutes from `instrumentation.ts`, catching the restart
  case a little later. This is a long-lived container, not a serverless function, so a plain
  interval is a real thing here and no external scheduler is needed.

Neither trusts what prompted it: both call `GET /api/status` and do nothing if the session is
actually fine — the webhook payload is undocumented, and a stale "disconnected" would otherwise
reconnect a healthy session. Attempts are spaced a minute apart and give up after five
consecutive failures, since the usual cause of a persistent failure is a session needing its QR
scanned again, which retrying cannot fix.

## Pointing wapi at it

Deploy first — the webhook needs a public URL. Then register it once, using your PAT (from the
dashboard's **Tokens** page) and your session id:

```bash
curl -X PUT "https://api.wapi.crafter.run/api/whatsapp-sessions/$SESSION_ID" \
  -H "Authorization: Bearer $WAPI_PAT" \
  -H 'Content-Type: application/json' \
  -d '{"webhook_url":"https://your-app.example.com/api/wapi/webhook",
       "webhook_enabled":true,
       "webhook_events":["messages.received"]}'
```

Or paste the same URL into the session's page in the dashboard. An empty `webhook_events` array
means *send everything*.

**Developing locally?** wapi still has to reach you, so you need a tunnel:
`cloudflared tunnel --url http://localhost:3000` (or ngrok), then register that hostname the
same way. This is the only reason a tunnel ever enters the picture — deployed, it doesn't.

## When it replies

- **Groups** — when `@`-tagged, or when someone replies to one of its messages.
- **Stickers** — collected silently in any group, without a tag. See below.
- **Direct messages** — ignored. A one-to-one chat has no tagging convention, so answering
  there means answering everything sent to it. Set `BOT_REPLY_TO_DMS=true` if you want that.

Tags are matched against both spellings of the bot's identity: its phone JID and its LID.
WhatsApp increasingly addresses people by LID, and a LID is not derivable from a phone number,
so both are checked rather than converted.

Everything else is dropped silently, which is what makes it tolerable in a busy group.

## What it can put in the chat

Beyond text, the bot decides for itself when one of these fits — you just ask in plain language.

| Ask it something like | What happens |
| --- | --- |
| "send me the PDF of that paper" | finds the file and sends it as a document, properly named |
| "show me a photo of the venue" | sends an image with a short caption |
| "read that out" / "send it as audio" | generates speech and sends a voice note |
| "let's vote on Friday or Saturday" | posts a WhatsApp poll people can tap |
| "link me the docs" | sends a bare URL, which WhatsApp expands into a preview |
| "send the laughing cat sticker" | sends one of the stickers the chat has already used |
| *(photo or GIF attached)* "@bot" | turns it into a sticker, animation intact, and keeps it |
| "make a sticker from <gif link>" | downloads it and converts it, animation intact |

Notes on each:

- **Files, images, video, PDFs** go out by URL — the bot sends a link it actually found, and is
  told never to invent one. Documents always carry a filename, because a document without one
  arrives named after its URL.
- **Voice notes** are generated with OpenAI TTS, re-encoded to **Ogg/Opus, mono, 48kHz**, then
  uploaded to wapi for a permanent URL. That encoding is the format, not a preference: mp3 plays
  in WhatsApp Web — a browser decodes whatever the OS can — and the mobile app refuses it, so
  the bug is invisible on a laptop. `npm run voice-check` verifies the container and codec with
  ffprobe. Six voices, and the bot can be asked for a delivery style ("warm and unhurried").
- **Polls** take 2–12 options and can allow multiple choices. Duplicate options are removed
  first — WhatsApp drops them silently, which would quietly turn a 3-option poll into 2.
- When a tool has already put something in the chat, the bot sends at most one short line after
  it, and often nothing. A poll on its own is a complete answer.

If a send fails, the error goes back to the model rather than being thrown, so it can tell you
what went wrong or try a different source instead of the turn dying silently.

## Stickers

The bot builds its own sticker library out of what people already send.

**Collecting.** Any sticker sent in a chat the bot is in gets kept — silently, with no reply.
This is the one thing the bot looks at without being tagged, because a sticker library is only
useful if it fills itself.

Three things make that less trivial than it sounds:

- **Inbound media is encrypted.** The webhook carries a CDN link and a `mediaKey`, not usable
  bytes, so each sticker goes through `decrypt-media` first.
- **The decrypted URL expires after an hour**, so the bytes are fetched and re-uploaded to get a
  permanent one. Storing the decrypted link would leave a library of dead images by tomorrow.
- **The bot cannot see its own library at send time**, so each sticker is described once on
  arrival by a vision call, and chosen later by that description.

**Deduplicated by content hash.** The same sticker gets sent over and over; hashing the bytes
means it is uploaded and described exactly once. A sticker already seen in another chat reuses
that work and only adds a row.

**Making them.** Send an image, a GIF or a short video, tag the bot, and it turns it into a
sticker — sends it back and keeps it in the library. Animated sources stay animated.

The awkward part is that **WhatsApp does not send GIFs as GIFs**. Picking one from the GIF tray
produces a `videoMessage` with `gifPlayback: true` — an mp4. A real `.gif` shared as a file
stays a GIF and arrives as a document instead. Both have to end up as animated WebP, so the
"is it animated" decision comes from those signals rather than the mimetype.

Conversion is ffmpeg (the only tool that reads JPEG, GIF *and* mp4 and writes animated WebP):

```
scale=512:512:force_original_aspect_ratio=decrease   fit inside 512x512, never distort
format=rgba                                          give pad an alpha channel to work with
pad=512:512:(ow-iw)/2:(oh-ih)/2:color=#00000000      centre on transparent, not black
```

Without `format=rgba` the padding comes out opaque black, which reads as a letterboxed photo
rather than a sticker. Animations are capped at 6 seconds and re-encoded down a quality ladder
until they fit WhatsApp's ceilings — 100KB static, 500KB animated — since an oversized sticker
is rejected.

**From a link.** Paste a GIF link, or just ask for a sticker of something — the bot can search,
find a GIF and turn that into one. Whether it animates is decided from the file's magic bytes,
not the URL: plenty of CDNs serve a GIF as `application/octet-stream`, and a `.gif` in a path
proves nothing.

Downloading a URL the model chose is the one genuinely dangerous thing here. Anyone in a group
can say "make a sticker from http://..." and this app runs on a server that can reach the
container network and the cloud metadata endpoint. `lib/fetch-media.ts` is what stands in the
way:

- http/https only, so `file:` and friends are unreachable
- every hostname resolved and checked against loopback, private, link-local, CGNAT and reserved
  ranges **before** connecting — and every address it resolves to, not just the first
- redirects followed by hand, re-validating each hop, because a public URL can redirect to
  `169.254.169.254` and a normal `fetch` would follow it without a word
- a byte cap enforced while streaming, not from `content-length`, which a server can lie about

A page URL (`tenor.com/view/...`) is rejected with an explanation rather than a confusing
failure — the bot needs the media link itself.

**Sending.** The chat's stickers are listed in the system prompt with their descriptions, so the
bot picks one the same way it recalls a fact — no lookup step. Ask for one, or let it reach for
one when a sticker answers better than words.

**One shared library.** Every chat draws from the same collection — a sticker picked up in one
group can be sent in any other. (Memories are still per chat; a fact and a reaction picture are
not the same kind of thing.)

**Named, and renameable.** Each sticker is auto-named on arrival by the vision call. Say what one
should be called — "call that one *angry cat*" — and the bot renames it, so it can be asked for
by that name later.

**Survives a change of number.** The bytes are stored in Postgres alongside the wapi URL. A new
number means a new session, and nothing promises the old upload URLs outlive it — so when a URL
stops resolving, the sticker is uploaded again from the local copy and the row repaired, with no
one noticing. Older stickers saved before this get their bytes backfilled the first time they
are sent.

Everything collected is shown on `/`.

## What it knows about itself

Ask it what it runs on, how it works, or who made it, and it answers from `lib/about.ts` rather
than inventing something plausible — where it is deployed, that WhatsApp reaches it by webhook
because wapi cannot be polled, which model is thinking, how voice notes and stickers are built,
and that it was made by Jibaru of Crafter Station (jibaru.dev).

That description lives in code, not in the database, because it describes the deployment: it
should change in the same commit the deployment does. A fact about the architecture kept in a
table goes stale silently. It is also read out to whoever asks, so nothing secret goes in it, and
the bot is told never to reveal keys, environment values or another chat's contents.

## Memory

Facts are scoped to the chat they were told in — the bot sits in shared rooms, and something
said in one group has no business surfacing in another. They go into the model's system prompt
every turn, so recall never depends on the model deciding to look something up.

In a chat, just say it: *"remember that standup moved to 9"*, *"forget that"*. The bot writes
through the `remember` and `forget` tools and confirms in one line. Everything it knows is
listed on `/`.

**Global facts.** Some things hold no matter who is talking — a standing instruction about how
the bot should behave, or something about the bot itself. Those are saved with scope
`everywhere`, are shown in every chat marked `(everywhere)`, and survive restarts and redeploys
like any other row. The bot is told to reserve that scope for facts that are genuinely
chat-independent; anything about the people in a room stays in that room.

`/reset` in a chat clears the running conversation but keeps the memories.

To set a fact visible in **every** chat, insert it against the `global` scope:

```sql
insert into memories (chat, text) values ('global', 'the office wifi password is hunter2');
```

## Tuning

| Variable | Default | Notes |
| --- | --- | --- |
| `BOT_MODEL` | `gpt-5.6` | Any model your account can reach on the Responses API. |
| `BOT_EFFORT` | `low` | Reasoning depth. Raise it if answers feel shallow, at the cost of latency. |
| `BOT_REPLY_TO_DMS` | `false` | Answer one-to-one chats too. Groups always require a tag regardless. |

Replies are requested at low verbosity — a WhatsApp message that needs scrolling has already
failed. The bot's manners live in the system prompt in `lib/agent.ts`.

## Checks

```bash
npm run smoke           # signature verification + "is this message for me?" — no keys needed
npm run sticker-check   # real ffmpeg conversion: 512x512, animated, under size ceilings
npm run voice-check     # voice notes really are Ogg/Opus mono 48kHz, per ffprobe
npm run build           # typecheck and production build
```

`npm run sticker-check` also drives the SSRF guard — every private range, IPv4-mapped IPv6, and
URLs like `http://169.254.169.254/` and `file:///etc/passwd` must be refused before a connection
is made — and downloads a real remote GIF end to end. It needs ffmpeg on PATH. It builds a non-square video and image, runs them
through `lib/sticker-maker`, and reads the WebP container back to confirm the canvas is 512x512,
that animated input really produced ANIM/ANMF frames, and that the padding kept an alpha
channel. `ffprobe` cannot parse animated WebP, which is why it inspects the chunks directly.

`npm run smoke` is the one worth running after touching `lib/mentions.ts`: it drives group
tagging, reply-to-bot, DMs, disappearing-message wrappers, own-message suppression, and both
webhook signing schemes.

## Notes on the wapi integration

Details that cost real debugging time, handled in `lib/wapi.ts` and the webhook route:

- **Five success envelopes, two failure envelopes.** Route handlers set `error`; middleware sets
  `message`. Reading only one loses half the failures.
- **The default webhook signature is a plain string compare**, not an HMAC — the header carries
  the secret itself. wapi also supports HMAC-SHA256 per session; the handler accepts both, so
  turning that on needs no redeploy.
- **Deliveries are acknowledged before the reply is generated**, via `after()`. Any non-2xx makes
  wapi retry with backoff, and a model turn takes seconds — holding the response open turns one
  message into several.
- **Retries still happen**, so message ids are claimed in Postgres rather than in memory:
  separate serverless invocations share no state, so an in-process `Set` would not deduplicate
  anything.
- **Sends are not safely retryable.** A timeout means the request failed, not that the message
  wasn't delivered, so nothing here retries a send.

Background on all of it: `.agents/skills/wapi-nextjs/references/api-notes.md`.

## Layout

```
app/page.tsx                     status page
app/api/wapi/webhook/route.ts    inbound: verify, ack, then reply
lib/agent.ts                     the model turn: prompt, web search, memory tools
lib/memory.ts                    facts, scoped per chat
lib/stickers.ts                  the sticker library: decrypt, dedupe, describe, store
lib/sticker-maker.ts             ffmpeg: anything -> 512x512 WebP, animation preserved
lib/fetch-media.ts               guarded remote downloads (SSRF, redirects, size cap)
lib/about.ts                     what the bot knows about itself
lib/audio.ts                     TTS output -> Ogg/Opus, the voice-note format
lib/ffmpeg.ts                    shared ffmpeg runner and scratch directories
lib/mentions.ts                  parsing WhatsApp message nodes, "is this for me?"
lib/wapi.ts                      wapi REST client
lib/signature.ts                 webhook signature verification
lib/db.ts                        Postgres pool and schema
```
