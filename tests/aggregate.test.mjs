import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRunsMap, buildRecentRuns, buildWorkflowDetail, buildFolderTree, buildPeople, nodeKind, isTriggerType, buildTimeline, logoFor, ownerOf, ownerTagsFrom } from "../web/lib/aggregate.js";

const NOW = Date.parse("2026-11-02T12:00:00Z");

function wf(id, name, tags, extra = {}) {
  return { id, name, active: true, tags: tags.map((t) => ({ name: t })), nodes: [], ...extra };
}

function ex(workflowId, minutesAgo, status = "success") {
  return {
    id: `e-${workflowId}-${minutesAgo}`,
    workflowId,
    status,
    startedAt: new Date(NOW - minutesAgo * 60_000).toISOString()
  };
}

test("buildRunsMap counts runs inside the requested window only", () => {
  const workflows = [wf("w1", "A", ["sys:cin7"])];
  const executions = [ex("w1", 10), ex("w1", 60 * 30)];
  const map = buildRunsMap({ workflows, executions, users: [], tagNames: [], range: "day", now: NOW });
  assert.equal(map.totals.runs, 1, "the 30-hour-old run is outside the 24h window");
});

test("buildRunsMap only lists systems that have workflows", () => {
  const workflows = [wf("w1", "A", ["sys:cin7"])];
  const map = buildRunsMap({ workflows, executions: [], users: [], tagNames: [], now: NOW });
  assert.deepEqual(map.nodes.map((n) => n.label), ["Cin7"]);
});

test("buildRunsMap marks a workflow that writes company data", () => {
  const workflows = [
    wf("w1", "Writer", ["sys:warehouse-db"], {
      nodes: [{ name: "I", type: "n8n-nodes-base.postgres", parameters: { operation: "insert" } }]
    })
  ];
  const map = buildRunsMap({ workflows, executions: [], users: [], tagNames: [], now: NOW });
  assert.equal(map.edges[0].writesCompanyData, true);
});

test("buildRunsMap sorts edges by run volume", () => {
  const workflows = [wf("w1", "Quiet", ["sys:cin7"]), wf("w2", "Busy", ["sys:cin7"])];
  const executions = [ex("w2", 1), ex("w2", 2), ex("w1", 3)];
  const map = buildRunsMap({ workflows, executions, users: [], tagNames: [], now: NOW });
  assert.deepEqual(map.edges.map((e) => e.name), ["Busy", "Quiet"]);
});

test("buildPeople attributes by owner tag when one exists", () => {
  const workflows = [wf("w1", "A", ["Sam", "sys:cin7"]), wf("w2", "B", ["Sam"])];
  const people = buildPeople({ workflows, users: [], tagNames: ["Sam", "sys:cin7"] });
  assert.equal(people.length, 1);
  assert.equal(people[0].name, "Sam");
  assert.equal(people[0].count, 2);
  assert.equal(people[0].source, "owner tag");
});

test("buildPeople falls back to the instance user and says so", () => {
  const workflows = [wf("w1", "A", ["sys:cin7"])];
  const users = [{ firstName: "Sam", lastName: "Rivera", email: "a@b.c" }];
  const people = buildPeople({ workflows, users, tagNames: ["sys:cin7"] });
  assert.equal(people[0].name, "Sam Rivera");
  assert.equal(people[0].source, "instance user");
});

// Regression: the live instance tags workflows "QR" and "cooper", which are
// subjects, not owners. They were being listed as people.
test("buildPeople ignores subject tags that are not owners", () => {
  const workflows = [wf("w1", "A", ["QR", "cooper", "slack", "sys:cin7"])];
  const users = [{ firstName: "Sam", lastName: "Rivera", email: "a@b.c" }];
  const people = buildPeople({ workflows, users, tagNames: ["QR", "cooper", "slack", "sys:cin7"] });
  assert.equal(people.length, 1);
  assert.equal(people[0].name, "Sam Rivera");
});

test("buildRecentRuns maps status to a tone", () => {
  const workflows = [wf("w1", "A", [])];
  const executions = [ex("w1", 1, "success"), ex("w1", 2, "error"), ex("w1", 3, "waiting")];
  const recent = buildRecentRuns({ workflows, executions });
  assert.deepEqual(recent.map((r) => r.tone), ["ok", "stop", "warn"]);
});

test("buildRecentRuns names an unknown workflow rather than dropping it", () => {
  const recent = buildRecentRuns({ workflows: [], executions: [ex("ghost", 1)] });
  assert.match(recent[0].name, /Unknown workflow \(ghost\)/);
});

