// The five guardrails from the Shepherd screen, each backed by the strongest
// evidence the instance can actually provide. Where a licensed feature is
// missing, the guardrail reports what it *can* prove and says what it cannot —
// it never claims enforcement it does not have.

import { isAvailable, unavailableReason } from "./capabilities.js";

// Node types the data boundary forbids outright. n8n's node type policy can
// enforce this server-side; Flock reports whether that policy is actually in
// place, because a guardrail that only exists in a dashboard is not a guardrail.
export const FORBIDDEN_NODE_TYPES = [
  "n8n-nodes-base.shopify",
  "n8n-nodes-base.shopifyTrigger"
];

// Reads the composed instance policy and reports whether each forbidden type is
// denied. n8n evaluates rules in order, so the last matching rule wins.
export function evaluateNodePolicy(policy) {
  if (!policy) return { configured: false, denied: [], allowed: FORBIDDEN_NODE_TYPES.slice() };
  const rules = Array.isArray(policy.rules) ? policy.rules : [];
  const defaultAction = policy.defaultAction || "allow";

  const denied = [];
  const allowed = [];
  for (const type of FORBIDDEN_NODE_TYPES) {
    let action = defaultAction;
    for (const rule of rules) {
      if (ruleMatches(rule, type)) action = rule.action;
    }
    if (action === "deny") denied.push(type);
    else allowed.push(type);
  }
  return {
    configured: rules.length > 0 || defaultAction !== "allow",
    version: policy.version ?? 0,
    defaultAction,
    ruleCount: rules.length,
    denied,
    allowed
  };
}

function ruleMatches(rule, type) {
  const sel = rule && rule.selector;
  if (!sel) return false;
  if (sel.kind === "name") return sel.value === type;
  if (sel.kind === "prefix") return type.startsWith(sel.value);
  if (sel.kind === "regex") {
    try {
      return new RegExp(sel.value).test(type);
    } catch {
      return false;
    }
  }
  return false;
}

// The Tests guardrail. n8n's evaluation feature stores test runs per workflow;
// a workflow with no completed run has no evidence behind it.
export function summariseEvaluation(testRuns) {
  if (!Array.isArray(testRuns)) return { state: "unknown", total: 0, passed: 0, failed: 0 };
  const completed = testRuns.filter((r) => r.status === "completed");
  const failed = testRuns.filter((r) => r.status === "error");
  const running = testRuns.filter((r) => r.status === "running" || r.status === "new");
  if (testRuns.length === 0) return { state: "none", total: 0, passed: 0, failed: 0, running: 0 };
  if (failed.length > 0) return { state: "failing", total: testRuns.length, passed: completed.length, failed: failed.length, running: running.length };
  if (running.length > 0) return { state: "running", total: testRuns.length, passed: completed.length, failed: 0, running: running.length };
  return { state: "passing", total: testRuns.length, passed: completed.length, failed: 0, running: 0 };
}

// n8n's own security audit returns a report keyed by category. Flock folds it
// into the same finding shape the secret scanner produces so the screen has one
// list, and keeps the source visible.
export function normaliseAuditReport(report) {
  if (!report || typeof report !== "object") return [];
  const findings = [];
  for (const [category, section] of Object.entries(report)) {
    if (!section || typeof section !== "object") continue;
    const sections = Array.isArray(section.sections) ? section.sections : [];
    for (const item of sections) {
      findings.push({
        source: "n8n audit",
        category: section.risk || category,
        title: item.title || category,
        description: item.description || "",
        recommendation: item.recommendation || "",
        severity: item.severity || null
      });
    }
  }
  return findings;
}

