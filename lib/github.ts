import "server-only";
import { query } from "./db";
import { seal, open } from "./secret-box";

/**
 * GitHub, as an account the bot acts on behalf of.
 *
 * **Why the REST API and not `gh`, and not an MCP server.** Both of those are wrappers over
 * these same endpoints. `gh` would add a package to the image and a process spawn per call, and
 * an MCP client would add a transport, and neither would move this feature forward — because the
 * hard part here is not calling GitHub. It is that *anyone in a WhatsApp group can ask*. "Open
 * an issue on that repo" is a sentence a stranger can type, so what matters is the layer that
 * decides whether the call happens at all: an allowlist, a set of per-operation switches, and a
 * daily ceiling. `gh` has no idea which repositories this bot is allowed to write to. That
 * decision has to live here, in front of the call, which means the call may as well be a `fetch`.
 *
 * The permission model is two layers, and they are not interchangeable:
 *
 * 1. **What the token can do**, decided on GitHub when it is issued. This is the real boundary —
 *    nothing here can exceed it, and a fine-grained token scoped to three repositories is worth
 *    more than every switch below.
 * 2. **What the bot is allowed to do with it**, decided on the dashboard. Always the tighter of
 *    the two, because the token is issued once and the bot is exposed to a group chat all day.
 *
 * Reads are permitted against anything the token can see. Writes — opening an issue, commenting,
 * creating a repository — are refused unless the repository is on the allowlist, and every one of
 * them is recorded, capped per day, and carries a line saying who asked for it and from where.
 */

const API = "https://api.github.com";

/** Pinned: GitHub versions its REST API by date, and an unpinned client is a silent breakage. */
const VERSION = "2022-11-28";

const TIMEOUT_MS = 15_000;

export class GitHubError extends Error {}

// ── settings ─────────────────────────────────────────────────────────────

export type Settings = {
  /** The account the token belongs to, as GitHub reported it when the token was saved. */
  login: string | null;
  /** Classic tokens announce their scopes in a header; fine-grained ones announce nothing. */
  scopes: string | null;
  /** Last four characters, for recognising which token is installed without revealing it. */
  hint: string | null;
  /** Who new repositories belong to: the account itself, or an organisation it can create in. */
  owner: string | null;
  /** Per-operation switches. Reads need none of these. */
  canOpenIssues: boolean;
  canComment: boolean;
  canCreateRepos: boolean;
  /** A repository created by a chat message should not be public by accident. */
  reposPrivate: boolean;
  maxWritesPerDay: number;
  connectedAt: Date | null;
};

