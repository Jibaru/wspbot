import { wapi } from "@/lib/wapi";
import { config } from "@/lib/config";
import * as summaries from "@/lib/summaries";
import * as features from "@/lib/features";
import * as cron from "@/lib/cron";
import { settle, when } from "../shared";
import { createSchedule, toggleSchedule, deleteSchedule } from "./actions";

/**
 * Scheduled summaries: read one group, post a digest into another.
 *
 * The page is blunt about what enabling one does, because it is the only thing in this app that
 * records conversation nobody addressed to the bot. Someone setting it up should not have to
 * read the source to find that out.
 */

export const dynamic = "force-dynamic";

/** Patterns people actually want, so nobody has to remember cron to get a daily digest. */
const PRESETS: { label: string; pattern: string }[] = [
  { label: "Every morning at 9", pattern: "0 9 * * *" },
  { label: "Every evening at 8", pattern: "0 20 * * *" },
  { label: "Weekdays at 6pm", pattern: "0 18 * * 1-5" },
  { label: "Mondays at 9", pattern: "0 9 * * 1" },
  { label: "Every 6 hours", pattern: "0 */6 * * *" },
];

export default async function SummariesPage() {
  const [schedules, groups, counts, enabled] = await Promise.all([
    settle(summaries.list()),
    settle(wapi.groups()),
    settle(summaries.recordedCounts()),
    settle(features.enabled()),
  ]);

  const on = enabled?.has("summaries") ?? true;
  const timeZone = config.timezone();
  const nameOf = (jid: string, stored: string | null) =>
    groups?.find((g) => g.jid === jid)?.name ?? stored ?? jid;

  return (
    <>
      <p className="lede">
        Reads one group and posts a digest into another on a schedule — decisions, open
        questions, links people shared, and the pictures worth seeing. Times are in{" "}
        <code>{timeZone}</code>.
      </p>

      {!on && (
        <div className="panel notice">
          The summaries feature is switched off, so nothing is being recorded and nothing will
          fire. Turn it on under Features.
        </div>
      )}

      <div className="panel notice" style={{ marginTop: "1.4rem" }}>
        <strong>While a schedule is enabled, every message in its source group is stored</strong>{" "}
        — not only the ones tagging the bot. That is what a digest is made of. Images are
        described once as they arrive, since the link WhatsApp gives dies within the hour.
        Nothing is kept longer than a fortnight, and switching the schedule off stops it at once.
      </div>

      <h2>Schedules{schedules?.length ? ` · ${schedules.length}` : ""}</h2>
      <div className="panel">
        {schedules === null ? (
          <p className="empty">Could not read the schedules table.</p>
        ) : schedules.length === 0 ? (
          <p className="empty">None yet. Add one below.</p>
        ) : (
          <ul className="rows">
            {schedules.map((s) => {
              const parsed = cron.validate(s.cron);
              const next = parsed.ok
                ? cron.nextRuns(cron.parse(s.cron), timeZone, 1)[0]
                : undefined;
              const held = counts?.get(s.sourceChat) ?? 0;

              return (
                <li key={s.id}>
                  <div className="grow">
                    <strong>{nameOf(s.sourceChat, s.sourceName)}</strong> →{" "}
                    {nameOf(s.destinationChat, s.destinationName)}
                    <span className="meta">
                      <code>{s.cron}</code>
                      {parsed.ok ? (
                        next ? (
                          <> · next {when(next)}</>
                        ) : (
                          <> · no run in the next 40 days</>
                        )
                      ) : (
                        <> · <span className="bad">{parsed.error}</span></>
                      )}
                      {s.enabled && <> · {held} message{held === 1 ? "" : "s"} held</>}
                      {s.lastRunAt && <> · last ran {when(s.lastRunAt)}</>}
                      {s.summarisedTo && <> · covered to {when(s.summarisedTo)}</>}
                    </span>
                    {s.lastError && <span className="meta bad">last error: {s.lastError}</span>}
                  </div>
                  <form action={toggleSchedule}>
                    <input type="hidden" name="id" value={s.id} />
                    <input type="hidden" name="on" value={s.enabled ? "false" : "true"} />
                    <button
                      type="submit"
                      className={s.enabled ? "switch on" : "switch"}
                      role="switch"
                      aria-checked={s.enabled}
                      aria-label={`${s.enabled ? "Disable" : "Enable"} this schedule`}
                    >
                      <span className="knob" />
                    </button>
                  </form>
                  <form action={deleteSchedule}>
                    <input type="hidden" name="id" value={s.id} />
                    <button type="submit" className="linky danger">
                      Delete
                    </button>
                  </form>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <h2>Add a schedule</h2>
      <div className="panel">
        {groups === null ? (
          <p className="empty">
            Could not list groups — check the session on the overview page.
          </p>
        ) : groups.length === 0 ? (
          <p className="empty">The bot is not in any groups yet.</p>
        ) : (
          <form action={createSchedule} className="schedule-form">
            <label htmlFor="source">Summarise this group</label>
            <select id="source" name="source" required>
              {groups.map((g) => (
                <option key={g.jid} value={g.jid}>
                  {g.name}
                </option>
              ))}
            </select>

            <label htmlFor="destination">Post the digest here</label>
            <select id="destination" name="destination" required>
              {groups.map((g) => (
                <option key={g.jid} value={g.jid}>
                  {g.name}
                </option>
              ))}
            </select>

            <label htmlFor="cron">When</label>
            <input
              id="cron"
              name="cron"
              defaultValue="0 9 * * *"
              list="cron-presets"
              required
              aria-describedby="cron-help"
            />
            <datalist id="cron-presets">
              {PRESETS.map((p) => (
                <option key={p.pattern} value={p.pattern}>
                  {p.label}
                </option>
              ))}
            </datalist>
            <p className="meta" id="cron-help">
              Five cron fields — minute, hour, day, month, weekday. {" "}
              {PRESETS.map((p) => (
                <span key={p.pattern}>
                  <code>{p.pattern}</code> {p.label.toLowerCase()};{" "}
                </span>
              ))}
            </p>

            <button type="submit">Add</button>
          </form>
        )}
      </div>
    </>
  );
}
