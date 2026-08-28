import * as reminders from "@/lib/reminders";
import * as features from "@/lib/features";
import { settle, shortJid } from "../shared";
import { cancelReminder } from "./actions";

/**
 * What is scheduled, across every chat.
 *
 * Worth a page of its own because a reminder is the one thing here that acts on its own: a
 * repeating job that has gone wrong keeps costing money on a timer, and nothing in a chat log
 * makes that obvious.
 */

export const dynamic = "force-dynamic";

export default async function RemindersPage() {
  const [scheduled, enabled] = await Promise.all([
    settle(reminders.all()),
    settle(features.enabled()),
  ]);
  const running = enabled?.has("reminders") ?? true;

  return (
    <>
      <p className="lede">
        Each is run back through the bot when it comes due, with all its tools — so “check the
        forecast and tell me” actually checks. One per person per chat; setting another replaces
        it.
      </p>

      {!running && (
        <div className="panel notice">
          Reminders are switched off, so nothing below will fire. Anything already overdue runs
          when the feature is switched back on, rather than being quietly dropped.
        </div>
      )}

      <h2>Scheduled{scheduled?.length ? ` · ${scheduled.length}` : ""}</h2>
      <div className="panel">
        {scheduled === null ? (
          <p className="empty">Could not read the reminders table.</p>
        ) : scheduled.length === 0 ? (
          <p className="empty">Nothing scheduled.</p>
        ) : (
          <ul className="rows">
            {scheduled.map((r) => (
              <li key={`${r.chat}:${r.userId}`}>
                <div className="grow">
                  {r.prompt}
                  <span className="meta">
                    {reminders.localTime(r.nextAt)}
                    {r.everyMinutes
                      ? ` · every ${r.everyMinutes} min`
                      : " · once"}
                    {r.maxRuns ? ` · ${r.runs}/${r.maxRuns} runs` : r.runs ? ` · ${r.runs} runs` : ""}
                    {" · "}
                    {r.askedBy ?? shortJid(r.userId)} in {r.chat}
                  </span>
                </div>
                <form action={cancelReminder}>
                  <input type="hidden" name="chat" value={r.chat} />
                  <input type="hidden" name="userId" value={r.userId} />
                  <button type="submit" className="linky danger">
                    Cancel
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
