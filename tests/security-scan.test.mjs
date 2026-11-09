import { test } from "node:test";
import assert from "node:assert/strict";
import { scanWorkflow, scanWorkflows, writesCompanyData, systemsFor } from "../web/lib/security-scan.js";

function wf(nodes, tags = []) {
  return { id: "w1", name: "Test", nodes, tags: tags.map((name) => ({ name })) };
}

test("flags a literal assigned to a secret-named variable in a Code node", () => {
  const findings = scanWorkflow(
    wf([{ name: "Verify", type: "n8n-nodes-base.code", parameters: { jsCode: "const SECRET = 'abcdef1234567890';" } }])
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].node, "Verify");
  assert.equal(findings[0].kind, "code-literal");
  assert.equal(findings[0].secret, "SECRET");
});

test("does not flag a Code node that reads $env", () => {
  const findings = scanWorkflow(
    wf([{ name: "Verify", type: "n8n-nodes-base.code", parameters: { jsCode: "const SECRET = $env.SHOPIFY_WEBHOOK_SECRET;" } }])
  );
  assert.deepEqual(findings, []);
});

// Regression: the live "Cooper: Ingest tracking (pin)" workflow builds a Slack
// thread id by concatenation. Flagging it buried three real findings in noise.
test("does not flag a derived identifier built by concatenation", () => {
  const findings = scanWorkflow(
    wf([{
      name: "Build dropship card",
      type: "n8n-nodes-base.code",
      parameters: { jsCode: "const threadKey = 'dropship-' + (poNumber || tracking || 'unknown');" }
    }])
  );
  assert.deepEqual(findings, []);
});

test("does not flag a short label in a secret-named variable", () => {
  const findings = scanWorkflow(
    wf([{ name: "C", type: "n8n-nodes-base.code", parameters: { jsCode: "const cacheKey = 'orders';" } }])
  );
  assert.deepEqual(findings, []);
});

test("does not flag a human-readable phrase in a secret-named variable", () => {
  const findings = scanWorkflow(
    wf([{ name: "C", type: "n8n-nodes-base.code", parameters: { jsCode: "const noteKey = 'see the audit log';" } }])
  );
  assert.deepEqual(findings, []);
});

test("flags a 64-hex Shopify webhook secret in a header parameter", () => {
  const secret = "a".repeat(64);
  const findings = scanWorkflow(
    wf([{
      name: "HTTP",
      type: "n8n-nodes-base.httpRequest",
      parameters: { headerParameters: { parameters: [{ name: "X-Sig", value: secret }] } }
    }])
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].secret, "Shopify webhook secret");
});

test("flags a Slack incoming webhook URL", () => {
  const findings = scanWorkflow(
    wf([{
      name: "Notify",
      type: "n8n-nodes-base.httpRequest",
      parameters: { jsonBody: "https://hooks.slack.com/services/T000/B000/abc123def" }
    }])
  );
  assert.ok(findings.some((f) => f.secret === "Slack webhook URL"));
});

test("ignores ordinary URLs in a url parameter", () => {
  const findings = scanWorkflow(
    wf([{ name: "Fetch", type: "n8n-nodes-base.httpRequest", parameters: { url: "https://api.example.com/v1/orders" } }])
  );
  assert.deepEqual(findings, []);
});

test("redacts the secret in the finding rather than echoing it", () => {
  const secret = "abcdef1234567890";
  const findings = scanWorkflow(
    wf([{ name: "C", type: "n8n-nodes-base.code", parameters: { jsCode: `const API_TOKEN = '${secret}';` } }])
  );
  assert.equal(findings.length, 1);
  assert.ok(!findings[0].preview.includes(secret), "literal must not appear in the finding");
  assert.match(findings[0].preview, /chars\)/);
});

test("scanWorkflows counts findings across workflows", () => {
  const list = [
    wf([{ name: "A", type: "n8n-nodes-base.code", parameters: { jsCode: "const A_KEY = 'zzzzzzzzzzzzzzzzzzzz';" } }]),
    wf([{ name: "B", type: "n8n-nodes-base.code", parameters: { jsCode: "const B_KEY = $env.B_KEY;" } }])
  ];
  assert.equal(scanWorkflows(list).length, 1);
});

test("systemsFor maps sys:* tags to human labels", () => {
  assert.deepEqual(systemsFor(wf([], ["sys:cin7", "sys:slack"])), ["Cin7", "Slack"]);
});

test("writesCompanyData is true for an insert against the warehouse DB", () => {
  const w = wf(
    [{ name: "Insert", type: "n8n-nodes-base.postgres", parameters: { operation: "insert" } }],
    ["sys:warehouse-db"]
  );
  assert.equal(writesCompanyData(w), true);
});

test("writesCompanyData is false for a select", () => {
  const w = wf(
    [{ name: "Select", type: "n8n-nodes-base.postgres", parameters: { operation: "select" } }],
    ["sys:warehouse-db"]
  );
  assert.equal(writesCompanyData(w), false);
});

test("writesCompanyData is false when the workflow does not touch the warehouse DB", () => {
  const w = wf([{ name: "Insert", type: "n8n-nodes-base.postgres", parameters: { operation: "insert" } }], ["sys:slack"]);
  assert.equal(writesCompanyData(w), false);
});

test("writesCompanyData detects a write hidden in an executeQuery", () => {
  const w = wf(
    [{ name: "Q", type: "n8n-nodes-base.postgres", parameters: { operation: "executeQuery", query: "UPDATE core.x SET y = 1" } }],
    ["sys:warehouse-db"]
  );
  assert.equal(writesCompanyData(w), true);
});
