// mission-control.test.mjs — proving tests for flightdeck/bin/mission-control.mjs (flow-0019).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  buildDiscoveryQuery,
  createBudget,
  decodeBase64,
  deriveGoalActivity,
  deriveMoving,
  deriveNeeds,
  deriveNext,
  extractTaskIdFromPRTitle,
  fetchRepoFiles,
  loadMissionControl,
  loadRepoRow,
  parseTaskFrontmatter,
  parseVision,
  renderErrorBannerHTML,
  renderMissionControlHTML,
  renderRepoRow,
  renderUnavailableRow,
  renderVisionDrawer,
  resolveOwner,
  statusLineText,
} from "./mission-control.mjs";

const BIN = dirname(fileURLToPath(import.meta.url));
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

// ── a tiny fake io: an ordered list of [matcher, value] pairs, first match wins ────────────
function fakeIO(routes) {
  return {
    calls: [],
    async rest(path) {
      this.calls.push(path);
      for (const [matcher, value] of routes) {
        const hit = typeof matcher === "string" ? matcher === path : matcher.test(path);
        if (!hit) continue;
        if (value instanceof Error) throw value;
        return typeof value === "function" ? value(path) : value;
      }
      const err = new Error(`no fake route for ${path}`);
      err.status = 404;
      throw err;
    },
  };
}
function notFound(path = "") {
  const err = new Error(`404: ${path}`);
  err.status = 404;
  return err;
}

// ── owner resolution — "given a PAT and no other configuration" ────────────────────────────

test("resolveOwner asks the token who it is via /user, rather than requiring a typed-in owner", async () => {
  const io = fakeIO([["/user", { login: "CandidDan", type: "User" }]]);
  const { login, type } = await resolveOwner({ io, budget: createBudget(5) });
  assert.equal(login, "CandidDan");
  assert.equal(type, "user");
});

test("resolveOwner maps an Organization account to ownerType 'org'", async () => {
  const io = fakeIO([["/user", { login: "acme", type: "Organization" }]]);
  assert.equal((await resolveOwner({ io, budget: createBudget(5) })).type, "org");
});

// ── discovery query ─────────────────────────────────────────────────────────────────────────

test("buildDiscoveryQuery is owner-scoped — never a bare topic:flow", () => {
  const q = buildDiscoveryQuery("CandidDan");
  assert.match(q, /\buser:CandidDan\b/);
  assert.match(q, /\btopic:flow\b/);
  assert.notEqual(q.trim(), "topic:flow");
});

test("buildDiscoveryQuery uses org: when told the owner is an organization", () => {
  assert.match(buildDiscoveryQuery("acme", { ownerType: "org" }), /\borg:acme\b/);
});

// ── base64 ───────────────────────────────────────────────────────────────────────────────────

test("decodeBase64 round-trips UTF-8 content, including a newline-wrapped body (as GitHub sends it)", () => {
  const text = "hello — world\nsecond line";
  const wrapped = b64(text).replace(/(.{20})/g, "$1\n");
  assert.equal(decodeBase64(wrapped), text);
});

// ── task frontmatter ─────────────────────────────────────────────────────────────────────────

test("parseTaskFrontmatter reads id/status/priority/serves/pr and returns null with no frontmatter", () => {
  const text = `---\nid: "flow-0099"\ntitle: "Do a thing"\nstatus: "ready"\npriority: 2\npr: ""\nserves: ["G1", "G2"]\ntouches: ["a.mjs"]\n---\n\nbody`;
  const t = parseTaskFrontmatter(text);
  assert.equal(t.id, "flow-0099");
  assert.equal(t.status, "ready");
  assert.equal(t.priority, 2);
  assert.equal(t.pr, null);
  assert.deepEqual(t.serves, ["G1", "G2"]);
  assert.equal(parseTaskFrontmatter("no frontmatter here"), null);
});

// ── vision parsing ───────────────────────────────────────────────────────────────────────────

const SAMPLE_VISION = `# Vision — Sample

<!-- a drift-anchor comment
     spanning two lines -->

Purpose paragraph, one sentence that
wraps across two lines.

## Goals

### G1 — First goal

### G2 — Second goal

## Non-goals

### NG1 — Not a platform

No service, no daemon, no dashboard to log into.

## Retired

### G3 — Old goal, now retired

## Change log

| Date | Change | Why |
|---|---|---|
| 2026-08-18 | Initial vision. | Needed an anchor. |
`;

