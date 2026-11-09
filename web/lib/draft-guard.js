// The guard every new automation passes before Flock will create it in n8n.
// It answers three questions, on the server, about the exact payload that
// would be sent — never trusting what the browser or the model claims:
//
//   1. Does it expose a secret or a key?      (blocked)
//   2. Could it reach the server, n8n itself, or the private network? (blocked)
//   3. Does it duplicate an automation that already exists? (blocked, unless
//      an admin overrides with a reason)
//
// Credentials are never attached by Flock. A draft that needs one says so in
// its questions, and an admin attaches it in the n8n editor before publishing.

import { scanWorkflow, SECRET_SHAPES } from "./security-scan.js";
import { systemsOf, hostOf } from "./infra.js";

const ALLOWED_NODE_TYPE = /^n8n-nodes-base\.[a-zA-Z]+$/;

// Node types a staff draft may never contain.
const DENIED_NODE_TYPES = [
  [/\.executeCommand$/i, "runs shell commands on the server"],
  [/\.ssh$/i, "opens SSH sessions"],
  [/\.ftp$/i, "opens FTP sessions"],
  [/\.(readWriteFile|readBinaryFiles?|writeBinaryFile|localFileTrigger)$/i, "reads or writes server files"],
  [/^n8n-nodes-base\.n8n$/i, "can change n8n itself, including credentials and other workflows"],
  [/\.(executeWorkflow|executeWorkflowTrigger)$/i, "calls or is called by other workflows"],
  [/\.errorTrigger$/i, "would take over error handling"],
  [/\.(code|function|functionItem)$/i, "runs arbitrary code, which can read the server's keys; ask an admin to add code in the editor"]
];

// Expressions that read keys or the server environment.
const KEY_EXPRESSIONS = /\$env\b|\$secrets\b|process\.env|\$credentials\b|\$vars\b/;

// Hosts that are the server itself, the Docker network, or the cloud metadata
// service. An HTTP step pointed at one could read internal services.
function isPrivateHost(host) {
  if (!host) return false;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) return true;
  if (!host.includes(".")) return true; // a bare Docker service name: postgres, n8n, metabase…
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (host === "0.0.0.0" || host.startsWith("[")) return true;
  return false;
}

const TOP_LEVEL_KEYS = new Set(["name", "description", "nodes", "connections", "settings"]);
const NODE_KEYS = new Set(["name", "type", "typeVersion", "position", "parameters", "notes"]);

function walk(value, visit, path = "") {
  if (typeof value === "string") return visit(value, path);
  if (Array.isArray(value)) return value.forEach((v, i) => walk(v, visit, `${path}[${i}]`));
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) walk(v, visit, path ? `${path}.${k}` : k);
  }
}

// --- duplicates ------------------------------------------------------------

const STOP_WORDS = new Set([
  "the", "and", "from", "into", "with", "when", "each", "every", "daily", "hourly", "weekly",
  "send", "post", "notify", "workflow", "automation", "new", "flow", "test", "draft", "copy"
]);

export function nameWords(name) {
  return new Set(
    String(name || "")
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9 ]+/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !STOP_WORDS.has(w))
  );
}

function triggerKind(workflow) {
  const first = (workflow.nodes || []).find((n) => /trigger|webhook|cron/i.test(n.type || ""));
  if (!first) return null;
  const t = first.type.split(".").pop().toLowerCase();
  if (/schedule|cron|interval/.test(t)) return "schedule";
  if (/webhook/.test(t)) return "webhook";
  if (/gmail|imap|email/.test(t)) return "email";
  if (/slack/.test(t)) return "slack";
  if (/chat/.test(t)) return "chat";
  if (/form/.test(t)) return "form";
  if (/manual/.test(t)) return "manual";
  return t;
}

const SQL_TABLE = /\b(?:from|into|update|join)\s+([a-z_][\w]*(?:\.[a-z_][\w]*)?)/gi;

// What a workflow does, as comparable tokens: its trigger, the systems it
// touches, and the concrete targets it reads or writes.
export function signature(workflow) {
  const tokens = new Set();
  const trig = triggerKind(workflow);
  if (trig) tokens.add(`trigger:${trig}`);
  for (const sys of systemsOf(workflow)) tokens.add(`sys:${sys}`);
  for (const node of workflow.nodes || []) {
    const kind = (node.type || "").split(".").pop();
    if (/^(slack|googleSheets|notion|postgres|httpRequest|airtable|discord|telegram)$/i.test(kind)) {
      tokens.add(`node:${kind.toLowerCase()}`);
    }
    const p = node.parameters || {};
    const host = hostOf(p.url);
    if (host) tokens.add(`host:${host}`);
    if (typeof p.path === "string" && /webhook/i.test(node.type)) tokens.add(`path:${p.path.trim().toLowerCase()}`);
    const ch = p.channelId && (p.channelId.value || p.channelId);
    if (typeof ch === "string" && ch.trim()) tokens.add(`channel:${ch.trim()}`);
    const doc = p.documentId && (p.documentId.value || p.documentId);
    if (typeof doc === "string" && doc.trim()) tokens.add(`doc:${doc.trim()}`);
    if (typeof p.query === "string") {
      for (const m of p.query.matchAll(SQL_TABLE)) tokens.add(`table:${m[1].toLowerCase()}`);
    }
  }
  return tokens;
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
}

