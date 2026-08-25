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

> The session API key and the account-level Personal Access Token both go on
> `Authorization: Bearer` and are **not** interchangeable. This app only ever sends messages, so
> it only needs the session key. If you see a `403` rather than a `401`, you have the wrong
> token *type* — that is what a 403 means here.

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

- **Direct messages** — always. Set `BOT_REPLY_TO_DMS=false` to stop that.
- **Groups** — only when `@`-tagged, or when someone replies to one of its messages.

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

Notes on each:

- **Files, images, video, PDFs** go out by URL — the bot sends a link it actually found, and is
  told never to invent one. Documents always carry a filename, because a document without one
  arrives named after its URL.
- **Voice notes** are generated with OpenAI TTS, uploaded to wapi for a permanent URL, then
  sent. Six voices are available and the bot can be asked for a delivery style ("warm and
  unhurried"). mp3 rather than opus, because every WhatsApp client plays it.
- **Polls** take 2–12 options and can allow multiple choices. Duplicate options are removed
  first — WhatsApp drops them silently, which would quietly turn a 3-option poll into 2.
- When a tool has already put something in the chat, the bot sends at most one short line after
  it, and often nothing. A poll on its own is a complete answer.

If a send fails, the error goes back to the model rather than being thrown, so it can tell you
what went wrong or try a different source instead of the turn dying silently.

## Memory

Facts are scoped to the chat they were told in — the bot sits in shared rooms, and something
said in one group has no business surfacing in another. They go into the model's system prompt
every turn, so recall never depends on the model deciding to look something up.

In a chat, just say it: *"remember that standup moved to 9"*, *"forget that"*. The bot writes
through the `remember` and `forget` tools and confirms in one line. Everything it knows is
listed on `/`.

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
| `BOT_REPLY_TO_DMS` | `true` | Groups always require a tag regardless. |

Replies are requested at low verbosity — a WhatsApp message that needs scrolling has already
failed. The bot's manners live in the system prompt in `lib/agent.ts`.

## Checks

```bash
npm run smoke      # signature verification + "is this message for me?" — no keys needed
npm run build      # typecheck and production build
```

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
lib/mentions.ts                  parsing WhatsApp message nodes, "is this for me?"
lib/wapi.ts                      wapi REST client
lib/signature.ts                 webhook signature verification
lib/db.ts                        Postgres pool and schema
```