// Builds the five guardrail cards. `caps` is the capability map, so each card
// can state whether its backing feature is licensed on this instance.
export function buildGuardrails({ caps, findings, loopFindings, failures, nodePolicy, evaluation, auditFindings }) {
  const cards = [];
  const why = (key) => describeUnavailable(caps, key);

  // 1. Security scan — Flock's own scanner, always available.
  const auditAvailable = isAvailable(caps, "securityAudit");
  const auditCount = Array.isArray(auditFindings) ? auditFindings.length : 0;
  cards.push({
    key: "security",
    title: "Security scan",
    detail: "No pasted passwords or keys. Logins live in the vault and the workflow only points at them.",
    status: findings.length === 0 && auditCount === 0 ? "pass" : "fail",
    count: findings.length + auditCount,
    evidence: [
      `${findings.length} secret literal${findings.length === 1 ? "" : "s"} in nodes`,
      auditAvailable
        ? `${auditCount} finding${auditCount === 1 ? "" : "s"} from n8n's own audit`
        : `n8n audit ${why("securityAudit")}`
    ]
  });

  // 2. Failure alerts — from execution history, always available.
  cards.push({
    key: "alerts",
    title: "Failure alerts",
    detail: "The owner hears on the first failure, with the step and the error. Repeats are grouped, not spammed.",
    status: failures.length === 0 ? "pass" : "warn",
    count: failures.length,
    evidence: [`${failures.length} workflow${failures.length === 1 ? "" : "s"} with grouped failures`]
  });

  // 3. Loop guard — from execution history, always available.
  cards.push({
    key: "loop",
    title: "Loop guard",
    detail: "Pauses anything that triggers itself, runs over 60 times a minute, or passes its spend cap.",
    status: loopFindings.length === 0 ? "pass" : "fail",
    count: loopFindings.length,
    evidence: [`${loopFindings.length} workflow${loopFindings.length === 1 ? "" : "s"} over the limit`]
  });

  // 4. Data boundary — real only if n8n's node policy denies the write types.
  const policyAvailable = isAvailable(caps, "nodePolicies");
  const policy = nodePolicy || { configured: false, denied: [], allowed: FORBIDDEN_NODE_TYPES };
  const enforced = policyAvailable && policy.allowed.length === 0;
  cards.push({
    key: "boundary",
    title: "Data boundary",
    detail: "Your own data: go. Company data: read-only. Writing to it waits for an admin's approval.",
    status: !policyAvailable ? "unknown" : enforced ? "pass" : "warn",
    count: policy.allowed.length,
    evidence: !policyAvailable
      ? [`node type policy ${why("nodePolicies")} — not enforced by n8n`]
      : enforced
        ? [`n8n denies ${policy.denied.length} write node type${policy.denied.length === 1 ? "" : "s"} server-side`]
        : [`n8n still allows: ${policy.allowed.join(", ")}`]
  });

  // 5. Tests — real only if evaluation is licensed and has runs.
  const evalAvailable = isAvailable(caps, "evaluation");
  const ev = evaluation || { state: "unknown", total: 0 };
  cards.push({
    key: "tests",
    title: "Tests",
    detail: "Shepherd saves a few real runs as tests. A change has to pass them before it goes live.",
    status: !evalAvailable ? "unknown" : ev.state === "failing" ? "fail" : ev.state === "none" ? "warn" : "pass",
    count: ev.failed || 0,
    evidence: !evalAvailable
      ? [`evaluation ${why("evaluation")}`]
      : [`${ev.total} test run${ev.total === 1 ? "" : "s"} · ${ev.passed} passed · ${ev.failed} failed`]
  });

  return cards;
}

// Turns a capability's raw state into a sentence a person can act on.
export function describeUnavailable(caps, key) {
  const entry = caps && caps[key];
  if (!entry) return "is unknown";
  if (entry.available) return "is available";
  switch (entry.reason) {
    case "unlicensed":
      return "is not in this instance's licence";
    case "missing-scope":
      return entry.scope
        ? `is unreachable — the n8n API key needs the ${entry.scope} scope`
        : "is unreachable — the n8n API key lacks the needed scope";
    case "not-testable":
      return "cannot be checked yet (no workflow to probe)";
    case "unauthorized":
      return "is unauthorized — check the n8n API key";
    case "not-found":
      return "is not present on this instance";
    case "error":
      return "could not be checked (connection error)";
    default:
      return `is ${unavailableReason(caps, key)}`;
  }
}
