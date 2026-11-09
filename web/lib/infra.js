// Which workflows are "infrastructure": the automations the business already
// runs on. Only an admin may change them through Flock. Everyone else
// can look at them, and can organize workflows that are not infrastructure.
//
// The rules are deliberately broad. A workflow is infrastructure when ANY rule
// matches, and every match is reported as a reason, so the lock is explainable
// rather than a mystery. A false positive costs a staff member a request to
// the admin; a false negative could switch off something the business needs.

// Systems whose data the company runs on. Touching any of them makes a
// workflow infrastructure, whether the evidence is a sys: tag or a node.
export const COMPANY_SYSTEMS = new Set([
  "cin7",
  "shopify",
  "shipstation",
  "fdo",
  "unishippers",
  "warehouse-db",
  "printing",
  "google-drive",
  "metabase",
  "gmail"
]);

// Node types that reach the host, other workflows, or n8n itself. Any of these
// is infrastructure regardless of anything else.
const SYSTEM_NODE_TYPES = [
  [/\.executeCommand$/i, "runs shell commands on the server"],
  [/\.ssh$/i, "opens SSH sessions"],
  [/\.(readWriteFile|readBinaryFiles?|writeBinaryFile|localFileTrigger)$/i, "reads or writes server files"],
  [/^n8n-nodes-base\.n8n$/i, "manages n8n itself through its API"],
  [/\.errorTrigger$/i, "is an error handler for other workflows"],
  [/\.executeWorkflowTrigger$/i, "is a subflow other workflows call"],
  [/\.executeWorkflow$/i, "calls other workflows"]
];

// Node types that read or write a company system directly.
const NODE_SYSTEMS = [
  [/\.postgres(Trigger)?$/i, "warehouse-db"],
  [/shopify/i, "shopify"],
  [/shipstation/i, "shipstation"],
  [/\.gmail(Trigger)?$/i, "gmail"],
  [/\.emailReadImap$/i, "gmail"],
  [/\.googleDrive(Trigger)?$/i, "google-drive"],
  [/metabase/i, "metabase"]
];

// HTTP hosts that are company systems.
const HOST_SYSTEMS = [
  [/(^|\.)dearsystems\.com$|(^|\.)dearinventory\.com$|(^|\.)cin7\.com$/i, "cin7"],
  [/(^|\.)myshopify\.com$|(^|\.)shopify\.com$/i, "shopify"],
  [/(^|\.)shipstation\.com$/i, "shipstation"],
  [/(^|\.)freightdesk\.online$/i, "fdo"],
  [/(^|\.)unishippers\.com$/i, "unishippers"]
];

const NAME_RULES = [
  [/^\[subflow\]/i, "is a subflow"],
  [/^\[one-shot\]/i, "is an admin one-shot"],
  [/catch-?all/i, "is a catch-all webhook"],
  [/\bsync\b/i, "is a sync"],
  [/security|canary/i, "is a security workflow"],
  [/error handler/i, "is an error handler"],
  [/pipeline/i, "is a pipeline"]
];

export function hostOf(url) {
  if (typeof url !== "string") return null;
  const m = url.match(/^\s*=?\s*https?:\/\/([^/:?#\s{}]+)/i);
  return m ? m[1].toLowerCase() : null;
}

// Systems a workflow touches, from its tags and its nodes.
// `internalHosts` are your own domains (e.g. "example.com"): a request to one
// of them, or a subdomain, counts as the "internal" system.
export function systemsOf(workflow, { internalHosts = [] } = {}) {
  const systems = new Set();
  for (const tag of workflow.tags || []) {
    const name = typeof tag === "string" ? tag : tag && tag.name;
    if (name && name.startsWith("sys:")) systems.add(name.slice(4));
  }
  for (const node of workflow.nodes || []) {
    for (const [re, sys] of NODE_SYSTEMS) if (re.test(node.type || "")) systems.add(sys);
    const host = hostOf(node.parameters && node.parameters.url);
    if (host) for (const [re, sys] of HOST_SYSTEMS) if (re.test(host)) systems.add(sys);
    if (host && internalHosts.some((h) => host === h.toLowerCase() || host.endsWith(`.${h.toLowerCase()}`))) systems.add("internal");
  }
  return systems;
}

function tagNames(workflow) {
  return (workflow.tags || []).map((t) => (typeof t === "string" ? t : t && t.name)).filter(Boolean);
}

export function classifyWorkflow(workflow, { internalHosts = [], companySystems = null } = {}) {
  const companySet = companySystems ? new Set(companySystems) : COMPANY_SYSTEMS;
  const reasons = [];
  const tags = tagNames(workflow);

  if (tags.includes("infra")) reasons.push("is tagged infra");
  if (workflow.active) reasons.push("is on (running in production)");

  for (const node of workflow.nodes || []) {
    for (const [re, why] of SYSTEM_NODE_TYPES) {
      if (re.test(node.type || "") && !reasons.includes(why)) reasons.push(why);
    }
  }

  const company = [...systemsOf(workflow, { internalHosts })].filter((s) => companySet.has(s) || s === "internal");
  if (company.length) reasons.push(`touches company systems: ${company.sort().join(", ")}`);

  for (const [re, why] of NAME_RULES) if (re.test(workflow.name || "")) reasons.push(why);

  return { infra: reasons.length > 0, reasons };
}

export function classifyAll(workflows, options = {}) {
  const out = new Map();
  for (const wf of workflows) out.set(wf.id, classifyWorkflow(wf, options));
  return out;
}

// Tags that carry meaning for this lock. Only an admin may add or remove them.
export const RESERVED_TAGS = new Set(["infra"]);
