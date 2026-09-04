import * as rateLimit from "@/lib/rate-limit";
import * as people from "@/lib/people";
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
  const [quotas, directory] = await Promise.all([
    settle(rateLimit.listQuotas()),
    settle(people.directory()),
  ]);

  /**
   * A picker rather than a box to paste an identifier into. `<input list>` with a `<datalist>`
   * is the searchable select the browser already has: you type to filter, or open the list and
   * choose, and with JavaScript off it degrades to exactly the free-text field it replaced.
   */
  const byHandle = new Map((directory ?? []).map((p) => [p.handle, p]));
  const known = new Set(quotas?.map((q) => q.userId) ?? []);
  const unlisted = (directory ?? []).filter((p) => !known.has(p.handle));

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
                    <span className="who-name">
                      {byHandle.get(q.userId)?.supporter && (
                        <span className="star" title="supporter">
                          ★
                        </span>
                      )}
                      {byHandle.get(q.userId)?.label !== q.userId &&
                      byHandle.get(q.userId)?.label ? (
                        byHandle.get(q.userId)?.label
                      ) : (
                        <code>{shortJid(q.userId)}</code>
                      )}
                    </span>
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
            list="people"
            placeholder="Search a name, number or @username"
            aria-label="Person"
            required
          />
          <datalist id="people">
            {(directory ?? []).map((p) => (
              <option key={p.handle} value={p.handle}>
                {p.supporter ? "★ " : ""}
                {p.label === p.handle ? p.seen.join(", ") : `${p.label} · ${p.seen.join(", ")}`}
              </option>
            ))}
          </datalist>
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
              Everyone this deployment knows an identity for and has no quota set — supporters
              first. A ★ is somebody who has chipped in; the rest is where the identity turned up.
            </p>
            <ul className="callers">
              {unlisted.map((p) => (
                <li key={p.handle}>
                  {p.supporter && (
                    <span className="star" title="supporter">
                      ★
                    </span>
                  )}
                  <code>{p.handle}</code>
                  <span className="meta">
                    {p.label === p.handle ? "" : `${p.label} · `}
                    {p.seen.join(" · ")}
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
