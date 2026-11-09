import { test } from "node:test";
import assert from "node:assert/strict";
import { createCapabilityCache, isAvailable, unavailableReason, ProbeSkip } from "../web/lib/capabilities.js";

function client(overrides = {}) {
  const ok = async () => ({});
  return {
    getNodeTypePolicy: ok,
    getCredentialTypePolicy: ok,
    listTestRuns: ok,
    generateAudit: ok,
    getSourceControlStatus: ok,
    insightsSummary: ok,
    getWorkflowHistory: ok,
    listDataTables: ok,
    ...overrides
  };
}

function licensedError() {
  const err = new Error("Your license does not allow for feat:nodeTypePolicy. To enable it, please upgrade to a license that supports this feature.");
  err.status = 403;
  return err;
}

test("a working endpoint is reported available", async () => {
  const cache = createCapabilityCache();
  const caps = await cache.get(client(), { workflowId: "w1" });
  assert.equal(caps.nodePolicies.available, true);
  assert.equal(caps.insights.available, true);
});

test("a licence 403 is reported as unlicensed, not as an error", async () => {
  const cache = createCapabilityCache();
  const caps = await cache.get(client({ getNodeTypePolicy: async () => { throw licensedError(); } }), { workflowId: "w1" });
  assert.equal(caps.nodePolicies.available, false);
  assert.equal(caps.nodePolicies.reason, "unlicensed");
});

// A bare "Forbidden" is a missing API key scope, which is fixable without a
// licence change. Reporting it as "unlicensed" would send someone to sales
// instead of to Settings → n8n API.
test("a bare 403 is reported as a missing scope, with the scope named", async () => {
  const cache = createCapabilityCache();
  const err = new Error("Forbidden");
  err.status = 403;
  const caps = await cache.get(client({ getNodeTypePolicy: async () => { throw err; } }), { workflowId: "w1" });
  assert.equal(caps.nodePolicies.reason, "missing-scope");
  assert.equal(caps.nodePolicies.scope, "nodeTypePolicy:manage");
});

test("a network error is not mistaken for a licensing problem", async () => {
  const cache = createCapabilityCache();
  const caps = await cache.get(client({ insightsSummary: async () => { throw new Error("ECONNREFUSED"); } }), { workflowId: "w1" });
  assert.equal(caps.insights.available, false);
  assert.equal(caps.insights.reason, "error");
  assert.match(caps.insights.error, /ECONNREFUSED/);
});

test("a workflow-scoped probe without a workflow is not-testable", async () => {
  const cache = createCapabilityCache();
  const caps = await cache.get(client(), {});
  assert.equal(caps.evaluation.available, false);
  assert.equal(caps.evaluation.reason, "not-testable");
});

test("results are cached until the ttl expires", async () => {
  let calls = 0;
  const cache = createCapabilityCache({ ttlMs: 60_000 });
  const c = client({ insightsSummary: async () => { calls += 1; return {}; } });
  await cache.get(c, { workflowId: "w1" });
  await cache.get(c, { workflowId: "w1" });
  assert.equal(calls, 1);
});

test("force re-probes even inside the ttl", async () => {
  let calls = 0;
  const cache = createCapabilityCache({ ttlMs: 60_000 });
  const c = client({ insightsSummary: async () => { calls += 1; return {}; } });
  await cache.get(c, { workflowId: "w1" });
  await cache.get(c, { workflowId: "w1" }, { force: true });
  assert.equal(calls, 2);
});

test("concurrent callers share one probe", async () => {
  let calls = 0;
  const cache = createCapabilityCache();
  const c = client({ insightsSummary: async () => { calls += 1; return {}; } });
  await Promise.all([cache.get(c, { workflowId: "w1" }), cache.get(c, { workflowId: "w1" })]);
  assert.equal(calls, 1);
});

test("isAvailable and unavailableReason read the map", () => {
  const caps = { insights: { available: true }, evaluation: { available: false, reason: "unlicensed" } };
  assert.equal(isAvailable(caps, "insights"), true);
  assert.equal(isAvailable(caps, "evaluation"), false);
  assert.equal(unavailableReason(caps, "evaluation"), "unlicensed");
  assert.equal(unavailableReason(caps, "missing"), "unknown");
});

test("ProbeSkip is distinguishable from a real failure", () => {
  assert.ok(new ProbeSkip("x") instanceof Error);
});
