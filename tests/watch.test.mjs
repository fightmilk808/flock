import { test } from "node:test";
import assert from "node:assert/strict";
import { openStore } from "../web/lib/approvals.js";
import { runWatch, currentProblems, activityAlerts, slackText } from "../web/lib/watch.js";

const leaky = { id: "W1", name: "Leaky", nodes: [{ name: "Post", type: "n8n-nodes-base.httpRequest", parameters: { headerValue: "xoxb-1234567890-abcdefghijkl" } }] };
const clean = { id: "W2", name: "Clean", nodes: [] };

test("first tick records the backlog without sending", async () => {
  const store = openStore();
  let sent = 0;
  const r = await runWatch({ store, workflows: [leaky], executions: [], send: async () => { sent += 1; } });
  assert.equal(r.firstRun, true);
  assert.equal(r.fresh.length, 0);
  assert.equal(sent, 0);
  assert.equal(store.openAlerts().length, 1);
});

test("a new problem alerts once, and again only after it cleared and came back", async () => {
  const store = openStore();
  const msgs = [];
  const send = async (t) => msgs.push(t);
  await runWatch({ store, workflows: [clean], executions: [], send });               // baseline
  await runWatch({ store, workflows: [clean, leaky], executions: [], send });       // new → 1 message
  await runWatch({ store, workflows: [clean, leaky], executions: [], send });       // same → nothing
  assert.equal(msgs.length, 1);
  assert.match(msgs[0], /Secret pasted into "Leaky"/);
  await runWatch({ store, workflows: [clean], executions: [], send });              // fixed → cleared
  assert.equal(store.openAlerts().length, 0);
  await runWatch({ store, workflows: [clean, leaky], executions: [], send });       // back → alerts again
  assert.equal(msgs.length, 2);
});

test("staff drafts, refusals and bulk changes are reported; the admin's own are not", () => {
  const rows = [
    { id: 1, actor: "jo@example.com", action: "workflow.draft-created", target: "X1", detail: "Supplier digest" },
    { id: 2, actor: "admin@example.com", action: "workflow.draft-created", target: "X2", detail: "Mine" },
    { id: 3, actor: "jo@example.com", action: "workflow.draft-refused", target: "Orders hook", detail: "duplicate,keys" },
    { id: 4, actor: "jo@example.com", action: "bulk.add-tags", target: "2 workflow(s)", detail: "2 applied" }
  ];
  const a = activityAlerts(rows, { admins: ["admin@example.com"] });
  assert.deepEqual(a.map((x) => x.kind), ["draft", "refused", "bulk"]);
});

test("failures are not watched: the n8n error handler already DMs them", () => {
  const ex = [{ workflowId: "W2", status: "error", startedAt: new Date().toISOString() }];
  assert.equal(currentProblems({ workflows: [clean], executions: ex }).length, 0);
});

test("a Slack send failure is recorded, not thrown", async () => {
  const store = openStore();
  await runWatch({ store, workflows: [clean], executions: [] });
  const r = await runWatch({ store, workflows: [clean, leaky], executions: [], send: async () => { throw new Error("Slack: channel_not_found"); } });
  assert.equal(r.sent, false);
  assert.match(store.getMeta("watch.lastError"), /channel_not_found/);
});

test("slackText caps the list and links to Shepherd", () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ kind: "secret", title: `t${i}`, detail: "d", workflowId: `W${i}` }));
  const t = slackText(many, { baseUrl: "https://flock.example.com", n8nUiUrl: "https://n8n.example.com" });
  assert.match(t, /12 new things/);
  assert.match(t, /and 2 more/);
  assert.match(t, /flock\.example\.com\/shepherd\.html/);
});
