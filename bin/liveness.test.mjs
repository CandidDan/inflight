// liveness.test.mjs — proving tests for flightdeck/bin/liveness.mjs (flow-0019).
//
// Every acceptance criterion this file is responsible for is proved by name in its test title,
// so `qa-verifier` can map criterion -> test without guessing.

import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyWorkflowTrigger,
  cronIntervalHours,
  eventLiveness,
  extractCronExpressions,
  parseCronExpr,
  repoSeverity,
  scheduledLiveness,
  sortBySeverity,
  ungatedMergesLiveness,
} from "./liveness.mjs";

// ── extractCronExpressions / classifyWorkflowTrigger ───────────────────────────────────────

test("extractCronExpressions reads every cron under on.schedule, ignores everything else", () => {
  const yaml = `
on:
  schedule:
    - cron: "0 */3 * * *"
    - cron: "0 6 * * 1-5"
  workflow_dispatch:
`;
  assert.deepEqual(extractCronExpressions(yaml), ["0 */3 * * *", "0 6 * * 1-5"]);
  assert.deepEqual(extractCronExpressions("on:\n  workflow_dispatch:\n"), []);
});

test("classifyWorkflowTrigger: a cron makes it scheduled even if other triggers are also present", () => {
  const yaml = `on:\n  schedule:\n    - cron: "0 6 * * 1-5"\n  workflow_dispatch:\n`;
  assert.deepEqual(classifyWorkflowTrigger(yaml), { kind: "scheduled", crons: ["0 6 * * 1-5"] });
});

test("classifyWorkflowTrigger: pull_request/push/etc with no schedule is event-triggered", () => {
  assert.equal(classifyWorkflowTrigger("on:\n  pull_request:\n    branches: [main]\n").kind, "event");
  assert.equal(classifyWorkflowTrigger("on:\n  push:\n    branches: [main]\n").kind, "event");
});

test("classifyWorkflowTrigger: workflow_dispatch only is manual, not scheduled or event", () => {
  assert.equal(classifyWorkflowTrigger("on:\n  workflow_dispatch:\n").kind, "manual");
  assert.equal(classifyWorkflowTrigger("").kind, "manual");
});

test("classifyWorkflowTrigger: the array shorthand (on: [push, pull_request]) is still event, not manual", () => {
  assert.equal(classifyWorkflowTrigger("on: [push, pull_request]\n").kind, "event");
  assert.equal(classifyWorkflowTrigger("on: [workflow_dispatch]\n").kind, "manual");
});

// ── cron parsing / interval math ────────────────────────────────────────────────────────────

test("parseCronExpr rejects anything that isn't exactly 5 fields", () => {
  assert.equal(parseCronExpr("0 */3 * * *").minute, "0");
  assert.equal(parseCronExpr("* * * *"), null);       // 4 fields
  assert.equal(parseCronExpr("* * * * * *"), null);   // 6 fields
  assert.equal(parseCronExpr(""), null);
});

test("cronIntervalHours: a 6-hour cron reports exactly 6 — the interval comes from the cron, not a constant", () => {
  assert.equal(cronIntervalHours("0 */6 * * *"), 6);
});

test("cronIntervalHours: an unparseable cron is null, not a guessed number", () => {
  assert.equal(cronIntervalHours("not a cron"), null);
  assert.equal(cronIntervalHours("* * 99 13 *"), null); // parses as 5 fields but never fires
});

test("cronIntervalHours: multiple cron lines union their fire-minutes rather than double-counting overlaps", () => {
  // Same schedule listed twice must report the same interval as listed once.
  assert.equal(cronIntervalHours(["0 */6 * * *", "0 */6 * * *"]), 6);
});

// ── scheduledLiveness — the exact boundary the acceptance criteria name ────────────────────

test("scheduledLiveness: 6h cron, last success 13h ago -> crit (age > 2x interval)", () => {
  const now = Date.parse("2026-08-20T13:00:00Z");
  const r = scheduledLiveness({ crons: "0 */6 * * *", lastSuccessAt: "2026-08-20T00:00:00Z", now, disabled: false });
  assert.equal(r.state, "crit");
  assert.equal(r.intervalHours, 6);
});

test("scheduledLiveness: 6h cron, last success 7h ago -> warn (interval < age <= 2x interval)", () => {
  const now = Date.parse("2026-08-20T07:00:00Z");
  const r = scheduledLiveness({ crons: "0 */6 * * *", lastSuccessAt: "2026-08-20T00:00:00Z", now, disabled: false });
  assert.equal(r.state, "warn");
});