test("parseVision extracts the purpose paragraph with the HTML comment stripped", () => {
  const v = parseVision(SAMPLE_VISION);
  assert.equal(v.purpose, "Purpose paragraph, one sentence that wraps across two lines.");
});

test("parseVision extracts goals, marks goals under ## Retired as retired", () => {
  const v = parseVision(SAMPLE_VISION);
  const byId = Object.fromEntries(v.goals.map((g) => [g.id, g]));
  assert.equal(byId.G1.retired, false);
  assert.equal(byId.G2.retired, false);
  assert.equal(byId.G3.retired, true);
});

test("parseVision extracts non-goals with their reason text", () => {
  const v = parseVision(SAMPLE_VISION);
  assert.equal(v.nonGoals.length, 1);
  assert.equal(v.nonGoals[0].id, "NG1");
  assert.match(v.nonGoals[0].reason, /No service, no daemon/);
});

test("parseVision extracts the dated change-log rows", () => {
  const v = parseVision(SAMPLE_VISION);
  assert.deepEqual(v.changelog, [{ date: "2026-08-18", change: "Initial vision.", why: "Needed an anchor." }]);
});

test("parseVision returns null for no VISION.md text, so callers can render its absence as absence, not an error", () => {
  assert.equal(parseVision(null), null);
  assert.equal(parseVision(""), null);
});

// ── PR <-> task correlation, goal activity ──────────────────────────────────────────────────

test("extractTaskIdFromPRTitle reads the [<task-id>] prefix PROTOCOL.md step 7 requires", () => {
  assert.equal(extractTaskIdFromPRTitle("[flow-0099] Do a thing"), "flow-0099");
  assert.equal(extractTaskIdFromPRTitle("no prefix here"), null);
});

test("deriveGoalActivity counts activity, never a percent — ready count, done-in-window, last-merged", () => {
  const tasks = [
    { id: "flow-0001", status: "ready", serves: ["G1"] },
    { id: "flow-0002", status: "done", serves: ["G1"] },
    { id: "flow-0003", status: "done", serves: ["G2"] }, // different goal — excluded
  ];
  const now = Date.parse("2026-08-24T00:00:00Z");
  const mergedPRs = [
    { title: "[flow-0002] Ship it", merged_at: "2026-08-20T00:00:00Z" }, // within 30d, serves G1
    { title: "[flow-0003] Other goal", merged_at: "2026-08-20T00:00:00Z" }, // serves G2 — excluded
    { title: "[flow-9999] Unknown task", merged_at: "2026-08-20T00:00:00Z" }, // no matching task
  ];
  const activity = deriveGoalActivity({ goalId: "G1", tasks, mergedPRs, now });
  assert.equal(activity.readyCount, 1);
  assert.equal(activity.doneIn30d, 1);
  assert.equal(activity.lastMerged, "2026-08-20T00:00:00Z");
});

// ── moving / next / needs ───────────────────────────────────────────────────────────────────

test("deriveMoving includes in_progress and in_review, excludes ready/done/blocked", () => {
  const tasks = [
    { id: "a", status: "in_progress", title: "A" },
    { id: "b", status: "in_review", title: "B", pr: "https://x/1" },
    { id: "c", status: "ready", title: "C" },
    { id: "d", status: "done", title: "D" },
  ];
  const moving = deriveMoving(tasks);
  assert.deepEqual(moving.map((m) => m.id), ["a", "b"]);
  assert.equal(moving[1].pr, "https://x/1");
});

test("deriveNext picks the top-priority ready task and reports the full ready count", () => {
  const tasks = [
    { id: "flow-0003", status: "ready", priority: 3, title: "Low" },
    { id: "flow-0001", status: "ready", priority: 1, title: "High" },
    { id: "flow-0002", status: "ready", priority: 1, title: "Also high, later id" },
  ];
  const { top, readyCount } = deriveNext(tasks);
  assert.equal(top.id, "flow-0001");
  assert.equal(readyCount, 3);
});

test("deriveNext with no ready tasks returns a null top and a zero count", () => {
  const { top, readyCount } = deriveNext([{ id: "a", status: "done", priority: 1 }]);
  assert.equal(top, null);
  assert.equal(readyCount, 0);
});

