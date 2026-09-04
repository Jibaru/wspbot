import * as roadmap from "@/lib/roadmap";
import * as supporters from "@/lib/supporters";
import { settle, when } from "../shared";
import { addItem, setItemState, removeItem } from "./actions";

/**
 * What gets built next, and who is asking for it.
 *
 * Proposals from supporters land here rather than on the list, so the roadmap stays yours while
 * the suggesting stays open.
 */

export const dynamic = "force-dynamic";

const NEXT: Record<roadmap.State, { label: string; to: roadmap.State }[]> = {
  proposed: [
    { label: "Approve", to: "open" },
    { label: "Decline", to: "declined" },
  ],
  open: [
    { label: "Shipped", to: "shipped" },
    { label: "Decline", to: "declined" },
  ],
  shipped: [{ label: "Reopen", to: "open" }],
  declined: [{ label: "Reopen", to: "open" }],
};

const HEADINGS: Record<roadmap.State, string> = {
  proposed: "Waiting for you",
  open: "Open for votes",
  shipped: "Shipped",
  declined: "Declined",
};

export default async function RoadmapPage() {
  const [items, everyone] = await Promise.all([
    settle(roadmap.list()),
    settle(supporters.list()),
  ]);

  const byHandle = new Map(
    (everyone ?? []).flatMap((s) => s.handles.map((h) => [h, s] as const)),
  );
  const votingPower = (everyone ?? []).reduce((sum, s) => sum + supporters.weightFor(s), 0);

  const grouped = (state: roadmap.State) => (items ?? []).filter((i) => i.state === state);

  return (
    <>
      <p className="lede">
        Supporters rank what gets built next, weighted by how much they have chipped in and capped
        at {supporters.MAX_WEIGHT} so nobody owns the list. They can back{" "}
        {roadmap.MAX_OPEN_VOTES} open items at a time. Voting ranks things — it never switches a
        feature on.
      </p>

      {items === null ? (
        <>
          <h2>Roadmap</h2>
          <div className="panel">
            <p className="empty">Could not read the roadmap.</p>
          </div>
        </>
      ) : (
        (["proposed", "open", "shipped", "declined"] as roadmap.State[])
          .filter((state) => grouped(state).length > 0 || state === "open")
          .map((state) => (
            <div key={state}>
              <h2>
                {HEADINGS[state]}
                {grouped(state).length > 0 ? ` · ${grouped(state).length}` : ""}
              </h2>
              <div className="panel">
                {grouped(state).length === 0 ? (
                  <p className="empty">Nothing here. Add the first below.</p>
                ) : (
                  <ul className="rows">
                    {grouped(state).map((item) => (
                      <li key={item.id}>
                        <div className="grow">
                          {item.title}
                          <span className="meta">
                            {state === "open" || state === "shipped" ? (
                              <>
                                <span className="star">★</span> {item.weight} point
                                {item.weight === 1 ? "" : "s"} · {item.backers} backer
                                {item.backers === 1 ? "" : "s"} ·{" "}
                              </>
                            ) : null}
                            {item.proposedBy
                              ? `suggested by ${byHandle.get(item.proposedBy)?.name ?? item.proposedBy}`
                              : "added here"}{" "}
                            · {when(item.createdAt)}
                          </span>
                          {item.detail && <span className="meta">{item.detail}</span>}
                        </div>
                        {NEXT[state].map((move) => (
                          <form action={setItemState} key={move.to}>
                            <input type="hidden" name="id" value={item.id} />
                            <input type="hidden" name="state" value={move.to} />
                            <button type="submit" className="linky">
                              {move.label}
                            </button>
                          </form>
                        ))}
                        <form action={removeItem}>
                          <input type="hidden" name="id" value={item.id} />
                          <button type="submit" className="linky danger">
                            Delete
                          </button>
                        </form>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          ))
      )}

      <h2>Add an item</h2>
      <div className="panel">
        <form action={addItem} className="schedule-form">
          <label htmlFor="title">What to build</label>
          <input id="title" name="title" required placeholder="Scheduled polls" />
          <label htmlFor="detail">Any detail</label>
          <input id="detail" name="detail" placeholder="optional" />
          <button type="submit">Add, open for votes</button>
        </form>
        <p className="meta" style={{ marginTop: "0.8rem" }}>
          Added here it is votable at once — there is nobody to approve it past. A suggestion that
          arrives through the bot lands under <em>Waiting for you</em> instead.
        </p>
      </div>

      <h2>The electorate</h2>
      <div className="panel">
        <dl>
          <div className="row">
            <dt>Supporters who can vote</dt>
            <dd>
              {(everyone ?? []).filter((s) => s.handles.length > 0).length} of{" "}
              {everyone?.length ?? 0}
            </dd>
          </div>
          <div className="row">
            <dt>Total voting power</dt>
            <dd>{votingPower} points</dd>
          </div>
        </dl>
        <p className="meta" style={{ marginTop: "0.6rem" }}>
          A supporter with no WhatsApp identity tied to them cannot vote — the bot has no way to
          recognise them. Tie one on the Supporters page.
        </p>
      </div>
    </>
  );
}
