import Link from "next/link";
import { wapi } from "@/lib/wapi";
import { query } from "@/lib/db";
import * as usage from "@/lib/usage";
import * as features from "@/lib/features";
import { settle, money, tokens } from "./shared";

/**
 * The overview: is it connected, what has it cost, how much of everything is there.
 *
 * Deliberately only counts. Each thing it counts has its own section, and a landing page that
 * tries to show all of them is the page nobody reads.
 */

export const dynamic = "force-dynamic";

export default async function Page() {
  const [status, me, spend, counts, enabled] = await Promise.all([
    settle(wapi.status()),
    settle(wapi.me()),
    settle(usage.summary()),
    settle(
      query<{ stickers: string; memories: string; reminders: string; tasks: string }>(
        `select (select count(*) from stickers)::text            as stickers,
                (select count(*) from memories)::text            as memories,
                (select count(*) from reminders)::text           as reminders,
                (select count(*) from tasks where not done)::text as tasks`,
      ),
    ),
    settle(features.enabled()),
  ]);

  const connected = status === "connected";
  const n = counts?.[0];
  const off = enabled ? features.FEATURES.length - enabled.size : null;

  return (
    <>
      <p className="lede">
        Answers when you tag it in WhatsApp. Everything it can do is switchable, per
        deployment, from these pages.
      </p>

      <h2>Session</h2>
      <div className="panel">
        <dl>
          <div className="row">
            <dt>Status</dt>
            <dd className={connected ? "ok" : "bad"}>{status ?? "unreachable"}</dd>
          </div>
          <div className="row">
            <dt>Identity</dt>
            <dd>{me?.name?.trim() || me?.id || "—"}</dd>
          </div>
          <div className="row">
            <dt>JID</dt>
            <dd>
              <code>{me?.id ?? "—"}</code>
            </dd>
          </div>
          <div className="row">
            <dt>Webhook</dt>
            <dd>
              <code>/api/wapi/webhook</code>
            </dd>
          </div>
        </dl>
      </div>

      {!connected && (
        <p className="lede" style={{ marginTop: "1rem" }}>
          {status === null
            ? "Could not reach wapi — check WAPI_API_KEY."
            : "Link the phone from the wapi dashboard, then reload."}
        </p>
      )}

      <h2>At a glance</h2>
      <div className="panel">
        <dl>
          <div className="row">
            <dt>
              <Link href="/dashboard/features">Features on</Link>
            </dt>
            <dd>
              {enabled === null
                ? "—"
                : `${enabled.size} of ${features.FEATURES.length}${off ? ` · ${off} off` : ""}`}
            </dd>
          </div>
          <div className="row">
            <dt>
              <Link href="/dashboard/stickers">Stickers</Link>
            </dt>
            <dd>{n?.stickers ?? "—"}</dd>
          </div>
          <div className="row">
            <dt>
              <Link href="/dashboard/memory">Remembered facts</Link>
            </dt>
            <dd>{n?.memories ?? "—"}</dd>
          </div>
          <div className="row">
            <dt>
              <Link href="/dashboard/reminders">Scheduled</Link>
            </dt>
            <dd>{n?.reminders ?? "—"}</dd>
          </div>
          <div className="row">
            <dt>Open checklist items</dt>
            <dd>{n?.tasks ?? "—"}</dd>
          </div>
        </dl>
      </div>

      <h2>Spend</h2>
      <div className="panel">
        {spend === null ? (
          <p className="empty">Could not read usage.</p>
        ) : spend.allTime.calls === 0 ? (
          <p className="empty">Nothing recorded yet.</p>
        ) : (
          <dl>
            {(
              [
                ["Today", spend.today],
                ["Last 7 days", spend.week],
                ["All time", spend.allTime],
              ] as const
            ).map(([label, t]) => (
              <div className="row" key={label}>
                <dt>{label}</dt>
                <dd>
                  {tokens(t.inputTokens + t.outputTokens)} tokens · {t.calls} calls ·{" "}
                  {money(t.estimatedUsd)}
                </dd>
              </div>
            ))}
          </dl>
        )}
        <p className="meta" style={{ marginTop: "0.6rem" }}>
          <Link href="/dashboard/usage">Full breakdown</Link>
        </p>
      </div>
    </>
  );
}