test("deriveNeeds: an empty ready queue is a need, not a silent healthy state", () => {
  const needs = deriveNeeds({ blockedTasks: [], proposedIssues: [], compassIssues: [], awaitingReviewPRs: [], readyCount: 0 });
  assert.ok(needs.some((n) => n.type === "empty-queue"));
});

test("deriveNeeds: a non-empty ready queue does not add the empty-queue entry", () => {
  const needs = deriveNeeds({ blockedTasks: [], proposedIssues: [], compassIssues: [], awaitingReviewPRs: [], readyCount: 3 });
  assert.ok(!needs.some((n) => n.type === "empty-queue"));
});

test("deriveNeeds folds in blocked tasks, proposed issues, compass findings and PRs awaiting review", () => {
  const needs = deriveNeeds({
    blockedTasks: [{ id: "flow-0001", title: "Stuck", blocked_reason: "needs a call" }],
    proposedIssues: [{ title: "New idea", html_url: "https://x/i1" }],
    compassIssues: [{ title: "Drift found", html_url: "https://x/i2" }],
    awaitingReviewPRs: [{ title: "Fix", html_url: "https://x/p1" }],
    readyCount: 1,
  });
  const types = needs.map((n) => n.type).sort();
  assert.deepEqual(types, ["blocked-task", "compass-finding", "pr-review", "proposed-issue"]);
});

// ── fetchRepoFiles — directory batching over the fake io ───────────────────────────────────

test("fetchRepoFiles reads every task and workflow file, and treats a missing VISION.md as absence", async () => {
  const io = fakeIO([
    ["/repos/o/r/contents/.flow/tasks", [
      { name: "flow-0001.md", type: "file" },
      { name: "_TEMPLATE.md", type: "file" }, // must be skipped
    ]],
    ["/repos/o/r/contents/.flow/tasks/flow-0001.md", { content: b64('---\nid: "flow-0001"\nstatus: "ready"\npriority: 1\n---\n') }],
    ["/repos/o/r/contents/.github/workflows", [{ name: "gates.yml", type: "file" }]],
    ["/repos/o/r/contents/.github/workflows/gates.yml", { content: b64("on:\n  pull_request:\n    branches: [main]\n") }],
    ["/repos/o/r/contents/VISION.md", notFound()],
  ]);
  const budget = createBudget(20);
  const files = await fetchRepoFiles({ io, budget, fullName: "o/r" });
  assert.equal(files.taskFiles.length, 1);
  assert.equal(files.workflowFiles.length, 1);
  assert.equal(files.workflowFiles[0].name, "gates.yml");
  assert.equal(files.visionText, null);
  assert.equal(budget.used(), 5); // 2 listings + 1 task file + 1 workflow file + 1 VISION attempt
});

// ── loadRepoRow — the full per-repo derivation over a fake io ──────────────────────────────

