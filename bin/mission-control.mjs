// mission-control.mjs — fetch and derivation for the mission-control page (flow-0019).
//
// Per ADR-0002 Amendment 1, the primary cross-repo view is a page computed live from the GitHub
// API at open time — no server, no build step, no render-and-commit step. This file is that
// computation: parsing task frontmatter and VISION.md, deriving the four per-repo questions
// (what's moving, what's next, what needs me, is the machinery alive — the last one via
// `liveness.mjs`), and orchestrating the GitHub calls that feed all of it. `flightdeck/index.html`
// imports this module and is a thin render shell over it — the logic lives here, tested, not in
// a `<script>` block (see the task's Notes/open-questions: that was flow-0001's original
// complaint wearing a new medium).
//
// BROWSER AND NODE, THE SAME MODULE. This file is loaded as a plain ES module both by the browser
// (`<script type="module" src="bin/mission-control.mjs">`, no bundler) and by `npm test`
// (Node >= 18). So it imports nothing from `node:*` and uses only Web-standard globals available
// in both: `fetch`, `atob`, `TextDecoder`. All real network IO is behind an injected `io` object
// (`{ rest(path) }`) exactly as `flightdeck-state.mjs` injects its IO — the derivation functions
// below take plain data and are unit-tested without a network; `createGitHubIO` (bottom of file)
// is the one real implementation, wired up by `index.html`.
//
// DELIBERATELY NO GRAPHQL. GraphQL would collapse the task-directory and workflow-directory reads
// from many REST calls into one — a real saving — but every GraphQL call, including a pure query,
// is an HTTP POST. The page's one absolute rule (ADR-0002 Amendment 1, decision 2; enforced by
// `mission-control.test.mjs`'s write-call scan) is that its source contains no write-capable
// call against `api.github.com` — a blunt, mechanical scan, not a semantic one, because a
// semantic exemption for "this POST is actually a read" is exactly the kind of judgment call a
// mechanical gate exists to not need. Every request here is a REST GET. The request-budget
// mechanism below (`createBudget`, `DEFAULT_REQUEST_CEILING`) exists to keep that honest choice
// affordable — see the ceiling math in `flightdeck/README.md`.
//
// A repo whose fetch fails is reported `{ status: "unavailable", reason }`, never dropped — same
// rule `flightdeck-state.mjs` holds, for the same reason (ADR-0002's "trust is a function of
// calibrated uncertainty").

import {
  classifyWorkflowTrigger,
  eventLiveness,
  repoSeverity,
  scheduledLiveness,
  sortBySeverity,
  ungatedMergesLiveness,
} from "./liveness.mjs";

const GITHUB_API = "https://api.github.com";
const MERGE_WINDOW_DAYS = 14;      // how far back "merges vs gate runs" looks
const GOAL_ACTIVITY_WINDOW_DAYS = 30;

// ~15 repos at up to ~55 requests each (a task-heavy repo with a dozen workflows), plus margin.
// See flightdeck/README.md for the per-repo cost breakdown this is measured against. A portfolio
// that would exceed it truncates VISIBLY (the `truncated` field below), never silently.
export const DEFAULT_REQUEST_CEILING = 900;

// ── request budget ──────────────────────────────────────────────────────────────────────────
// A plain counter, not a rate limiter: it exists so "how many requests did this page load make,
// and did it hit the ceiling" is answerable and testable, not so retries/backoff happen here.
export function createBudget(max = DEFAULT_REQUEST_CEILING) {
  let used = 0;
  return {
    max,
    used: () => used,
    remaining: () => Math.max(0, max - used),
    charge(n = 1) {
      if (used + n > max) {
        const err = new Error(`request budget exceeded (max ${max})`);
        err.budgetExceeded = true;
        throw err;
      }
      used += n;
    },
  };
}

async function budgetedRest(io, budget, path) {
  budget.charge(1);
  return io.rest(path);
}

// ── discovery ────────────────────────────────────────────────────────────────────────────────
// Owner-scoped by construction — a bare `topic:flow` matches most of GitHub. `ownerType: "org"`
// switches the qualifier for an organization account; GitHub's `user:` qualifier only reaches
// personal accounts.
export function buildDiscoveryQuery(owner, { ownerType = "user" } = {}) {
  const qualifier = ownerType === "org" ? "org" : "user";
  return `${qualifier}:${String(owner ?? "")} topic:flow`;
}

