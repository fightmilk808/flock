import { logoForSystem, logoForNode } from "./logos.js";
// Turns the live n8n payloads into the view models the three screens render.
// Everything here is derived; nothing is invented. When a field is missing the
// screen shows "unknown" rather than a plausible-looking placeholder.

import { systemsFor, writesCompanyData } from "./security-scan.js";
import { extractEdges } from "./flow-graph.js";
import { glyphFor } from "./glyphs.js";

const WINDOW_MS = { hour: 60 * 60_000, day: 24 * 60 * 60_000, week: 7 * 24 * 60 * 60_000 };

// Systems the runs map knows by name, from sys:* tags (e.g. sys:slack).
const SYSTEMS = [
  { key: "sys:shopify", label: "Shopify", initials: "S", color: "#3F6E28" },
  { key: "sys:cin7", label: "Cin7", initials: "C7", color: "#1F4FBF" },
  { key: "sys:shipstation", label: "ShipStation", initials: "SS", color: "#0F766E" },
  { key: "sys:warehouse-db", label: "Company DB", initials: "DB", color: "#334155", note: "writes need an admin" },
  { key: "sys:slack", label: "Slack", initials: "Sl", color: "#4A154B" },
  { key: "sys:google-sheets", label: "Google Sheets", initials: "GS", color: "#137333" },
  { key: "sys:fdo", label: "FreightDesk", initials: "FD", color: "#B45309" },
  { key: "sys:unishippers", label: "Unishippers", initials: "UN", color: "#6D28D9" },
  { key: "sys:ai", label: "Agents", initials: "AI", color: "#BE185D" },
  { key: "sys:printing", label: "Printing", initials: "PR", color: "#0E7490" },
  { key: "sys:gmail", label: "Gmail", initials: "GM", color: "#C2410C" },
  { key: "sys:notion", label: "Notion", initials: "NO", color: "#15171C" },
  { key: "sys:metabase", label: "Metabase", initials: "MB", color: "#1D4ED8" },
  { key: "sys:google-drive", label: "Google Drive", initials: "GD", color: "#A16207" }
];

// Tags that describe a workflow's subject or lifecycle, not who owns it. The
// a typical tag list mixes both, so ownership is decided by an explicit
// allowlist rather than "any tag without a colon".
const NON_OWNER_TAGS = new Set([
  "archive", "audit", "cron", "ingest", "webhook", "mcp", "unconfirmed",
  "Do Not Share", "Found-Template", "QR", "cooper", "slack"
]);

// n8n Community has one project and one user today, so attribution comes from
// a person tag on the workflow (e.g. "owner:sam"), falling back to the single
// instance user. It is labelled as an inference, never presented as fact.
export function ownerTagsFrom(tagNames) {
  return (tagNames || []).filter((t) => !t.includes(":") && !NON_OWNER_TAGS.has(t));
}

export function ownerOf(workflow, ownerTags, users) {
  const tags = (workflow.tags || []).map((t) => t.name);
  const tagged = tags.find((t) => ownerTags.includes(t));
  if (tagged) return tagged;
  const user = (users || [])[0];
  if (!user) return "Unattributed";
  return `${user.firstName || ""} ${user.lastName || ""}`.trim() || user.email || "Unattributed";
}

export function buildPeople({ workflows, users, tagNames }) {
  const byPerson = new Map();
  const ownerTags = ownerTagsFrom(tagNames);

  for (const wf of workflows) {
    const owner = ownerOf(wf, ownerTags, users);
    if (!byPerson.has(owner)) byPerson.set(owner, { name: owner, count: 0, systems: new Set() });
    const person = byPerson.get(owner);
    person.count += 1;
    for (const s of systemsFor(wf)) person.systems.add(s);
  }

  const palette = ["#4A55C7", "#B45309", "#0F766E", "#BE185D", "#6D28D9", "#0E7490"];
  return [...byPerson.values()]
    .sort((a, b) => b.count - a.count)
    .map((p, i) => ({
      name: p.name,
      initials: p.name.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase(),
      count: p.count,
      uses: [...p.systems].slice(0, 3).join(" · ") || "—",
      color: palette[i % palette.length],
      source: ownerTags.includes(p.name) ? "owner tag" : "instance user"
    }));
}

