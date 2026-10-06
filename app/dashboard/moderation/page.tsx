import { wapi } from "@/lib/wapi";
import * as moderation from "@/lib/moderation";
import * as features from "@/lib/features";
import { settle, when, shortJid } from "../shared";
import { saveModeration, toggleModeration, deleteModeration } from "./actions";

/**
 * Removing people from a group.
 *
 * The page leads with what it cannot do, because that is what somebody needs to believe before
 * switching this on: the bot cannot be pointed at a person by name, cannot touch an admin, and
 * warns before it removes. Every warning and refusal is listed underneath, not just the
 * removals — a feature whose record only shows what it did is a feature nobody can audit.
 */

export const dynamic = "force-dynamic";

export default async function ModerationPage() {
  const [settings, groups, log, enabled] = await Promise.all([
    settle(moderation.list()),
    settle(wapi.groups()),
    settle(moderation.history(null, 15)),
    settle(features.enabled()),
  ]);

  const on = enabled?.has("moderation") ?? true;
  const configured = new Set((settings ?? []).map((s) => s.chat));
  const nameOf = (jid: string, stored: string | null) =>
    groups?.find((g) => g.jid === jid)?.name ?? stored ?? shortJid(jid);

  return (
    <>
      <p className="lede">
        Groups where the bot may remove somebody. It needs to be an admin of the group for any of
        this to work, and nothing here happens in a group that is not listed.
      </p>

      {!on && (
        <div className="panel notice">
          The feature is switched off, so nobody can be removed anywhere. Turn it on under
          Features.
        </div>
      )}

      <div className="panel notice" style={{ marginTop: "1.4rem" }}>
        <strong>What it cannot do, whatever is ticked below.</strong> It can only act on whoever
        wrote the message it is answering — naming somebody in text does nothing, so nobody can
        point it at another member by typing. It never removes an admin, a super-admin or the
        group&rsquo;s owner. It cannot remove itself. And it is told never to threaten anybody
        with removal, which is the part that would make a group worse than the person it is aimed
        at.
      </div>

      <h2>Groups{settings?.length ? ` · ${settings.length}` : ""}</h2>
      <div className="panel">
        {settings === null ? (
          <p className="empty">Could not read the settings table.</p>
        ) : settings.length === 0 ? (
          <p className="empty">None. The bot cannot remove anybody anywhere.</p>
        ) : (
          <ul className="rows">
            {settings.map((s) => (
              <li key={s.chat}>
                <div className="grow">
                  <strong>{nameOf(s.chat, s.chatName)}</strong>
                  <span className="meta">
                    {s.onRequest ? "an admin may ask" : "not on request"} ·{" "}
                    {s.onOwnJudgement ? (
                      <strong>also on its own judgement</strong>
                    ) : (
                      "never on its own"
                    )}{" "}
                    · {s.warnFirst ? `warns first (${s.warnWindowHours}h)` : "no warning"} · at
                    most {s.maxPerDay}/day
                  </span>
                  {s.note && <span className="meta">note: {s.note}</span>}
                </div>
                <form action={toggleModeration}>
                  <input type="hidden" name="chat" value={s.chat} />
                  <input type="hidden" name="on" value={s.enabled ? "false" : "true"} />
                  <button
                    type="submit"
                    className={s.enabled ? "switch on" : "switch"}
                    role="switch"
                    aria-checked={s.enabled}
                    aria-label={`${s.enabled ? "Disable" : "Enable"} removals here`}
                  >
                    <span className="knob" />
                  </button>
                </form>
                <form action={deleteModeration}>
                  <input type="hidden" name="chat" value={s.chat} />
                  <button type="submit" className="linky danger">
                    Delete
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </div>

      <h2>{settings?.length ? "Add or adjust a group" : "Allow a group"}</h2>
      <div className="panel">
        {groups === null ? (
          <p className="empty">Could not list groups — check the session on the overview page.</p>
        ) : groups.length === 0 ? (
          <p className="empty">The bot is not in any groups yet.</p>
        ) : (
          <form action={saveModeration} className="schedule-form">
            <label htmlFor="chat">Group</label>
            <select id="chat" name="chat" required>
              {groups.map((g) => (
                <option key={g.jid} value={g.jid}>
                  {g.name}
                  {configured.has(g.jid) ? " (already set up)" : ""}
                </option>
              ))}
            </select>

            <label>When it may remove somebody</label>
            <div className="checks">
              <label className="pick">
                <input type="checkbox" name="onRequest" defaultChecked />
                <span>
                  When an admin asks
                  <span className="meta">
                    The admin has to reply to the message of the person they mean.
                  </span>
                </span>
              </label>
              <label className="pick">
                <input type="checkbox" name="onOwnJudgement" />
                <span>
                  On its own judgement
                  <span className="meta">
                    With nobody asking, when somebody is being abusive towards it. Off by
                    default, and the one setting here worth thinking twice about — it makes a
                    model the judge of who stays in a room.
                  </span>
                </span>
              </label>
              <label className="pick">
                <input type="checkbox" name="warnFirst" defaultChecked />
                <span>
                  Warn first
                  <span className="meta">
                    A first offence gets one warning; removal needs it to happen again inside the
                    window. An admin asking outright skips the warning.
                  </span>
                </span>
              </label>
            </div>

            <label htmlFor="warnWindowHours">A warning lasts</label>
            <input
              id="warnWindowHours"
              name="warnWindowHours"
              type="number"
              min={1}
              max={336}
              defaultValue={moderation.DEFAULTS.warnWindowHours}
              aria-describedby="window-help"
            />
            <p className="meta" id="window-help">
              Hours. After that the slate is clean and the next offence is a first one again.
            </p>

            <label htmlFor="maxPerDay">At most</label>
            <input
              id="maxPerDay"
              name="maxPerDay"
              type="number"
              min={1}
              max={5}
              defaultValue={moderation.DEFAULTS.maxPerDay}
              aria-describedby="cap-help"
            />
            <p className="meta" id="cap-help">
              Removals a day in this group. The thing worth bounding is not one wrong removal, it
              is a bot having a bad afternoon.
            </p>

            <label htmlFor="note">What is out of line here</label>
            <input
              id="note"
              name="note"
              maxLength={300}
              placeholder="Optional — this group swears constantly and it means nothing"
              aria-describedby="note-help"
            />
            <p className="meta" id="note-help">
              Read into the turn. A group where everyone insults each other affectionately is not
              a group where an insult means anything, and the bot has no way to know that.
            </p>

            <button type="submit">Save</button>
          </form>
        )}
      </div>

      <h2>What it has done</h2>
      <div className="panel">
        {log === null ? (
          <p className="empty">Could not read the log.</p>
        ) : log.length === 0 ? (
          <p className="empty">
            Nothing yet. Warnings, removals and refusals all land here, with their reason.
          </p>
        ) : (
          <ul className="rows">
            {log.map((entry, i) => (
              <li key={`${entry.at.toISOString()}-${i}`}>
                <div className="grow">
                  <strong className={entry.outcome === "removed" ? "bad" : undefined}>
                    {entry.outcome}
                  </strong>{" "}
                  {entry.targetName ?? shortJid(entry.target)}
                  <span className="meta">
                    {when(entry.at)} · in {nameOf(entry.chat, null)}
                    {entry.askedBy && <> · asked by {entry.askedBy}</>}
                  </span>
                  {entry.reason && <span className="meta">{entry.reason}</span>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
