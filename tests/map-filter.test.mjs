import { test } from "node:test";
import assert from "node:assert/strict";

// The filter predicate lives in runs.html, which is not importable. It is
// reproduced here so a change to the rule has to be made in both places
// deliberately, and so the narrowing behaviour is pinned by a test.
function applyFilters(data, { people = new Set(), systems = new Set() } = {}) {
  const anyPeople = people.size > 0;
  const anySystems = systems.size > 0;
  const edges = data.edges.filter((e) => {
    if (anyPeople && !people.has(e.owner)) return false;
    if (anySystems && !e.systems.some((s) => systems.has(s))) return false;
    return true;
  });
  const visible = new Set(edges.flatMap((e) => e.systems));
  const nodes = data.nodes.filter((n) => (anySystems ? systems.has(n.label) : visible.has(n.label)));
  return { edges, nodes };
}

const DATA = {
  nodes: [
    { key: "sys:cin7", label: "Cin7" },
    { key: "sys:slack", label: "Slack" },
    { key: "sys:warehouse-db", label: "Company DB" }
  ],
  edges: [
    { workflowId: "a", owner: "Sam", systems: ["Cin7", "Slack"] },
    { workflowId: "b", owner: "Sam", systems: ["Cin7", "Company DB"] },
    { workflowId: "c", owner: "Jo", systems: ["Slack"] }
  ]
};

test("no filter keeps every edge", () => {
  assert.equal(applyFilters(DATA).edges.length, 3);
});

test("a system filter keeps only edges touching that system", () => {
  const { edges } = applyFilters(DATA, { systems: new Set(["Slack"]) });
  assert.deepEqual(edges.map((e) => e.workflowId), ["a", "c"]);
});

test("a person filter keeps only that person's edges", () => {
  const { edges } = applyFilters(DATA, { people: new Set(["Jo"]) });
  assert.deepEqual(edges.map((e) => e.workflowId), ["c"]);
});

test("person and system filters combine as AND", () => {
  const { edges } = applyFilters(DATA, { people: new Set(["Sam"]), systems: new Set(["Slack"]) });
  assert.deepEqual(edges.map((e) => e.workflowId), ["a"]);
});

test("a system filter narrows the nodes to the selected systems", () => {
  const { nodes } = applyFilters(DATA, { systems: new Set(["Slack"]) });
  assert.deepEqual(nodes.map((n) => n.label), ["Slack"]);
});

test("without a system filter, nodes are those still connected", () => {
  const { nodes } = applyFilters(DATA, { people: new Set(["Jo"]) });
  assert.deepEqual(nodes.map((n) => n.label), ["Slack"]);
});

test("a filter matching nothing yields an empty graph", () => {
  const { edges, nodes } = applyFilters(DATA, { people: new Set(["Nobody"]) });
  assert.equal(edges.length, 0);
  assert.equal(nodes.length, 0);
});
