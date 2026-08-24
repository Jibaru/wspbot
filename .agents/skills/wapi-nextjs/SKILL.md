---
name: wapi-nextjs
description: Integrate wapi (self-hosted WhatsApp REST API) into a Next.js app — sending messages, reading contacts and groups, and receiving webhooks. Use when adding WhatsApp messaging to a Next.js project, or when a WasenderAPI client needs to point at wapi.
---

# Integrating wapi into a Next.js app

wapi exposes WhatsApp over a plain REST API and is wire-compatible with WasenderAPI.

- Base URL: `https://api.wapi.crafter.run`
- Per-endpoint reference (generated from the server's own contract): `https://api.wapi.crafter.run/docs`
- Raw OpenAPI spec: `https://api.wapi.crafter.run/openapi.json`
- Narrative guide, with worked examples: `https://wapi.crafter.run/docs`

Fetch the OpenAPI spec if you need a field this skill does not cover — it is generated from the
contract the server validates against, so it cannot drift from the implementation.

Work in this order. Steps 1–3 are always required; 4 and 5 are per-feature.

## 1. Decide which credential each call needs

Two token types go in the same `Authorization: Bearer` header and are **not** interchangeable.
Using the wrong one returns `403`, not `401`, which is the usual source of a confusing first
failure.

| Token | Use for | Where it comes from |
| --- | --- | --- |
| **Session API key** | messaging, contacts, groups, media, status | the session's page in the dashboard |
| **Personal Access Token** | creating/updating/deleting sessions, proxies, regenerating keys | the Tokens page |

The session key *is* the session selector — that is why `GET /api/status` takes no session id.
Most app code needs only the session key.

## 2. Put the key on the server, never in the browser

Both tokens grant full control of a WhatsApp account. They must never reach the client.

```bash
# .env.local — no NEXT_PUBLIC_ prefix, deliberately
WAPI_BASE_URL=https://api.wapi.crafter.run
WAPI_API_KEY=<session api key>
WAPI_WEBHOOK_SECRET=<session webhook secret>
```

If a component needs to trigger a send, use a **Server Action** or a Route Handler. Never a
`fetch` from a client component with the key in scope — a `NEXT_PUBLIC_` key is world-readable
the moment it ships.

## 3. Add the client

Copy `references/wapi-client.ts` into the project (suggested `src/lib/wapi.ts`) and mark it
server-only. It is dependency-free and handles the parts of this API that surprise people; read
`references/api-notes.md` before hand-rolling anything, because several of these are not
guessable from the endpoint names.

## 4. Send a message

`POST /api/send-message` is one endpoint for every message type. **Which field you set decides
what is sent** — there is no separate route for images or groups. Setting two content fields is
an error rather than a silent preference.

```ts
"use server";
import { wapi } from "@/lib/wapi";

export async function notify(phone: string, text: string) {
  const { msgId } = await wapi.sendMessage({ to: phone, text });
  return msgId;
}
```

Sending to a group is the same call with a group JID (`…@g.us`) as `to`.

Media is sent **by URL** — `imageUrl`, `documentUrl` and friends are fetched server-side at send
time. If the file is not already hosted, `POST /api/upload` first and use the URL it returns:
that one is permanent, so it still resolves when the message is sent later.

## 5. Receive webhooks

Create a Route Handler and verify the signature before trusting anything. Copy
`references/webhook-route.ts` to `src/app/api/wapi/webhook/route.ts`.

Two things that will bite otherwise:

- **The default signature is a plain string compare**, not an HMAC — `X-Webhook-Signature`
  carries the webhook secret itself. That is WasenderAPI's scheme, reproduced for
  compatibility. wapi additionally supports HMAC-SHA256 over the raw body as a per-session
  opt-in (`webhook_hmac`); prefer it, and the reference handler supports both.
- **Acknowledge fast.** Delivery retries with backoff on any non-2xx, so slow handlers cause
  duplicate deliveries. Return 200 and do the work after.

Point the session at the handler:

```bash
curl -X PUT "$WAPI_BASE_URL/api/whatsapp-sessions/1" \
  -H "Authorization: Bearer $WAPI_PAT" \
  -H 'Content-Type: application/json' \
  -d '{"webhook_url":"https://your.app/api/wapi/webhook",
       "webhook_enabled":true,
       "webhook_events":["messages.received"]}'
```

An empty `webhook_events` array means *send everything*.

## Checks before you call it done

- No token reaches the client bundle. Grep the build output for the key's prefix.
- The webhook handler rejects a request with a wrong or missing signature.
- A `403` is handled distinctly from `401` — they mean different things here.
- Pagination, if used, sends `?paginated=true` and reads `data.items`, not `data`.
- Sends are not retried blindly. A timeout does not mean the message was not sent; reconcile
  with `GET /api/messages/{msgId}/info` rather than sending again.

## Migrating from WasenderAPI

Their published npm client works unmodified. The base URL is the third argument:

```ts
import { createWasender } from "wasenderapi";
const wa = createWasender(process.env.WAPI_API_KEY!, undefined, `${base}/api`);
```

If a client validates media hostnames or pins the provider origin, point it at wapi's origin —
media is served from the same host as the API.
