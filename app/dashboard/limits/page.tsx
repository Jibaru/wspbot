import * as rateLimit from "@/lib/rate-limit";
import { config } from "@/lib/config";
import { settle, shortJid, when } from "../shared";
import { saveQuota, removeQuota } from "./actions";

/**
 * Who may call the bot how often.
 *
 * The table holds exceptions, not people: anyone without a row gets the deployment default. So
 * an empty list is the normal state, not a broken one.
 */

export const dynamic = "force-dynamic";

export default async function LimitsPage() {
  const [quotas, callers] = await Promise.all([
    settle(rateLimit.listQuotas()),
    settle(rateLimit.recentCallers()),
  ]);

  const known = new Set(quotas?.map((q) => q.userId) ?? []);
  const unlisted = (callers ?? []).filter((c) => !known.has(c.userId));

  return (
    <>
      <p className="lede">
        Counted per person, not per chat, on a sliding one-minute window — so nobody can use up a
        group&apos;s allowance, and nobody gets a fresh allowance by waiting for the clock to
        tick over. Someone over their limit is told once per window and never reaches the model.
      </p>

      <h2>Default</h2>
      <div className="panel">
        <dl>
          <div className="row">
            <dt>Everyone without a row below</dt>
            <dd>
              {config.defaultRateLimit()} per minute
            </dd>
          </div>
        </dl>
        <p className="meta" style={{ marginTop: "0.6rem" }}>
          Set by <code>BOT_RATE_LIMIT_PER_MINUTE</code>, so changing it is a deploy. Per-person
          limits below take effect on the next message.
        </p>
      </div>

      <h2>Per person{quotas?.length ? ` · ${quotas.length}` : ""}</h2>
      <div className="panel">
        {quotas === null ? (
          <p className="empty">Could not read the quota table.</p>
        ) : quotas.length === 0 ? (
          <p className="empty">
            No exceptions set — everyone is on the default.
          </p>
        ) : (
          <ul className="rows">
            {quotas.map((q) => (
              <li key={q.userId}>
                <form action={saveQuota} className="quota-form">
                  <input type="hidden" name="userId" value={q.userId} />
                  <div className="quota-who">
                    <code>{shortJid(q.userId)}</code>
                    <span className="meta">set {when(q.updatedAt)}</span>
                  </div>
                  <input
                    type="number"
                    name="perMinute"
                    min={1}
                    defaultValue={q.perMinute}
                    aria-label={`Messages per minute for ${shortJid(q.userId)}`}
                  />
                  <input
                    type="text"
                    name="note"
                    defaultValue={q.note ?? ""}
                    placeholder="note"
                    aria-label="Note"
                  />
                  <button type="submit">Save</button>
                </form>
                <form action={removeQuota}>
                  <input type="hidden" name="userId" value={q.userId} />
                  <button type="submit" className="linky">
                    Back to default
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </div>

      <h2>Add a limit</h2>
      <div className="panel">
        <form action={saveQuota} className="quota-form new">
          <input
            type="text"
            name="userId"
            placeholder="51922471582@s.whatsapp.net"
            aria-label="Person"
            required
          />
          <input
            type="number"
            name="perMinute"
            min={1}
            defaultValue={config.defaultRateLimit()}
            aria-label="Messages per minute"
            required
          />
          <input type="text" name="note" placeholder="note (optional)" aria-label="Note" />
          <button type="submit">Add</button>
        </form>
        {unlisted.length > 0 && (
          <>
            <p className="meta" style={{ margin: "1rem 0 0.5rem" }}>
              Seen calling recently — copy one rather than hunting for a raw id. Only the last
              hour is kept, which is also when someone is hitting a limit and you come looking.
            </p>
            <ul className="callers">
              {unlisted.map((c) => (
                <li key={c.userId}>
                  <code>{c.userId}</code>
                  <span className="meta">
                    {c.calls} call{c.calls === 1 ? "" : "s"} · last {when(c.lastAt)}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </>
  );
}
