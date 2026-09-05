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
  repos_private: boolean;
  max_writes_per_day: number;
  connected_at: Date | null;
};

const saved = (
  await query<Saved>(
    "select token, login, scopes, hint, owner, can_open_issues, can_comment, can_create_repos, repos_private, max_writes_per_day, connected_at from github_settings where id = 1",
  )
)[0];

const restore = async () => {
  await query("delete from github_settings where id = 1");
  if (saved) {
    await query(
      `insert into github_settings (id, token, login, scopes, hint, owner, can_open_issues, can_comment, can_create_repos, repos_private, max_writes_per_day, connected_at)
       values (1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        saved.token,
        saved.login,
        saved.scopes,
        saved.hint,
        saved.owner,
        saved.can_open_issues,
        saved.can_comment,
        saved.can_create_repos,
        saved.repos_private,
        saved.max_writes_per_day,
        saved.connected_at,
      ],
    );
  }
  await query("delete from github_repos where repo = $1", [FAKE]);
  await query("delete from github_actions where who = $1", [MARK]);
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
       can_open_issues = false, can_comment = false, can_create_repos = false`,
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

  // ── the allowlist, with the switch on ──────────────────────────────────
  console.log("\nswitched on, but pointed somewhere it may not write:");
  await github.setPermissions({
    owner: "check-account",
    canOpenIssues: true,
    canComment: true,
    canCreateRepos: true,
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
