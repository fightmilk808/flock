// Demo mode: a made-up n8n instance for a fictional coffee roaster, so anyone
// can try Flock with `npm run demo` before pointing it at their own n8n. Every
// workflow, run, person and key here is invented. The fake "leaked" keys are
// shaped like real ones so the security scan has something to find, but none
// of them is, or ever was, a working credential.
//
// The client has the same methods as createN8nClient. Writes (drafts, tags,
// on/off) change this in-memory copy only and are gone on restart.

import { N8nError } from "./n8n-client.js";

export const DEMO_CONFIG = {
  n8n: { baseUrl: "http://demo.invalid", projectId: "demo-project" },
  org: { name: "Juniper Coffee Roasters", adminName: "Maya" },
  watch: { intervalMinutes: 10 }
};

const B = "n8n-nodes-base.";
const L = "@n8n/n8n-nodes-langchain.";

// A node; positions are irrelevant because Flock lays workflows out itself.
const n = (name, type, parameters = {}, extra = {}) => ({ id: name, name, type, typeVersion: 1, position: [0, 0], parameters, ...extra });
const to = (node, index = 0) => ({ node, type: "main", index });
// Connections from a compact list: [from, output, to].
function wire(links) {
  const c = {};
  for (const [from, out, target] of links) {
    c[from] ||= { main: [] };
    while (c[from].main.length <= out) c[from].main.push([]);
    c[from].main[out].push(to(target));
  }
  return c;
}
const chain = (...names) => names.slice(1).map((name, i) => [names[i], 0, name]);

