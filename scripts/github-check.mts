/**
 * The GitHub integration, against the real database and the real API.
 *
 * What this exists for is the permission layer, not the API calls. Anyone in a WhatsApp group can
 * type "open an issue on X", so every one of these is a failure that would be discovered by
 * somebody else's repository receiving something:
 *
 * - a write to a repository that is **not on the allowlist**
 * - a write while its operation is **switched off**
 * - a write **past the daily ceiling**
 * - a repository created **public** when the setting says private
 *
 * None of them throws. Each is a boolean that has to be false, which is exactly the kind of thing
 * that survives a refactor by being quietly inverted.
 *
 * Writes are never actually performed here. The refusals are asserted through the same functions
 * the tools call, up to the point where the request would leave — because it never gets that far.
 * The read half runs against api.github.com only when a token is stored.
 *
 * Needs DATABASE_URL. Costs nothing, and touches no repository.
 *
 *   npm run github-check
 */

import { query } from "../lib/db.js";
import * as github from "../lib/github.js";
import * as stickerSite from "../lib/sticker-site.js";
import { seal, open } from "../lib/secret-box.js";

let failures = 0;
const check = (label: string, pass: boolean, detail = "") => {
  if (!pass) failures++;
  console.log(pass ? "  PASS" : "  FAIL", label, detail);
};

const MARK = "github-check";
const FAKE = "github-check-owner/allowed-repo";
const STRANGER = "someone-else/private-thing";

/**
 * The real settings row is read and put back. This deployment's actual token and switches live in
 * it — a check that clobbered them would silently disconnect GitHub, which is worse than a failed
 * assertion by some margin.
 */
type Saved = {
  token: string | null;
  login: string | null;
  scopes: string | null;
  hint: string | null;
  owner: string | null;
  can_open_issues: boolean;
  can_comment: boolean;
  can_create_repos: boolean;
  can_deploy_pages: boolean;
  can_push_files: boolean;
  repos_private: boolean;
  max_writes_per_day: number;
  connected_at: Date | null;
  /*
   * Every column has to be here. This one was missed once and the restore put the row back
   * without it, which reset "only these groups" to "everywhere" — a check that silently widens
   * the thing it is checking. Add a column to github_settings, add it here.
   */
  chat_mode: string;
};

const saved = (
  await query<Saved>(
    "select token, login, scopes, hint, owner, can_open_issues, can_comment, can_create_repos, can_deploy_pages, can_push_files, repos_private, max_writes_per_day, connected_at, chat_mode from github_settings where id = 1",
  )
)[0];