type Row = {
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

const COLUMNS =
  "login, scopes, hint, owner, can_open_issues, can_comment, can_create_repos, repos_private, max_writes_per_day, connected_at";

const DEFAULTS: Settings = {
  login: null,
  scopes: null,
  hint: null,
  owner: null,
  canOpenIssues: false,
  canComment: false,
  canCreateRepos: false,
  reposPrivate: true,
  maxWritesPerDay: 10,
  connectedAt: null,
};

/**
 * One row, always id 1. A single deployment acts as a single GitHub account, and a table that
 * could hold two would have to answer "which one?" at every call site for no gain.
 */
export const settings = async (): Promise<Settings> => {
  const rows = await query<Row>(`select ${COLUMNS} from github_settings where id = 1`);
  const row = rows[0];
  if (!row) return DEFAULTS;
  return {
    login: row.login,
    scopes: row.scopes,
    hint: row.hint,
    owner: row.owner,
    canOpenIssues: row.can_open_issues,
    canComment: row.can_comment,
    canCreateRepos: row.can_create_repos,
    reposPrivate: row.repos_private,
    maxWritesPerDay: Number(row.max_writes_per_day),
    connectedAt: row.connected_at,
  };
};

export const connected = async (): Promise<boolean> => (await token()) !== null;

/** The token itself, opened. Nothing outside this file has any business holding it. */
const token = async (): Promise<string | null> => {
  const rows = await query<{ token: string | null }>(
    "select token from github_settings where id = 1",
  );
  const sealed = rows[0]?.token;
  return sealed ? open(sealed) : null;
};

/**
 * Save a token, after checking with GitHub that it works.
 *
 * Verified rather than trusted, because a token that is wrong is otherwise discovered by
 * somebody in a group asking for something and being told "not found" — which reads as the
 * repository not existing rather than as the connection being broken.
 */
export const connect = async (raw: string): Promise<{ login: string; scopes: string | null }> => {
  const value = raw.trim();
  if (!value) throw new GitHubError("no token given");

  const res = await request("GET", "/user", { token: value });
  const login = (res.body as { login?: string }).login;
  if (!login) throw new GitHubError("GitHub accepted that token but returned no account");

  // Classic tokens list their scopes here; a fine-grained token sends the header empty.
  const scopes = res.headers.get("x-oauth-scopes")?.trim() || null;

  await query(
    `insert into github_settings (id, token, login, scopes, hint, owner, connected_at)
     values (1, $1, $2, $3, $4, coalesce((select owner from github_settings where id = 1), $2), now())
     on conflict (id) do update set
       token        = excluded.token,
       login        = excluded.login,
       scopes       = excluded.scopes,
       hint         = excluded.hint,
       connected_at = excluded.connected_at`,
    [seal(value), login, scopes, value.slice(-4)],
  );

  return { login, scopes };
};

export const disconnect = (): Promise<unknown[]> =>
  query("delete from github_settings where id = 1");

export type Permissions = {
  owner?: string | null;
  canOpenIssues?: boolean;
  canComment?: boolean;
  canCreateRepos?: boolean;
  reposPrivate?: boolean;
  maxWritesPerDay?: number;
};

export const setPermissions = async (input: Permissions): Promise<void> => {
  const cap = Number.isFinite(input.maxWritesPerDay)
    ? Math.min(100, Math.max(0, Math.round(input.maxWritesPerDay as number)))
    : 10;

  await query(
    `insert into github_settings (id, owner, can_open_issues, can_comment, can_create_repos, repos_private, max_writes_per_day)
     values (1, $1, $2, $3, $4, $5, $6)
     on conflict (id) do update set
       owner              = excluded.owner,
       can_open_issues    = excluded.can_open_issues,
       can_comment        = excluded.can_comment,
       can_create_repos   = excluded.can_create_repos,
       repos_private      = excluded.repos_private,
       max_writes_per_day = excluded.max_writes_per_day`,
    [
      input.owner?.trim() || null,
      input.canOpenIssues ?? false,
      input.canComment ?? false,
      input.canCreateRepos ?? false,
      input.reposPrivate ?? true,
      cap,
    ],
  );
};

// ── the allowlist ────────────────────────────────────────────────────────

/**
 * Which repositories may be written to.
 *
 * Fails closed: an empty list means no writes anywhere, which is the correct state for a bot
 * that has just been connected and not yet been told what it is for. Reads are not listed here —
 * a public repository is public, and gating "how many stars does X have" behind an allowlist
 * would only make the feature useless without making anything safer.
 */
export type Allowed = { repo: string; addedAt: Date };

/** `owner/name`, lowercased. GitHub is case-insensitive here and a mixed-case row would miss. */
export const normalise = (repo: string): string =>
  repo
    .trim()
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/^\/+|\/+$/g, "")
    .toLowerCase();

const VALID = /^[a-z0-9._-]+\/[a-z0-9._-]+$/;

export const allowed = async (): Promise<Allowed[]> => {
  const rows = await query<{ repo: string; added_at: Date }>(
    "select repo, added_at from github_repos order by repo",
  );
  return rows.map((r) => ({ repo: r.repo, addedAt: r.added_at }));
};

export const allow = async (repo: string): Promise<void> => {
  const value = normalise(repo);
  if (!VALID.test(value)) throw new GitHubError(`"${repo}" is not an owner/name pair`);
  await query("insert into github_repos (repo) values ($1) on conflict do nothing", [value]);
};

export const disallow = (repo: string): Promise<unknown[]> =>
  query("delete from github_repos where repo = $1", [normalise(repo)]);

export const isAllowed = async (repo: string): Promise<boolean> => {
  const rows = await query("select 1 from github_repos where repo = $1", [normalise(repo)]);
  return rows.length > 0;
};

// ── the audit trail ──────────────────────────────────────────────────────

export type Action = {
  at: Date;
  chat: string | null;
  who: string | null;
  action: string;
  target: string | null;
  detail: string | null;
};

export const record = async (entry: Omit<Action, "at">): Promise<void> => {
  await query(
    "insert into github_actions (chat, who, action, target, detail) values ($1, $2, $3, $4, $5)",
    [entry.chat, entry.who, entry.action, entry.target, entry.detail?.slice(0, 500) ?? null],
  );
};

export const history = async (limit = 20): Promise<Action[]> => {
  const rows = await query<{
    at: Date;
    chat: string | null;
    who: string | null;
    action: string;
    target: string | null;
    detail: string | null;
  }>("select at, chat, who, action, target, detail from github_actions order by at desc limit $1", [
    limit,
  ]);
  return rows;
};

/** Writes in the last 24 hours, which is what the cap counts. */
export const writesToday = async (): Promise<number> => {
  const rows = await query<{ count: string }>(
    "select count(*)::text as count from github_actions where at > now() - interval '24 hours'",
  );
  return Number(rows[0]?.count ?? 0);
};

// ── the client ───────────────────────────────────────────────────────────