// ── base64 (GitHub Contents API returns file bodies base64-encoded) ───────────────────────────
export function decodeBase64(b64) {
  const clean = String(b64 ?? "").replace(/\n/g, "");
  const binary = atob(clean);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder("utf-8").decode(bytes);
}

// ── task frontmatter (same tolerant line-scan style as pick-task.mjs's parseTask, browser-safe:
// no node:fs — the text arrives already fetched, not read from disk) ─────────────────────────
export function parseTaskFrontmatter(text) {
  const t = String(text ?? "");
  if (!t.startsWith("---")) return null;
  const end = t.indexOf("\n---", 3);
  if (end === -1) return null;
  const head = t.slice(3, end);
  const get = (k) => {
    const m = head.match(new RegExp(`^${k}:\\s*(.*)$`, "m"));
    return m ? m[1].split("#")[0].trim().replace(/^"(.*)"$/, "$1") : "";
  };
  const arr = (k) => {
    const raw = (head.match(new RegExp(`^${k}:\\s*\\[(.*?)\\]`, "m")) || [, ""])[1];
    return [...raw.matchAll(/"([^"]*)"|'([^']*)'/g)].map((x) => x[1] ?? x[2]).filter(Boolean);
  };
  const id = get("id");
  if (!id) return null;
  const priority = parseInt(get("priority"), 10);
  return {
    id,
    title: get("title"),
    status: get("status"),
    priority: Number.isFinite(priority) ? priority : 999,
    pr: get("pr") || null,
    issue: get("issue") || null,
    blocked_reason: get("blocked_reason") || "",
    serves: arr("serves"),
    touches: arr("touches"),
  };
}

// ── VISION.md (mirrors the heading grammar flow-doctor.mjs's parseVisionGoals reads — a
// second, independent reader by design: this repo's data comes from another repo entirely, over
// the network, so it cannot import that file directly) ────────────────────────────────────────
const GOAL_HEADING = /^###\s+(G|NG)(\d+)\s*[—–-]\s*(.+?)\s*$/;
const CHANGELOG_ROW = /^\|\s*(\d{4}-\d{2}-\d{2})\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*$/;