test("buildWorkflowDetail marks a clean workflow as secretsClean", () => {
  const workflow = wf("w1", "A", ["sys:cin7"], { nodes: [{ name: "T", type: "n8n-nodes-base.webhook", parameters: {} }] });
  const detail = buildWorkflowDetail({ workflow, findings: [], executions: [] });
  assert.equal(detail.secretsClean, true);
  assert.equal(detail.nodes[0].isTrigger, true);
  assert.equal(detail.lastRun, null);
});

test("buildWorkflowDetail surfaces findings for that workflow only", () => {
  const workflow = wf("w1", "A", []);
  const findings = [
    { workflowId: "w1", node: "X", secret: "s" },
    { workflowId: "w2", node: "Y", secret: "s" }
  ];
  const detail = buildWorkflowDetail({ workflow, findings, executions: [] });
  assert.equal(detail.findings.length, 1);
  assert.equal(detail.secretsClean, false);
});

test("buildFolderTree nests children under their parent", () => {
  const folders = [
    { id: "a", name: "Warehouse", parentFolderId: null },
    { id: "b", name: "Receiving", parentFolderId: "a" },
    { id: "c", name: "Cin7", parentFolderId: null }
  ];
  const tree = buildFolderTree(folders);
  assert.deepEqual(tree.map((f) => f.name), ["Cin7", "Warehouse"]);
  assert.equal(tree[1].children[0].name, "Receiving");
});

test("buildFolderTree treats an orphan as a root", () => {
  const tree = buildFolderTree([{ id: "x", name: "Orphan", parentFolderId: "missing" }]);
  assert.equal(tree.length, 1);
  assert.equal(tree[0].name, "Orphan");
});

// Regression: every postgres node was labelled "Write", including SELECTs,
// which misrepresents the data boundary the Shepherd screen promises.
test("nodeKind labels a postgres SELECT as a read", () => {
  assert.equal(nodeKind({ type: "n8n-nodes-base.postgres", parameters: { operation: "select" } }), "Read");
});

test("nodeKind labels a postgres insert as a write", () => {
  assert.equal(nodeKind({ type: "n8n-nodes-base.postgres", parameters: { operation: "insert" } }), "Write");
});

test("nodeKind reads an executeQuery for a write verb", () => {
  assert.equal(
    nodeKind({ type: "n8n-nodes-base.postgres", parameters: { operation: "executeQuery", query: "DELETE FROM x" } }),
    "Write"
  );
  assert.equal(
    nodeKind({ type: "n8n-nodes-base.postgres", parameters: { operation: "executeQuery", query: "SELECT 1" } }),
    "Read"
  );
});

test("nodeKind labels a trigger", () => {
  assert.equal(nodeKind({ type: "n8n-nodes-base.scheduleTrigger", parameters: {} }), "Trigger");
});

test("nodeKind labels a plain step", () => {
  assert.equal(nodeKind({ type: "n8n-nodes-base.slack", parameters: {} }), "Step");
});

// Regression: "Respond to Webhook" is an action but a substring test on
// "webhook" called it a Trigger.
test("isTriggerType is false for respondToWebhook", () => {
  assert.equal(isTriggerType("n8n-nodes-base.respondToWebhook"), false);
});

test("isTriggerType is true for real trigger nodes", () => {
  assert.equal(isTriggerType("n8n-nodes-base.webhook"), true);
  assert.equal(isTriggerType("n8n-nodes-base.scheduleTrigger"), true);
  assert.equal(isTriggerType("n8n-nodes-base.manualTrigger"), true);
  assert.equal(isTriggerType("n8n-nodes-base.gmailTrigger"), true);
});

test("isTriggerType is false for an ordinary action node", () => {
  assert.equal(isTriggerType("n8n-nodes-base.slack"), false);
  assert.equal(isTriggerType("n8n-nodes-base.code"), false);
});

// ── Timeline ────────────────────────────────────────────────────────────

test("buildTimeline buckets executions into equal slices", () => {
  const executions = [ex("w1", 5), ex("w1", 10), ex("w2", 60 * 20)];
  const t = buildTimeline({ executions, range: "day", buckets: 24, now: NOW });
  assert.equal(t.buckets.length, 24);
  assert.equal(t.inWindow, 3);
  const total = t.buckets.reduce((n, b) => n + b.total, 0);
  assert.equal(total, 3);
});

