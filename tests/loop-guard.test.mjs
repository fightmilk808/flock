import { test } from "node:test";
import assert from "node:assert/strict";
import { analyseExecutions, groupFailures } from "../web/lib/loop-guard.js";

const NOW = Date.parse("2026-11-02T12:00:00Z");

function ex(workflowId, offsetSeconds, status = "success") {
  return {
    id: String(offsetSeconds),
    workflowId,
    status,
    startedAt: new Date(NOW - offsetSeconds * 1000).toISOString()
  };
}

test("flags a workflow that runs more than 60 times in a minute", () => {
  const executions = Array.from({ length: 70 }, (_, i) => ex("wf", i * 0.5));
  const findings = analyseExecutions(executions, { now: NOW });
  const rate = findings.find((f) => f.kind === "rate");
  assert.ok(rate, "expected a rate finding");
  assert.equal(rate.severity, "stop");
});

test("does not flag a workflow running well under the limit", () => {
  const executions = [ex("wf", 10), ex("wf", 600), ex("wf", 1200)];
  assert.deepEqual(analyseExecutions(executions, { now: NOW }), []);
});

test("flags a sustained sub-second cadence as self-triggered", () => {
  const executions = Array.from({ length: 40 }, (_, i) => ex("wf", i * 0.2));
  const findings = analyseExecutions(executions, { now: NOW });
  assert.ok(findings.some((f) => f.kind === "self-trigger"));
});

test("ignores executions that cannot be parsed", () => {
  const executions = [{ id: "x", workflowId: "wf", status: "success", startedAt: "not-a-date" }];
  assert.deepEqual(analyseExecutions(executions, { now: NOW }), []);
});

test("groups repeated failures into one record per workflow", () => {
  const executions = [
    ex("wf1", 10, "error"),
    ex("wf1", 20, "error"),
    ex("wf1", 30, "error"),
    ex("wf2", 40, "success")
  ];
  const groups = groupFailures(executions);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].workflowId, "wf1");
  assert.equal(groups[0].count, 3);
  assert.equal(groups[0].executionIds.length, 3);
});

test("counts crashed executions as failures", () => {
  const groups = groupFailures([ex("wf", 5, "crashed")]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].count, 1);
});

test("returns nothing when every run succeeded", () => {
  assert.deepEqual(groupFailures([ex("wf", 5, "success")]), []);
});

import { runTimeStats } from "../web/lib/loop-guard.js";

test("runTimeStats reports the median, not an average a few long waits can skew", () => {
  const t = (s, ms) => ({ startedAt: new Date(s).toISOString(), stoppedAt: new Date(s + ms).toISOString() });
  const runs = [t(0, 200), t(0, 300), t(0, 400), t(0, 500), t(0, 3 * 3600_000)];
  const r = runTimeStats(runs);
  assert.equal(r.medianMs, 400);
  assert.equal(r.count, 5);
  assert.equal(runTimeStats([{ startedAt: "x" }]), null);
});
