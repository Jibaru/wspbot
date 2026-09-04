import { wapi } from "@/lib/wapi";
import { config } from "@/lib/config";
import * as chime from "@/lib/chime";
import * as features from "@/lib/features";
import { settle, when } from "../shared";
import { saveChime, toggleChime, deleteChime } from "./actions";

/**
 * Chiming in: the groups the bot may speak in without being tagged.
 *
 * The page leads with what it costs a group — every message stored, and the bot able to speak
 * unprompted — because those are the two things somebody would be annoyed to discover later.
 * Each row says *why* it is not about to say anything, since "enabled and silent" is the normal
 * state and a page that only showed a switch would look broken.
 */

export const dynamic = "force-dynamic";

export default async function ChimePage() {
  const now = new Date();
  const [settings, groups, enabled] = await Promise.all([
    settle(chime.list()),
    settle(wapi.groups()),
    settle(features.enabled()),
  ]);

  const on = enabled?.has("chime") ?? true;
  const timeZone = config.timezone();
  const nameOf = (jid: string, stored: string | null) =>
    groups?.find((g) => g.jid === jid)?.name ?? stored ?? jid;

  // Read alongside each row: what the runner would decide about this group right now.
  const holds = new Map<string, string | null>();
  const recents = new Map<string, { at: Date; text: string }[]>();
  for (const s of settings ?? []) {
    holds.set(s.chat, await settle(chime.holdReason(s, now)));
    recents.set(s.chat, (await settle(chime.recent(s.chat, 3))) ?? []);
  }

  const configured = new Set((settings ?? []).map((s) => s.chat));
  const available = (groups ?? []).filter((g) => !configured.has(g.jid));

  return (
    <>
      <p className="lede">
        Groups the bot reads along in and occasionally speaks in without being tagged — the way
        somebody in the room would. Quiet hours are in <code>{timeZone}</code>.
      </p>

      {!on && (
        <div className="panel notice">
          Chiming in is switched off, so nothing here is being recorded and nothing will be said.
          Turn it on under Features.
        </div>
      )}

      <div className="panel notice" style={{ marginTop: "1.4rem" }}>
        <strong>A group set up here is recorded and can be spoken in unprompted</strong> — every
        message stored, not only the ones tagging the bot, exactly as a summary schedule does.
        That is what it reads to know whether anything is worth saying. Nothing is kept longer
        than a fortnight, the bot answers honestly when anyone asks whether it is listening, and
        switching a group off stops both at once.
      </div>

      <h2>Groups{settings?.length ? ` · ${settings.length}` : ""}</h2>
      <div className="panel">
        {settings === null ? (
          <p className="empty">Could not read the settings table.</p>
        ) : settings.length === 0 ? (
          <p className="empty">None yet. Add one below.</p>
        ) : (
          <ul className="rows">
            {settings.map((s) => {
              const hold = holds.get(s.chat);
              const said = recents.get(s.chat) ?? [];
              return (
                <li key={s.chat}>
                  <div className="grow">
                    <strong>{nameOf(s.chat, s.chatName)}</strong>
                    <span className="meta">
                      at most every {s.everyMinutes} min · after {s.minMessages} new messages ·{" "}
                      {s.maxPerDay}/day ·{" "}
                      {s.quietFrom === s.quietTo
                        ? "never quiet"
                        : `quiet ${s.quietFrom}:00–${s.quietTo}:00`}
                      {s.lastChimeAt && <> · last considered {when(s.lastChimeAt)}</>}
                    </span>
                    {s.note && <span className="meta">note: {s.note}</span>}
                    <span className="meta">
                      {hold ? <>holding: {hold}</> : <>ready — it will speak when something is worth saying</>}
                    </span>
                    {s.lastError && <span className="meta bad">last error: {s.lastError}</span>}
                    {said.length > 0 && (
                      <span className="meta">
                        last said: {said.map((c) => `“${c.text.split("\n")[0]}”`).join(" · ")}
                      </span>
                    )}
                  </div>
                  <form action={toggleChime}>
                    <input type="hidden" name="chat" value={s.chat} />
                    <input type="hidden" name="on" value={s.enabled ? "false" : "true"} />
                    <button
                      type="submit"
                      className={s.enabled ? "switch on" : "switch"}
                      role="switch"
                      aria-checked={s.enabled}
                      aria-label={`${s.enabled ? "Disable" : "Enable"} chiming in here`}
                    >
                      <span className="knob" />
                    </button>
                  </form>
                  <form action={deleteChime}>
                    <input type="hidden" name="chat" value={s.chat} />
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

      <h2>{settings?.length ? "Add or adjust a group" : "Add a group"}</h2>
      <div className="panel">
        {groups === null ? (
          <p className="empty">
            Could not list groups — check the session on the overview page.
          </p>
        ) : groups.length === 0 ? (
          <p className="empty">The bot is not in any groups yet.</p>
        ) : (
          <form action={saveChime} className="schedule-form">
            <label htmlFor="chat">Group</label>
            <select id="chat" name="chat" required>
              {/* Ones already set up stay in the list: this form edits as well as adds. */}
              {[...available, ...(groups.filter((g) => configured.has(g.jid)) ?? [])].map((g) => (
                <option key={g.jid} value={g.jid}>
                  {g.name}
                  {configured.has(g.jid) ? " (already set up)" : ""}
                </option>
              ))}
            </select>

            <label htmlFor="everyMinutes">At most once every</label>
            <input
              id="everyMinutes"
              name="everyMinutes"
              type="number"
              min={15}
              max={1440}
              defaultValue={chime.DEFAULTS.everyMinutes}
              aria-describedby="every-help"
            />
            <p className="meta" id="every-help">
              Minutes. The floor on how often it may speak here, not a timer — it still only
              speaks when there is something worth saying.
            </p>

            <label htmlFor="minMessages">After at least</label>
            <input
              id="minMessages"
              name="minMessages"
              type="number"
              min={2}
              max={200}
              defaultValue={chime.DEFAULTS.minMessages}
              aria-describedby="min-help"
            />
            <p className="meta" id="min-help">
              New messages since it last spoke, so it joins a conversation rather than talking to
              an empty room. The most recent of them has to be within the last{" "}
              {chime.FRESH_MINUTES} minutes.
            </p>

            <label htmlFor="maxPerDay">No more than</label>
            <input
              id="maxPerDay"
              name="maxPerDay"
              type="number"
              min={1}
              max={12}
              defaultValue={chime.DEFAULTS.maxPerDay}
              aria-describedby="max-help"
            />
            <p className="meta" id="max-help">
              Times a day. A day means a day in <code>{timeZone}</code>.
            </p>

            <label htmlFor="quietFrom">Quiet from</label>
            <input
              id="quietFrom"
              name="quietFrom"
              type="number"
              min={0}
              max={23}
              defaultValue={chime.DEFAULTS.quietFrom}
            />

            <label htmlFor="quietTo">Quiet until</label>
            <input
              id="quietTo"
              name="quietTo"
              type="number"
              min={0}
              max={23}
              defaultValue={chime.DEFAULTS.quietTo}
              aria-describedby="quiet-help"
            />
            <p className="meta" id="quiet-help">
              Hours of the day, 0–23. Set both the same for no quiet hours at all.
            </p>

            <label htmlFor="note">About this group</label>
            <input
              id="note"
              name="note"
              maxLength={300}
              placeholder="Optional — what this group is, and how to behave in it"
              aria-describedby="note-help"
            />
            <p className="meta" id="note-help">
              Read into the turn that writes the message. “Work group, keep it dry” or “friends,
              jokes are fine” changes what it says more than any of the numbers above.
            </p>

            <button type="submit">Save</button>
          </form>
        )}
      </div>
    </>
  );
}
