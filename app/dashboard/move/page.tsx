import { wapi } from "@/lib/wapi";
import * as transfer from "@/lib/transfer";
import { settle } from "../shared";
import { moveContext } from "./actions";

/**
 * Moving a group's context into another group.
 *
 * Two steps, and both are plain form posts so the whole thing works with JavaScript off. Picking
 * a source reloads the page with `?from=`, which is what lets the second form list real items
 * with real checkboxes rather than inventing a client-side picker.
 */

export const dynamic = "force-dynamic";

const KIND_LABELS: Record<transfer.Kind, string> = {
  memory: "Remembered facts",
  task: "Checklist",
  reminder: "Scheduled reminders",
  notion: "Notion",
};

const ORDER: transfer.Kind[] = ["memory", "task", "reminder", "notion"];

export default async function MovePage({
  searchParams,
}: {
  searchParams: Promise<{
    from?: string;
    to?: string;
    moved?: string;
    of?: string;
    skipped?: string | string[];
    error?: string;
  }>;
}) {
  const params = await searchParams;
  const from = params.from ?? "";

  const [groups, items] = await Promise.all([
    settle(wapi.groups()),
    from ? settle(transfer.inventory(from)) : Promise.resolve([]),
  ]);

  const nameOf = (jid: string) => groups?.find((g) => g.jid === jid)?.name ?? jid;
  const skipped = params.skipped
    ? Array.isArray(params.skipped)
      ? params.skipped
      : [params.skipped]
    : [];
  const moved = params.moved ? Number(params.moved) : null;

  const byKind = new Map<transfer.Kind, transfer.Item[]>();
  for (const item of items ?? []) {
    byKind.set(item.kind, [...(byKind.get(item.kind) ?? []), item]);
  }

  return (
    <>
      <p className="lede">
        A group gets remade and everything the bot had learned stays behind. This carries the
        curated part across — facts, checklist items, reminders, the Notion connection — one item
        at a time, so you take what is still true and leave the rest.
      </p>

      {moved !== null && (
        <div className="panel notice" style={{ borderColor: "var(--accent)", color: "var(--text)" }}>
          Moved <strong>{moved}</strong> of {params.of} into{" "}
          <strong>{nameOf(params.to ?? "")}</strong>.
          {skipped.length > 0 && (
            <ul className="rows" style={{ marginTop: "0.7rem" }}>
              {skipped.map((s) => (
                <li key={s}>
                  <span className="grow meta">{s}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {params.error && (
        <div className="panel notice">
          Nothing to do — pick a source, a different destination, and at least one item.
        </div>
      )}

      <h2>Which group</h2>
      <div className="panel">
        {groups === null ? (
          <p className="empty">Could not list groups — check the session on the overview page.</p>
        ) : (
          <form className="schedule-form" method="get">
            <label htmlFor="from">Take context out of</label>
            <select id="from" name="from" defaultValue={from} required>
              <option value="">Choose a group…</option>
              {groups.map((g) => (
                <option key={g.jid} value={g.jid}>
                  {g.name}
                </option>
              ))}
            </select>
            <button type="submit">Show what it has</button>
          </form>
        )}
      </div>

      {from && (
        <>
          <h2>
            {nameOf(from)} · {items?.length ?? 0} movable
          </h2>
          <div className="panel">
            {items === null ? (
              <p className="empty">Could not read that group&apos;s context.</p>
            ) : items.length === 0 ? (
              <p className="empty">
                Nothing here yet — no facts, checklist items, reminders or Notion connection.
              </p>
            ) : (
              <form action={moveContext}>
                <input type="hidden" name="from" value={from} />

                {ORDER.filter((k) => byKind.has(k)).map((kind) => (
                  <div key={kind}>
                    <p className="meta" style={{ margin: "0.9rem 0 0.4rem" }}>
                      {KIND_LABELS[kind]}
                    </p>
                    <ul className="rows">
                      {(byKind.get(kind) ?? []).map((item) => (
                        <li key={item.ref}>
                          <label className="pick grow">
                            <input type="checkbox" name="ref" value={item.ref} />
                            <span>
                              {item.label}
                              {item.detail && <span className="meta">{item.detail}</span>}
                            </span>
                          </label>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}

                <div className="move-controls">
                  <label htmlFor="to">Into</label>
                  <select id="to" name="to" required>
                    <option value="">Choose a group…</option>
                    {(groups ?? [])
                      .filter((g) => g.jid !== from)
                      .map((g) => (
                        <option key={g.jid} value={g.jid}>
                          {g.name}
                        </option>
                      ))}
                  </select>

                  <fieldset className="modes">
                    <label>
                      <input type="radio" name="mode" value="move" defaultChecked /> Move — it
                      leaves this group
                    </label>
                    <label>
                      <input type="radio" name="mode" value="copy" /> Copy — both groups keep it
                    </label>
                  </fieldset>

                  <button type="submit">Take them across</button>
                </div>

                <p className="meta" style={{ marginTop: "0.8rem" }}>
                  A Notion connection is always moved, never copied: somebody authorised that
                  workspace for one conversation, and one grant should stay one grant. A reminder
                  is refused if that person already has one waiting in the destination.
                </p>
              </form>
            )}
          </div>
        </>
      )}

      <h2>What stays put</h2>
      <div className="panel">
        <ul className="features">
          {transfer.IMMOVABLE.map((i) => (
            <li key={i.what}>
              <strong>{i.what}</strong>
              <span>{i.why}</span>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}