type Response = { status: number; body: unknown; headers: Headers };

const request = async (
  method: string,
  path: string,
  options: { token?: string; body?: unknown } = {},
): Promise<Response> => {
  const auth = options.token ?? (await token());
  if (!auth) throw new GitHubError("GitHub is not connected — add a token on the dashboard");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(`${API}${path}`, {
      method,
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${auth}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": VERSION,
        "user-agent": "wspbot",
        ...(options.body ? { "content-type": "application/json" } : {}),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    });

    const text = await res.text();
    const body: unknown = text ? JSON.parse(text) : null;

    if (!res.ok) {
      const message = (body as { message?: string })?.message ?? `HTTP ${res.status}`;
      /*
       * The rate limit is worth naming: a 403 that is really "you have used your hour" reads as a
       * permissions problem otherwise, and somebody would go and widen the token for no reason.
       */
      if (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0") {
        throw new GitHubError("GitHub's rate limit is used up for this hour");
      }
      throw new GitHubError(message);
    }

    return { status: res.status, body, headers: res.headers };
  } catch (err) {
    if (err instanceof GitHubError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new GitHubError("GitHub did not answer in time");
    }
    throw new GitHubError(err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timer);
  }
};

// ── reads ────────────────────────────────────────────────────────────────

export type Repo = {
  fullName: string;
  description: string | null;
  url: string;
  private: boolean;
  fork: boolean;
  language: string | null;
  stars: number;
  forks: number;
  openIssues: number;
  defaultBranch: string;
  pushedAt: string | null;
  topics: string[];
  homepage: string | null;
};

type RepoBody = {
  full_name: string;
  description: string | null;
  html_url: string;
  private: boolean;
  fork: boolean;
  language: string | null;
  stargazers_count: number;
  forks_count: number;
  open_issues_count: number;
  default_branch: string;
  pushed_at: string | null;
  topics?: string[];
  homepage: string | null;
};

const toRepo = (body: RepoBody): Repo => ({
  fullName: body.full_name,
  description: body.description,
  url: body.html_url,
  private: body.private,
  fork: body.fork,
  language: body.language,
  stars: body.stargazers_count,
  forks: body.forks_count,
  openIssues: body.open_issues_count,
  defaultBranch: body.default_branch,
  pushedAt: body.pushed_at,
  topics: body.topics ?? [],
  homepage: body.homepage,
});

export const repo = async (name: string): Promise<Repo> => {
  const path = normalise(name);
  if (!VALID.test(path)) throw new GitHubError(`"${name}" is not an owner/name pair`);
  const res = await request("GET", `/repos/${path}`);
  return toRepo(res.body as RepoBody);
};

/** What the account itself can see, newest activity first — for "what are you working on?". */
export const mine = async (limit = 20): Promise<Repo[]> => {
  const res = await request("GET", `/user/repos?sort=pushed&per_page=${Math.min(limit, 100)}`);
  return (res.body as RepoBody[]).map(toRepo);
};

export type Issue = {
  number: number;
  title: string;
  state: string;
  url: string;
  author: string | null;
  comments: number;
  createdAt: string;
  isPullRequest: boolean;
  body: string | null;
};

type IssueBody = {
  number: number;
  title: string;
  state: string;
  html_url: string;
  user: { login: string } | null;
  comments: number;
  created_at: string;
  pull_request?: unknown;
  body: string | null;
};

const toIssue = (body: IssueBody): Issue => ({
  number: body.number,
  title: body.title,
  state: body.state,
  url: body.html_url,
  author: body.user?.login ?? null,
  comments: body.comments,
  createdAt: body.created_at,
  // The issues endpoint returns pull requests too, and "3 open issues" that are really PRs is
  // a wrong answer nobody would think to question.
  isPullRequest: body.pull_request !== undefined,
  body: body.body,
});

export const issues = async (
  name: string,
  options: { state?: "open" | "closed" | "all"; limit?: number } = {},
): Promise<Issue[]> => {
  const path = normalise(name);
  if (!VALID.test(path)) throw new GitHubError(`"${name}" is not an owner/name pair`);
  const state = options.state ?? "open";
  const res = await request(
    "GET",
    `/repos/${path}/issues?state=${state}&per_page=${Math.min(options.limit ?? 15, 50)}`,
  );
  return (res.body as IssueBody[]).map(toIssue);
};

export const issue = async (name: string, number: number): Promise<Issue> => {
  const path = normalise(name);
  const res = await request("GET", `/repos/${path}/issues/${number}`);
  return toIssue(res.body as IssueBody);
};

// ── writes ───────────────────────────────────────────────────────────────

/**
 * The line every written thing carries.
 *
 * An issue that appears on a repository with no idea where it came from is the thing that makes
 * a maintainer turn this feature off. Naming the person and the group is also what makes a
 * misuse traceable to somebody rather than to "the bot".
 */
