import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateNodePolicy,
  summariseEvaluation,
  normaliseAuditReport,
  buildGuardrails,
  describeUnavailable,
  FORBIDDEN_NODE_TYPES
} from "../web/lib/guardrails.js";

function caps(overrides = {}) {
  const base = {
    nodePolicies: { available: true, data: {} },
    credentialPolicies: { available: true, data: {} },
    evaluation: { available: true, data: [] },
    securityAudit: { available: true, data: {} },
    insights: { available: true, data: {} }
  };
  return { ...base, ...overrides };
}

test("evaluateNodePolicy reports nothing denied when the policy is empty", () => {
  const result = evaluateNodePolicy({ defaultAction: "allow", rules: [], version: 0 });
  assert.equal(result.configured, false);
  assert.deepEqual(result.denied, []);
  assert.deepEqual(result.allowed, FORBIDDEN_NODE_TYPES);
});

test("evaluateNodePolicy reports a deny rule as enforced", () => {
  const policy = {
    defaultAction: "allow",
    version: 3,
    rules: FORBIDDEN_NODE_TYPES.map((t, i) => ({
      id: `r${i}`,
      action: "deny",
      selector: { kind: "name", value: t }
    }))
  };
  const result = evaluateNodePolicy(policy);
  assert.equal(result.configured, true);
  assert.equal(result.denied.length, FORBIDDEN_NODE_TYPES.length);
  assert.deepEqual(result.allowed, []);
});

test("evaluateNodePolicy honours a prefix selector", () => {
  const policy = {
    defaultAction: "allow",
    rules: [{ id: "r", action: "deny", selector: { kind: "prefix", value: "n8n-nodes-base.shopify" } }]
  };
  const result = evaluateNodePolicy(policy);
  assert.ok(result.denied.includes("n8n-nodes-base.shopify"));
  assert.ok(result.denied.includes("n8n-nodes-base.shopifyTrigger"));
});

test("evaluateNodePolicy lets a later allow rule override an earlier deny", () => {
  const policy = {
    defaultAction: "allow",
    rules: [
      { id: "a", action: "deny", selector: { kind: "name", value: "n8n-nodes-base.shopify" } },
      { id: "b", action: "allow", selector: { kind: "name", value: "n8n-nodes-base.shopify" } }
    ]
  };
  const result = evaluateNodePolicy(policy);
  assert.ok(result.allowed.includes("n8n-nodes-base.shopify"));
});

test("evaluateNodePolicy treats a deny-by-default policy as denying", () => {
  const result = evaluateNodePolicy({ defaultAction: "deny", rules: [] });
  assert.equal(result.denied.length, FORBIDDEN_NODE_TYPES.length);
});

test("evaluateNodePolicy ignores a malformed regex selector", () => {
  const policy = { defaultAction: "allow", rules: [{ id: "r", action: "deny", selector: { kind: "regex", value: "[" } }] };
  assert.doesNotThrow(() => evaluateNodePolicy(policy));
});

test("summariseEvaluation reports none when there are no runs", () => {
  assert.equal(summariseEvaluation([]).state, "none");
});

test("summariseEvaluation reports failing when a run errored", () => {
  const result = summariseEvaluation([
    { status: "completed" },
    { status: "error" }
  ]);
  assert.equal(result.state, "failing");
  assert.equal(result.failed, 1);
});

test("summariseEvaluation reports passing when all runs completed", () => {
  const result = summariseEvaluation([{ status: "completed" }, { status: "completed" }]);
  assert.equal(result.state, "passing");
  assert.equal(result.passed, 2);
});

test("summariseEvaluation reports running when a run is in flight", () => {
  assert.equal(summariseEvaluation([{ status: "running" }]).state, "running");
});

test("normaliseAuditReport flattens n8n's category sections", () => {
  const report = {
    "Credentials Risk Report": {
      risk: "credentials",
      sections: [
        { title: "Hardcoded secrets", description: "d", recommendation: "r" }
      ]
    }
  };
  const findings = normaliseAuditReport(report);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].title, "Hardcoded secrets");
  assert.equal(findings[0].category, "credentials");
  assert.equal(findings[0].source, "n8n audit");
});

