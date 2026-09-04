import * as supporters from "@/lib/supporters";
import { config } from "@/lib/config";
import { settle, when } from "../shared";
import { addSupporter, updateSupporter, removeSupporter, syncCoffee } from "./actions";

/**
 * Who has chipped in.
 *
 * Yape is entered by hand because there is nothing to read: it is a bank transfer, and the only
 * record is a screenshot on somebody's phone. Buy Me a Coffee has an API, so that half can be
 * pulled — when a token is configured.
 */

export const dynamic = "force-dynamic";

const VIA: supporters.Via[] = ["yape", "coffee", "code", "other"];

const WEBHOOK_EVENTS = [
  "donation.created",
  "extra_purchase.created",
  "commission_order.created",
  "wishlist_payment.created",
  "membership.started",
  "recurring_donation.started",
  "donation.refunded",
];

export default async function SupportersPage({
  searchParams,
}: {
  searchParams: Promise<{ added?: string; seen?: string; failed?: string }>;
}) {
  const params = await searchParams;
  const all = await settle(supporters.list());
  const coffeeReady = Boolean(config.coffeeToken());
  const webhookReady = Boolean(config.coffeeWebhookSecret());

  return (
    <>
      <p className="lede">
        The people who have helped pay for this — names and how they helped, never amounts. Tie
        one to a WhatsApp identity and they are starred on the rate-limit page, and the bot can
        name them when somebody asks who supports it.
      </p>

      {params.added !== undefined && (
        <div className="panel notice" style={{ borderColor: "var(--accent)", color: "var(--text)" }}>
          Buy Me a Coffee: <strong>{params.added}</strong> new of {params.seen} found.
        </div>
      )}
      {params.failed && <div className="panel notice">Buy Me a Coffee: {params.failed}</div>}

      <h2>Supporters{all?.length ? ` · ${all.length}` : ""}</h2>
      <div className="panel">
        {all === null ? (
          <p className="empty">Could not read the supporters table.</p>
        ) : all.length === 0 ? (
          <p className="empty">Nobody yet. Add the first below.</p>
        ) : (
          <ul className="rows">
            {all.map((s) => (
              <li key={s.id}>
                <form action={updateSupporter} className="quota-form">
                  <input type="hidden" name="id" value={s.id} />
                  <span className="star" aria-label="supporter">
                    ★
                  </span>
                  <input
                    type="text"
                    name="name"
                    defaultValue={s.name}
                    aria-label="Name"
                    required
                  />
                  <input
                    type="text"
                    name="handles"
                    defaultValue={s.handles.join(", ")}
                    placeholder="number, @username, LID — any that are them"
                    aria-label="WhatsApp identities"
                  />
                  <input
                    type="number"
                    name="coffees"
                    min={1}
                    defaultValue={s.coffees}
                    aria-label="Coffees, the voting weight"
                    title="Coffees — the voting weight, capped at 5"
                  />
                  <input
                    type="text"
                    name="note"
                    defaultValue={s.note ?? ""}
                    placeholder="note"
                    aria-label="Note"
                  />
                  <button type="submit">Save</button>
                </form>
                <span className="meta" style={{ whiteSpace: "nowrap" }}>
                  {supporters.VIA_LABELS[s.via]} · {when(s.since)}
                </span>
                <form action={removeSupporter}>
                  <input type="hidden" name="id" value={s.id} />
                  <button type="submit" className="linky danger">
                    Remove
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </div>

      <h2>Add someone</h2>
      <div className="panel">
        <form action={addSupporter} className="quota-form new">
          <input type="text" name="name" placeholder="Name" aria-label="Name" required />
          <input
            type="text"
            name="handles"
            placeholder="51999888777, @username, LID — comma separated"
            aria-label="WhatsApp identities"
          />
          <select name="via" aria-label="How they helped" defaultValue="yape">
            {VIA.map((v) => (
              <option key={v} value={v}>
                {supporters.VIA_LABELS[v]}
              </option>
            ))}
          </select>
          <input
            type="number"
            name="coffees"
            min={1}
            defaultValue={1}
            aria-label="Coffees"
            title="Coffees — the voting weight"
          />
          <input type="text" name="note" placeholder="note (optional)" aria-label="Note" />
          <button type="submit">Add</button>
        </form>
        <p className="meta" style={{ marginTop: "0.8rem" }}>
          The WhatsApp identity is optional, and takes either form: a number like{" "}
          <code>51999888777</code> or the newer <code>@username</code>. It is normalised to the
          same shape the bot sees on an incoming message, which is what makes the match work.
          Without one they cannot vote on the roadmap, because the bot has no way to recognise
          them.
        </p>
        <p className="meta">
          <strong>Coffees</strong> is the voting weight — a count, never money. Buy Me a Coffee
          fills it in; for a Yape gift you decide the equivalent. It is capped at{" "}
          {supporters.MAX_WEIGHT} when voting, so generosity shows here in full while influence
          levels off.
        </p>
      </div>

      <h2>Buy Me a Coffee</h2>
      <div className="panel">
        {coffeeReady ? (
          <>
            <form action={syncCoffee}>
              <button type="submit">Pull supporters</button>
            </form>
            <p className="meta" style={{ marginTop: "0.8rem" }}>
              Adds anyone new; never overwrites a name or handle edited here, since each pulled
              row is matched on the id it arrived with.
            </p>
          </>
        ) : (
          <>
            <p className="empty">Not connected.</p>
            <p className="meta" style={{ marginTop: "0.6rem" }}>
              Set <code>BUYMEACOFFEE_TOKEN</code> — a personal access token from
              developers.buymeacoffee.com — and this becomes a button. Until then, coffee
              supporters can be added by hand like the Yape ones.
            </p>
          </>
        )}
      </div>

      <h2>Webhook</h2>
      <div className="panel">
        <p className={webhookReady ? "meta" : "empty"}>
          {webhookReady
            ? "Listening. New supporters appear here on their own."
            : "Not listening — no signing secret, so deliveries are refused rather than trusted."}
        </p>
        <dl style={{ marginTop: "0.8rem" }}>
          <div className="row">
            <dt>Point the webhook at</dt>
            <dd>
              <code>{config.appUrl()}/api/coffee/webhook</code>
            </dd>
          </div>
          <div className="row">
            <dt>Then set</dt>
            <dd>
              <code>BUYMEACOFFEE_WEBHOOK_SECRET</code>
            </dd>
          </div>
          <div className="row">
            <dt>Events worth subscribing to</dt>
            <dd style={{ textAlign: "left" }}>
              {WEBHOOK_EVENTS.map((e) => (
                <div key={e}>
                  <code>{e}</code>
                </div>
              ))}
            </dd>
          </div>
        </dl>
        <p className="meta" style={{ marginTop: "0.8rem" }}>
          Each webhook has its own signing secret, shown when you create it; removing and
          re-adding the webhook is how it is regenerated. Deliveries are verified as HMAC-SHA256
          over the raw body and acknowledged immediately — a failed one is retried four times with
          exponential delays, so a slow reply would turn one coffee into five. The dashboard&apos;s
          <em> Send test event</em> button is accepted and deliberately not stored, so you can
          prove the endpoint without inventing a supporter.
        </p>
      </div>
    </>
  );
}