const restore = async () => {
  await query("delete from github_settings where id = 1");
  if (saved) {
    await query(
      `insert into github_settings (id, token, login, scopes, hint, owner, can_open_issues, can_comment, can_create_repos, can_deploy_pages, can_push_files, repos_private, max_writes_per_day, connected_at, chat_mode)
       values (1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        saved.token,
        saved.login,
        saved.scopes,
        saved.hint,
        saved.owner,
        saved.can_open_issues,
        saved.can_comment,
        saved.can_create_repos,
        saved.can_deploy_pages,
        saved.can_push_files,
        saved.repos_private,
        saved.max_writes_per_day,
        saved.connected_at,
        saved.chat_mode,
      ],
    );
  }
  await query("delete from github_repos where repo = $1", [FAKE]);
  await query("delete from github_actions where who = $1", [MARK]);
  await query("delete from github_chats where chat like '1200000000000000%'");
  github.forgetScope();
};

try {
  // ── sealing ────────────────────────────────────────────────────────────
  console.log("\nthe token is sealed, not stored:");
  const secret = "ghp_" + "x".repeat(36);
  const sealed = seal(secret);
  check("it does not appear in the sealed value", !sealed.includes(secret));
  check("and it comes back out", open(sealed) === secret);
  check("twice sealed is twice different", seal(secret) !== seal(secret));
  check("a tampered value refuses to open", open(sealed.slice(0, -4) + "AAAA") === null);
  check("so does something else entirely", open("not a sealed value") === null);

  // ── naming ─────────────────────────────────────────────────────────────
  console.log("\nreading a repository name:");
  check("a plain pair", github.normalise("Jibaru/wspbot") === "jibaru/wspbot");
  check(
    "a URL",
    github.normalise("https://github.com/Crafter-Station/wapi") === "crafter-station/wapi",
  );
  check("a .git suffix", github.normalise("Jibaru/wspbot.git") === "jibaru/wspbot");
  check("trailing slashes", github.normalise("jibaru/wspbot/") === "jibaru/wspbot");

  // ── the allowlist ──────────────────────────────────────────────────────
  console.log("\nthe allowlist:");
  await github.allow(FAKE);
  check("what was added is on it", await github.isAllowed(FAKE));
  check(
    "and case does not matter",
    await github.isAllowed("GitHub-Check-Owner/Allowed-Repo"),
  );
  check("anything else is not", !(await github.isAllowed(STRANGER)));

  let rejected = false;
  try {
    await github.allow("not-a-pair");
  } catch {
    rejected = true;
  }
  check("a name that is not owner/name is refused", rejected);

  // ── the switches ───────────────────────────────────────────────────────
  console.log("\nwith every write switched off:");
  await query(
    `insert into github_settings (id, token, login, can_open_issues, can_comment, can_create_repos)
     values (1, $1, 'check-account', false, false, false)
     on conflict (id) do update set token = excluded.token, login = excluded.login,
       can_open_issues = false, can_comment = false, can_create_repos = false,
       can_deploy_pages = false, can_push_files = false`,
    [seal("ghp_not_a_real_token")],
  );

  const issueOff = await github.openIssue(FAKE, { title: `${MARK} should not exist` }, { who: MARK });
  check("opening an issue is refused", !issueOff.ok);
  check(
    "and says which switch",
    !issueOff.ok && issueOff.why.includes("switched off"),
    !issueOff.ok ? `— ${issueOff.why}` : "",
  );

  const commentOff = await github.comment(FAKE, 1, "no", { who: MARK });
  check("so is commenting", !commentOff.ok);

  const repoOff = await github.createRepo({ name: `${MARK}-repo` }, { who: MARK });
  check("so is creating a repository", !repoOff.ok);

  const visibilityOff = await github.setVisibility(FAKE, true, { who: MARK });
  check("so is changing what is public", !visibilityOff.ok);

  const pagesOff = await github.deployPages(FAKE, {}, { who: MARK });
  check("so is publishing a site", !pagesOff.ok);

  const filesOff = await github.putFiles(
    FAKE,
    [{ path: "index.html", content: "<h1>no</h1>" }],
    `${MARK} should not land`,
    {},
    { who: MARK },
  );
  check("so is committing files", !filesOff.ok);
  check(
    "and it names that switch rather than another",
    !pagesOff.ok && pagesOff.why.includes("publishing sites"),
    !pagesOff.ok ? `— ${pagesOff.why}` : "",
  );

  // ── the allowlist, with the switch on ──────────────────────────────────
  console.log("\nswitched on, but pointed somewhere it may not write:");
  await github.setPermissions({
    owner: "check-account",
    canOpenIssues: true,
    canComment: true,
    canCreateRepos: true,
    canDeployPages: true,
    canPushFiles: true,
    reposPrivate: true,
    maxWritesPerDay: 10,
  });

  const elsewhere = await github.openIssue(STRANGER, { title: `${MARK} nope` }, { who: MARK });
  check("a repository not on the list is refused", !elsewhere.ok);
  check(
    "and it names the repository",
    !elsewhere.ok && elsewhere.why.includes(STRANGER),
    !elsewhere.ok ? `— ${elsewhere.why}` : "",
  );

  const commentElsewhere = await github.comment(STRANGER, 1, "nope", { who: MARK });
  check("commenting there too", !commentElsewhere.ok);

  /*
   * Publishing is the write that reaches furthest — it puts a repository on the public web — so
   * it has to obey the same list as the rest rather than being waved through as "just a setting".
   */
  const pagesElsewhere = await github.deployPages(STRANGER, {}, { who: MARK });
  check("and publishing a site somewhere unlisted", !pagesElsewhere.ok);

  const filesElsewhere = await github.putFiles(
    STRANGER,
    [{ path: "index.html", content: "<h1>no</h1>" }],
    `${MARK} nope`,
    {},
    { who: MARK },
  );
  check("and committing files there", !filesElsewhere.ok);
  check(
    "for the list, not the switch",
    !pagesElsewhere.ok && pagesElsewhere.why.includes("not on the list"),
    !pagesElsewhere.ok ? `— ${pagesElsewhere.why}` : "",
  );

  /*
   * The allowed repository is deliberately *not* attempted: it would reach the API with a
   * nonsense token and open nothing, but the point of a check is not to find out. Everything up
   * to the decision has been asserted; the decision itself is the feature.
   */

  // ── the daily ceiling ──────────────────────────────────────────────────
  console.log("\nthe daily ceiling:");
  await github.setPermissions({
    owner: "check-account",
    canOpenIssues: true,
    canComment: true,
    canCreateRepos: true,
    canDeployPages: true,
    canPushFiles: true,
    reposPrivate: true,
    maxWritesPerDay: 2,
  });
  const before = await github.writesToday();
  for (let i = 0; i < 2; i++) {
    await github.record({ chat: null, who: MARK, action: "open_issue", target: FAKE, detail: null });
  }
  check("two writes are counted", (await github.writesToday()) === before + 2);

  const capped = await github.openIssue(FAKE, { title: `${MARK} over the line` }, { who: MARK });
  check("the next one is refused", !capped.ok);
  check(
    "and says it is the limit",
    !capped.ok && capped.why.includes("limit"),
    !capped.ok ? `— ${capped.why}` : "",
  );

  await github.setPermissions({
    owner: "check-account",
    canOpenIssues: true,
    canComment: false,
    canCreateRepos: false,
    reposPrivate: true,
    maxWritesPerDay: 0,
  });
  const zero = await github.openIssue(FAKE, { title: `${MARK} zero` }, { who: MARK });
  check("a ceiling of zero stops everything", !zero.ok);
  const pagesCapped = await github.deployPages(FAKE, {}, { who: MARK });
  check("publishing counts against the same ceiling", !pagesCapped.ok);

  // ── with nothing connected ─────────────────────────────────────────────
  console.log("\nwith no account connected:");
  await query("delete from github_settings where id = 1");
  check("it knows it is not connected", !(await github.connected()));
  const unconnected = await github.openIssue(FAKE, { title: `${MARK} no account` }, { who: MARK });
  check("and refuses rather than throwing", !unconnected.ok);
  check(
    "with a reason a person could act on",
    !unconnected.ok && unconnected.why.includes("not connected"),
    !unconnected.ok ? `— ${unconnected.why}` : "",
  );

  let readThrew = "";
  try {
    await github.repo("jibaru/wspbot");
  } catch (err) {
    readThrew = err instanceof Error ? err.message : String(err);
  }
  check("a read says so too", readThrew.includes("not connected"), `— ${readThrew}`);

  // ── which chats may ask ────────────────────────────────────────────────
  console.log("\nwhich chats may ask:");
  const HERE = "120000000000000001@g.us";
  const THERE = "120000000000000002@g.us";

  await github.setChats([], "everywhere");
  github.forgetScope();
  check("everywhere means everywhere", await github.availableIn(THERE));

  await github.setChats([{ chat: HERE, chatName: `${MARK} group` }], "listed");
  github.forgetScope();
  check("a listed group may ask", await github.availableIn(HERE));
  check("one that is not may not", !(await github.availableIn(THERE)));

  /*
   * The empty-list case is the one worth stating. "Only these groups" with none listed means
   * nowhere — the honest reading — and getting it backwards would be an integration that quietly
   * became available everywhere the moment somebody cleared the list.
   */
  await github.setChats([], "listed");
  github.forgetScope();
  check("listed with nothing listed is nowhere", !(await github.availableIn(HERE)));

  await github.setChats([], "everywhere");
  github.forgetScope();

  // ── making something public ────────────────────────────────────────────
  console.log("\nmaking something public:");
  /*
   * The asymmetry is the point. Going private is tidying up; going public puts a repository and
   * every commit in it in front of the world, from a chat message. So it needs the decision that
   * was taken in advance on the dashboard, and the bot cannot grant it to itself.
   */
  /*
   * A token first. The section above deletes the settings row, and without one every answer here
   * is "GitHub is not connected" — which passes a check about refusing to publish while testing
   * nothing at all. It did, once.
   */
  await query(
    `insert into github_settings (id, token, login) values (1, $1, 'check-account')
     on conflict (id) do update set token = excluded.token, login = excluded.login`,
    [seal("ghp_not_a_real_token")],
  );
  await github.setPermissions({
    owner: "check-account",
    canOpenIssues: true,
    canComment: true,
    canCreateRepos: true,
    canDeployPages: true,
    canPushFiles: true,
    reposPrivate: true,
    maxWritesPerDay: 50,
  });
  const toPublic = await github.setVisibility(FAKE, true, { who: MARK });
  check("public is refused while public repositories are switched off", !toPublic.ok);
  check(
    "and it says a person has to allow it, not that it failed",
    !toPublic.ok && toPublic.why.includes("dashboard"),
    !toPublic.ok ? `— ${toPublic.why}` : "",
  );

  const strangerPublic = await github.setVisibility(STRANGER, false, { who: MARK });
  check("and the allowlist still applies to it", !strangerPublic.ok);

  // ── the plan error ─────────────────────────────────────────────────────
  console.log("\nwhen GitHub says the plan does not allow it:");
  /*
   * The message that cost an afternoon: everything was correct and Pages still refused, because
   * a private repository needs a paid plan for it. GitHub says so and says nothing about the fix.
   */
  const planned = github.explain(
    403,
    "Your current plan does not support GitHub Pages for this repository.",
    "POST",
    "/repos/kekito-crafter/wspbot-stickers/pages",
  );
  check("the explanation names the fix", planned.includes("public"), `— ${planned}`);
  check("and keeps what GitHub said", planned.includes("plan does not support"));

  // ── can it actually write there? ───────────────────────────────────────
  console.log("\ncan it actually write there:");
  /*
   * The case that actually happened, first. The token was valid, the switches were on, the
   * repository was on the allowlist and public — and GitHub refused, because a fine-grained token
   * belonging to one account cannot be granted anything on a repository owned by another. Nothing
   * on this side was wrong, which is exactly why the verdict has to say it out loud.
   */
  const fineGrained = {
    kind: "fine-grained" as const,
    login: "kekito-crafter",
    visible: true,
    granted: false,
    push: false,
    isPrivate: false,
    hasIssues: true,
    scopes: [],
  };
  const notGranted = github.verdict(fineGrained);
  check("a fine-grained token with no grant cannot write", !notGranted.ok);
  check(
    "and it explains the rule rather than the symptom",
    notGranted.why.includes("owns") && notGranted.why.includes("classic"),
    `— ${notGranted.why}`,
  );
  check(
    "the same token on a repository it was granted can",
    github.verdict({ ...fineGrained, granted: true }).ok,
  );

  /*
   * The other half of the same confusion: a classic token needs no write access at all to open an
   * issue on a public repository, because any account may. Treating "push: false" as "cannot
   * write" would refuse the one arrangement that actually works here.
   */
  const classic = { ...fineGrained, kind: "classic" as const, scopes: ["public_repo"] };
  check("a classic token may open issues on a public repository", github.verdict(classic).ok);
  check(
    "without being a collaborator",
    github.verdict(classic).why.includes("without being a collaborator"),
  );
  check(
    "but not on a private one it has no access to",
    !github.verdict({ ...classic, isPrivate: true, scopes: ["repo"] }).ok,
  );
  check(
    "unless it is a collaborator",
    github.verdict({ ...classic, isPrivate: true, push: true, scopes: ["repo"] }).ok,
  );
  check(
    "public_repo is not enough for a private repository",
    !github.verdict({ ...classic, isPrivate: true, push: true }).ok,
  );
  check(
    "issues switched off is its own answer",
    github.verdict({ ...classic, hasIssues: false }).why.includes("switched off"),
  );
  check(
    "and so is a repository it cannot see",
    github.verdict({ ...classic, visible: false }).why.includes("cannot see"),
  );

  check("a token with scopes reads as classic", github.kindOf({ scopes: "repo,gist" }) === "classic");
  check("one without reads as fine-grained", github.kindOf({ scopes: null }) === "fine-grained");

  console.log("\nwhat it will not commit:");
  /*
   * The section above deletes the settings row to check the unconnected case, so the switches
   * have to be put back before asking about shapes — otherwise every answer here is "GitHub is
   * not connected", and the check passes while testing nothing.
   */
  await query(
    `insert into github_settings (id, token, login, can_push_files, max_writes_per_day)
     values (1, $1, 'check-account', true, 50)
     on conflict (id) do update set token = excluded.token, login = excluded.login,
       can_push_files = true, max_writes_per_day = 50`,
    [seal("ghp_not_a_real_token")],
  );
  const bad = async (files: { path: string; content: string }[]): Promise<string> => {
    const r = await github.putFiles(FAKE, files, `${MARK} shape`, {}, { who: MARK });
    return r.ok ? "" : r.why;
  };
  check("nothing at all", (await bad([])).includes("no files"));
  check(
    "a path climbing out of the repository",
    (await bad([{ path: "../../etc/passwd", content: "x" }])).length > 0,
  );
  check(
    "a path into .git",
    (await bad([{ path: ".git/config", content: "x" }])).length > 0,
  );
  check(
    "an empty path",
    (await bad([{ path: "   ", content: "x" }])).length > 0,
  );
  check(
    "more files than it will take at once",
    (await bad(
      Array.from({ length: 400 }, (_, i) => ({ path: `f${i}.txt`, content: "x" })),
    )).includes("most I will commit"),
  );

  // ── the sticker gallery ────────────────────────────────────────────────
  console.log("\nthe sticker gallery, built from the real library:");
  const site = await stickerSite.build({ title: "check gallery" });
  const index = site.files.find((f) => f.path === "index.html");
  check("it writes an index.html", index !== undefined);
  check(
    "one picture per sticker, plus the page",
    site.files.length === site.count + 1,
    `— ${site.files.length} files for ${site.count} stickers`,
  );
  /*
   * The library is 49MB. A commit of everything is minutes of sequential blob uploads and a
   * repository nobody wants; the budget is what turns that into a page that exists.
   */
  const bytes = site.files.reduce(
    (sum, f) => sum + (typeof f.content === "string" ? Buffer.byteLength(f.content) : f.content.length),
    0,
  );
  check(
    "the whole commit stays inside the budget",
    bytes <= 20 * 1024 * 1024,
    `— ${(bytes / 1024 / 1024).toFixed(1)}MB for ${site.count} stickers, ${site.left} left out`,
  );
  check("and it says how many were left out", typeof site.left === "number");
  check(
    "a smaller budget takes fewer",
    (await stickerSite.build({ budgetBytes: 2 * 1024 * 1024 })).count < site.count,
  );
  check(
    "the pictures are bytes, not links",
    site.files.every((f) => f.path === "index.html" || Buffer.isBuffer(f.content)),
  );
  check(
    "every picture is referenced by the page",
    site.files
      .filter((f) => f.path !== "index.html")
      .every((f) => String(index?.content).includes(f.path)),
  );
  /*
   * Links out are fine; *loads* are not. A stylesheet, font or image fetched from elsewhere is a
   * gallery that looks broken the day that host does, and a Pages site should not need the
   * network to render itself. The footer's link to the repository is not that.
   */
  const html = String(index?.content);
  check("the page loads nothing from elsewhere", !/src=["\']https?:/i.test(html));
  check("no stylesheet or font from elsewhere", !/<link[^>]+href=["\']https?:/i.test(html));
  check("and nothing pulled in by CSS", !/url\(\s*["\']?https?:/i.test(html));
  check("and it is a whole document", String(index?.content).startsWith("<!doctype html>"));

  // ── the real API ───────────────────────────────────────────────────────
  console.log("\nagainst api.github.com:");
  if (!saved?.token) {
    console.log("  SKIP no token stored — connect an account on /dashboard/github first");
  } else {
    await restore();
    const repo = await github.repo("crafter-station/wapi");
    check("it reads a real repository", repo.fullName.toLowerCase() === "crafter-station/wapi");
    check("with the fields the bot reports", typeof repo.stars === "number" && repo.defaultBranch !== "");

    const issues = await github.issues("crafter-station/wapi", { limit: 5 });
    check("and its issues", Array.isArray(issues));
    check(
      "pull requests are marked as such rather than counted as issues",
      issues.every((i) => typeof i.isPullRequest === "boolean"),
    );

    let missing = "";
    try {
      await github.repo("jibaru/this-repository-does-not-exist-9x8y7z");
    } catch (err) {
      missing = err instanceof Error ? err.message : String(err);
    }
    check("a missing repository is a sentence, not a stack trace", missing.length > 0, `— ${missing}`);
  }
} finally {
  await restore();
  console.log("settings restored");
}

console.log(failures === 0 ? "\nall checks passed\n" : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