test("normaliseAuditReport tolerates an empty report", () => {
  assert.deepEqual(normaliseAuditReport({}), []);
  assert.deepEqual(normaliseAuditReport(null), []);
});

test("buildGuardrails marks the boundary unknown when node policies are unlicensed", () => {
  const cards = buildGuardrails({
    caps: caps({ nodePolicies: { available: false, reason: "unlicensed" } }),
    findings: [],
    loopFindings: [],
    failures: [],
    nodePolicy: null,
    evaluation: null,
    auditFindings: null
  });
  const boundary = cards.find((c) => c.key === "boundary");
  assert.equal(boundary.status, "unknown");
  assert.match(boundary.evidence[0], /licence/);
});

test("buildGuardrails marks the boundary pass only when n8n denies every write type", () => {
  const cards = buildGuardrails({
    caps: caps(),
    findings: [],
    loopFindings: [],
    failures: [],
    nodePolicy: { configured: true, denied: FORBIDDEN_NODE_TYPES, allowed: [], ruleCount: 2, defaultAction: "allow", version: 1 },
    evaluation: null,
    auditFindings: null
  });
  assert.equal(cards.find((c) => c.key === "boundary").status, "pass");
});

test("buildGuardrails warns when n8n still allows a write type", () => {
  const cards = buildGuardrails({
    caps: caps(),
    findings: [],
    loopFindings: [],
    failures: [],
    nodePolicy: { configured: true, denied: [], allowed: FORBIDDEN_NODE_TYPES, ruleCount: 0, defaultAction: "allow", version: 0 },
    evaluation: null,
    auditFindings: null
  });
  const boundary = cards.find((c) => c.key === "boundary");
  assert.equal(boundary.status, "warn");
  assert.match(boundary.evidence[0], /still allows/);
});

test("buildGuardrails marks tests unknown when evaluation is unlicensed", () => {
  const cards = buildGuardrails({
    caps: caps({ evaluation: { available: false, reason: "unlicensed" } }),
    findings: [],
    loopFindings: [],
    failures: [],
    nodePolicy: null,
    evaluation: null,
    auditFindings: null
  });
  assert.equal(cards.find((c) => c.key === "tests").status, "unknown");
});

test("buildGuardrails fails the security card when the n8n audit finds something", () => {
  const cards = buildGuardrails({
    caps: caps(),
    findings: [],
    loopFindings: [],
    failures: [],
    nodePolicy: null,
    evaluation: null,
    auditFindings: [{ title: "x" }]
  });
  const security = cards.find((c) => c.key === "security");
  assert.equal(security.status, "fail");
  assert.equal(security.count, 1);
});

test("buildGuardrails always returns all five cards", () => {
  const cards = buildGuardrails({
    caps: caps(),
    findings: [],
    loopFindings: [],
    failures: [],
    nodePolicy: null,
    evaluation: null,
    auditFindings: null
  });
  assert.deepEqual(cards.map((c) => c.key), ["security", "alerts", "loop", "boundary", "tests"]);
});

test("describeUnavailable names the missing scope so the fix is actionable", () => {
  const caps = { nodePolicies: { available: false, reason: "missing-scope", scope: "nodeTypePolicy:manage" } };
  assert.match(describeUnavailable(caps, "nodePolicies"), /nodeTypePolicy:manage scope/);
});

test("describeUnavailable distinguishes unlicensed from a missing scope", () => {
  assert.match(describeUnavailable({ x: { available: false, reason: "unlicensed" } }, "x"), /licence/);
  assert.match(describeUnavailable({ x: { available: false, reason: "missing-scope" } }, "x"), /scope/);
});

test("describeUnavailable handles an unknown capability", () => {
  assert.equal(describeUnavailable({}, "nope"), "is unknown");
});
