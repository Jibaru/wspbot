import { wapi } from "@/lib/wapi";
import { config } from "@/lib/config";
import * as cron from "@/lib/cron";
import * as features from "@/lib/features";
import * as leaderboard from "@/lib/leaderboard";
import { settle, when } from "../shared";
import { saveWatch, toggleWatch, deleteWatch, sendNow } from "./actions";

/**
 * The vote leaderboard: where the project stands, and which groups get told when it moves.
 *
 * The page leads with the live standing rather than with the settings, because that is the thing
 * anybody opening it actually wants — and because seeing the same figure the bot would send is
 * the fastest way to know this is wired up correctly. Each row then says *why* it is not about
 * to send anything: "enabled and silent" is the normal state for a watch on a board that has not
 * moved, and a page showing only a switch would read as broken.
 */

export const dynamic = "force-dynamic";

/** Cadences that make sense for a vote that runs for a day or two, so nobody types cron. */
const PRESETS: { label: string; pattern: string }[] = [
  { label: "Every 10 minutes", pattern: "*/10 * * * *" },
  { label: "Every half hour", pattern: "*/30 * * * *" },
  { label: "Hourly", pattern: "0 * * * *" },
  { label: "Every 3 hours", pattern: "0 */3 * * *" },
  { label: "Twice a day, 9 and 9", pattern: "0 9,21 * * *" },
];