// Same webhook path, a near-identical name, or the same trigger + systems +
// targets as an existing automation. Archived workflows are ignored.
export function findDuplicates(payload, workflows) {
  const sig = signature(payload);
  const words = nameWords(payload.name);
  const out = [];
  for (const wf of workflows) {
    if (wf.isArchived) continue;
    const other = signature(wf);
    const shared = [...sig].filter((t) => other.has(t));
    const samePath = shared.some((t) => t.startsWith("path:"));
    const nameScore = jaccard(words, nameWords(wf.name));
    const sigScore = jaccard(sig, other);
    const sharedSpecific = shared.filter((t) => !t.startsWith("trigger:") && !t.startsWith("node:"));
    const blocking = samePath || nameScore >= 0.6 || (sigScore >= 0.6 && sharedSpecific.length >= 2);
    const similar = blocking || nameScore >= 0.4 || (sigScore >= 0.45 && sharedSpecific.length >= 1);
    if (!similar) continue;
    out.push({
      workflowId: wf.id,
      workflowName: wf.name,
      active: Boolean(wf.active),
      blocking,
      why: samePath
        ? "uses the same webhook path"
        : nameScore >= 0.4
          ? `has a near-identical name (${Math.round(nameScore * 100)}% of words shared)`
          : `does the same thing: ${sharedSpecific.join(", ")}`
    });
  }
  return out.sort((a, b) => Number(b.blocking) - Number(a.blocking));
}

// --- the guard --------------------------------------------------------------

export function guardDraft(payload, { workflows = [], isAdmin = false, overrideDuplicate = "" } = {}) {
  const blocked = [];
  const warnings = [];

  if (!payload || typeof payload !== "object" || !Array.isArray(payload.nodes)) {
    return { ok: false, blocked: [{ rule: "shape", why: "payload must have a nodes array" }], warnings, duplicates: [] };
  }

  for (const key of Object.keys(payload)) {
    if (!TOP_LEVEL_KEYS.has(key)) blocked.push({ rule: "shape", why: `field "${key}" is not allowed in a draft` });
  }
  const settings = payload.settings || {};
  for (const key of Object.keys(settings)) {
    if (key !== "executionOrder") blocked.push({ rule: "shape", why: `setting "${key}" is not allowed in a draft` });
  }

  for (const node of payload.nodes) {
    const label = node && node.name ? `step "${node.name}"` : "a step";
    for (const key of Object.keys(node || {})) {
      if (key === "credentials") {
        blocked.push({ rule: "keys", why: `${label} attaches a credential; an admin attaches credentials in the n8n editor` });
      } else if (!NODE_KEYS.has(key)) {
        blocked.push({ rule: "shape", why: `${label} has field "${key}", which drafts may not set` });
      }
    }
    const type = (node && node.type) || "";
    if (!ALLOWED_NODE_TYPE.test(type)) {
      blocked.push({ rule: "node-type", why: `${label} uses a node type Flock will not create: ${type || "(none)"}` });
    }
    for (const [re, why] of DENIED_NODE_TYPES) {
      if (re.test(type)) blocked.push({ rule: "server-access", why: `${label} ${why}` });
    }

    walk(node && node.parameters, (value, path) => {
      if (KEY_EXPRESSIONS.test(value)) {
        blocked.push({ rule: "keys", why: `${label} reads keys or server settings at ${path}` });
      }
      // Every string, including url/text/message, which the workflow scanner
      // skips: a draft has no legitimate reason to carry a credential shape.
      for (const shape of SECRET_SHAPES) {
        if (shape.re.test(value)) blocked.push({ rule: "keys", why: `${label} contains what looks like a ${shape.name} at ${path}` });
      }
    });

    const host = hostOf(node && node.parameters && node.parameters.url);
    if (host && isPrivateHost(host)) {
      blocked.push({ rule: "server-access", why: `${label} calls ${host}, which is the server or its private network` });
    }
    if (/webhook/i.test(type)) {
      const auth = node.parameters && node.parameters.authentication;
      if (!auth || auth === "none") {
        warnings.push({ rule: "public-endpoint", why: `${label} is a webhook with no authentication; an admin must add it before publishing` });
      }
    }
  }

  for (const f of scanWorkflow({ id: "draft", name: payload.name, nodes: payload.nodes })) {
    blocked.push({ rule: "keys", why: `step "${f.node}" contains what looks like a secret (${f.secret})` });
  }

  const duplicates = findDuplicates(payload, workflows);
  const blockingDupes = duplicates.filter((d) => d.blocking);
  if (blockingDupes.length) {
    const override = isAdmin && typeof overrideDuplicate === "string" && overrideDuplicate.trim().length >= 10;
    if (override) {
      warnings.push({ rule: "duplicate", why: `admin override: ${overrideDuplicate.trim()}` });
    } else {
      for (const d of blockingDupes) {
        blocked.push({ rule: "duplicate", why: `duplicates "${d.workflowName}" (${d.workflowId}): it ${d.why}` });
      }
    }
  }
  for (const d of duplicates.filter((x) => !x.blocking)) {
    warnings.push({ rule: "similar", why: `similar to "${d.workflowName}" (${d.workflowId}): it ${d.why}` });
  }

  // De-duplicate identical reasons (one node can trip a rule twice).
  const uniq = (list) => [...new Map(list.map((x) => [`${x.rule}|${x.why}`, x])).values()];
  const finalBlocked = uniq(blocked);
  return { ok: finalBlocked.length === 0, blocked: finalBlocked, warnings: uniq(warnings), duplicates };
}
