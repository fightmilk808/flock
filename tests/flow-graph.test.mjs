import { test } from "node:test";
import assert from "node:assert/strict";
import { extractEdges, layoutGraph, edgePath, outputLabel } from "../web/lib/flow-graph.js";

const n = (name, type = "n8n-nodes-base.set", extra = {}) => ({ name, type, ...extra });
const link = (node, index = 0) => ({ node, type: "main", index });

function ifWorkflow() {
  const nodes = [n("Hook", "n8n-nodes-base.webhook"), n("Paid?", "n8n-nodes-base.if"), n("Ship"), n("Email"), n("Log")];
  const connections = {
    Hook: { main: [[link("Paid?")]] },
    "Paid?": { main: [[link("Ship")], [link("Email")]] },
    Ship: { main: [[link("Log")]] },
    Email: { main: [[link("Log")]] }
  };
  return { nodes, connections };
}

test("an IF node's two outputs become labelled true/false edges", () => {
  const wf = ifWorkflow();
  const edges = extractEdges(wf, wf.nodes);
  const fromIf = edges.filter((e) => e.from === "Paid?");
  assert.deepEqual(fromIf.map((e) => [e.to, e.label]), [["Ship", "true"], ["Email", "false"]]);
});

test("branches sit side by side and merge back below both", () => {
  const wf = ifWorkflow();
  const g = layoutGraph(wf.nodes, extractEdges(wf, wf.nodes));
  const b = g.boxes;
  assert.equal(g.layers, 4);
  assert.equal(b.Ship.layer, 2);
  assert.equal(b.Email.layer, 2);
  assert.ok(b.Ship.x < b.Email.x, "true branch is on the left");
  assert.equal(b.Log.layer, 3);
  assert.equal(b.Log.x, (b.Ship.x + b.Email.x) / 2, "merge centres under its parents");
  assert.equal(b.Hook.x, b["Paid?"].x, "a plain chain stays straight");
  assert.equal(g.branches, true);
});

test("a straight chain is one column", () => {
  const nodes = [n("A", "n8n-nodes-base.webhook"), n("B"), n("C")];
  const wf = { nodes, connections: { A: { main: [[link("B")]] }, B: { main: [[link("C")]] } } };
  const g = layoutGraph(nodes, extractEdges(wf, nodes));
  assert.equal(new Set(Object.values(g.boxes).map((x) => x.x)).size, 1);
  assert.equal(g.branches, false);
});

test("a loop back edge is kept, marked, and does not break layering", () => {
  const nodes = [n("Start", "n8n-nodes-base.manualTrigger"), n("Loop", "n8n-nodes-base.splitInBatches"), n("Work"), n("Done")];
  const wf = {
    nodes,
    connections: {
      Start: { main: [[link("Loop")]] },
      Loop: { main: [[link("Done")], [link("Work")]] },
      Work: { main: [[link("Loop")]] }
    }
  };
  const edges = extractEdges(wf, nodes);
  assert.equal(edges.find((e) => e.from === "Loop" && e.to === "Work").label, "loop");
  const g = layoutGraph(nodes, edges);
  const backs = g.edges.filter((e) => e.back);
  assert.deepEqual(backs.map((e) => [e.from, e.to]), [["Work", "Loop"]]);
  assert.ok(g.boxes.Work.layer > g.boxes.Loop.layer);
  assert.match(edgePath(backs[0], g.boxes, g.width).d, /^M /);
});

test("AI sub-nodes hang below their agent", () => {
  const nodes = [n("Chat", "@n8n/n8n-nodes-langchain.chatTrigger"), n("Agent", "@n8n/n8n-nodes-langchain.agent"), n("Model", "@n8n/n8n-nodes-langchain.lmChatAnthropic")];
  const wf = {
    nodes,
    connections: {
      Chat: { main: [[link("Agent")]] },
      Model: { ai_languageModel: [[{ node: "Agent", type: "ai_languageModel", index: 0 }]] }
    }
  };
  const edges = extractEdges(wf, nodes);
  const ai = edges.find((e) => e.kind === "ai");
  assert.deepEqual([ai.from, ai.to, ai.label], ["Agent", "Model", "language model"]);
  const g = layoutGraph(nodes, edges);
  assert.ok(g.boxes.Model.layer > g.boxes.Agent.layer);
});

test("Switch outputs use their renamed keys; error outputs say error", () => {
  const sw = n("Route", "n8n-nodes-base.switch", {
    parameters: { rules: { values: [{ renameOutput: true, outputKey: "Freight" }, {}] } }
  });
  assert.equal(outputLabel(sw, 0, 2), "Freight");
  assert.equal(outputLabel(sw, 1, 2), "output 1");
  const http = n("Call", "n8n-nodes-base.httpRequest", { onError: "continueErrorOutput" });
  assert.equal(outputLabel(http, 1, 2), "error");
  assert.equal(outputLabel(n("Plain"), 0, 1), null);
});

test("edges to nodes that are not drawn (sticky notes, missing) are dropped", () => {
  const nodes = [n("A", "n8n-nodes-base.webhook")];
  const wf = { nodes, connections: { A: { main: [[link("Ghost")]] }, Ghost: { main: [[link("A")]] } } };
  assert.deepEqual(extractEdges(wf, nodes), []);
  const g = layoutGraph(nodes, []);
  assert.equal(g.layers, 1);
});

test("nodes stay inside the canvas and never overlap", () => {
  const nodes = [n("T", "n8n-nodes-base.webhook"), n("S", "n8n-nodes-base.switch"), n("A"), n("B"), n("C"), n("D")];
  const wf = { nodes, connections: { T: { main: [[link("S")]] }, S: { main: [[link("A")], [link("B")], [link("C")], [link("D")]] } } };
  const g = layoutGraph(nodes, extractEdges(wf, nodes));
  const row = ["A", "B", "C", "D"].map((k) => g.boxes[k]).sort((p, q) => p.x - q.x);
  for (let i = 1; i < row.length; i += 1) assert.ok(row[i].x >= row[i - 1].x + row[i - 1].w);
  for (const box of Object.values(g.boxes)) {
    assert.ok(box.x >= 0 && box.x + box.w <= g.width);
    assert.ok(box.y >= 0 && box.y + box.h <= g.height);
  }
});

test("an edge that skips rows gets a lane beside the cards, not behind them", () => {
  // Gate's true side jumps straight to End; its false side goes the long way.
  const nodes = [n("T", "n8n-nodes-base.webhook"), n("Gate", "n8n-nodes-base.if"), n("A"), n("B"), n("C"), n("End")];
  const wf = {
    nodes,
    connections: {
      T: { main: [[link("Gate")]] },
      Gate: { main: [[link("End")], [link("A")]] },
      A: { main: [[link("B")]] }, B: { main: [[link("C")]] }, C: { main: [[link("End")]] }
    }
  };
  const g = layoutGraph(nodes, extractEdges(wf, nodes));
  const jump = g.edges.find((e) => e.from === "Gate" && e.to === "End");
  assert.equal(jump.via.length, 3, "one lane stretch per skipped row");
  for (const v of jump.via) {
    for (const k of ["A", "B", "C"]) {
      const b = g.boxes[k];
      const sameRow = v.top === b.y;
      if (sameRow) assert.ok(v.x < b.x || v.x > b.x + b.w, `lane clears ${k}`);
    }
    assert.ok(v.x >= 0 && v.x <= g.width);
  }
  assert.match(edgePath(jump, g.boxes, g.width).d, / L /);
});
