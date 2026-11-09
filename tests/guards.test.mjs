import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createSign } from "node:crypto";

import { classifyWorkflow, classifyAll, RESERVED_TAGS } from "../web/lib/infra.js";
import { guardDraft, findDuplicates } from "../web/lib/draft-guard.js";
import { authorizeBulk, BulkError } from "../web/lib/bulk.js";
import { createIdentity, verifyAccessJwt, AuthError } from "../web/lib/identity.js";
import { validateConfig, resolveSecret, ConfigError } from "../web/lib/config.js";

const tags = (...names) => names.map((name, i) => ({ id: String(i), name }));
const node = (name, type, parameters = {}) => ({ name, type, typeVersion: 1, position: [0, 0], parameters });

// --- infrastructure ----------------------------------------------------------

test("an active workflow is infrastructure", () => {
  const r = classifyWorkflow({ id: "1", name: "Anything", active: true, nodes: [] });
  assert.equal(r.infra, true);
  assert.match(r.reasons.join(), /running in production/);
});

test("a workflow touching a company system is infrastructure even when off", () => {
  const r = classifyWorkflow({ id: "1", name: "Draft", active: false, tags: tags("sys:cin7"), nodes: [] });
  assert.equal(r.infra, true);
  assert.match(r.reasons.join(), /cin7/);
});

test("company systems are found from nodes and hosts, not only tags", () => {
  const pg = classifyWorkflow({ id: "1", name: "x", nodes: [node("q", "n8n-nodes-base.postgres")] });
  assert.match(pg.reasons.join(), /warehouse-db/);
  const http = classifyWorkflow({
    id: "2",
    name: "x",
    nodes: [node("h", "n8n-nodes-base.httpRequest", { url: "https://inventory.dearsystems.com/ExternalApi/v2/sale" })]
  });
  assert.match(http.reasons.join(), /cin7/);
});

test("server-reaching nodes, subflows and error handlers are infrastructure", () => {
  for (const type of ["n8n-nodes-base.executeCommand", "n8n-nodes-base.errorTrigger", "n8n-nodes-base.executeWorkflowTrigger", "n8n-nodes-base.n8n"]) {
    assert.equal(classifyWorkflow({ id: "1", name: "x", nodes: [node("a", type)] }).infra, true, type);
  }
});

test("names that mark infrastructure are honoured", () => {
  for (const name of ["[Subflow] BOL Created", "Shopify Catch-All Webhook", "Cin7 → Postgres Sync (30 min)", "Security — Canary token alert relay", "FREIGHT PIPELINE 🟢"]) {
    assert.equal(classifyWorkflow({ id: "1", name, nodes: [] }).infra, true, name);
  }
});

test("an inactive Slack-only or AI chat workflow is open to staff", () => {
  const r = classifyWorkflow({
    id: "1",
    name: "AI agent chat",
    active: false,
    tags: tags("trigger:webhook", "sys:ai"),
    nodes: [node("w", "n8n-nodes-base.webhook"), node("s", "n8n-nodes-base.slack")]
  });
  assert.deepEqual(r, { infra: false, reasons: [] });
});

test("the infra tag forces the lock", () => {
  assert.equal(classifyWorkflow({ id: "1", name: "x", tags: tags("infra"), nodes: [] }).infra, true);
});

// --- bulk authorization --------------------------------------------------------

const wfs = [
  { id: "a", name: "Freight", active: true, nodes: [] },
  { id: "b", name: "Notes", active: false, nodes: [] }
];
const classification = classifyAll(wfs);
const plan = (op, ids, tagList = null) => ({ op, label: op, workflowIds: ids, count: ids.length, tags: tagList });

test("staff cannot change infrastructure workflows", () => {
  assert.throws(
    () => authorizeBulk(plan("add-tags", ["a", "b"], [{ id: "1", name: "x" }]), { isAdmin: false, classification, workflows: wfs }),
    (err) => err instanceof BulkError && /infrastructure/.test(err.message) && /"Freight"/.test(err.message)
  );
});

test("staff can tag non-infrastructure workflows", () => {
  assert.doesNotThrow(() => authorizeBulk(plan("add-tags", ["b"], [{ id: "1", name: "x" }]), { isAdmin: false, classification, workflows: wfs }));
});