export function buildRunsMap({ workflows, executions, users, tagNames, range = "day", now = Date.now() }) {
  const window = WINDOW_MS[range] || WINDOW_MS.day;
  const cutoff = now - window;
  const ownerTags = ownerTagsFrom(tagNames);
  const counted = executions.filter((ex) => {
    const t = Date.parse(ex.startedAt);
    return !Number.isNaN(t) && t >= cutoff;
  });

  const runsByWorkflow = new Map();
  for (const ex of counted) {
    runsByWorkflow.set(ex.workflowId, (runsByWorkflow.get(ex.workflowId) || 0) + 1);
  }
  const failsByWorkflow = new Map();
  for (const ex of counted) {
    if (ex.status === "error" || ex.status === "crashed") {
      failsByWorkflow.set(ex.workflowId, (failsByWorkflow.get(ex.workflowId) || 0) + 1);
    }
  }

  const nodes = SYSTEMS.map((sys) => {
    const touching = workflows.filter((wf) => (wf.tags || []).some((t) => t.name === sys.key));
    const runs = touching.reduce((sum, wf) => sum + (runsByWorkflow.get(wf.id) || 0), 0);
    return { ...sys, workflowCount: touching.length, runs, logoPath: logoFor(sys.key) };
  }).filter((n) => n.workflowCount > 0);

  const edges = [];
  for (const wf of workflows) {
    const sys = systemsFor(wf);
    const runs = runsByWorkflow.get(wf.id) || 0;
    edges.push({
      workflowId: wf.id,
      name: wf.name,
      active: wf.active,
      runs,
      failures: failsByWorkflow.get(wf.id) || 0,
      systems: sys,
      owner: ownerOf(wf, ownerTags, users),
      writesCompanyData: writesCompanyData(wf),
      // Line thickness encodes run volume; 0-run workflows still appear thin.
      weight: runs
    });
  }
  edges.sort((a, b) => b.runs - a.runs);

  return {
    range,
    generatedAt: new Date(now).toISOString(),
    totals: {
      workflows: workflows.length,
      active: workflows.filter((w) => w.active).length,
      runs: counted.length
    },
    nodes,
    edges,
    builders: buildPeople({ workflows, users, tagNames })
  };
}

// Brand marks live in one place (logos.js) so every screen agrees.
export function logoFor(tag) {
  return logoForSystem(tag);
}

export function buildRecentRuns({ workflows, executions, limit = 8 }) {
  const byId = new Map(workflows.map((w) => [w.id, w]));
  return executions.slice(0, limit).map((ex) => {
    const wf = byId.get(ex.workflowId);
    const ok = ex.status === "success";
    const failed = ex.status === "error" || ex.status === "crashed";
    return {
      executionId: ex.id,
      workflowId: ex.workflowId,
      name: wf ? wf.name : `Unknown workflow (${ex.workflowId})`,
      status: ok ? "OK" : failed ? "Failed" : ex.status,
      tone: ok ? "ok" : failed ? "stop" : "warn",
      startedAt: ex.startedAt,
      stoppedAt: ex.stoppedAt
    };
  });
}

// Buckets executions into equal slices so the map can be scrubbed through time.
// The n8n executions endpoint returns newest-first with a cap, so a bucket far
// in the past can be sparse; the caller is told the sample size rather than
// being shown a curve that implies more data than was read.
export function buildTimeline({ executions, range = "day", buckets = 24, now = Date.now() }) {
  const window = WINDOW_MS[range] || WINDOW_MS.day;
  const start = now - window;
  const width = window / buckets;

  const slots = Array.from({ length: buckets }, (_, i) => ({
    index: i,
    from: new Date(start + i * width).toISOString(),
    to: new Date(start + (i + 1) * width).toISOString(),
    total: 0,
    failed: 0,
    byWorkflow: {}
  }));

  let inWindow = 0;
  for (const ex of executions) {
    const t = Date.parse(ex.startedAt);
    if (Number.isNaN(t) || t < start || t > now) continue;
    inWindow += 1;
    const i = Math.min(buckets - 1, Math.floor((t - start) / width));
    const slot = slots[i];
    slot.total += 1;
    if (ex.status === "error" || ex.status === "crashed") slot.failed += 1;
    slot.byWorkflow[ex.workflowId] = (slot.byWorkflow[ex.workflowId] || 0) + 1;
  }

  return {
    range,
    buckets: slots,
    sampleSize: executions.length,
    inWindow,
    // True when the execution read was capped, so the timeline is a sample and
    // the UI says so.
    truncated: executions.length >= 250
  };
}

// The Builder screen: a workflow's nodes laid out as steps, plus the guardrail
// status n8n itself does not surface.
export function buildWorkflowDetail({ workflow, findings, executions }) {
  // Sticky notes are canvas annotations, not steps.
  const nodes = (workflow.nodes || []).filter((n) => !/stickyNote$/i.test(n.type || "")).map((n, i) => ({
    index: i,
    name: n.name,
    type: n.type,
    isTrigger: isTriggerType(n.type),
    // The label must reflect what the node actually does: a postgres node
    // running a SELECT is a read, and calling it a write would be a false
    // claim about the data boundary.
    kind: nodeKind(n),
    icon: { ...iconFor(n.type), ...(glyphFor(n.type, n.name) || {}), ...(logoForNode(n.type, n.parameters, n.name) || {}) }
  }));

  // How the steps connect: branches, merges, loops and AI sub-nodes, so the
  // canvas can draw the same shape n8n does instead of a list.
  const drawn = (workflow.nodes || []).filter((n) => !/stickyNote$/i.test(n.type || ""));
  const edges = extractEdges(workflow, drawn);

  const wfFindings = findings.filter((f) => f.workflowId === workflow.id);
  const wfExecutions = executions.filter((e) => e.workflowId === workflow.id);
  const lastRun = wfExecutions[0] || null;

  return {
    id: workflow.id,
    name: workflow.name,
    description: workflow.description || null,
    active: workflow.active,
    versionId: workflow.versionId,
    updatedAt: workflow.updatedAt,
    createdAt: workflow.createdAt,
    folderId: workflow.parentFolderId || null,
    tags: (workflow.tags || []).map((t) => t.name),
    systems: systemsFor(workflow),
    nodes,
    edges,
    findings: wfFindings,
    writesCompanyData: writesCompanyData(workflow),
    lastRun: lastRun
      ? { status: lastRun.status, startedAt: lastRun.startedAt, executionId: lastRun.id }
      : null,
    secretsClean: wfFindings.length === 0
  };
}

