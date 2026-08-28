import * as features from "@/lib/features";
import { config } from "@/lib/config";
import { toggleFeature } from "./actions";

/**
 * What the bot is allowed to do.
 *
 * A switch here withdraws the feature's tools *and* the part of the system prompt that describes
 * them, on the next message. Nothing is cached, so there is no deploy or restart in the loop.
 */

export const dynamic = "force-dynamic";

export default async function FeaturesPage() {
  const list = await features.list();
  const available = {
    notion: Boolean(config.notion()),
    sheets: Boolean(config.googleServiceAccount()),
  };

  /** Reading needs no credentials; only writing does. So sheets is never fully unavailable. */
  const unmet = (f: features.Feature): string | null =>
    f.needs === "notion" && !available.notion
      ? "Needs NOTION_CLIENT_ID and NOTION_CLIENT_SECRET — the tools stay hidden until it has them."
      : f.needs === "sheets" && !available.sheets
        ? "Reading works; writing needs GOOGLE_SERVICE_ACCOUNT_JSON."
        : null;

  return (
    <>
      <p className="lede">
        Switched off means the tools are withdrawn and the instructions describing them go with
        them, from the next message onwards. The bot then says the thing is turned off rather
        than offering to do it.
      </p>

      <h2>Switchable · {list.filter((f) => f.on).length} on</h2>
      <div className="panel">
        <ul className="toggles">
          {list.map((f) => {
            const note = unmet(f);
            return (
              <li key={f.key}>
                <div className="toggle-text">
                  <strong>{f.title}</strong>
                  <span>{f.detail}</span>
                  {note && <span className="warn-note">{note}</span>}
                </div>
                <form action={toggleFeature}>
                  <input type="hidden" name="key" value={f.key} />
                  <input type="hidden" name="on" value={f.on ? "false" : "true"} />
                  <button
                    type="submit"
                    className={f.on ? "switch on" : "switch"}
                    role="switch"
                    aria-checked={f.on}
                    aria-label={`${f.on ? "Disable" : "Enable"} ${f.title}`}
                  >
                    <span className="knob" />
                  </button>
                </form>
              </li>
            );
          })}
        </ul>
      </div>

      <h2>Always on</h2>
      <div className="panel">
        <ul className="features">
          {features.ALWAYS.map((f) => (
            <li key={f.title}>
              <strong>{f.title}</strong>
              <span>{f.detail}</span>
            </li>
          ))}
        </ul>
        <p className="meta" style={{ marginTop: "0.9rem" }}>
          Not offered as switches: with any of them off there would be no bot left to configure.
        </p>
      </div>
    </>
  );
}
