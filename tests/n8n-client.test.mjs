import { test } from "node:test";
import assert from "node:assert/strict";
import { createN8nClient, N8nError, isAllowed } from "../web/lib/n8n-client.js";

function mockFetch(responses) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    const body = responses.shift();
    return {
      ok: body.status >= 200 && body.status < 300,
      status: body.status,
      text: async () => JSON.stringify(body.json)
    };
  };
  impl.calls = calls;
  return impl;
}

test("sends the API key and Cloudflare Access headers", async () => {
  const fetchImpl = mockFetch([{ status: 200, json: { data: [] } }]);
  const client = createN8nClient({
    baseUrl: "https://n8n.example.com/",
    apiKey: "key",
    cfAccessClientId: "cid",
    cfAccessClientSecret: "csecret",
    fetchImpl
  });
  await client.listWorkflows();
  const headers = fetchImpl.calls[0].init.headers;
  assert.equal(headers["X-N8N-API-KEY"], "key");
  assert.equal(headers["CF-Access-Client-Id"], "cid");
  assert.equal(headers["CF-Access-Client-Secret"], "csecret");
  assert.equal(fetchImpl.calls[0].url, "https://n8n.example.com/api/v1/workflows?limit=250");
});

test("pages through results until nextCursor is exhausted", async () => {
  const fetchImpl = mockFetch([
    { status: 200, json: { data: [{ id: "a" }], nextCursor: "c1" } },
    { status: 200, json: { data: [{ id: "b" }], nextCursor: null } }
  ]);
  const client = createN8nClient({ baseUrl: "https://x.test", apiKey: "k", fetchImpl });
  const all = await client.listWorkflows();
  assert.deepEqual(all.map((w) => w.id), ["a", "b"]);
  assert.match(fetchImpl.calls[1].url, /cursor=c1/);
});

test("the write allowlist admits only the reviewed operations", () => {
  assert.equal(isAllowed("POST", "workflows"), true);
  // Bulk organisation: folder move, tag replace, and on/off.
  assert.equal(isAllowed("PUT", "workflows/abc"), true);
  assert.equal(isAllowed("PUT", "workflows/abc/tags"), true);
  assert.equal(isAllowed("POST", "workflows/abc/activate"), true);
  assert.equal(isAllowed("POST", "workflows/abc/deactivate"), true);
  // Still refused: publishing, archiving, deleting, and anything credential- or
  // user-shaped. Those are not bulk-organisation operations.
  assert.equal(isAllowed("POST", "workflows/abc/publish"), false);
  assert.equal(isAllowed("POST", "workflows/abc/archive"), false);
  assert.equal(isAllowed("DELETE", "workflows/abc"), false);
  assert.equal(isAllowed("PATCH", "workflows/abc"), false);
  assert.equal(isAllowed("POST", "credentials"), false);
  assert.equal(isAllowed("POST", "users"), false);
});

test("reads are limited to the reviewed endpoint set", () => {
  assert.equal(isAllowed("GET", "workflows?limit=250"), true);
  assert.equal(isAllowed("GET", "workflows/abc"), true);
  assert.equal(isAllowed("GET", "executions?limit=20"), true);
  assert.equal(isAllowed("GET", "insights/summary"), true);
  assert.equal(isAllowed("GET", "projects/PMz/folders"), true);
  assert.equal(isAllowed("GET", "settings/security-policy"), false);
  assert.equal(isAllowed("GET", "source-control/status"), false);
});

test("surfaces n8n's error message and status", async () => {
  const fetchImpl = mockFetch([{ status: 401, json: { message: "unauthorized" } }]);
  const client = createN8nClient({ baseUrl: "https://x.test", apiKey: "k", fetchImpl });
  await assert.rejects(() => client.listWorkflows(), (err) => {
    assert.ok(err instanceof N8nError);
    assert.equal(err.status, 401);
    assert.equal(err.message, "unauthorized");
    return true;
  });
});

test("createWorkflow posts to the workflows collection", async () => {
  const fetchImpl = mockFetch([{ status: 200, json: { id: "new1", name: "Test" } }]);
  const client = createN8nClient({ baseUrl: "https://x.test", apiKey: "k", fetchImpl });
  const created = await client.createWorkflow({ name: "Test", nodes: [], connections: {}, settings: {} });
  assert.equal(created.id, "new1");
  assert.equal(fetchImpl.calls[0].init.method, "POST");
  assert.equal(fetchImpl.calls[0].url, "https://x.test/api/v1/workflows");
});

// Regression: this endpoint returns a bare array. Reading `.data` returned []
// and made add-tags think the workflow had no tags, so it replaced the whole
// list instead of merging — silently stripping every existing tag.
test("getWorkflowTags reads a bare array, not a data collection", async () => {
  const fetchImpl = mockFetch([{ status: 200, json: [{ id: "t1", name: "Sam" }] }]);
  const client = createN8nClient({ baseUrl: "https://x.test", apiKey: "k", fetchImpl });
  const tags = await client.getWorkflowTags("w1");
  assert.deepEqual(tags, [{ id: "t1", name: "Sam" }]);
});

test("getWorkflowTags tolerates the data-collection shape too", async () => {
  const fetchImpl = mockFetch([{ status: 200, json: { data: [{ id: "t1" }] } }]);
  const client = createN8nClient({ baseUrl: "https://x.test", apiKey: "k", fetchImpl });
  assert.deepEqual(await client.getWorkflowTags("w1"), [{ id: "t1" }]);
});

test("rejects construction without an api key", () => {
  assert.throws(() => createN8nClient({ baseUrl: "https://x.test" }), N8nError);
});