export default async function LeaderboardPage() {
  const now = new Date();
  const cfg = config.leaderboard();
  const timeZone = config.timezone();

  const [watches, groups, enabled, reading] = await Promise.all([
    settle(leaderboard.list(now)),
    settle(wapi.groups()),
    settle(features.enabled()),
    cfg ? settle(leaderboard.read()) : Promise.resolve(null),
  ]);

  const on = enabled?.has("leaderboard") ?? true;
  const standing =
    reading && cfg ? leaderboard.standing(reading.projects, cfg.slug) : null;
  const current = standing && reading ? leaderboard.isCurrent(standing, reading) : false;

  const nameOf = (jid: string, stored: string | null) =>
    groups?.find((g) => g.jid === jid)?.name ?? stored ?? jid;

  const configured = new Set((watches ?? []).map((w) => w.chat));
  const available = (groups ?? []).filter((g) => !configured.has(g.jid));

  return (
    <>
      <p className="lede">
        Where we stand in the public vote, and which groups hear about it. Quiet hours and the
        daily cap are in <code>{timeZone}</code>.
      </p>

      {!on && (
        <div className="panel notice">
          Following the leaderboard is switched off, so nothing is read and no group is told
          anything. Turn it on under Features.
        </div>
      )}

      {!cfg && (
        <div className="panel notice">
          <strong>No board is configured on this deployment.</strong> Set{" "}
          <code>LEADERBOARD_URL</code> to the site and <code>LEADERBOARD_SLUG</code> to our
          project&rsquo;s slug, in the compose environment <em>and</em> in{" "}
          <code>docker-compose.yml</code> — set in only one of the two, the container never sees
          them and this page looks exactly like this.
        </div>
      )}

      <h2>Right now</h2>
      <div className="panel">
        {!cfg ? (
          <p className="empty">Nothing to read until a board is configured.</p>
        ) : reading === null ? (
          <p className="empty">
            Could not read <code>{cfg.url}</code>. Nothing will be sent while that is true, and
            no group is told about the failure.
          </p>
        ) : !standing ? (
          <p className="empty">
            The board was read — {reading.projects.length} projects — but{" "}
            <code>{cfg.slug}</code> is not one of them. Check <code>LEADERBOARD_SLUG</code>.
          </p>
        ) : (
          <>
            <p>
              <strong>
                #{standing.position}
                {standing.shared ? " (shared)" : ""}
              </strong>{" "}
              of {standing.of} projects · <strong>{standing.me.votes} votes</strong>
            </p>
            <p>
              {standing.next ? (
                <>
                  <strong>{standing.next.toBeat} more votes</strong> passes {standing.next.name},
                  who has {standing.next.votes}. {standing.next.toTie} would draw level and share
                  the place.
                </>
              ) : (
                <strong>Top of the board.</strong>
              )}
            </p>
            <span className="meta">
              {standing.chaser && (
                <>
                  {standing.chaser.name} is next below on {standing.chaser.votes}, a lead of{" "}
                  {standing.chaser.lead} ·{" "}
                </>
              )}
              {standing.totalVotes} votes cast in total
              {reading.at && <> · feed updated {when(reading.at)}</>}
            </span>
            {!current && (
              <span className="meta bad">
                This reading is not current — the feed says so itself. Anything sent now says as
                much.
              </span>
            )}
            <span className="meta">
              <a href={cfg.url} target="_blank" rel="noopener noreferrer">
                {cfg.url}
              </a>
            </span>
          </>
        )}
      </div>

      <h2>Groups told{watches?.length ? ` · ${watches.length}` : ""}</h2>
      <div className="panel">
        {watches === null ? (
          <p className="empty">Could not read the watch table.</p>
        ) : watches.length === 0 ? (
          <p className="empty">None yet. Add one below.</p>
        ) : (
          <ul className="rows">
            {watches.map((w) => {
              const parsed = cron.validate(w.cron);
              const next = parsed.ok
                ? cron.nextRuns(cron.parse(w.cron), timeZone, 1)[0]
                : undefined;
              /*
               * `holdReason` answers for the row; whether this deployment has a board at all is
               * this page's business. A row reading "ready" under the notice above would be the
               * page contradicting itself.
               */
              const hold =
                leaderboard.holdReason(w, now) ??
                (cfg ? null : "no board is configured on this deployment");

              return (
                <li key={w.chat}>
                  <div className="grow">
                    <strong>{nameOf(w.chat, w.chatName)}</strong>
                    <span className="meta">
                      <code>{w.cron}</code>
                      {parsed.ok ? (
                        next ? (
                          <> · next check {when(next)}</>
                        ) : (
                          <> · no check in the next 40 days</>
                        )
                      ) : (
                        <>
                          {" · "}
                          <span className="bad">{parsed.error}</span>
                        </>
                      )}
                      {" · "}
                      {w.onChangeOnly ? "only when it moves" : "every check"}
                      {" · "}
                      {w.withPicture ? "with a picture" : "text only"}
                      {" · "}
                      {w.announcedToday}/{w.maxPerDay} today
                      {w.quietFrom !== w.quietTo && (
                        <>
                          {" · "}quiet {w.quietFrom}:00–{w.quietTo}:00
                        </>
                      )}
                      {w.endsAt && <> · until {when(w.endsAt)}</>}
                    </span>
                    <span className="meta">
                      {w.last
                        ? `last told them #${w.last.position} on ${w.last.votes} votes${
                            w.last.gap === null ? "" : `, ${w.last.gap} off the next place`
                          }`
                        : "nothing sent yet"}
                      {w.lastRunAt && <> · last checked {when(w.lastRunAt)}</>}
                    </span>
                    <span className="meta">
                      {hold ? (
                        <>holding: {hold}</>
                      ) : (
                        <>ready — it speaks on the next check where something has moved</>
                      )}
                    </span>
                    {w.note && <span className="meta">sounds like: {w.note}</span>}
                    {w.lastError && <span className="meta bad">last error: {w.lastError}</span>}
                  </div>
                  <form action={sendNow}>
                    <input type="hidden" name="chat" value={w.chat} />
                    <button type="submit" className="linky">
                      Send now
                    </button>
                  </form>
                  <form action={toggleWatch}>
                    <input type="hidden" name="chat" value={w.chat} />
                    <input type="hidden" name="on" value={w.enabled ? "false" : "true"} />
                    <button
                      type="submit"
                      className={w.enabled ? "switch on" : "switch"}
                      role="switch"
                      aria-checked={w.enabled}
                      aria-label={`${w.enabled ? "Stop" : "Start"} telling this group`}
                    >
                      <span className="knob" />
                    </button>
                  </form>
                  <form action={deleteWatch}>
                    <input type="hidden" name="chat" value={w.chat} />
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

      <h2>{watches?.length ? "Add or adjust a group" : "Add a group"}</h2>
      <div className="panel">
        {groups === null ? (
          <p className="empty">
            Could not list groups — check the session on the overview page.
          </p>
        ) : groups.length === 0 ? (
          <p className="empty">The bot is not in any groups yet.</p>
        ) : (
          <form action={saveWatch} className="schedule-form">
            <label htmlFor="chat">Group</label>
            <select id="chat" name="chat" required>
              {/* Ones already set up stay listed: this form edits as well as adds. */}
              {[...available, ...(groups.filter((g) => configured.has(g.jid)) ?? [])].map((g) => (
                <option key={g.jid} value={g.jid}>
                  {g.name}
                  {configured.has(g.jid) ? " (already set up)" : ""}
                </option>
              ))}
            </select>

            <label htmlFor="cron">Check</label>
            <input
              id="cron"
              name="cron"
              defaultValue={leaderboard.DEFAULTS.cron}
              list="leaderboard-presets"
              required
              aria-describedby="cron-help"
            />
            <datalist id="leaderboard-presets">
              {PRESETS.map((p) => (
                <option key={p.pattern} value={p.pattern}>
                  {p.label}
                </option>
              ))}
            </datalist>
            <p className="meta" id="cron-help">
              Five cron fields — minute, hour, day, month, weekday. This is how often it{" "}
              <em>looks</em>, which is a ceiling and not a timer: with the switch below it only
              sends when the standing has actually changed.
            </p>

            <label htmlFor="onChangeOnly">Only when it moves</label>
            <input
              id="onChangeOnly"
              name="onChangeOnly"
              type="checkbox"
              defaultChecked={leaderboard.DEFAULTS.onChangeOnly}
              aria-describedby="change-help"
            />
            <p className="meta" id="change-help">
              A change of place, of votes, or of the gap. Turn this off and it sends on every
              check, which is how a group learns to mute the bot.
            </p>

            <label htmlFor="withPicture">Attach a picture</label>
            <input
              id="withPicture"
              name="withPicture"
              type="checkbox"
              defaultChecked={leaderboard.DEFAULTS.withPicture}
              aria-describedby="picture-help"
            />
            <p className="meta" id="picture-help">
              A screenshot of the board, with the figures as its caption. The numbers never come
              from the picture — they are read from the board&rsquo;s own data either way. Costs
              one browser run per message that goes out, which the cap above bounds; a capture
              that fails costs the picture, not the message.
            </p>

            <label htmlFor="maxPerDay">No more than</label>
            <input
              id="maxPerDay"
              name="maxPerDay"
              type="number"
              min={1}
              max={48}
              defaultValue={leaderboard.DEFAULTS.maxPerDay}
              aria-describedby="max-help"
            />
            <p className="meta" id="max-help">
              Messages a day, counted in a day in <code>{timeZone}</code>. &ldquo;Send now&rdquo;
              counts too.
            </p>

            <label htmlFor="quietFrom">Quiet from</label>
            <input
              id="quietFrom"
              name="quietFrom"
              type="number"
              min={0}
              max={23}
              defaultValue={leaderboard.DEFAULTS.quietFrom}
            />

            <label htmlFor="quietTo">Quiet until</label>
            <input
              id="quietTo"
              name="quietTo"
              type="number"
              min={0}
              max={23}
              defaultValue={leaderboard.DEFAULTS.quietTo}
              aria-describedby="quiet-help"
            />
            <p className="meta" id="quiet-help">
              Hours, 0–23, wrapping across midnight. Set both the same for none at all.
            </p>

            <label htmlFor="note">How to sound here</label>
            <input
              id="note"
              name="note"
              maxLength={300}
              placeholder="Optional — “peruano, seco, con jerga” or “formal, es un grupo de clientes”"
              aria-describedby="note-help"
            />
            <p className="meta" id="note-help">
              Read by the turn that writes the closing line, and it counts for more than anything
              else on this page. Left empty, it copies the register of whatever the bot has
              already said in this group — which is usually right, and occasionally not what you
              wanted. The figures never come from that turn.
            </p>

            <label htmlFor="endsAt">Stop after</label>
            <input id="endsAt" name="endsAt" type="date" aria-describedby="ends-help" />
            <p className="meta" id="ends-help">
              Optional, and worth setting: a vote ends, and without a date here the bot is still
              announcing a frozen board next month. Leave empty to run until switched off.
            </p>

            <button type="submit">Save</button>
          </form>
        )}
      </div>
    </>
  );
}