test("buildTimeline counts failures separately", () => {
  const executions = [ex("w1", 5, "error"), ex("w1", 6, "success")];
  const t = buildTimeline({ executions, range: "day", buckets: 24, now: NOW });
  assert.equal(t.buckets.reduce((n, b) => n + b.failed, 0), 1);
});

test("buildTimeline drops executions outside the window", () => {
  const executions = [ex("w1", 60 * 30)];
  const t = buildTimeline({ executions, range: "day", buckets: 24, now: NOW });
  assert.equal(t.inWindow, 0);
});

test("buildTimeline records per-workflow counts in each bucket", () => {
  const executions = [ex("w1", 5), ex("w1", 6), ex("w2", 7)];
  const t = buildTimeline({ executions, range: "day", buckets: 24, now: NOW });
  const last = t.buckets[t.buckets.length - 1];
  assert.equal(last.byWorkflow.w1, 2);
  assert.equal(last.byWorkflow.w2, 1);
});

test("buildTimeline flags a truncated sample", () => {
  const executions = Array.from({ length: 250 }, (_, i) => ex("w1", i));
  const t = buildTimeline({ executions, range: "day", buckets: 24, now: NOW });
  assert.equal(t.truncated, true);
});

test("buildTimeline does not flag a small sample as truncated", () => {
  const t = buildTimeline({ executions: [ex("w1", 1)], range: "day", buckets: 24, now: NOW });
  assert.equal(t.truncated, false);
});

// ── Logos and ownership ─────────────────────────────────────────────────

test("logoFor returns a vendored path for a system with a mark", () => {
  assert.equal(logoFor("sys:shopify"), "/vendor/logos/shopify.svg");
  assert.equal(logoFor("sys:warehouse-db"), "/vendor/logos/postgresql.svg");
});

test("logoFor returns null rather than inventing a mark", () => {
  assert.equal(logoFor("sys:printing"), null);
  assert.equal(logoFor("sys:ai"), null);
  assert.equal(logoFor("sys:unknown"), null);
  assert.equal(logoFor("sys:notion"), "/vendor/logos/notion.svg");
});

test("buildRunsMap attaches a logoPath to every node", () => {
  const workflows = [wf("w1", "A", ["sys:cin7"])];
  const map = buildRunsMap({ workflows, executions: [], users: [], tagNames: [], now: NOW });
  assert.equal(map.nodes[0].logoPath, "/vendor/logos/cin7.svg");
});

test("buildRunsMap attributes each edge to an owner", () => {
  const workflows = [wf("w1", "A", ["Sam", "sys:cin7"])];
  const map = buildRunsMap({ workflows, executions: [], users: [], tagNames: ["Sam"], now: NOW });
  assert.equal(map.edges[0].owner, "Sam");
});

test("ownerTagsFrom excludes subject tags", () => {
  assert.deepEqual(ownerTagsFrom(["Sam", "QR", "cooper", "sys:cin7"]), ["Sam"]);
});

test("ownerOf falls back to the instance user", () => {
  const users = [{ firstName: "Sam", lastName: "Rivera", email: "a@b.c" }];
  assert.equal(ownerOf(wf("w1", "A", []), [], users), "Sam Rivera");
});

test("ownerOf reports Unattributed when there is no user and no tag", () => {
  assert.equal(ownerOf(wf("w1", "A", []), [], []), "Unattributed");
});

import { buildPairs } from "../web/lib/aggregate.js";

test("buildPairs gives every arc the workflows behind it, including 3-system workflows", () => {
  const pairs = buildPairs([
    { workflowId: "a", name: "Sync", runs: 40, failures: 2, active: true, systems: ["Cin7", "Company DB"] },
    { workflowId: "b", name: "Freight", runs: 5, failures: 0, active: true, systems: ["Slack", "Cin7", "Company DB"] },
    { workflowId: "c", name: "Solo", runs: 1, active: false, systems: ["Slack"] }
  ]);
  const byKey = Object.fromEntries(pairs.map((p) => [p.key, p]));
  assert.deepEqual(Object.keys(byKey).sort(), ["Cin7↔Company DB", "Cin7↔Slack", "Company DB↔Slack"]);
  const main = byKey["Cin7↔Company DB"];
  assert.deepEqual(main.workflows.map((w) => w.name), ["Sync", "Freight"]);
  assert.equal(main.runs, 45);
  assert.equal(main.failures, 2);
  assert.equal(main.active, 2);
  assert.equal(pairs[0].key, "Cin7↔Company DB", "busiest first");
});