function iconFor(type) {
  if (/webhook/i.test(type)) return { initials: "WH", color: "#B45309" };
  if (/schedule|cron/i.test(type)) return { initials: "⏰", color: "#6D28D9" };
  if (/trigger/i.test(type)) return { initials: "T", color: "#4A55C7" };
  if (/postgres|supabase|mySql|sql/i.test(type)) return { initials: "DB", color: "#334155" };
  if (/slack/i.test(type)) return { initials: "Sl", color: "#4A154B" };
  if (/googleSheets|spreadsheet/i.test(type)) return { initials: "GS", color: "#137333" };
  if (/httpRequest|http/i.test(type)) return { initials: "H", color: "#0E7490" };
  if (/shopify/i.test(type)) return { initials: "S", color: "#3F6E28" };
  if (/code/i.test(type)) return { initials: "{}", color: "#5B6170" };
  if (/if|switch|filter/i.test(type)) return { initials: "IF", color: "#A16207" };
  if (/agent|langchain/i.test(type)) return { initials: "AI", color: "#BE185D" };
  return { initials: "•", color: "#8A8F9A" };
}

const DB_NODE = /postgres|supabase|mySql|microsoftSql|sql/i;
const WRITE_OP = /^(insert|update|delete|upsert|create|drop|truncate|alter)$/i;

// n8n marks trigger nodes by a "Trigger" suffix (scheduleTrigger,
// manualTrigger) or by being the webhook node itself. A plain substring test
// would also match respondToWebhook, which is an action, not a trigger.
export function isTriggerType(type) {
  if (typeof type !== "string") return false;
  const short = type.replace(/^n8n-nodes-base\./, "");
  if (/Trigger$/.test(short)) return true;
  return short === "webhook" || short === "chatTrigger" || /^[a-z]+Poll$/.test(short);
}

export function nodeKind(node) {
  if (isTriggerType(node.type)) return "Trigger";
  if (DB_NODE.test(node.type)) {
    const params = node.parameters || {};
    const op = params.operation;
    if (typeof op === "string" && WRITE_OP.test(op)) return "Write";
    if (op === "executeQuery") {
      const q = String(params.query || "");
      return /\b(insert|update|delete|truncate|drop|alter)\b/i.test(q) ? "Write" : "Read";
    }
    return "Read";
  }
  if (/if|switch|filter|merge|split/i.test(node.type)) return "Branch";
  return "Step";
}

// Folders arrive as a flat list with parent pointers; the sidebar wants a tree.
export function buildFolderTree(folders) {
  const byId = new Map(folders.map((f) => [f.id, { ...f, children: [] }]));
  const roots = [];
  for (const f of byId.values()) {
    if (f.parentFolderId && byId.has(f.parentFolderId)) byId.get(f.parentFolderId).children.push(f);
    else roots.push(f);
  }
  const sortRec = (list) => {
    list.sort((a, b) => a.name.localeCompare(b.name));
    for (const item of list) sortRec(item.children);
  };
  sortRec(roots);
  return roots;
}

// The arcs the map draws: one per pair of systems, carrying every workflow
// that connects them. A workflow touching three systems contributes to all
// three pairs, so no connection is silently dropped.
export function buildPairs(edges) {
  const pairs = new Map();
  for (const e of edges) {
    const sys = [...new Set(e.systems || [])].sort();
    for (let i = 0; i < sys.length; i += 1) {
      for (let j = i + 1; j < sys.length; j += 1) {
        const key = `${sys[i]}↔${sys[j]}`;
        if (!pairs.has(key)) pairs.set(key, { key, a: sys[i], b: sys[j], workflows: [], runs: 0, failures: 0, active: 0 });
        const p = pairs.get(key);
        p.workflows.push({
          workflowId: e.workflowId,
          name: e.name,
          runs: e.runs || 0,
          failures: e.failures || 0,
          active: Boolean(e.active),
          owner: e.owner,
          writesCompanyData: Boolean(e.writesCompanyData)
        });
        p.runs += e.runs || 0;
        p.failures += e.failures || 0;
        if (e.active) p.active += 1;
      }
    }
  }
  for (const p of pairs.values()) {
    p.workflows.sort((x, y) => y.runs - x.runs || Number(y.active) - Number(x.active) || x.name.localeCompare(y.name));
    p.owner = p.workflows[0] && p.workflows[0].owner;
  }
  return [...pairs.values()].sort((x, y) => y.runs - x.runs);
}