function buildHappyPathIO() {
  const taskReady = `---\nid: "flow-0002"\ntitle: "Ship it"\nstatus: "ready"\npriority: 1\nserves: ["G1"]\n---\n`;
  const taskBlocked = `---\nid: "flow-0003"\ntitle: "Stuck"\nstatus: "blocked"\npriority: 2\nblocked_reason: "needs a call"\nserves: ["G1"]\n---\n`;
  const scheduledYaml = `on:\n  schedule:\n    - cron: "0 */6 * * *"\n  workflow_dispatch:\n`;
  const eventYaml = `on:\n  pull_request:\n    branches: [main]\n`;
  const vision = `# Vision\n\nPurpose text.\n\n## Goals\n\n### G1 — Ship things\n\n## Non-goals\n\n## Retired\n\n## Change log\n\n| Date | Change | Why |\n|---|---|---|\n| 2026-08-18 | Initial. | Anchor. |\n`;

  return fakeIO([
    ["/repos/o/r", { full_name: "o/r" }],
    ["/repos/o/r/contents/.flow/tasks", [{ name: "flow-0002.md", type: "file" }, { name: "flow-0003.md", type: "file" }]],
    ["/repos/o/r/contents/.flow/tasks/flow-0002.md", { content: b64(taskReady) }],
    ["/repos/o/r/contents/.flow/tasks/flow-0003.md", { content: b64(taskBlocked) }],
    ["/repos/o/r/contents/.github/workflows", [{ name: "flow-gates.yml", type: "file" }, { name: "flow-recover.yml", type: "file" }]],
    ["/repos/o/r/contents/.github/workflows/flow-gates.yml", { content: b64(eventYaml) }],
    ["/repos/o/r/contents/.github/workflows/flow-recover.yml", { content: b64(scheduledYaml) }],
    ["/repos/o/r/contents/VISION.md", { content: b64(vision) }],
    ["/repos/o/r/actions/workflows?per_page=100", { workflows: [
      { id: 1, name: "flow-gates", path: ".github/workflows/flow-gates.yml", state: "active" },
      { id: 2, name: "flow-recover", path: ".github/workflows/flow-recover.yml", state: "active" },
    ] }],
    [/\/repos\/o\/r\/actions\/workflows\/1\/runs/, { workflow_runs: [{ conclusion: "success", head_sha: "sha-gated" }] }],
    [/\/repos\/o\/r\/actions\/workflows\/2\/runs/, { workflow_runs: [{ run_started_at: new Date().toISOString() }] }],
    // head.sha matches the gate's run (it's what the gate actually ran against); merge_commit_sha
    // is deliberately DIFFERENT and unmatched, as it always is on real GitHub data — a merge
    // commit is created after merge, so no gate run is ever triggered against it.
    [/\/repos\/o\/r\/pulls\?state=closed/, [
      { title: "[flow-0002] Ship it", merged_at: new Date().toISOString(), merge_commit_sha: "sha-post-merge-commit", head: { sha: "sha-gated" } },
    ]],
    [/\/repos\/o\/r\/pulls\?state=open/, [{ title: "[flow-0004] Review me", draft: false, html_url: "https://x/pr9" }]],
    [/\/repos\/o\/r\/issues\?labels=proposed/, [{ title: "Proposed idea", html_url: "https://x/i1" }]],
    [/\/repos\/o\/r\/issues\?labels=compass/, []],
  ]);
}

test("loadRepoRow: a healthy repo comes back ok with moving/next/needs/machinery/vision all populated", async () => {
  const io = buildHappyPathIO();
  const budget = createBudget(50);
  const now = Date.now();
  const row = await loadRepoRow({ io, budget, fullName: "o/r", desc: "a repo", now });

  assert.equal(row.status, "ok");
  assert.equal(row.name, "o/r");
  assert.equal(row.moving.length, 0); // nothing in_progress/in_review in the fixture
  assert.equal(row.next[0].id, "flow-0002");
  assert.equal(row.nextMore, 0);
  assert.ok(row.needs.some((n) => n.type === "blocked-task" && n.id === "flow-0003"));
  assert.ok(row.needs.some((n) => n.type === "proposed-issue"));
  assert.ok(row.needs.some((n) => n.type === "pr-review"));
  assert.equal(row.machinery.length, 3); // gates (event) + recover (scheduled) + merges-vs-gate-runs
  assert.ok(row.machinery.every((m) => m.state)); // never a blank cell
  assert.equal(row.machinery.find((m) => m.name === "merges vs gate runs").state, "good"); // sha-gated is covered
  assert.equal(row.vision.purpose, "Purpose text.");
  assert.equal(row.vision.goals[0].id, "G1");
  assert.equal(row.vision.goals[0].activity.doneIn30d, 1); // flow-0002 merged within window, serves G1
  assert.equal(row.detail && typeof row.detail, "object");
  assert.deepEqual(row.detail, {}); // the judgment slot ships empty
});

test("loadRepoRow: an ungated merge is reported crit, naming the count", async () => {
  const io = buildHappyPathIO();
  // Replace the closed-PR route with one whose merge SHA never appears in the gate's runs.
  const origRest = io.rest.bind(io);
  io.rest = async (path) => (/\/pulls\?state=closed/.test(path)
    ? [{ title: "[flow-0002] Ship it", merged_at: new Date().toISOString(), merge_commit_sha: "sha-also-not-gated", head: { sha: "sha-NOT-gated" } }]
    : origRest(path));
  const budget = createBudget(50);
  const row = await loadRepoRow({ io, budget, fullName: "o/r", desc: "", now: Date.now() });
  const m = row.machinery.find((x) => x.name === "merges vs gate runs");
  assert.equal(m.state, "crit");
  assert.equal(m.count, 1);
});