test("scheduledLiveness: 6h cron, last success 3h ago -> good (age <= interval)", () => {
  const now = Date.parse("2026-08-20T03:00:00Z");
  const r = scheduledLiveness({ crons: "0 */6 * * *", lastSuccessAt: "2026-08-20T00:00:00Z", now, disabled: false });
  assert.equal(r.state, "good");
});

test("scheduledLiveness: disabled workflow reports off with a reason, never a blank cell", () => {
  const r = scheduledLiveness({ crons: "0 */6 * * *", lastSuccessAt: null, now: Date.now(), disabled: true });
  assert.equal(r.state, "off");
  assert.ok(r.reason && r.reason.length > 0);
});

test("scheduledLiveness: no successful run ever recorded is crit, not a blank", () => {
  const r = scheduledLiveness({ crons: "0 */6 * * *", lastSuccessAt: null, now: Date.now(), disabled: false });
  assert.equal(r.state, "crit");
  assert.match(r.reason, /no successful run/);
});

test("scheduledLiveness: unparseable cron is crit rather than silently 'good'", () => {
  const r = scheduledLiveness({ crons: "garbage", lastSuccessAt: new Date().toISOString(), now: Date.now(), disabled: false });
  assert.equal(r.state, "crit");
});

// ── eventLiveness ────────────────────────────────────────────────────────────────────────────

test("eventLiveness: latest run failed -> crit", () => {
  assert.equal(eventLiveness({ disabled: false, latestRun: { conclusion: "failure" } }).state, "crit");
});

test("eventLiveness: latest run succeeded -> good", () => {
  assert.equal(eventLiveness({ disabled: false, latestRun: { conclusion: "success" } }).state, "good");
});

test("eventLiveness: disabled -> off with a reason", () => {
  const r = eventLiveness({ disabled: true, latestRun: { conclusion: "failure" } });
  assert.equal(r.state, "off");
  assert.ok(r.reason);
});

test("eventLiveness: never run is good (nothing has failed), not a blank", () => {
  const r = eventLiveness({ disabled: false, latestRun: null });
  assert.equal(r.state, "good");
  assert.ok(r.reason);
});

// ── ungatedMergesLiveness — the named silent killer ────────────────────────────────────────

test("ungatedMergesLiveness: every merged SHA has a gate run -> good", () => {
  const r = ungatedMergesLiveness({ mergedShas: ["a", "b"], gateRunShas: ["a", "b", "c"] });
  assert.equal(r.state, "good");
  assert.equal(r.count, 0);
});

test("ungatedMergesLiveness: a merge with no gate run -> crit, naming the count", () => {
  const r = ungatedMergesLiveness({ mergedShas: ["a", "b", "c"], gateRunShas: ["a"] });
  assert.equal(r.state, "crit");
  assert.equal(r.count, 2);
  assert.match(r.reason, /2 merged with no gate run/);
});

test("ungatedMergesLiveness: no merges in the window -> good, not crit on an empty set", () => {
  assert.equal(ungatedMergesLiveness({ mergedShas: [], gateRunShas: [] }).state, "good");
});

// ── repoSeverity / sortBySeverity — "the sort order IS the triage order" ──────────────────

test("repoSeverity: any crit machinery -> critical, regardless of needsAttention", () => {
  assert.equal(repoSeverity({ machineryStates: ["good", "crit"], needsAttention: false }), "critical");
});

test("repoSeverity: no crit, but something needs a human -> attention", () => {
  assert.equal(repoSeverity({ machineryStates: ["good", "warn", "off"], needsAttention: true }), "attention");
});

test("repoSeverity: no crit and nothing needs a human -> quiet", () => {
  assert.equal(repoSeverity({ machineryStates: ["good", "off"], needsAttention: false }), "quiet");
});

test("sortBySeverity: critical sorts above attention, which sorts above quiet", () => {
  const rows = [{ id: "c", severity: "quiet" }, { id: "a", severity: "critical" }, { id: "b", severity: "attention" }];
  const sorted = sortBySeverity(rows).map((r) => r.id);
  assert.deepEqual(sorted, ["a", "b", "c"]);
});

test("sortBySeverity: is stable — equal-severity rows keep their relative order", () => {
  const rows = [
    { id: "first", severity: "attention" },
    { id: "second", severity: "attention" },
    { id: "third", severity: "critical" },
  ];
  const sorted = sortBySeverity(rows).map((r) => r.id);
  assert.deepEqual(sorted, ["third", "first", "second"]);
});