function workflows() {
  const list = [
    {
      id: "wf-orders", name: "Shopify order → roast queue", active: true, owner: "Maya", sys: ["shopify", "google-sheets", "slack"],
      nodes: [
        n("New Shopify order", B + "shopifyTrigger", { topic: "orders/create" }),
        n("Has whole-bean items?", B + "if"),
        n("Split line items", B + "splitOut"),
        n("Add to roast queue", B + "googleSheets", { operation: "append" }),
        n("Ground-only order", B + "noOp"),
        n("Merge", B + "merge"),
        n("Slack: post to #roastery", B + "slack", { channel: "#roastery" })
      ],
      links: [...chain("New Shopify order", "Has whole-bean items?"), ["Has whole-bean items?", 0, "Split line items"], ["Has whole-bean items?", 1, "Ground-only order"], ["Split line items", 0, "Add to roast queue"], ["Add to roast queue", 0, "Merge"], ["Ground-only order", 0, "Merge"], ["Merge", 0, "Slack: post to #roastery"]]
    },
    {
      id: "wf-wholesale", name: "Wholesale order intake", active: true, owner: "Theo", sys: ["gmail", "ai", "google-sheets", "slack"],
      nodes: [
        n("Wholesale inbox", B + "gmailTrigger"),
        n("Read the order", L + "agent"),
        n("Claude", L + "lmChatAnthropic"),
        n("Price list", L + "toolHttpRequest"),
        n("Route by size", B + "switch", { rules: { values: [{ renameOutput: true, outputKey: "Café" }, { renameOutput: true, outputKey: "Grocery" }] }, options: { fallbackOutput: "extra" } }),
        n("Café order sheet", B + "googleSheets", { operation: "append" }),
        n("Grocery order sheet", B + "googleSheets", { operation: "append" }),
        n("Slack: ask Theo", B + "slack", { channel: "@theo" })
      ],
      links: [...chain("Wholesale inbox", "Read the order", "Route by size"), ["Route by size", 0, "Café order sheet"], ["Route by size", 1, "Grocery order sheet"], ["Route by size", 2, "Slack: ask Theo"]],
      ai: [["Claude", "ai_languageModel", "Read the order"], ["Price list", "ai_tool", "Read the order"]]
    },
    {
      id: "wf-stock", name: "Green coffee stock check", active: true, owner: "Priya", sys: ["warehouse-db", "slack"],
      nodes: [
        n("Every morning", B + "scheduleTrigger"),
        n("PG: green stock by origin", B + "postgres", { operation: "executeQuery" }),
        n("Below reorder level?", B + "filter"),
        n("Slack: reorder list", B + "slack", { channel: "#sourcing" })
      ],
      links: chain("Every morning", "PG: green stock by origin", "Below reorder level?", "Slack: reorder list")
    },
    {
      id: "wf-labels", name: "Roast-day label PDFs", active: true, owner: "Priya", sys: ["google-sheets", "google-drive"],
      nodes: [
        n("Roast schedule updated", B + "googleSheetsTrigger"),
        n("Loop over batches", B + "splitInBatches"),
        n("Render label", B + "httpRequest", { url: "http://labels:8080/render" }),
        n("Convert to PDF", B + "convertToFile"),
        n("Upload label PDF", B + "googleDrive", { operation: "upload" }),
        n("Done", B + "noOp")
      ],
      links: [["Roast schedule updated", 0, "Loop over batches"], ["Loop over batches", 0, "Done"], ["Loop over batches", 1, "Render label"], ["Render label", 0, "Convert to PDF"], ["Convert to PDF", 0, "Upload label PDF"], ["Upload label PDF", 0, "Loop over batches"]]
    },
    {
      id: "wf-reviews", name: "Review digest", active: true, owner: "Theo", sys: ["ai", "notion", "slack"],
      nodes: [
        n("Every Monday", B + "scheduleTrigger"),
        n("Fetch reviews", B + "httpRequest", { url: "https://api.reviews.example/v1/reviews" }),
        n("Summarise", L + "chainSummarization"),
        n("GPT", L + "lmChatOpenAi"),
        n("Notion: weekly page", B + "notion", { operation: "create" }),
        n("Slack: link it", B + "slack", { channel: "#team" })
      ],
      links: chain("Every Monday", "Fetch reviews", "Summarise", "Notion: weekly page", "Slack: link it"),
      ai: [["GPT", "ai_languageModel", "Summarise"]]
    },
    {
      id: "wf-subs", name: "Subscription renewals", active: true, owner: "Maya", sys: ["shopify", "gmail"],
      nodes: [
        n("Renewal webhook", B + "webhook", { path: "renewals", authentication: "headerAuth" }),
        n("Card failed?", B + "if"),
        n("Email: update your card", B + "gmail", { operation: "send" }),
        n("Shopify: tag customer", B + "shopify", { operation: "update" })
      ],
      links: [...chain("Renewal webhook", "Card failed?"), ["Card failed?", 0, "Email: update your card"], ["Card failed?", 1, "Shopify: tag customer"]]
    },
    {
      // The deliberate mistake: a token pasted into a header. The token
      // is fake; it exists so the security scan has a finding to show.
      id: "wf-cafe", name: "Café sales to sheet", active: true, owner: "Sam", sys: ["google-sheets", "slack"],
      nodes: [
        n("Every hour", B + "scheduleTrigger"),
        n("POS: last hour's sales", B + "httpRequest", { url: "https://pos.example/api/sales" }),
        n("Append to sales sheet", B + "googleSheets", { operation: "append" }),
        n("Slack: big day?", B + "httpRequest", {
          url: "https://slack.com/api/chat.postMessage",
          headerParameters: { parameters: [{ name: "Authorization", value: "Bearer demo-not-a-real-token-0000000000" }] }
        })
      ],
      links: chain("Every hour", "POS: last hour's sales", "Append to sales sheet", "Slack: big day?")
    },
    {
      // Re-triggers itself through its own webhook: the loop guard's example.
      id: "wf-sync", name: "Inventory sync (retry loop)", active: true, owner: "Sam", sys: ["shopify", "warehouse-db"],
      nodes: [
        n("Sync webhook", B + "webhook", { path: "sync", authentication: "headerAuth" }),
        n("PG: stock levels", B + "postgres", { operation: "executeQuery" }),
        n("Shopify: set inventory", B + "shopify", { operation: "update" }),
        n("Retry if busy", B + "httpRequest", { url: "http://localhost:5678/webhook/sync" })
      ],
      links: chain("Sync webhook", "PG: stock levels", "Shopify: set inventory", "Retry if busy")
    },
    {
      id: "wf-errors", name: "Error handler → Slack", active: true, owner: "Maya", sys: ["slack"],
      nodes: [n("When any workflow fails", B + "errorTrigger"), n("Slack: #alerts", B + "slack", { channel: "#alerts" })],
      links: chain("When any workflow fails", "Slack: #alerts")
    },
    {
      id: "wf-support", name: "Support agent (website chat)", active: true, owner: "Theo", sys: ["ai", "notion"],
      nodes: [
        n("Website chat", L + "chatTrigger"),
        n("Support agent", L + "agent"),
        n("Claude Haiku", L + "lmChatAnthropic"),
        n("Chat memory", L + "memoryBufferWindow"),
        n("Brew guides (Notion)", B + "notionTool"),
        n("Order status", L + "toolWorkflow")
      ],
      links: chain("Website chat", "Support agent"),
      ai: [["Claude Haiku", "ai_languageModel", "Support agent"], ["Chat memory", "ai_memory", "Support agent"], ["Brew guides (Notion)", "ai_tool", "Support agent"], ["Order status", "ai_tool", "Support agent"]]
    },
    {
      id: "wf-csa", name: "Farm partner newsletter", active: false, owner: "Priya", sys: ["notion", "gmail"],
      nodes: [n("Manual run", B + "manualTrigger"), n("Notion: this month's farm", B + "notion"), n("Email partners", B + "gmail", { operation: "send" })],
      links: chain("Manual run", "Notion: this month's farm", "Email partners")
    },
    {
      id: "wf-old", name: "Old Etsy importer", active: false, owner: "Sam", sys: ["google-sheets"],
      nodes: [n("Manual run", B + "manualTrigger"), n("Read Etsy CSV", B + "extractFromFile"), n("Append rows", B + "googleSheets", { operation: "append" })],
      links: chain("Manual run", "Read Etsy CSV", "Append rows")
    }
  ];

  const tagId = (name) => `tag-${name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
  return list.map((w, i) => {
    const connections = wire(w.links);
    for (const [from, kind, target] of w.ai || []) {
      connections[from] ||= {};
      connections[from][kind] = [[{ node: target, type: kind, index: 0 }]];
    }
    const tags = [w.owner, ...w.sys.map((s) => `sys:${s}`)].map((name) => ({ id: tagId(name), name }));
    const day = 86_400_000;
    return {
      id: w.id,
      name: w.name,
      active: w.active,
      nodes: w.nodes,
      connections,
      tags,
      settings: { executionOrder: "v1" },
      createdAt: new Date(Date.now() - (60 - i * 3) * day).toISOString(),
      updatedAt: new Date(Date.now() - (i % 5) * day - i * 3_600_000).toISOString()
    };
  });
}

// Deterministic pseudo-random numbers, so the demo looks the same every run.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

// Runs over the last 24 hours. Runs per day and failure rates are per workflow;
// the retry loop gets a burst of 90 runs in under a minute an hour ago.
function executions(wfs, now = Date.now()) {
  const rand = rng(42);
  const plan = { "wf-orders": [70, 0.02], "wf-wholesale": [14, 0.07], "wf-stock": [1, 0], "wf-labels": [6, 0], "wf-reviews": [1, 0], "wf-subs": [9, 0.11], "wf-cafe": [24, 0], "wf-sync": [30, 0.2], "wf-errors": [5, 0], "wf-support": [40, 0.05] };
  const out = [];
  let id = 5000;
  for (const wf of wfs) {
    const [perDay, failRate] = plan[wf.id] || [0, 0];
    for (let k = 0; k < perDay; k += 1) {
      const start = now - rand() * 86_400_000;
      out.push(run(wf.id, start, rand() < failRate ? "error" : "success"));
    }
  }
  const burst = now - 3_600_000;
  for (let k = 0; k < 90; k += 1) out.push(run("wf-sync", burst + k * 550, k % 9 === 8 ? "error" : "success"));
  function run(workflowId, start, status) {
    id += 1;
    const ms = 300 + Math.floor(rand() * 4000);
    return { id: String(id), workflowId, status, finished: status === "success", mode: "trigger", startedAt: new Date(start).toISOString(), stoppedAt: new Date(start + ms).toISOString() };
  }
  return out.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
}

const USERS = [{ id: "u1", email: "maya@juniper.example", firstName: "Maya", lastName: "Okafor", role: "global:owner" }];

export function createDemoN8nClient() {
  const wfs = workflows();
  const runs = executions(wfs);
  let nextId = 1;

  const find = (id) => {
    const wf = wfs.find((w) => w.id === id);
    if (!wf) throw new N8nError("Not Found", { status: 404, path: `workflows/${id}` });
    return wf;
  };
  const allTags = () => {
    const seen = new Map();
    for (const w of wfs) for (const t of w.tags) seen.set(t.id, t);
    return [...seen.values()];
  };
  const forbidden = (path, message = "Forbidden") => Promise.reject(new N8nError(message, { status: 403, path }));
  const copy = (x) => JSON.parse(JSON.stringify(x));

  return {
    listWorkflows: async () => copy(wfs),
    getWorkflow: async (id) => copy(find(id)),
    listExecutions: async ({ workflowId, status, limit = 100 } = {}) => ({
      data: runs.filter((r) => (!workflowId || r.workflowId === workflowId) && (!status || r.status === status)).slice(0, limit)
    }),
    listUsers: async () => copy(USERS),
    listCredentials: async () => [],
    listTags: async () => allTags(),
    listFolders: async () => [
      { id: "f-orders", name: "Orders", parentFolderId: null },
      { id: "f-roastery", name: "Roastery", parentFolderId: null },
      { id: "f-support", name: "Support", parentFolderId: null }
    ],
    insightsSummary: async () => ({ total: { value: runs.length }, failed: { value: runs.filter((r) => r.status === "error").length } }),
    listTestRuns: (id) => forbidden(`workflows/${id}/test-runs`, "Forbidden: missing scope testRun:list"),
    getTestRunCases: () => forbidden("test-cases"),
    getWorkflowHistory: async (id) => {
      const wf = find(id);
      const day = 86_400_000;
      return [0, 1, 3, 9].map((d, i) => ({
        versionId: `${id}-v${4 - i}`,
        createdAt: new Date(Date.parse(wf.updatedAt) - d * day).toISOString(),
        authors: ["Maya Okafor", "Theo Lind", "Maya Okafor", "Priya Shah"][i]
      }));
    },
    getWorkflowTags: async (id) => copy(find(id).tags),
    setWorkflowTags: async (id, tags) => {
      const wf = find(id);
      const known = new Map(allTags().map((t) => [t.id, t]));
      wf.tags = tags.map((t) => known.get(t.id) || { id: t.id, name: t.name || t.id });
      return copy(wf.tags);
    },
    updateWorkflow: async (id, body) => {
      const wf = find(id);
      if (body && body.parentFolderId !== undefined) wf.parentFolderId = body.parentFolderId;
      return copy(wf);
    },
    activateWorkflow: async (id) => { const wf = find(id); wf.active = true; return copy(wf); },
    deactivateWorkflow: async (id) => { const wf = find(id); wf.active = false; return copy(wf); },
    listDataTables: async () => [],
    getNodeTypePolicy: () => forbidden("node-type-policies/instance", "Forbidden: missing scope nodeTypePolicy:manage"),
    getCredentialTypePolicy: () => forbidden("credential-type-policies/instance", "Forbidden: missing scope credentialTypePolicy:manage"),
    getSourceControlStatus: () => forbidden("source-control/status", "Your license does not allow for feat:sourceControl"),
    generateAudit: async () => ({
      "Credentials Risk Report": {
        risk: "credentials",
        sections: [{ title: "Credentials not used in any workflow", description: "2 credentials are not used by any workflow.", recommendation: "Remove credentials nobody uses." }]
      },
      "Nodes Risk Report": {
        risk: "nodes",
        sections: [{ title: "Official risky nodes", description: "1 workflow calls an HTTP endpoint on localhost.", recommendation: "Check that internal calls are intended." }]
      }
    }),
    createWorkflow: async (workflow) => {
      const created = { ...copy(workflow), id: `demo-draft-${nextId++}`, active: false, tags: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      wfs.push(created);
      return copy(created);
    }
  };
}

// Shepherd without a model: two scripted turns so the chat and the drawing can
// be tried with no API key. A question first, then a branching draft.
export function createDemoLlm() {
  return {
    async draftWorkflow(request, { history = [] } = {}) {
      const asked = history.some((t) => t.role === "assistant" && /which channel/i.test(t.content || ""));
      if (!asked && !/draw|build|make|create|when /i.test(request)) {
        return {
          kind: "answer",
          reply: "Demo Shepherd here: I only know one trick without a model key. Ask me to build something, like \"when a wholesale order is over $500, post it to Slack\"."
        };
      }
      if (!asked) {
        return {
          kind: "answer",
          reply: "Happy to draw that. Which channel should the alert go to, and should small orders be logged somewhere too?"
        };
      }
      return {
        kind: "draft",
        reply: "Here's a draft: big orders go to Slack, the rest are logged to the sheet. Nothing is created until you say so, and it lands unpublished.",
        name: "Big wholesale orders → Slack",
        description: "Alerts on large wholesale orders and logs the rest.",
        steps: [
          { name: "New wholesale order", nodeType: "n8n-nodes-base.webhook", why: "Starts when the order form posts." },
          { name: "Over $500?", nodeType: "n8n-nodes-base.if", why: "Splits big orders from small ones." },
          { name: "Slack: #wholesale", nodeType: "n8n-nodes-base.slack", why: "Posts big orders. An admin attaches the Slack credential in n8n.", after: "Over $500?", output: 0 },
          { name: "Log to order sheet", nodeType: "n8n-nodes-base.googleSheets", why: "Keeps a record of smaller orders.", after: "Over $500?", output: 1 }
        ],
        questions: ["Which Google Sheet should small orders go to?"]
      };
    }
  };
}