test("loadRepoRow: ungated-merge detection matches on head.sha, not merge_commit_sha — the two differ on real GitHub data", async () => {
  const io = buildHappyPathIO();
  const origRest = io.rest.bind(io);
  // A merge_commit_sha that coincidentally matches a gate run's head_sha ("sha-gated") must NOT
  // read as gated — the gate never ran against a merge commit. Only head.sha, which genuinely was
  // NOT gated here, may decide the verdict.
  io.rest = async (path) => (/\/pulls\?state=closed/.test(path)
    ? [{ title: "[flow-0002] Ship it", merged_at: new Date().toISOString(), merge_commit_sha: "sha-gated", head: { sha: "sha-NOT-gated" } }]
    : origRest(path));
  const budget = createBudget(50);
  const row = await loadRepoRow({ io, budget, fullName: "o/r", desc: "", now: Date.now() });
  const m = row.machinery.find((x) => x.name === "merges vs gate runs");
  assert.equal(m.state, "crit", "preferring merge_commit_sha over head.sha would have wrongly reported this as gated");
});

test("loadRepoRow: a repo with no VISION.md renders vision: null, not an error", async () => {
  const io = buildHappyPathIO();
  const origRest = io.rest.bind(io);
  io.rest = async (path) => (path === "/repos/o/r/contents/VISION.md" ? Promise.reject(notFound(path)) : origRest(path));
  const row = await loadRepoRow({ io, budget: createBudget(50), fullName: "o/r", desc: "", now: Date.now() });
  assert.equal(row.status, "ok");
  assert.equal(row.vision, null);
});

test("loadRepoRow: an unreachable repo is reported unavailable with a reason, never thrown or dropped", async () => {
  const io = fakeIO([["/repos/o/gone", notFound("/repos/o/gone")]]);
  const row = await loadRepoRow({ io, budget: createBudget(50), fullName: "o/gone", desc: "", now: Date.now() });
  assert.equal(row.status, "unavailable");
  assert.ok(row.reason && row.reason.length > 0);
});

test("loadRepoRow: gate-run SHAs accumulate across multiple gate-named workflows, never overwrite", async () => {
  const eventYaml = `on:\n  pull_request:\n    branches: [main]\n`;
  const io = fakeIO([
    ["/repos/o/r", { full_name: "o/r" }],
    ["/repos/o/r/contents/.flow/tasks", []],
    ["/repos/o/r/contents/.github/workflows", [{ name: "flow-gates-a.yml", type: "file" }, { name: "flow-gates-b.yml", type: "file" }]],
    ["/repos/o/r/contents/.github/workflows/flow-gates-a.yml", { content: b64(eventYaml) }],
    ["/repos/o/r/contents/.github/workflows/flow-gates-b.yml", { content: b64(eventYaml) }],
    ["/repos/o/r/contents/VISION.md", notFound()],
    ["/repos/o/r/actions/workflows?per_page=100", { workflows: [
      { id: 1, name: "flow-gates-a", path: ".github/workflows/flow-gates-a.yml", state: "active" },
      { id: 2, name: "flow-gates-b", path: ".github/workflows/flow-gates-b.yml", state: "active" },
    ] }],
    [/\/repos\/o\/r\/actions\/workflows\/1\/runs/, { workflow_runs: [{ conclusion: "success", head_sha: "sha-from-gate-a" }] }],
    [/\/repos\/o\/r\/actions\/workflows\/2\/runs/, { workflow_runs: [{ conclusion: "success", head_sha: "sha-from-gate-b" }] }],
    // Merged only against gate-a's run — lost entirely if gate-b's processing overwrote gateRunShas.
    [/\/repos\/o\/r\/pulls\?state=closed/, [{ title: "[flow-0002] Ship it", merged_at: new Date().toISOString(), head: { sha: "sha-from-gate-a" } }]],
    [/\/repos\/o\/r\/pulls\?state=open/, []],
    [/\/repos\/o\/r\/issues/, []],
  ]);
  const row = await loadRepoRow({ io, budget: createBudget(50), fullName: "o/r", desc: "", now: Date.now() });
  const m = row.machinery.find((x) => x.name === "merges vs gate runs");
  assert.equal(m.state, "good", "gate-a's run must still count after gate-b is also processed");
});

