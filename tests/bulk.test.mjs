import { test } from "node:test";
import assert from "node:assert/strict";
import { planBulk, applyBulk, describeOp, BulkError, BULK_OPS } from "../web/lib/bulk.js";

const TAGS = [
  { id: "t1", name: "Sam" },
  { id: "t2", name: "sys:cin7" },
  { id: "t3", name: "archive" }
];
const FOLDERS = [{ id: "f1", name: "Warehouse" }, { id: "f2", name: "Freight" }];
const WORKFLOWS = [
  { id: "w1", name: "A" },
  { id: "w2", name: "B" }
];

function plan(overrides = {}) {
  return planBulk({
    op: "add-tags",
    workflowIds: ["w1"],
    tags: ["Sam"],
    tagCatalogue: TAGS,
    folderCatalogue: FOLDERS,
    workflows: WORKFLOWS,
    ...overrides
  });
}

test("plans an add-tags operation and resolves tag ids", () => {
  const p = plan();
  assert.equal(p.op, "add-tags");
  assert.equal(p.count, 1);
  assert.deepEqual(p.tags, [{ id: "t1", name: "Sam" }]);
});

test("refuses an empty selection", () => {
  assert.throws(() => plan({ workflowIds: [] }), /select at least one/);
});

test("refuses a selection above the cap", () => {
  const many = Array.from({ length: 201 }, (_, i) => `w${i}`);
  const workflows = many.map((id) => ({ id, name: id }));
  assert.throws(() => plan({ workflowIds: many, workflows }), /at most 200/);
});

test("refuses a workflow that no longer exists", () => {
  assert.throws(() => plan({ workflowIds: ["ghost"] }), /no longer exist/);
});

test("refuses a tag that does not exist rather than creating it", () => {
  assert.throws(() => plan({ tags: ["brand-new"] }), /unknown tag/);
});

test("refuses an empty tag list for a tag operation", () => {
  assert.throws(() => plan({ tags: [] }), /name at least one tag/);
});

test("refuses a tag containing a comma", () => {
  assert.throws(() => plan({ tags: ["a,b"] }), /cannot contain a comma/);
});

test("refuses more than 20 tags at once", () => {
  const many = Array.from({ length: 21 }, (_, i) => `t${i}`);
  assert.throws(() => plan({ tags: many }), /at most 20 tags/);
});

test("plans a folder move and resolves the folder", () => {
  const p = plan({ op: "move-folder", tags: [], folderId: "f1" });
  assert.deepEqual(p.folder, { id: "f1", name: "Warehouse" });
});

test("refuses a move without a destination", () => {
  assert.throws(() => plan({ op: "move-folder", tags: [], folderId: "" }), /choose a destination/);
});

test("refuses a move to an unknown folder", () => {
  assert.throws(() => plan({ op: "move-folder", tags: [], folderId: "nope" }), /folder not found/);
});

test("destructive operations are not offered", () => {
  assert.throws(() => describeOp("archive"), /not available in bulk/);
  assert.throws(() => describeOp("delete"), /not available in bulk/);
  assert.throws(() => describeOp("publish"), /not available in bulk/);
});

test("an unknown operation is refused", () => {
  assert.throws(() => describeOp("rm-rf"), /unknown bulk operation/);
});

test("every offered operation is described", () => {
  for (const key of Object.keys(BULK_OPS)) {
    assert.ok(describeOp(key).label);
  }
});

// ── applyBulk ───────────────────────────────────────────────────────────
function fakeClient(overrides = {}) {
  const calls = [];
  return {
    calls,
    getWorkflowTags: async (id) => {
      calls.push(["getTags", id]);
      return [{ id: "t1" }];
    },
    setWorkflowTags: async (id, tags) => {
      calls.push(["setTags", id, tags]);
      return {};
    },
    getWorkflow: async (id) => {
      calls.push(["getWorkflow", id]);
      return { name: "A", nodes: [], connections: {}, settings: {} };
    },
    updateWorkflow: async (id, body) => {
      calls.push(["updateWorkflow", id, body]);
      return {};
    },
    activateWorkflow: async (id) => {
      calls.push(["activate", id]);
      return {};
    },
    deactivateWorkflow: async (id) => {
      calls.push(["deactivate", id]);
      return {};
    },
    ...overrides
  };
}

// n8n's tag PUT replaces the whole list, so adding must merge with what is
// already there or the workflow silently loses its other tags.
test("add-tags merges with existing tags instead of replacing them", async () => {
  const client = fakeClient({ getWorkflowTags: async () => [{ id: "t2" }] });
  const p = plan();
  await applyBulk(client, p);
  const setCall = client.calls.find((c) => c[0] === "setTags");
  assert.deepEqual(setCall[2], [{ id: "t2" }, { id: "t1" }]);
});

test("add-tags is a no-op when the tag is already present", async () => {
  const client = fakeClient();
  const p = plan();
  const result = await applyBulk(client, p);
  assert.equal(result.unchanged, 1);
  assert.equal(result.applied, 0);
  assert.equal(client.calls.filter((c) => c[0] === "setTags").length, 0);
});

test("remove-tags drops only the named tag", async () => {
  const client = fakeClient({
    getWorkflowTags: async () => [{ id: "t1" }, { id: "t2" }]
  });
  const p = plan({ op: "remove-tags", tags: ["Sam"] });
  await applyBulk(client, p);
  const setCall = client.calls.find((c) => c[0] === "setTags");
  assert.deepEqual(setCall[2], [{ id: "t2" }]);
});

test("applyBulk reports one failure without hiding the others", async () => {
  let n = 0;
  const client = fakeClient({
    getWorkflowTags: async () => {
      n += 1;
      if (n === 1) throw new Error("boom");
      return [];
    }
  });
  const p = plan({ workflowIds: ["w1", "w2"] });
  const result = await applyBulk(client, p);
  assert.equal(result.failed, 1);
  assert.equal(result.applied, 1);
  assert.equal(result.results.length, 2);
});

test("applyBulk reports progress per workflow", async () => {
  const seen = [];
  const client = fakeClient();
  const p = plan({ workflowIds: ["w1", "w2"] });
  await applyBulk(client, p, { onProgress: (x) => seen.push(x.done) });
  assert.deepEqual(seen, [1, 2]);
});

test("a move re-reads the workflow before updating so no field is dropped", async () => {
  const client = fakeClient();
  const p = plan({ op: "move-folder", tags: [], folderId: "f1" });
  await applyBulk(client, p);
  const update = client.calls.find((c) => c[0] === "updateWorkflow");
  assert.equal(update[2].name, "A");
  assert.deepEqual(update[2].nodes, []);
  assert.deepEqual(update[2].connections, {});
  assert.equal(update[2].parentFolderId, "f1");
});

test("activate calls activate, not update", async () => {
  const client = fakeClient();
  const p = plan({ op: "activate", tags: [] });
  await applyBulk(client, p);
  assert.equal(client.calls.filter((c) => c[0] === "activate").length, 1);
  assert.equal(client.calls.filter((c) => c[0] === "updateWorkflow").length, 0);
});

test("deactivate calls deactivate", async () => {
  const client = fakeClient();
  const p = plan({ op: "deactivate", tags: [] });
  await applyBulk(client, p);
  assert.equal(client.calls.filter((c) => c[0] === "deactivate").length, 1);
});