const attribution = (by: { who?: string | null; where?: string | null }): string =>
  `\n\n---\n_Opened through wspbot${by.who ? ` on behalf of ${by.who}` : ""}${
    by.where ? `, from the “${by.where}” WhatsApp group` : ""
  }._`;

export type By = { chat?: string | null; who?: string | null; where?: string | null };

/**
 * Everything a write has to be true for, in one place, so no caller can perform half of it.
 *
 * Returns the reason rather than throwing, because every one of these is a sentence the bot
 * should say out loud in the chat: "that repository is not on the list" is useful, and a thrown
 * error that reaches the model as a stack trace is not.
 */
const refuse = async (
  what: "open_issue" | "comment" | "create_repo",
  repoName: string | null,
): Promise<string | null> => {
  const s = await settings();
  if (!(await connected())) return "GitHub is not connected here yet";

  if (what === "open_issue" && !s.canOpenIssues) return "opening issues is switched off";
  if (what === "comment" && !s.canComment) return "commenting is switched off";
  if (what === "create_repo" && !s.canCreateRepos) return "creating repositories is switched off";

  if (repoName && !(await isAllowed(repoName))) {
    return `${normalise(repoName)} is not on the list of repositories I may write to`;
  }

  const used = await writesToday();
  if (used >= s.maxWritesPerDay) {
    return `I have already made ${used} changes on GitHub in the last day, which is the limit`;
  }

  return null;
};

export type Written = { ok: true; url: string; number?: number } | { ok: false; why: string };

export const openIssue = async (
  name: string,
  input: { title: string; body?: string; labels?: string[] },
  by: By = {},
): Promise<Written> => {
  const why = await refuse("open_issue", name);
  if (why) return { ok: false, why };

  const path = normalise(name);
  const created = await request("POST", `/repos/${path}/issues`, {
    body: {
      title: input.title.slice(0, 250),
      body: `${input.body ?? ""}${attribution(by)}`,
      ...(input.labels?.length ? { labels: input.labels.slice(0, 5) } : {}),
    },
  });

  const body = created.body as { html_url: string; number: number };
  await record({
    chat: by.chat ?? null,
    who: by.who ?? null,
    action: "open_issue",
    target: `${path}#${body.number}`,
    detail: input.title,
  });
  return { ok: true, url: body.html_url, number: body.number };
};

export const comment = async (
  name: string,
  number: number,
  text: string,
  by: By = {},
): Promise<Written> => {
  const why = await refuse("comment", name);
  if (why) return { ok: false, why };

  const path = normalise(name);
  const created = await request("POST", `/repos/${path}/issues/${number}/comments`, {
    body: { body: `${text}${attribution(by)}` },
  });

  const body = created.body as { html_url: string };
  await record({
    chat: by.chat ?? null,
    who: by.who ?? null,
    action: "comment",
    target: `${path}#${number}`,
    detail: text,
  });
  return { ok: true, url: body.html_url, number };
};

export const createRepo = async (
  input: { name: string; description?: string; private?: boolean },
  by: By = {},
): Promise<Written> => {
  // No repository to check against the allowlist: this one does not exist yet, which is why the
  // switch and the owner matter more here than anywhere else.
  const why = await refuse("create_repo", null);
  if (why) return { ok: false, why };

  const s = await settings();
  const name = input.name.trim().replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 90);
  if (!name) return { ok: false, why: "that is not a usable repository name" };

  /*
   * Private unless the dashboard says otherwise, and never public just because a message asked
   * for it: "make it public" from a group chat is exactly the request that should need somebody
   * to have decided in advance.
   */
  const isPrivate = s.reposPrivate ? true : (input.private ?? true);

  const owner = s.owner && s.owner !== s.login ? s.owner : null;
  const created = await request(
    "POST",
    owner ? `/orgs/${owner}/repos` : "/user/repos",
    {
      body: {
        name,
        description: input.description?.slice(0, 300),
        private: isPrivate,
        auto_init: true,
      },
    },
  );

  const body = created.body as { html_url: string; full_name: string };
  /*
   * Added to the allowlist as it is created. It was made by this bot, on purpose, so the
   * alternative is a repository it cannot then open an issue on — which reads as a bug.
   */
  await allow(body.full_name);
  await record({
    chat: by.chat ?? null,
    who: by.who ?? null,
    action: "create_repo",
    target: body.full_name,
    detail: isPrivate ? "private" : "public",
  });
  return { ok: true, url: body.html_url };
};

/** Organisations the token can act in, for the owner picker. */
export const orgs = async (): Promise<string[]> => {
  const res = await request("GET", "/user/orgs?per_page=100");
  return (res.body as { login: string }[]).map((o) => o.login);
};