test("loadRepoRow: a disabled workflow reports off, never a blank cell", async () => {
  const io = buildHappyPathIO();
  const origRest = io.rest.bind(io);
  io.rest = async (path) => {
    if (path === "/repos/o/r/actions/workflows?per_page=100") {
      return {
        workflows: [
          { id: 1, name: "flow-gates", path: ".github/workflows/flow-gates.yml", state: "disabled_manually" },
          { id: 2, name: "flow-recover", path: ".github/workflows/flow-recover.yml", state: "active" },
        ],
      };
    }
    return origRest(path);
  };
  const row = await loadRepoRow({ io, budget: createBudget(50), fullName: "o/r", desc: "", now: Date.now() });
  const gate = row.machinery.find((m) => m.name === "flow-gates");
  assert.equal(gate.state, "off");
});

// ── loadMissionControl — discovery, sort order, truncation, unavailable repos ──────────────

test("loadMissionControl sorts critical repos above attention above quiet", async () => {
  const io = fakeIO([
    ["/search/repositories?q=" + encodeURIComponent(buildDiscoveryQuery("o")) + "&per_page=100", {
      items: [{ full_name: "o/quiet", description: "" }, { full_name: "o/critical", description: "" }],
    }],
    ["/repos/o/quiet", {}],
    ["/repos/o/quiet/contents/.flow/tasks", []],
    ["/repos/o/quiet/contents/.github/workflows", []],
    ["/repos/o/quiet/contents/VISION.md", notFound()],
    ["/repos/o/quiet/actions/workflows?per_page=100", { workflows: [] }],
    [/\/repos\/o\/quiet\/pulls/, []],
    [/\/repos\/o\/quiet\/issues/, []],
    ["/repos/o/critical", {}],
    ["/repos/o/critical/contents/.flow/tasks", []],
    ["/repos/o/critical/contents/.github/workflows", [{ name: "flow-gates.yml", type: "file" }]],
    ["/repos/o/critical/contents/.github/workflows/flow-gates.yml", { content: b64("on:\n  pull_request:\n    branches: [main]\n") }],
    ["/repos/o/critical/contents/VISION.md", notFound()],
    ["/repos/o/critical/actions/workflows?per_page=100", { workflows: [{ id: 9, name: "flow-gates", path: ".github/workflows/flow-gates.yml", state: "active" }] }],
    [/\/repos\/o\/critical\/actions\/workflows\/9\/runs/, { workflow_runs: [{ conclusion: "failure" }] }],
    [/\/repos\/o\/critical\/pulls/, []],
    [/\/repos\/o\/critical\/issues/, []],
  ]);
  const doc = await loadMissionControl({ io, owner: "o", now: Date.now() });
  assert.deepEqual(doc.repos.map((r) => r.name), ["o/critical", "o/quiet"]);
  assert.equal(doc.truncated, null);
});

test("loadMissionControl: exceeding the request ceiling truncates visibly rather than silently dropping repos", async () => {
  const io = fakeIO([
    ["/search/repositories?q=" + encodeURIComponent(buildDiscoveryQuery("o")) + "&per_page=100", {
      items: [{ full_name: "o/a", description: "" }, { full_name: "o/b", description: "" }],
    }],
    [/\/repos\/o\/[ab]$/, {}],
    [/\/repos\/o\/[ab]\/contents\/.flow\/tasks/, []],
    [/\/repos\/o\/[ab]\/contents\/.github\/workflows/, []],
    [/\/repos\/o\/[ab]\/contents\/VISION.md/, notFound()],
    [/\/repos\/o\/[ab]\/actions\/workflows/, { workflows: [] }],
    [/\/repos\/o\/[ab]\/pulls/, []],
    [/\/repos\/o\/[ab]\/issues/, []],
  ]);
  // Budget for the search call plus one full repo's worth of calls, not two.
  const budget = createBudget(6);
  const doc = await loadMissionControl({ io, owner: "o", budget, now: Date.now() });
  assert.ok(doc.truncated, "expected a visible truncation notice");
  assert.ok(doc.truncated.count >= 1);
  assert.equal(doc.requestCount, budget.used());
  assert.ok(doc.requestCount <= budget.max);
});

test("loadMissionControl: a repo whose fetch fails appears explicitly unavailable, not silently omitted", async () => {
  const io = fakeIO([
    ["/search/repositories?q=" + encodeURIComponent(buildDiscoveryQuery("o")) + "&per_page=100", { items: [{ full_name: "o/broken", description: "" }] }],
    ["/repos/o/broken", notFound()],
  ]);
  const doc = await loadMissionControl({ io, owner: "o", now: Date.now() });
  assert.equal(doc.repos.length, 1);
  assert.equal(doc.repos[0].status, "unavailable");
});