export function parseVision(text) {
  if (!text) return null;
  const cleaned = String(text).replace(/<!--[\s\S]*?-->/g, "");
  const lines = cleaned.split("\n");

  const h1Idx = lines.findIndex((l) => /^#\s+/.test(l));
  const firstSectionIdx = lines.findIndex((l, i) => i > h1Idx && /^##\s+/.test(l));
  const purposeSlice = lines.slice(h1Idx + 1, firstSectionIdx === -1 ? lines.length : firstSectionIdx);
  const purpose = purposeSlice.filter((l) => l.trim()).join(" ").replace(/\s+/g, " ").trim();

  const goals = [];
  const nonGoals = [];
  const changelog = [];
  let inRetired = false;
  let currentNonGoal = null;

  for (const line of lines) {
    if (/^##\s+/.test(line)) {
      inRetired = /^##\s+retired\b/i.test(line);
      currentNonGoal = null;
      continue;
    }
    const m = line.match(GOAL_HEADING);
    if (m) {
      const id = m[1] + m[2];
      const title = m[3].trim();
      if (m[1] === "NG") {
        currentNonGoal = { id, title, reason: "" };
        nonGoals.push(currentNonGoal);
      } else {
        currentNonGoal = null;
        goals.push({ id, title, retired: inRetired });
      }
      continue;
    }
    const row = line.match(CHANGELOG_ROW);
    if (row) { changelog.push({ date: row[1], change: row[2], why: row[3] }); continue; }
    if (currentNonGoal && line.trim() && !line.trim().startsWith("|")) {
      currentNonGoal.reason = (currentNonGoal.reason ? currentNonGoal.reason + " " : "") + line.trim();
    }
  }

  return { purpose, goals, nonGoals, changelog };
}

// ── PR <-> task correlation (the `[<task-id>] Title` convention PROTOCOL.md step 7 requires) ──
export function extractTaskIdFromPRTitle(title) {
  const m = String(title ?? "").match(/^\[([^\]]+)\]/);
  return m ? m[1] : null;
}

// Activity, never progress (per Scope: "no percent-complete on any goal, anywhere") — counts of
// motion attributed to this goal via `serves`, cross-referenced against merged PRs by the
// `[<task-id>]` title convention. No extra request: both inputs are already fetched for other
// reasons (tasks for the row itself, mergedPRs for "merges vs gate runs").
export function deriveGoalActivity({ goalId, tasks, mergedPRs, now, windowDays = GOAL_ACTIVITY_WINDOW_DAYS }) {
  const byId = new Map((tasks ?? []).map((t) => [t.id, t]));
  const servingMerges = (mergedPRs ?? [])
    .map((pr) => ({ pr, taskId: extractTaskIdFromPRTitle(pr.title) }))
    .filter(({ taskId }) => taskId && byId.has(taskId) && (byId.get(taskId).serves ?? []).includes(goalId));

  const readyCount = (tasks ?? []).filter((t) => t.status === "ready" && (t.serves ?? []).includes(goalId)).length;
  const windowMs = windowDays * 24 * 3600 * 1000;
  const doneIn30d = servingMerges.filter(({ pr }) => now - new Date(pr.merged_at).getTime() <= windowMs).length;
  const lastMerged = servingMerges
    .map(({ pr }) => pr.merged_at)
    .sort()
    .slice(-1)[0] ?? null;

  return { readyCount, doneIn30d, lastMerged };
}

// ── row derivation (moving / next / needs) ──────────────────────────────────────────────────

export function deriveMoving(tasks) {
  return (tasks ?? [])
    .filter((t) => t.status === "in_progress" || t.status === "in_review")
    .map((t) => ({ id: t.id, title: t.title, status: t.status, pr: t.pr || null }));
}

export function deriveNext(tasks) {
  const ready = (tasks ?? [])
    .filter((t) => t.status === "ready")
    .sort((a, b) => (a.priority - b.priority) || String(a.id).localeCompare(String(b.id)));
  return { top: ready[0] ?? null, readyCount: ready.length };
}

// "An empty ready queue is flagged — idle workers with no ready work is a planning gap, not a
// rest state" (Scope). Folded into `needs`, not a separate silent-good field, so severity's
// "attention if anything needs a human" picks it up for free.
export function deriveNeeds({ blockedTasks, proposedIssues, compassIssues, awaitingReviewPRs, readyCount }) {
  const needs = [];
  for (const t of blockedTasks ?? []) {
    needs.push({ type: "blocked-task", id: t.id, title: t.title || t.id, reason: t.blocked_reason || "" });
  }
  for (const i of proposedIssues ?? []) {
    needs.push({ type: "proposed-issue", title: i.title, url: i.html_url ?? i.url ?? "" });
  }
  for (const i of compassIssues ?? []) {
    needs.push({ type: "compass-finding", title: i.title, url: i.html_url ?? i.url ?? "" });
  }
  for (const p of awaitingReviewPRs ?? []) {
    needs.push({ type: "pr-review", title: p.title, url: p.html_url ?? p.url ?? "" });
  }
  if (readyCount === 0) {
    needs.push({
      type: "empty-queue",
      title: "ready queue is empty",
      reason: "idle workers with no ready work is a planning gap, not a rest state",
    });
  }
  return needs;
}

// ── per-repo file fetch (batched into two directory listings, never a working-tree read —
// this reads api.github.com exclusively) ────────────────────────────────────────────────────

async function listDirOrEmpty(io, budget, path) {
  try {
    const data = await budgetedRest(io, budget, path);
    return Array.isArray(data) ? data : [];
  } catch (err) {
    if (err && err.status === 404) return [];
    throw err;
  }
}

async function fetchTextFile(io, budget, path) {
  const data = await budgetedRest(io, budget, path);
  if (!data || typeof data.content !== "string") throw new Error(`${path}: no file content in response`);
  return decodeBase64(data.content);
}

async function fetchOptionalTextFile(io, budget, path) {
  try {
    const data = await budgetedRest(io, budget, path);
    if (!data || typeof data.content !== "string") return null;
    return decodeBase64(data.content);
  } catch (err) {
    if (err && err.status === 404) return null;
    throw err;
  }
}

export async function fetchRepoFiles({ io, budget, fullName }) {
  const taskEntries = await listDirOrEmpty(io, budget, `/repos/${fullName}/contents/.flow/tasks`);
  const taskFiles = [];
  for (const entry of taskEntries) {
    if (entry.type !== "file" || !entry.name.endsWith(".md") || entry.name === "_TEMPLATE.md") continue;
    taskFiles.push(await fetchTextFile(io, budget, `/repos/${fullName}/contents/.flow/tasks/${entry.name}`));
  }

  const workflowEntries = await listDirOrEmpty(io, budget, `/repos/${fullName}/contents/.github/workflows`);
  const workflowFiles = [];
  for (const entry of workflowEntries) {
    if (entry.type !== "file" || !/\.ya?ml$/.test(entry.name)) continue;
    const text = await fetchTextFile(io, budget, `/repos/${fullName}/contents/.github/workflows/${entry.name}`);
    workflowFiles.push({ name: entry.name, text });
  }

  const visionText = await fetchOptionalTextFile(io, budget, `/repos/${fullName}/contents/VISION.md`);

  return { taskFiles, workflowFiles, visionText };
}

// ── one repo row ─────────────────────────────────────────────────────────────────────────────

export async function loadRepoRow({ io, budget, fullName, desc, now }) {
  try {
    await budgetedRest(io, budget, `/repos/${fullName}`); // existence/access check, cheap and decisive
  } catch (err) {
    if (err.budgetExceeded) throw err;
    return { name: fullName, status: "unavailable", reason: `repo unreachable: ${err.message || err}` };
  }

  let files;
  try {
    files = await fetchRepoFiles({ io, budget, fullName });
  } catch (err) {
    if (err.budgetExceeded) throw err;
    return { name: fullName, status: "unavailable", reason: `could not read repo files: ${err.message || err}` };
  }

  const tasks = files.taskFiles.map(parseTaskFrontmatter).filter(Boolean);
  const vision = files.visionText ? parseVision(files.visionText) : null;

  let workflowMeta;
  try {
    workflowMeta = await budgetedRest(io, budget, `/repos/${fullName}/actions/workflows?per_page=100`);
  } catch (err) {
    if (err.budgetExceeded) throw err;
    return { name: fullName, status: "unavailable", reason: `could not read workflows: ${err.message || err}` };
  }
  const workflowsByPath = new Map((workflowMeta.workflows ?? []).map((w) => [w.path, w]));

  const machinery = [];
  let gateRunShas = [];

  for (const wf of files.workflowFiles) {
    const path = `.github/workflows/${wf.name}`;
    const meta = workflowsByPath.get(path);
    if (!meta) continue; // file exists but isn't a registered workflow (rare; nothing to report on)
    const disabled = meta.state !== "active";
    const trigger = classifyWorkflowTrigger(wf.text);
    if (trigger.kind === "manual") continue; // no liveness expectation to check

    const isGate = /gate/i.test(wf.name) || /gate/i.test(meta.name ?? "");

    if (trigger.kind === "scheduled") {
      let lastSuccessAt = null;
      try {
        const runs = await budgetedRest(io, budget, `/repos/${fullName}/actions/workflows/${meta.id}/runs?status=success&per_page=1`);
        const run = (runs.workflow_runs ?? [])[0];
        lastSuccessAt = run?.run_started_at ?? run?.created_at ?? null;
      } catch (err) {
        if (err.budgetExceeded) throw err;
        // leave lastSuccessAt null -> scheduledLiveness correctly reports crit, not a blank
      }
      machinery.push({ name: meta.name || wf.name, path, kind: "scheduled", ...scheduledLiveness({ crons: trigger.crons, lastSuccessAt, now, disabled }) });
    } else {
      const perPage = isGate ? 100 : 1;
      let runs = { workflow_runs: [] };
      try {
        runs = await budgetedRest(io, budget, `/repos/${fullName}/actions/workflows/${meta.id}/runs?per_page=${perPage}`);
      } catch (err) {
        if (err.budgetExceeded) throw err;
      }
      const latestRun = (runs.workflow_runs ?? [])[0] ? { conclusion: runs.workflow_runs[0].conclusion } : null;
      machinery.push({ name: meta.name || wf.name, path, kind: "event", ...eventLiveness({ disabled, latestRun }) });
      // Accumulate rather than overwrite: a repo could carry more than one event-triggered
      // workflow whose name matches /gate/i, and dropping an earlier one's runs would silently
      // shrink gateRunShas — the wrong direction for a check whose job is not missing a merge.
      if (isGate) gateRunShas = gateRunShas.concat((runs.workflow_runs ?? []).map((r) => r.head_sha).filter(Boolean));
    }
  }

  let mergedPRs = [];
  let openPRs = [];
  try {
    const closed = await budgetedRest(io, budget, `/repos/${fullName}/pulls?state=closed&sort=updated&direction=desc&per_page=50`);
    mergedPRs = (Array.isArray(closed) ? closed : []).filter((p) => p.merged_at);
  } catch (err) { if (err.budgetExceeded) throw err; }
  try {
    const open = await budgetedRest(io, budget, `/repos/${fullName}/pulls?state=open&per_page=50`);
    openPRs = Array.isArray(open) ? open : [];
  } catch (err) { if (err.budgetExceeded) throw err; }

  if (gateRunShas.length > 0 || mergedPRs.length > 0) {
    const windowMs = MERGE_WINDOW_DAYS * 24 * 3600 * 1000;
    // `gateRunShas` comes from the gate workflow's `pull_request`-triggered runs, whose
    // `head_sha` is the PR branch's own tip — never a merge commit, because flow-gates.yml
    // triggers on `pull_request`/`workflow_dispatch`, not `push`. So the merged SHA that must
    // match is `p.head.sha` (what the gate actually ran against), not `merge_commit_sha` (a
    // brand-new commit created AFTER merge that no gate run was ever triggered against). Falling
    // back to `merge_commit_sha` only covers the rare case where GitHub has already pruned the
    // head ref data for an old merged PR.
    const mergedShas = mergedPRs
      .filter((p) => now - new Date(p.merged_at).getTime() <= windowMs)
      .map((p) => p.head?.sha || p.merge_commit_sha)
      .filter(Boolean);
    machinery.push({ name: "merges vs gate runs", path: null, kind: "derived", ...ungatedMergesLiveness({ mergedShas, gateRunShas }) });
  }

  let proposedIssues = [];
  let compassIssues = [];
  try {
    const r = await budgetedRest(io, budget, `/repos/${fullName}/issues?labels=proposed&state=open&per_page=50`);
    proposedIssues = Array.isArray(r) ? r : [];
  } catch (err) { if (err.budgetExceeded) throw err; }
  try {
    const r = await budgetedRest(io, budget, `/repos/${fullName}/issues?labels=compass&state=open&per_page=50`);
    compassIssues = Array.isArray(r) ? r : [];
  } catch (err) { if (err.budgetExceeded) throw err; }

  const blockedTasks = tasks.filter((t) => t.status === "blocked");
  const { top, readyCount } = deriveNext(tasks);
  const needs = deriveNeeds({
    blockedTasks,
    proposedIssues,
    compassIssues,
    awaitingReviewPRs: openPRs.filter((p) => !p.draft),
    readyCount,
  });

  const severity = repoSeverity({ machineryStates: machinery.map((m) => m.state), needsAttention: needs.length > 0 });

  const goals = vision
    ? vision.goals.filter((g) => !g.retired).map((g) => ({ ...g, activity: deriveGoalActivity({ goalId: g.id, tasks, mergedPRs, now }) }))
    : [];

  return {
    name: fullName,
    desc: desc ?? "",
    status: "ok",
    severity,
    vision: vision ? { purpose: vision.purpose, goals, nonGoals: vision.nonGoals, changelog: vision.changelog } : null,
    moving: deriveMoving(tasks),
    next: top ? [{ id: top.id, title: top.title, priority: top.priority }] : [],
    nextMore: Math.max(0, readyCount - (top ? 1 : 0)),
    lastMerged: mergedPRs.length ? mergedPRs.map((p) => p.merged_at).sort().slice(-1)[0] : null,
    needs,
    machinery,
    detail: {}, // deliberately empty — judgment (`why`/`action`) is a later, dated reading, never a live fact
  };
}

// The token names its own owner via `GET /user` — "given a read-only PAT and no other
// configuration" (acceptance criteria) means the page never asks for a username to discover
// against; it asks the token who it is.
export async function resolveOwner({ io, budget }) {
  const user = await budgetedRest(io, budget, "/user");
  return { login: user.login, type: user.type === "Organization" ? "org" : "user" };
}

// ── the whole page's data, across every discovered repo ────────────────────────────────────

export async function loadMissionControl({ io, owner, ownerType, budget = createBudget(), now = Date.now() }) {
  const query = buildDiscoveryQuery(owner, { ownerType });
  let search;
  try {
    search = await budgetedRest(io, budget, `/search/repositories?q=${encodeURIComponent(query)}&per_page=100`);
  } catch (err) {
    return { owner, query, repos: [], truncated: null, requestCount: budget.used(), requestCeiling: budget.max, error: String(err.message || err) };
  }

  const candidates = (search.items ?? []).map((r) => ({ name: r.full_name, desc: r.description ?? "" }));
  const rows = [];
  const truncatedNames = [];

  for (const c of candidates) {
    try {
      rows.push(await loadRepoRow({ io, budget, fullName: c.name, desc: c.desc, now }));
    } catch (err) {
      if (err && err.budgetExceeded) { truncatedNames.push(c.name); continue; }
      rows.push({ name: c.name, status: "unavailable", reason: String(err?.message ?? err) });
    }
  }

  const ok = rows.filter((r) => r.status === "ok");
  const unavailable = rows.filter((r) => r.status !== "ok");
  const repos = [...sortBySeverity(ok, (r) => r.severity), ...unavailable];

  return {
    owner,
    query,
    repos,
    truncated: truncatedNames.length > 0
      ? { count: truncatedNames.length, repos: truncatedNames, reason: `request ceiling (${budget.max}) reached` }
      : null,
    requestCount: budget.used(),
    requestCeiling: budget.max,
  };
}

// ── render — pure HTML-string templating, tested and linted like everything else ──────────────
// `index.html`'s Notes/open-questions rule: "the page is a render shell over tested modules...
// logic inlined in HTML is neither linted nor testable." That applies to templating as much as
// to derivation — an untested `renderRepo()` sitting in a `<script>` block is exactly the failure
// this task exists to avoid repeating. So the render functions live here, as pure functions of
// already-derived data (a `doc` from `loadMissionControl`, or one `row` from `doc.repos`) to an
// HTML string. `index.html`'s own script does nothing but wire DOM events, call `loadMissionControl`,
// and assign the returned string to `innerHTML` — no decision of what to show is made there.

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
export function escapeAttr(s) { return escapeHtml(s); }

export function renderUnavailableRow(row) {
  return `<div class="repo"><div class="unavailable"><strong>${escapeHtml(row.name)}</strong> — unavailable: ${escapeHtml(row.reason || "unknown reason")}</div></div>`;
}

export function renderVisionDrawer(row) {
  const goals = row.vision.goals.map((g) => `
      <div class="vision-goal">
        <strong>${escapeHtml(g.id)}</strong> — ${escapeHtml(g.title)}
        <div class="activity">activity: ${g.activity.doneIn30d} done in 30d · ${g.activity.readyCount} ready ·
          last merged ${g.activity.lastMerged ? escapeHtml(g.activity.lastMerged) : "never"}</div>
      </div>`).join("");
  const nonGoals = row.vision.nonGoals.map((ng) =>
    `<div class="non-goal"><strong>${escapeHtml(ng.id)}</strong> — ${escapeHtml(ng.title)}: ${escapeHtml(ng.reason)}</div>`).join("");
  const changelogRows = row.vision.changelog.map((c) =>
    `<tr><td>${escapeHtml(c.date)}</td><td>${escapeHtml(c.change)}</td><td>${escapeHtml(c.why)}</td></tr>`).join("");

  return `
      <details class="vision">
        <summary>Vision</summary>
        <p>${escapeHtml(row.vision.purpose)}</p>
        ${goals}
        ${nonGoals}
        <table class="changelog"><tr><th>Date</th><th>Change</th><th>Why</th></tr>${changelogRows}</table>
        <p><a href="https://github.com/${escapeAttr(row.name)}/edit/main/VISION.md">Propose a [vision] change on GitHub &rarr;</a></p>
      </details>`;
}

export function renderRepoRow(row) {
  const moving = row.moving.length
    ? `<ul>${row.moving.map((m) => `<li>${escapeHtml(m.title || m.id)} <span class="empty">(${escapeHtml(m.status)})</span></li>`).join("")}</ul>`
    : `<p class="empty">Nothing in flight.</p>`;

  const next = row.next.length
    ? `<ul><li>${escapeHtml(row.next[0].title || row.next[0].id)}${row.nextMore > 0 ? ` <span class="empty">+${row.nextMore} more ready</span>` : ""}</li></ul>`
    : `<p class="empty">Ready queue is empty.</p>`;

  const needs = row.needs.length
    ? `<ul>${row.needs.map((n) => `<li>${n.url ? `<a href="${escapeAttr(n.url)}">${escapeHtml(n.title)}</a>` : escapeHtml(n.title)}</li>`).join("")}</ul>`
    : `<p class="empty">Nothing waiting on you.</p>`;

  const machinery = `<div class="machinery">${row.machinery.map((m) =>
    `<span class="m-chip" title="${escapeAttr(m.reason || m.state)}"><span class="m-dot m-${escapeAttr(m.state)}"></span>${escapeHtml(m.name)}</span>`
  ).join("")}</div>`;

  return `
      <div class="repo">
        <div class="repo-head">
          <span class="sev-dot sev-${escapeAttr(row.severity)}"></span>
          <span class="name">${escapeHtml(row.name)}</span>
          <span class="desc">${escapeHtml(row.desc || "")}</span>
        </div>
        <div class="repo-body">
          <div class="col"><h3>What's moving</h3>${moving}</div>
          <div class="col"><h3>What's next</h3>${next}</div>
          <div class="col"><h3>What needs you</h3>${needs}</div>
          <div class="col"><h3>Machinery</h3>${machinery}</div>
        </div>
        ${row.vision ? renderVisionDrawer(row) : ""}
      </div>`;
}

// The status line's text, separated from the HTML body so a caller can assign it to a plain
// `textContent` node (never `innerHTML`) without re-deriving anything.
export function statusLineText(doc) {
  return `${doc.requestCount}/${doc.requestCeiling} requests · generated just now, computed live — never stored`;
}

// The full `#app` body for one loaded document: the truncation banner (if any), an explicit
// empty-state message (never a blank pane), then every repo row in `doc.repos`' own order —
// `loadMissionControl` has already sorted that needs-you-first, so preserving order here is the
// whole contract.
export function renderMissionControlHTML(doc) {
  const parts = [];
  if (doc.truncated) {
    parts.push(
      `<div class="banner">Request ceiling reached (${escapeHtml(String(doc.truncated.reason))}) — ` +
      `${doc.truncated.count} repo(s) not loaded: ${doc.truncated.repos.map(escapeHtml).join(", ")}</div>`
    );
  }
  if (doc.repos.length === 0) {
    parts.push(`<p class="empty">No repos carrying the <code>flow</code> topic were found for ${escapeHtml(doc.owner)}.</p>`);
  }
  for (const row of doc.repos) parts.push(row.status === "ok" ? renderRepoRow(row) : renderUnavailableRow(row));
  return parts.join("\n");
}

export function renderErrorBannerHTML(err) {
  return `<div class="banner error">${escapeHtml(err?.message || String(err))}</div>`;
}

// ── the one real IO implementation — browser fetch, never called from a test ──────────────────
// Read-only by construction: every method issues a GET. There is no POST/PATCH/PUT/DELETE
// anywhere in this file (see the module comment) — `mission-control.test.mjs` asserts it by
// scanning this file's own source, so the property can't silently rot as the file grows.
export function createGitHubIO(token) {
  async function rest(path) {
    const res = await fetch(`${GITHUB_API}${path}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!res.ok) {
      const err = new Error(`${res.status} ${res.statusText} — GET ${path}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }
  return { rest };
}
