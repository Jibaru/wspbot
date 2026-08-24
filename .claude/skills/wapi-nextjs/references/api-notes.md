# wapi API notes

Behaviours that are not guessable from the endpoint names. Each of these has cost someone real
debugging time; several are inherited from the interface wapi clones and are deliberate rather
than accidental.

## There are five success envelopes, not one

Do not write a single `unwrap(res.data)` helper and assume it applies everywhere.

| Shape | Endpoints |
| --- | --- |
| `{success, data}` | most routes |
| `{status}` — **no `success` key at all** | `GET /api/status` |
| `{success, api_key}` — at the top level | `POST .../regenerate-key` |
| `{success, publicUrl}` — at the top level | `POST /api/upload`, `POST /api/decrypt-media` |
| `{success, message}` | `POST .../restart` |
| no body at all (`204`) | `DELETE /api/whatsapp-sessions/{id}` |

## There are two failure envelopes, and which one you get tells you where it failed

- `{success: false, error: "…"}` — a route handler decided this. Session not connected, group
  not found, upload too large.
- `{success: false, message: "…", errors?: {field: [messages]}}` — middleware decided it.
  Authentication, validation, subscription gating.

A third exists for rate limiting: `{message, retry_after}` with **no `success` key**.

So: check `success === false` *and* read both `error` and `message`. Reading only one loses half
the failures.

## `?paginated=true` changes the response shape

`GET /api/contacts` and `GET /api/groups` return a flat array in `data` by default. With
`?paginated=true` they return `data: {items, pagination: {page, limit, total, totalPages}}`.

`limit` defaults to **20** and caps at 500. If you validate the page, `totalPages` is
`ceil(total / limit)` and `page` echoes what you asked for.

There is also a *second, unrelated* pagination shape: the message-log and session-log routes use
Laravel's length-aware paginator (`current_page`, `data`, `per_page`, `total`, …). Two shapes in
one API is not a design anyone chose; it is what the interface does.

## Contacts and groups carry both key spellings

A contact is keyed on `jid` in list responses and `id` in the single-contact response. wapi emits
both with the same value in both places, so read whichever you prefer — but do not assume a key
is absent because the other one is present.

Groups likewise carry `jid` and `id`, and both `name` and `subject` (same value). Participants
carry `{jid, isAdmin, isSuperAdmin}` and `{id, admin}` at once.

`imgUrl` and `status` on a contact are **always null in a list**. A profile picture and an
"about" string are per-contact fetches against WhatsApp; a list call does not make N of them.

## `GET /api/messages/{msgId}/info` uses WhatsApp's types, not the API's

Two fields do not match what a send returns:

- `messageTimestamp` is a **string** — it is a protobuf 64-bit integer, which JSON cannot hold
  as a number.
- `status` is a **number**: `0` error, `1` pending, `2` sent, `3` delivered, `4` read. A send
  returns the word `"in_progress"`; this returns the numeric acknowledgement.

## `msgId` is wapi's integer, not WhatsApp's id

Every send returns an integer `msgId` from a server-side sequence. Use it for `replyTo` and for
`/info`. WhatsApp's own string id is `data.key.id`, returned alongside.

## Identities are often LIDs, not phone numbers

WhatsApp increasingly addresses users by LID (`…@lid`) rather than phone number. A `remoteJid`
may be a LID with the phone number in `remoteJidAlt`. Resolve with `GET /api/lid-from-pn/{pn}`
and `GET /api/pn-from-lid/{lid}`; the latter returns `404` when no mapping is known, which is a
normal outcome and not an error to retry.

Never guess a phone number from a LID. They are not derivable from one another.

## Sends are not safely retryable

A timeout tells you the request failed, not that the message was not delivered. Retrying blindly
sends twice. Reconcile with `/info` using the `msgId` you already have, or accept the ambiguity —
do not paper over it with a retry loop.

## Rate limiting

`X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset` are on every response. A
`429` carries `retry_after` in seconds. Sessions with `account_protection` enabled additionally
pace sends to one every five seconds, server-side.

## Connecting is asynchronous

`POST .../connect` returns immediately with a status, possibly `NEED_SCAN` plus a `qrCode`. Note
the status is SCREAMING_CASE in connect responses and lowercase everywhere else — another
inherited inconsistency. Poll `GET /api/status` until it reads `connected`; the QR rotates while
you wait.
