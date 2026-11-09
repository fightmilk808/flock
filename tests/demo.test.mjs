import { test } from "node:test";
import assert from "node:assert/strict";
import { createDemoN8nClient, createDemoLlm, DEMO_CONFIG } from "../web/lib/demo.js";
import { validateConfig } from "../web/lib/config.js";
import { scanWorkflows } from "../web/lib/security-scan.js";
import { analyseExecutions } from "../web/lib/loop-guard.js";
import { extractEdges, layoutGraph } from "../web/lib/flow-graph.js";
import { buildWorkflowPayload, isDraftTurn } from "../web/lib/shepherd.js";

test("the demo instance has workflows, runs, and a branch to draw", async () => {
  const c = createDemoN8nClient();
  const wfs = await c.listWorkflows();
  assert.ok(wfs.length >= 10);
  const runs = (await c.listExecutions({ limit: 1000 })).data;
  assert.ok(runs.length > 100);
  const orders = wfs.find((w) => w.id === "wf-orders");
  assert.equal(layoutGraph(orders.nodes, extractEdges(orders, orders.nodes)).branches, true);
});

test("the demo gives every guardrail something to show", async () => {
  const c = createDemoN8nClient();
  const wfs = await c.listWorkflows();
  assert.ok(scanWorkflows(wfs).length >= 1, "a planted (fake) key is found");
  const runs = (await c.listExecutions({ limit: 1000 })).data;
  assert.ok(analyseExecutions(runs).some((f) => f.workflowId === "wf-sync"), "the retry loop trips the loop guard");
  await assert.rejects(c.getNodeTypePolicy(), (e) => e.status === 403);
});

test("demo writes stay in memory and drafts land inactive", async () => {
  const c = createDemoN8nClient();
  const created = await c.createWorkflow({ name: "x", nodes: [], connections: {} });
  assert.equal(created.active, false);
  assert.ok((await c.listWorkflows()).some((w) => w.id === created.id));
  const fresh = await createDemoN8nClient().listWorkflows();
  assert.ok(!fresh.some((w) => w.id === created.id), "a new demo instance starts clean");
});

test("demo Shepherd asks a question, then draws a valid branching draft", async () => {
  const llm = createDemoLlm();
  const first = await llm.draftWorkflow("when a wholesale order is big, post it to Slack");
  assert.equal(first.kind, "answer");
  const second = await llm.draftWorkflow("#wholesale", { history: [{ role: "user", content: "x" }, { role: "assistant", content: first.reply }] });
  assert.ok(isDraftTurn(second));
  const payload = buildWorkflowPayload(second);
  assert.equal(payload.connections["Over $500?"].main.length, 2);
});

test("the demo config is a valid config shape apart from the key", () => {
  assert.doesNotThrow(() => validateConfig({ ...DEMO_CONFIG, n8n: { ...DEMO_CONFIG.n8n, apiKey: "env:DEMO" } }));
});