test("staff cannot switch workflows on or off, even open ones", () => {
  for (const op of ["activate", "deactivate"]) {
    assert.throws(() => authorizeBulk(plan(op, ["b"]), { isAdmin: false, classification, workflows: wfs }), /admin-only/);
  }
});

test("staff cannot add or remove the reserved infra tag", () => {
  assert.throws(
    () => authorizeBulk(plan("remove-tags", ["b"], [{ id: "9", name: "infra" }]), { isAdmin: false, classification, reservedTags: RESERVED_TAGS, workflows: wfs }),
    /admin-only/
  );
});

test("an admin may do anything the planner allows", () => {
  assert.doesNotThrow(() => authorizeBulk(plan("deactivate", ["a"]), { isAdmin: true, classification, workflows: wfs }));
});

// --- draft guard ------------------------------------------------------------------

const draft = (nodes, extra = {}) => ({ name: "Weekly supplier digest", description: "", nodes, connections: {}, settings: { executionOrder: "v1" }, ...extra });

test("a plain schedule → Slack draft passes", () => {
  const g = guardDraft(draft([node("Every Monday", "n8n-nodes-base.scheduleTrigger"), node("Post", "n8n-nodes-base.slack")]));
  assert.equal(g.ok, true, JSON.stringify(g.blocked));
});

test("credentials on a node are refused", () => {
  const n = { ...node("Post", "n8n-nodes-base.slack"), credentials: { slackApi: { id: "7", name: "Team bot" } } };
  const g = guardDraft(draft([node("t", "n8n-nodes-base.manualTrigger"), n]));
  assert.equal(g.ok, false);
  assert.ok(g.blocked.some((b) => b.rule === "keys" && /credential/.test(b.why)));
});

test("reading $env or process.env is refused anywhere in parameters", () => {
  for (const expr of ["={{ $env.CIN7_APP_KEY }}", "={{ $secrets.vault.key }}", "process.env.N8N_API_KEY"]) {
    const g = guardDraft(draft([node("t", "n8n-nodes-base.manualTrigger"), node("h", "n8n-nodes-base.set", { values: { k: expr } })]));
    assert.equal(g.ok, false, expr);
  }
});

test("secret-shaped strings are refused even in fields the workflow scan skips", () => {
  const g = guardDraft(draft([node("t", "n8n-nodes-base.manualTrigger"), node("Post", "n8n-nodes-base.slack", { text: "token xoxb-1234567890-abcdefghij" })]));
  assert.equal(g.ok, false);
  assert.ok(g.blocked.some((b) => /Slack token/.test(b.why)));
});

test("server-reaching node types are refused", () => {
  for (const type of ["n8n-nodes-base.executeCommand", "n8n-nodes-base.ssh", "n8n-nodes-base.code", "n8n-nodes-base.n8n", "n8n-nodes-base.readWriteFile", "n8n-nodes-base.executeWorkflow"]) {
    const g = guardDraft(draft([node("t", "n8n-nodes-base.manualTrigger"), node("x", type)]));
    assert.equal(g.ok, false, type);
  }
});

test("non-core node types are refused", () => {
  const g = guardDraft(draft([node("t", "n8n-nodes-base.manualTrigger"), node("x", "@n8n/n8n-nodes-langchain.agent")]));
  assert.ok(g.blocked.some((b) => b.rule === "node-type"));
});

test("HTTP calls to the server or its private network are refused", () => {
  for (const url of ["http://postgres:5432", "http://localhost:5678/api/v1/workflows", "http://169.254.169.254/latest", "http://10.0.0.5/", "http://172.18.0.1:8650/", "http://n8n:5678"]) {
    const g = guardDraft(draft([node("t", "n8n-nodes-base.manualTrigger"), node("h", "n8n-nodes-base.httpRequest", { url })]));
    assert.equal(g.ok, false, url);
  }
  const ok = guardDraft(draft([node("t", "n8n-nodes-base.manualTrigger"), node("h", "n8n-nodes-base.httpRequest", { url: "https://api.weather.gov/points" })]));
  assert.equal(ok.ok, true);
});

test("extra top-level fields (pinData, staticData, active) are refused", () => {
  for (const extra of [{ pinData: {} }, { staticData: {} }, { active: true }]) {
    assert.equal(guardDraft(draft([node("t", "n8n-nodes-base.manualTrigger")], extra)).ok, false, Object.keys(extra)[0]);
  }
  assert.equal(guardDraft(draft([node("t", "n8n-nodes-base.manualTrigger")], { settings: { callerPolicy: "any" } })).ok, false);
});

