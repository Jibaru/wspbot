import * as github from "@/lib/github";
import * as features from "@/lib/features";
import { wapi } from "@/lib/wapi";
import { settle, when, shortJid } from "../shared";
import {
  connectGithub,
  disconnectGithub,
  savePermissions,
  saveScope,
  allowRepo,
  disallowRepo,
} from "./actions";

/**
 * GitHub: which account the bot acts as, and what it is allowed to do with it.
 *
 * The page is arranged as the two layers actually are — the token first, because nothing here
 * can exceed what GitHub itself granted it, then the switches, which are always the tighter of
 * the two. The allowlist sits with the switches rather than apart from them, since a switch that
 * is on with an empty list still does nothing, and that would otherwise look broken.
 */

export const dynamic = "force-dynamic";

export default async function GithubPage() {
  const [settings, repos, log, enabled, orgs, statuses] = await Promise.all([
    settle(github.settings()),
    settle(github.allowed()),
    settle(github.history(12)),
    settle(features.enabled()),
    // Fails quietly when no token is stored, which is the ordinary state before connecting.
    settle(github.orgs()),
    /*
     * Asked here rather than left for a chat to discover. Being on the allowlist means the bot is
     * *permitted* to write there; this says whether it *can*, and the two came apart the first
     * time this feature was used in earnest.
     */
    settle(github.statuses()),
  ]);
  const [scope, chats, groups] = await Promise.all([
    settle(github.scope()),
    settle(github.chats()),
    settle(wapi.groups()),
  ]);
  const picked = new Set((chats ?? []).map((c) => c.chat));
  const statusOf = new Map((statuses ?? []).map((s) => [s.repo, s]));

  const on = enabled?.has("github") ?? true;
  const s = settings;
  const connected = Boolean(s?.login);
  const writesOn = Boolean(
    s &&
      (s.canOpenIssues ||
        s.canComment ||
        s.canCreateRepos ||
        s.canDeployPages ||
        s.canPushFiles),
  );

  return (
    <>
      <p className="lede">
        The GitHub account the bot acts as, and what it may do with it. Reading is always allowed;
        every kind of writing is off until you turn it on.
      </p>

      {!on && (
        <div className="panel notice">
          The GitHub feature is switched off, so none of this is reachable from a chat. Turn it on
          under Features.
        </div>
      )}

      <h2>The account</h2>
      <div className="panel">
        {connected ? (
          <>
            <ul className="rows">
              <li>
                <div className="grow">
                  <strong>{s?.login}</strong>
                  <span className="meta">
                    token ending <code>{s?.hint}</code>
                    {s?.connectedAt && <> · connected {when(s.connectedAt)}</>}
                  </span>
                  <span className="meta">
                    {s?.scopes
                      ? `classic token, scopes: ${s.scopes}`
                      : "fine-grained token — GitHub reports no scopes for these, so what it reaches is whatever was selected when it was made"}
                  </span>
                  {!s?.scopes && (
                    <span className="meta">
                      A fine-grained token can only be granted repositories <strong>{s?.login}</strong>{" "}
                      owns, or an organisation&rsquo;s where that was allowed. One belonging to
                      somebody else cannot be selected in it at all — it will still be read when it
                      is public, and every write to it refused. For those, use a classic token with{" "}
                      <code>public_repo</code>.
                    </span>
                  )}
                </div>
                <form action={disconnectGithub}>
                  <button type="submit" className="linky danger">
                    Disconnect
                  </button>
                </form>
              </li>
            </ul>
            <p className="meta">
              Replacing it is the same form below — the new token is verified with GitHub before
              anything is stored.
            </p>
          </>
        ) : (
          <p className="empty">Not connected. Add a token below.</p>
        )}

        <form action={connectGithub} className="schedule-form" style={{ marginTop: "1rem" }}>
          <label htmlFor="token">Personal access token</label>
          <input
            id="token"
            name="token"
            type="password"
            autoComplete="off"
            placeholder="github_pat_… or ghp_…"
            required
            aria-describedby="token-help"
          />
          <p className="meta" id="token-help">
            Made on the bot&rsquo;s own GitHub account, at{" "}
            <code>Settings → Developer settings → Personal access tokens</code>. A{" "}
            <strong>fine-grained</strong> token is the one to use: it is scoped to the
            repositories you pick, so what the bot can reach is decided by GitHub rather than only
            by this page. It needs <code>Issues: read and write</code> and{" "}
            <code>Contents: read</code> on those repositories, plus{" "}
            <code>Administration: read and write</code> only if it should create new ones. The
            token is sealed before it is stored and never shown again.
          </p>
          <button type="submit">Save token</button>
        </form>
      </div>

      <h2>What it may do</h2>
      <div className="panel">
        {!connected ? (
          <p className="empty">Connect an account first.</p>
        ) : (
          <form action={savePermissions} className="schedule-form">
            <label htmlFor="owner">New repositories belong to</label>
            <select id="owner" name="owner" defaultValue={s?.owner ?? s?.login ?? ""}>
              <option value={s?.login ?? ""}>{s?.login} (the account itself)</option>
              {(orgs ?? []).map((o) => (
                <option key={o} value={o}>
                  {o} (organisation)
                </option>
              ))}
            </select>

            <label>Allowed operations</label>
            <div className="checks">
              {/* label.pick is the dashboard's existing checkbox row: the whole line is the
                  target, which is what makes it usable on a phone. */}
              <label className="pick">
                <input
                  type="checkbox"
                  name="canOpenIssues"
                  defaultChecked={s?.canOpenIssues ?? false}
                />
                <span>Open issues</span>
              </label>
              <label className="pick">
                <input type="checkbox" name="canComment" defaultChecked={s?.canComment ?? false} />
                <span>Comment on issues and pull requests</span>
              </label>
              <label className="pick">
                <input
                  type="checkbox"
                  name="canCreateRepos"
                  defaultChecked={s?.canCreateRepos ?? false}
                />
                <span>
                  Create repositories, and change whether they are public
                  <span className="meta">
                    Repository administration. Making one public still needs the setting below.
                  </span>
                </span>
              </label>
              <label className="pick">
                <input
                  type="checkbox"
                  name="canPushFiles"
                  defaultChecked={s?.canPushFiles ?? false}
                />
                <span>
                  Commit files
                  <span className="meta">
                    Whole files, replacing whatever is at that path. This is what lets it publish
                    a page it wrote, or the sticker gallery.
                  </span>
                </span>
              </label>
              <label className="pick">
                <input
                  type="checkbox"
                  name="canDeployPages"
                  defaultChecked={s?.canDeployPages ?? false}
                />
                <span>
                  Publish repositories as websites (GitHub Pages)
                  <span className="meta">
                    Needs admin on the repository, so in practice its own; a private repository
                    cannot have one without a paid plan.
                  </span>
                </span>
              </label>
              <label className="pick">
                <input
                  type="checkbox"
                  name="allowPublic"
                  defaultChecked={!(s?.reposPrivate ?? true)}
                />
                <span>
                  Let repositories be public
                  <span className="meta">
                    Required for GitHub Pages: a site is free on a public repository and needs a
                    paid plan on a private one. Without this, everything it creates stays private
                    and cannot be published.
                  </span>
                </span>
              </label>
            </div>

            <label htmlFor="maxWritesPerDay">At most</label>
            <input
              id="maxWritesPerDay"
              name="maxWritesPerDay"
              type="number"
              min={0}
              max={100}
              defaultValue={s?.maxWritesPerDay ?? 10}
              aria-describedby="cap-help"
            />
            <p className="meta" id="cap-help">
              Writes in any 24 hours, counted across every chat. Anyone in a group can ask the bot
              to open an issue, so this is the ceiling on how bad a bad day can get. Zero stops
              writing entirely without changing anything else.
            </p>

            <button type="submit">Save</button>
          </form>
        )}
      </div>

      <h2>Where it can be used</h2>
      <div className="panel">
        {/*
          * The state that reads as a broken integration: "only these groups", with none. It is the
          * honest meaning of what was chosen and it switches GitHub off everywhere, so the page
          * has to say so — the alternative is a bot that answers "I do not have access" in every
          * chat while the dashboard shows five permissions happily ticked.
          */}
        {scope === "listed" && (chats?.length ?? 0) === 0 && (
          <div className="notice" style={{ marginBottom: "1rem" }}>
            <strong>GitHub is switched off in every chat.</strong> &ldquo;Only the groups ticked
            below&rdquo; is selected and none are ticked, so nothing can reach it — the bot will
            not even know it has GitHub. Tick a group, or choose every chat.
          </div>
        )}
        <p className="meta" style={{ marginTop: 0 }}>
          Reachable from{" "}
          <strong>
            {scope === "everywhere"
              ? "every chat"
              : (chats?.length ?? 0) === 0
                ? "nowhere"
                : `${chats?.length} group${chats?.length === 1 ? "" : "s"}`}
          </strong>
          .
        </p>
        <p className="meta" style={{ marginTop: 0 }}>
          This is a different question from the list below: that one is <em>where writes land</em>,
          this one is <em>who may ask</em>. A chat GitHub is switched off in is not told it exists
          at all, so the bot does not offer something it will then refuse.
        </p>
        <form action={saveScope} className="schedule-form">
          <div className="checks">
            <label className="pick">
              <input
                type="radio"
                name="mode"
                value="everywhere"
                defaultChecked={(scope ?? "everywhere") === "everywhere"}
              />
              <span>Every chat the bot is in</span>
            </label>
            <label className="pick">
              <input
                type="radio"
                name="mode"
                value="listed"
                defaultChecked={scope === "listed"}
              />
              <span>Only the groups ticked below</span>
            </label>
          </div>

          <label>Groups</label>
          {groups === null ? (
            <p className="empty">Could not list groups — check the session on the overview page.</p>
          ) : groups.length === 0 ? (
            <p className="empty">The bot is not in any groups yet.</p>
          ) : (
            <div className="checks">
              {groups.map((g) => (
                <label className="pick" key={g.jid}>
                  <input
                    type="checkbox"
                    name="chats"
                    value={g.jid}
                    defaultChecked={picked.has(g.jid)}
                  />
                  <span>{g.name}</span>
                </label>
              ))}
              {/* A chat that is on the list but no longer a group the bot can see still has to be
                  shown, or saving the form would quietly drop it. */}
              {(chats ?? [])
                .filter((c) => !groups.some((g) => g.jid === c.chat))
                .map((c) => (
                  <label className="pick" key={c.chat}>
                    <input type="checkbox" name="chats" value={c.chat} defaultChecked />
                    <span>
                      {c.chatName ?? shortJid(c.chat)}{" "}
                      <span className="meta">· not a group the bot is in any more</span>
                    </span>
                  </label>
                ))}
            </div>
          )}

          <button type="submit">Save</button>
        </form>
      </div>

      <h2>Repositories it may write to{repos?.length ? ` · ${repos.length}` : ""}</h2>
      <div className="panel">
        {writesOn && repos?.length === 0 && (
          <div className="notice" style={{ marginBottom: "1rem" }}>
            Writing is switched on but no repository is listed, so every attempt will be refused.
            Add one below.
          </div>
        )}
        {repos === null ? (
          <p className="empty">Could not read the list.</p>
        ) : repos.length === 0 ? (
          <p className="empty">
            None. Reading works anywhere; issues and comments land nowhere until something is
            listed here.
          </p>
        ) : (
          <ul className="rows">
            {repos.map((r) => {
              const status = statusOf.get(r.repo);
              return (
              <li key={r.repo}>
                <div className="grow">
                  <strong>{r.repo}</strong>
                  <span className="meta">added {when(r.addedAt)}</span>
                  {status && (
                    <span className={status.ok ? "meta" : "meta bad"}>
                      {status.ok ? "✓ " : "cannot write here — "}
                      {status.why}
                    </span>
                  )}
                </div>
                <form action={disallowRepo}>
                  <input type="hidden" name="repo" value={r.repo} />
                  <button type="submit" className="linky danger">
                    Remove
                  </button>
                </form>
              </li>
              );
            })}
          </ul>
        )}

        <form action={allowRepo} className="schedule-form" style={{ marginTop: "1rem" }}>
          <label htmlFor="repo">Add a repository</label>
          <input
            id="repo"
            name="repo"
            placeholder="owner/name"
            required
            aria-describedby="repo-help"
          />
          <p className="meta" id="repo-help">
            An <code>owner/name</code> pair, or a github.com link. Anything the bot creates itself
            is added here automatically.
          </p>
          <button type="submit">Add</button>
        </form>
      </div>

      <h2>What it has done</h2>
      <div className="panel">
        {log === null ? (
          <p className="empty">Could not read the log.</p>
        ) : log.length === 0 ? (
          <p className="empty">Nothing yet. Every write lands here, with who asked for it.</p>
        ) : (
          <ul className="rows">
            {log.map((a, i) => (
              <li key={`${a.at.toISOString()}-${i}`}>
                <div className="grow">
                  <strong>{a.action.replace(/_/g, " ")}</strong> {a.target}
                  <span className="meta">
                    {when(a.at)}
                    {a.who && <> · asked by {a.who}</>}
                    {a.chat && <> · in {shortJid(a.chat)}</>}
                  </span>
                  {a.detail && <span className="meta">{a.detail}</span>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