// ── render — the actual page HTML, exercised and asserted, not just scanned for absence ────
// The QA gate's own finding on this task (flow-0019): moving the templating out of index.html's
// <script> block into this file is only real if something calls it with data and checks the
// output — a source-presence scan proves the code exists, not that it renders correctly.

test("renderUnavailableRow names the repo and the reason", () => {
  const html = renderUnavailableRow({ name: "o/gone", reason: "404: /repos/o/gone" });
  assert.match(html, /o\/gone/);
  assert.match(html, /404: \/repos\/o\/gone/);
});

test("renderRepoRow renders all four question columns with their real content", () => {
  const row = {
    name: "o/r", desc: "a repo", severity: "attention",
    moving: [{ id: "flow-0001", title: "In flight", status: "in_progress" }],
    next: [{ id: "flow-0002", title: "Next up" }], nextMore: 2,
    needs: [{ type: "blocked-task", title: "Stuck task" }, { type: "pr-review", title: "Review me", url: "https://x/pr1" }],
    machinery: [{ name: "flow-gates", state: "good" }, { name: "flow-recover", state: "warn", reason: "running late" }],
    vision: null,
  };
  const html = renderRepoRow(row);
  assert.match(html, /What's moving/);
  assert.match(html, /In flight/);
  assert.match(html, /What's next/);
  assert.match(html, /Next up/);
  assert.match(html, /\+2 more ready/);
  assert.match(html, /What needs you/);
  assert.match(html, /Stuck task/);
  assert.match(html, /href="https:\/\/x\/pr1"/);
  assert.match(html, /Machinery/);
  assert.match(html, /flow-gates/);
  assert.match(html, /m-good/);
  assert.match(html, /m-warn/);
  assert.match(html, /sev-attention/);
  assert.doesNotMatch(html, /class="vision"/, "no vision drawer when the row has none");
});

test("renderRepoRow shows explicit empty states, never a blank column", () => {
  const html = renderRepoRow({
    name: "o/r", desc: "", severity: "quiet",
    moving: [], next: [], nextMore: 0, needs: [], machinery: [], vision: null,
  });
  assert.match(html, /Nothing in flight\./);
  assert.match(html, /Ready queue is empty\./);
  assert.match(html, /Nothing waiting on you\./);
});

test("renderRepoRow includes the vision drawer only when the row carries one", () => {
  const html = renderRepoRow({ ...VISION_FIXTURE, desc: "", severity: "quiet", moving: [], next: [], nextMore: 0, needs: [], machinery: [] });
  assert.match(html, /class="vision"/);
  assert.match(html, /Ship things/);
});

test("renderRepoRow/renderUnavailableRow escape hostile data from the GitHub API — no raw HTML injection", () => {
  const html = renderRepoRow({
    name: "<img src=x onerror=alert(1)>", desc: "<script>evil()</script>", severity: "quiet",
    moving: [], next: [], nextMore: 0,
    needs: [{ type: "pr-review", title: "<b>hi</b>", url: "javascript:alert(1)" }],
    machinery: [], vision: null,
  });
  assert.doesNotMatch(html, /<img src=x/);
  assert.doesNotMatch(html, /<script>evil/);
  assert.doesNotMatch(html, /<b>hi<\/b>/);
  assert.match(html, /&lt;img/);
  assert.match(html, /&lt;script&gt;/);
});

test("renderMissionControlHTML preserves doc.repos' own order (needs-you-first, already sorted upstream)", () => {
  const doc = {
    owner: "o", repos: [
      { status: "ok", name: "o/first", desc: "", severity: "critical", moving: [], next: [], nextMore: 0, needs: [], machinery: [], vision: null },
      { status: "ok", name: "o/second", desc: "", severity: "quiet", moving: [], next: [], nextMore: 0, needs: [], machinery: [], vision: null },
      { status: "unavailable", name: "o/third", reason: "boom" },
    ], truncated: null,
  };
  const html = renderMissionControlHTML(doc);
  const iFirst = html.indexOf("o/first"), iSecond = html.indexOf("o/second"), iThird = html.indexOf("o/third");
  assert.ok(iFirst > -1 && iSecond > iFirst && iThird > iSecond, "render order must match doc.repos order");
});

test("renderMissionControlHTML shows the truncation banner naming the count and reason, and an explicit empty state", () => {
  const truncated = renderMissionControlHTML({ owner: "o", repos: [], truncated: { count: 2, reason: "request ceiling (10) reached", repos: ["o/a", "o/b"] } });
  assert.match(truncated, /2 repo\(s\) not loaded/);
  assert.match(truncated, /request ceiling \(10\) reached/);
  assert.match(truncated, /o\/a, o\/b/);

  const empty = renderMissionControlHTML({ owner: "o", repos: [], truncated: null });
  assert.match(empty, /No repos carrying the.*flow.*topic were found for o/);
});

test("statusLineText reports the request count against the documented ceiling", () => {
  assert.match(statusLineText({ requestCount: 42, requestCeiling: 900 }), /42\/900 requests/);
});

test("renderErrorBannerHTML escapes the error message", () => {
  assert.doesNotMatch(renderErrorBannerHTML(new Error("<script>x</script>")), /<script>x<\/script>/);
  assert.match(renderErrorBannerHTML(new Error("Paste a read-only PAT first.")), /Paste a read-only PAT first\./);
});

// ── the write-call scan — "makes no write calls" is asserted, not documented ───────────────
//
// A blunt word-boundary scan for "POST" also flags this very file's own prose explaining why
// POST is avoided (see mission-control.mjs's module comment), so the scan targets the actual
// code SHAPES a write call takes — a fetch/XHR method literal or an HTTP-client verb call —
// rather than the bare word. Still mechanical (a regex, no judgment), just precise enough not
// to trip on a comment that mentions the word.
const WRITE_METHOD_USAGE = /method\s*[:=]\s*["'`](POST|PUT|PATCH|DELETE)["'`]|\.open\s*\(\s*["'`](POST|PUT|PATCH|DELETE)["'`]|\.(post|put|patch|delete)\s*\(/i;

test("no write-capable API call (POST/PATCH/PUT/DELETE) appears anywhere in the mission-control source", () => {
  const src = readFileSync(join(BIN, "mission-control.mjs"), "utf8");
  assert.doesNotMatch(src, WRITE_METHOD_USAGE, "a write-capable HTTP method call appears in mission-control.mjs");
});

test("no write-capable API call appears anywhere in liveness.mjs", () => {
  const src = readFileSync(join(BIN, "liveness.mjs"), "utf8");
  assert.doesNotMatch(src, WRITE_METHOD_USAGE, "a write-capable HTTP method call appears in liveness.mjs");
});

test("no write-capable API call appears anywhere in flightdeck/index.html", () => {
  const html = readFileSync(join(BIN, "..", "index.html"), "utf8");
  assert.doesNotMatch(html, WRITE_METHOD_USAGE, "a write-capable HTTP method call appears in index.html");
});

const VISION_FIXTURE = {
  name: "o/r",
  vision: {
    purpose: "Purpose text.",
    goals: [{ id: "G1", title: "Ship things", activity: { doneIn30d: 2, readyCount: 1, lastMerged: "2026-08-20T00:00:00Z" } }],
    nonGoals: [{ id: "NG1", title: "Not a platform", reason: "no daemon" }],
    changelog: [{ date: "2026-08-18", change: "Initial.", why: "Anchor." }],
  },
};

test("renderVisionDrawer's only action is a link to propose a change — no edit affordance", () => {
  const html = renderVisionDrawer(VISION_FIXTURE);
  assert.match(html, /Propose a \[vision\] change on GitHub/, "no propose-a-change link in the vision drawer");
  assert.match(html, /href="https:\/\/github\.com\/o\/r\/edit\/main\/VISION\.md"/);
  assert.doesNotMatch(html, /<input|<textarea|<button|contenteditable/i, "the vision drawer offers an edit affordance, which ADR-0002 Amendment 1 forbids");
});

test("renderVisionDrawer shows purpose, each goal's activity line, non-goals with reasons, and the change log", () => {
  const html = renderVisionDrawer(VISION_FIXTURE);
  assert.match(html, /Purpose text\./);
  assert.match(html, /G1/);
  assert.match(html, /2 done in 30d/);
  assert.match(html, /1 ready/);
  assert.match(html, /NG1/);
  assert.match(html, /no daemon/);
  assert.match(html, /Initial\./);
  assert.doesNotMatch(html, /%|percent|progress/i, "activity is counts, never a percent-complete");
});