test("an unauthenticated webhook is a warning, not a block", () => {
  const g = guardDraft(draft([node("w", "n8n-nodes-base.webhook", { path: "supplier-digest" }), node("s", "n8n-nodes-base.slack")]));
  assert.equal(g.ok, true);
  assert.ok(g.warnings.some((w) => w.rule === "public-endpoint"));
});

// --- duplicates -------------------------------------------------------------------

const estate = [
  {
    id: "SHOP",
    name: "Shopify Catch-All Webhook",
    active: true,
    tags: tags("sys:shopify", "sys:warehouse-db"),
    nodes: [node("w", "n8n-nodes-base.webhook", { path: "shopify-catchall" }), node("pg", "n8n-nodes-base.postgres", { query: "insert into raw.shopify_events values ($1)" })]
  },
  {
    id: "BOM",
    name: "BOM (flat) → Google Sheet (daily 6am)",
    active: true,
    nodes: [node("s", "n8n-nodes-base.scheduleTrigger"), node("pg", "n8n-nodes-base.postgres", { query: "select * from core.bom_flat" }), node("g", "n8n-nodes-base.googleSheets", { documentId: { value: "1AbC" } })]
  },
  { id: "OLD", name: "Shopify Catch-All Webhook (old)", isArchived: true, nodes: [] }
];

test("the same webhook path is a blocking duplicate", () => {
  const g = guardDraft(draft([node("w", "n8n-nodes-base.webhook", { path: "shopify-catchall" }), node("s", "n8n-nodes-base.slack")], { name: "Orders hook" }), { workflows: estate });
  assert.equal(g.ok, false);
  assert.ok(g.blocked.some((b) => b.rule === "duplicate" && /Shopify Catch-All/.test(b.why)));
});

test("a near-identical name is a blocking duplicate", () => {
  const g = guardDraft(draft([node("s", "n8n-nodes-base.scheduleTrigger"), node("x", "n8n-nodes-base.slack")], { name: "Flat BOM to Google Sheet daily" }), { workflows: estate });
  assert.equal(g.ok, false);
  assert.ok(g.blocked.some((b) => b.rule === "duplicate" && /BOM/.test(b.why)));
});

test("same trigger, systems and targets is a blocking duplicate under any name", () => {
  const copy = draft(
    [node("s", "n8n-nodes-base.scheduleTrigger"), node("pg", "n8n-nodes-base.postgres", { query: "select * from core.bom_flat" }), node("g", "n8n-nodes-base.googleSheets", { documentId: { value: "1AbC" } })],
    { name: "Morning parts export" }
  );
  const dupes = findDuplicates(copy, estate);
  assert.ok(dupes.some((d) => d.workflowId === "BOM" && d.blocking), JSON.stringify(dupes));
});

test("archived workflows are not counted as duplicates", () => {
  const dupes = findDuplicates({ name: "Shopify Catch-All Webhook (old)", nodes: [] }, [estate[2]]);
  assert.equal(dupes.length, 0);
});

test("unrelated drafts are not flagged", () => {
  const g = guardDraft(draft([node("s", "n8n-nodes-base.scheduleTrigger"), node("x", "n8n-nodes-base.slack")], { name: "Remind team about stand-up" }), { workflows: estate });
  assert.equal(g.ok, true);
  assert.equal(g.duplicates.length, 0);
});

test("only an admin with a written reason can override a duplicate", () => {
  const d = draft([node("w", "n8n-nodes-base.webhook", { path: "shopify-catchall" })], { name: "Orders hook" });
  assert.equal(guardDraft(d, { workflows: estate, isAdmin: false, overrideDuplicate: "replacing the old one next week" }).ok, false);
  assert.equal(guardDraft(d, { workflows: estate, isAdmin: true, overrideDuplicate: "ok" }).ok, false, "a reason is required");
  assert.equal(guardDraft(d, { workflows: estate, isAdmin: true, overrideDuplicate: "replacing the old one next week" }).ok, true);
});

test("an admin cannot override a key or server-access block", () => {
  const g = guardDraft(draft([node("t", "n8n-nodes-base.manualTrigger"), node("x", "n8n-nodes-base.executeCommand")]), { isAdmin: true, overrideDuplicate: "trust me, it is fine" });
  assert.equal(g.ok, false);
});

