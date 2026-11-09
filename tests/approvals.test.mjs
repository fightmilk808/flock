import { test } from "node:test";
import assert from "node:assert/strict";
import { openStore } from "../web/lib/approvals.js";

function store() {
  return openStore(":memory:");
}

function make(s, overrides = {}) {
  return s.createApproval({
    id: "a1",
    workflowId: "wf1",
    workflowName: "Update stock",
    requestedBy: "Jo",
    reason: "writes on-hand counts",
    risk: "writes-company-data",
    createdAt: "2026-11-02T12:00:00Z",
    ...overrides
  });
}

test("creates a pending approval and lists it", () => {
  const s = store();
  make(s);
  const pending = s.pending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].status, "pending");
  assert.equal(pending[0].workflow_name, "Update stock");
  s.close();
});

test("approving moves it out of the pending list", () => {
  const s = store();
  make(s);
  const row = s.decide({ id: "a1", status: "approved", decidedBy: "Sam", at: "2026-11-02T13:00:00Z" });
  assert.equal(row.status, "approved");
  assert.equal(row.decided_by, "Sam");
  assert.equal(s.pending().length, 0);
  s.close();
});

test("a second decision on the same approval is refused", () => {
  const s = store();
  make(s);
  s.decide({ id: "a1", status: "approved", decidedBy: "Sam", at: "2026-11-02T13:00:00Z" });
  const again = s.decide({ id: "a1", status: "denied", decidedBy: "Sam", at: "2026-11-02T13:01:00Z" });
  assert.equal(again, false);
  assert.equal(s.get("a1").status, "approved");
  s.close();
});

test("deciding an unknown approval returns false", () => {
  const s = store();
  assert.equal(s.decide({ id: "nope", status: "approved", decidedBy: "A", at: "x" }), false);
  s.close();
});

test("every decision is written to the audit log", () => {
  const s = store();
  make(s);
  s.decide({ id: "a1", status: "denied", decidedBy: "Sam", note: "use your own sheet", at: "2026-11-02T13:00:00Z" });
  const log = s.auditLog();
  const actions = log.map((r) => r.action);
  assert.ok(actions.includes("approval.requested"));
  assert.ok(actions.includes("approval.denied"));
  const denied = log.find((r) => r.action === "approval.denied");
  assert.equal(denied.detail, "use your own sheet");
  s.close();
});

test("record writes an arbitrary audit entry", () => {
  const s = store();
  s.record("Sam", "workflow.draft-created", "wf9", "Test draft", "2026-11-02T12:00:00Z");
  const log = s.auditLog();
  assert.equal(log[0].action, "workflow.draft-created");
  assert.equal(log[0].target, "wf9");
  s.close();
});