// --- identity -----------------------------------------------------------------------

const TEAM = "example-team.cloudflareaccess.com";
const AUD = "a".repeat(64);
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256" };
const fetchCerts = async () => ({ ok: true, json: async () => ({ keys: [jwk] }) });

function sign(claims, { kid = "k1", key = privateKey } = {}) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = enc({ alg: "RS256", kid, typ: "JWT" });
  const body = enc(claims);
  const sig = createSign("RSA-SHA256").update(`${head}.${body}`).sign(key).toString("base64url");
  return `${head}.${body}.${sig}`;
}
const good = (over = {}) => ({ aud: [AUD], email: "Jo@Example.com", iss: `https://${TEAM}`, exp: Math.floor(Date.now() / 1000) + 600, ...over });

test("a valid Access token identifies the person, lower-cased", async () => {
  const id = createIdentity({ access: { teamDomain: TEAM, audience: AUD }, admins: ["admin@example.com"], fetchImpl: fetchCerts });
  const who = await id.identify({ headers: { "cf-access-jwt-assertion": sign(good()) } });
  assert.deepEqual(who, { email: "jo@example.com", isAdmin: false, source: "cloudflare-access" });
  const admin = await id.identify({ headers: { "cf-access-jwt-assertion": sign(good({ email: "admin@example.com" })) } });
  assert.equal(admin.isAdmin, true);
});

test("a spoofed email header without a valid token is rejected", async () => {
  const id = createIdentity({ access: { teamDomain: TEAM, audience: AUD }, admins: ["admin@example.com"], fetchImpl: fetchCerts });
  await assert.rejects(id.identify({ headers: { "cf-access-authenticated-user-email": "admin@example.com" } }), AuthError);
});

test("tokens with a bad signature, wrong audience, wrong issuer or past expiry are rejected", async () => {
  const keyCache = { get: async () => publicKey };
  const opts = { keyCache, audience: AUD, teamDomain: TEAM };
  const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
  await assert.rejects(verifyAccessJwt(sign(good(), { key: other }), opts), /signature/);
  await assert.rejects(verifyAccessJwt(sign(good({ aud: ["b".repeat(64)] })), opts), /different application/);
  await assert.rejects(verifyAccessJwt(sign(good({ iss: "https://evil.cloudflareaccess.com" })), opts), /issuer/);
  await assert.rejects(verifyAccessJwt(sign(good({ exp: 1000 })), opts), /expired/);
});

test("without Access settings the local actor is the admin", async () => {
  const who = await createIdentity({ localActor: "Sam" }).identify({ headers: {} });
  assert.deepEqual(who, { email: "Sam", isAdmin: true, source: "local" });
});

// --- config ---------------------------------------------------------------------------

const base = { n8n: { baseUrl: "http://n8n:5678", apiKey: "env:FLOCK_N8N_API_KEY" } };

test("env: references are accepted and literals still refused", () => {
  assert.doesNotThrow(() => validateConfig(base));
  assert.throws(() => validateConfig({ n8n: { baseUrl: "http://n8n:5678", apiKey: "n8n_api_123456" } }), ConfigError);
  assert.throws(() => validateConfig({ n8n: { baseUrl: "http://n8n:5678", apiKey: "env:lowercase" } }), ConfigError);
});

test("access requires a team domain, a 64-hex audience and at least one admin", () => {
  assert.throws(() => validateConfig({ ...base, access: { teamDomain: TEAM, audience: AUD } }), /admins is required/);
  assert.throws(() => validateConfig({ ...base, access: { teamDomain: "evil.com", audience: AUD }, admins: ["a@b.c"] }), /teamDomain/);
  assert.throws(() => validateConfig({ ...base, access: { teamDomain: TEAM, audience: "short" }, admins: ["a@b.c"] }), /audience/);
  assert.doesNotThrow(() => validateConfig({ ...base, access: { teamDomain: TEAM, audience: AUD }, admins: ["admin@example.com"] }));
});

test("env: references resolve from the environment and fail loudly when unset", async () => {
  assert.equal(await resolveSecret("env:FLOCK_X", { env: { FLOCK_X: "v" } }), "v");
  await assert.rejects(resolveSecret("env:FLOCK_X", { env: {} }), /not set/);
});
