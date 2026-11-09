import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { extname, join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import { loadConfig, resolveN8nCredentials, resolveSecret, orgSettings, ConfigError } from "../web/lib/config.js";
import { createDemoN8nClient, createDemoLlm, DEMO_CONFIG } from "../web/lib/demo.js";
import { createN8nClient, N8nError } from "../web/lib/n8n-client.js";
import { scanWorkflows } from "../web/lib/security-scan.js";
import { analyseExecutions, groupFailures, runTimeStats } from "../web/lib/loop-guard.js";
import { openStore } from "../web/lib/approvals.js";
import { createCapabilityCache, isAvailable, unavailableReason } from "../web/lib/capabilities.js";
import {
  buildGuardrails,
  evaluateNodePolicy,
  summariseEvaluation,
  normaliseAuditReport
} from "../web/lib/guardrails.js";
import {
  buildRunsMap,
  buildRecentRuns,
  buildTimeline,
  buildWorkflowDetail,
  buildFolderTree
} from "../web/lib/aggregate.js";
import { buildWorkflowPayload, vetDraft, DraftError, isDraftTurn } from "../web/lib/shepherd.js";
import { createLlmClient, LlmError } from "../web/lib/llm.js";
import { extractAgents } from "../web/lib/agents.js";
import { planBulk, applyBulk, authorizeBulk, BulkError, BULK_OPS, ADMIN_ONLY_OPS } from "../web/lib/bulk.js";
import { classifyAll, RESERVED_TAGS, systemsOf } from "../web/lib/infra.js";
import { systemsFromTags } from "../web/lib/logos.js";
import { guardDraft } from "../web/lib/draft-guard.js";
import { createIdentity, AuthError } from "../web/lib/identity.js";
import { runWatch, createSlackSender } from "../web/lib/watch.js";

const webRoot = resolve(fileURLToPath(new URL("../web/", import.meta.url)));
const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2"
};

const HOST = process.env.FLOCK_HOST || "127.0.0.1";
const PORT = Number(process.env.FLOCK_PORT || 4174);
const CONFIG_PATH = process.env.FLOCK_CONFIG || join(repoRoot, "flock.config.json");
const DB_PATH = process.env.FLOCK_DB || join(repoRoot, "data", process.env.FLOCK_DEMO === "1" ? "flock-demo.db" : "flock.db");

// Who a request is from. Behind Cloudflare Access this is the verified email
// on the Access token (see web/lib/identity.js). Run locally with no `access`
// block, it is this single local actor, who is treated as the admin.
const LOCAL_ACTOR = process.env.FLOCK_ACTOR || (process.env.FLOCK_DEMO === "1" ? "maya@juniper.example" : "admin");
// Demo mode: made-up sample workflows and runs, no n8n and no keys needed.
const DEMO = process.env.FLOCK_DEMO === "1";
let identity;

let config;
let org;
let n8n;
let store;
let llm = null;
const capabilities = createCapabilityCache();

async function boot() {
  if (DEMO) {
    config = DEMO_CONFIG;
    n8n = createDemoN8nClient();
  } else {
    config = await loadConfig(CONFIG_PATH);
    const creds = await resolveN8nCredentials(config);
    n8n = createN8nClient(creds);
  }
  org = orgSettings(config);
  await mkdir(dirname(DB_PATH), { recursive: true });
  store = openStore(DB_PATH);
  identity = createIdentity({ access: config.access, admins: config.admins || [], localActor: LOCAL_ACTOR });

  if (config.watch) {
    const w = config.watch;
    if (w.slack) {
      watchSend = createSlackSender({ token: await resolveSecret(w.slack.token), channel: w.slack.channel });
    }
    const every = (w.intervalMinutes || 10) * 60_000;
    setTimeout(watchTick, 30_000);
    setInterval(watchTick, every).unref();
  }

  if (DEMO) {
    llm = createDemoLlm();
  } else if (config.shepherd && config.shepherd.apiKey) {
    llm = createLlmClient({
      baseUrl: config.shepherd.baseUrl || "https://openrouter.ai/api/v1",
      apiKey: await resolveSecret(config.shepherd.apiKey),
      model: config.shepherd.model || "anthropic/claude-sonnet-4.5",
      org
    });
  }
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store"
  });
  res.end(payload);
}

function readBody(req, limit = 256 * 1024) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolvePromise(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// One snapshot per request keeps the three screens consistent with each other
// and keeps the number of n8n round-trips bounded.
async function snapshot() {
  const [workflows, executions, users, tags, folders] = await Promise.all([
    n8n.listWorkflows(),
    n8n.listExecutions({ limit: 250 }).then((r) => (r && r.data) || []),
    n8n.listUsers().catch(() => []),
    n8n.listTags().catch(() => []),
    n8n.listFolders(config.n8n.projectId).catch(() => [])
  ]);
  const findings = scanWorkflows(workflows);
  const infra = classifyAll(workflows, { internalHosts: org.internalHosts, companySystems: org.companySystems });
  return { workflows, executions, users, tags, folders, findings, infra };
}

let watchSend = null;
let watchRunning = false;
async function watchTick() {
  if (watchRunning) return null;
  watchRunning = true;
  try {
    const [workflows, executions] = await Promise.all([
      n8n.listWorkflows(),
      n8n.listExecutions({ limit: 250 }).then((r) => (r && r.data) || [])
    ]);
    const result = await runWatch({ store, workflows, executions, admins: config.admins || [], send: watchSend, links: { baseUrl: org.publicUrl, n8nUiUrl: org.n8nUiUrl } });
    if (result.fresh.length) console.log(`[flock] watch: ${result.fresh.length} new alert(s), sent=${result.sent}${result.sendError ? ` error=${result.sendError}` : ""}`);
    return result;
  } catch (err) {
    store.setMeta("watch.lastError", `${new Date().toISOString()} ${err.message}`);
    console.error("[flock] watch failed:", err.message);
    return null;
  } finally {
    watchRunning = false;
  }
}

// The systems a workflow touches (tags + nodes), with their logos.
function systemsWithLogos(wf) {
  return systemsFromTags([...systemsOf(wf, { internalHosts: org.internalHosts })].map((name) => `sys:${name}`));
}

const routes = {
  "GET /api/health": async (url, body, who) => ({
    ok: true,
    n8n: config.n8n.baseUrl,
    demo: DEMO,
    org: { name: org.name, adminName: org.adminName, n8nUiUrl: org.n8nUiUrl },
    shepherd: Boolean(llm),
    actor: who.email,
    isAdmin: who.isAdmin,
    auth: identity.mode
  }),

  // What the background watcher has raised and not yet seen go away.
  "GET /api/alerts": async () => ({
    enabled: Boolean(config.watch),
    slack: Boolean(watchSend),
    intervalMinutes: config.watch ? config.watch.intervalMinutes || 10 : null,
    lastRun: store.getMeta("watch.lastRun"),
    lastError: store.getMeta("watch.lastError"),
    alerts: store.openAlerts(50)
  }),

  "POST /api/watch/run": async (url, body, who) => {
    if (!who.isAdmin) return { error: `only ${org.adminName} can run the watcher by hand`, status: 403 };
    if (!config.watch) return { error: "the watcher is off (no watch block in config)", status: 409 };
    const r = await watchTick();
    return r ? { fresh: r.fresh.length, sent: r.sent, sendError: r.sendError, open: r.open, firstRun: r.firstRun } : { error: "watcher is already running or failed; see lastError", status: 409 };
  },

  // Which workflows are infrastructure, and why. Only admins can change them.
  "GET /api/infra": async () => {
    const snap = await snapshot();
    const rows = snap.workflows.map((wf) => ({
      id: wf.id,
      name: wf.name,
      active: wf.active,
      ...snap.infra.get(wf.id)
    }));
    return {
      infra: rows.filter((r) => r.infra),
      open: rows.filter((r) => !r.infra),
      counts: { infra: rows.filter((r) => r.infra).length, open: rows.filter((r) => !r.infra).length }
    };
  },

  // What this instance actually licenses. Cached; `?force=1` re-probes.
  "GET /api/capabilities": async (url) => {
    const workflows = await n8n.listWorkflows();
    const caps = await capabilities.get(
      n8n,
      { workflowId: workflows[0]?.id },
      { force: url.searchParams.get("force") === "1" }
    );
    return {
      capabilities: Object.fromEntries(
        Object.entries(caps).map(([key, value]) => [
          key,
          {
            label: value.label,
            detail: value.detail,
            available: value.available,
            reason: value.reason || null
          }
        ])
      )
    };
  },

  // n8n's own instance-wide risk report, run on demand.
  "POST /api/audit": async () => {
    const report = await n8n.generateAudit({});
    return { findings: normaliseAuditReport(report), raw: report };
  },

  // Version history for a workflow, so a bad publish can be traced.
  "GET /api/history": async (url) => {
    const id = url.searchParams.get("id");
    if (!id) return { error: "id is required", status: 400 };
    const versions = await n8n.getWorkflowHistory(id);
    return {
      versions: versions.map((v) => ({
        versionId: v.versionId,
        createdAt: v.createdAt,
        // The history endpoint lists versions, not their contents: it carries
        // an author but no nodes. The full version is a separate fetch, which
        // Flock does not do for a list.
        authors: v.authors || null,
        nodeCount: Array.isArray(v.nodes) ? v.nodes.length : null
      }))
    };
  },

  "GET /api/overview": async () => {
    const snap = await snapshot();
    const tagNames = snap.tags.map((t) => t.name);
    return {
      runsMap: buildRunsMap({
        workflows: snap.workflows,
        executions: snap.executions,
        users: snap.users,
        tagNames
      }),
      recent: buildRecentRuns({ workflows: snap.workflows, executions: snap.executions }),
      folders: buildFolderTree(snap.folders),
      counts: {
        personal: 0,
        company: snap.workflows.length,
        findings: snap.findings.length
      }
    };
  },

  "GET /api/runs": async (url) => {
    const range = url.searchParams.get("range") || "day";
    const snap = await snapshot();
    const map = buildRunsMap({
      workflows: snap.workflows,
      executions: snap.executions,
      users: snap.users,
      tagNames: snap.tags.map((t) => t.name),
      range
    });
    return {
      ...map,
      timeline: buildTimeline({
        executions: snap.executions,
        range,
        buckets: range === "hour" ? 30 : range === "week" ? 28 : 24
      })
    };
  },

  "GET /api/workflows": async () => {
    const snap = await snapshot();
    return {
      workflows: snap.workflows.map((wf) => ({
        id: wf.id,
        name: wf.name,
        active: wf.active,
        archived: wf.isArchived || false,
        updatedAt: wf.updatedAt,
        tags: (wf.tags || []).map((t) => t.name),
        folderId: wf.parentFolderId || null,
        findings: snap.findings.filter((f) => f.workflowId === wf.id).length,
        infra: snap.infra.get(wf.id).infra,
        infraReasons: snap.infra.get(wf.id).reasons,
        systems: systemsWithLogos(wf)
      }))
    };
  },

  // Agents as they are actually built here: LangChain agent nodes in workflows.
  // n8n's native Agents module has no public endpoint, and the screen says so.
  "GET /api/agents": async () => {
    const snap = await snapshot();
    const result = extractAgents({
      workflows: snap.workflows,
      executions: snap.executions,
      findings: snap.findings
    });
    return { ...result, counts: { company: snap.workflows.length, agents: result.summary.agentCount } };
  },

  // Everything the bulk panel needs to offer choices: the tag catalogue, the
  // folder tree, and the workflow list it can act on.
  "GET /api/bulk/options": async (url, body, who) => {
    const snap = await snapshot();
    return {
      actor: who.email,
      isAdmin: who.isAdmin,
      operations: Object.entries(BULK_OPS)
        .filter(([key]) => who.isAdmin || !ADMIN_ONLY_OPS.has(key))
        .map(([key, def]) => ({
          key,
          label: def.label,
          detail: def.detail,
          needs: def.needs
        })),
      tags: snap.tags.map((t) => ({ id: t.id, name: t.name })).sort((a, b) => a.name.localeCompare(b.name)),
      folders: snap.folders.map((f) => ({ id: f.id, name: f.name, parentFolderId: f.parentFolderId || null })),
      workflows: snap.workflows.map((wf) => ({
        id: wf.id,
        name: wf.name,
        active: wf.active,
        archived: wf.isArchived || false,
        tags: (wf.tags || []).map((t) => t.name),
        infra: snap.infra.get(wf.id).infra,
        infraReasons: snap.infra.get(wf.id).reasons,
        systems: systemsWithLogos(wf)
      }))
    };
  },

  // Plans without writing. The UI shows this list before anything is applied.
  "POST /api/bulk/plan": async (url, body, who) => {
    const snap = await snapshot();
    const plan = planBulk({
      op: body && body.op,
      workflowIds: body && body.workflowIds,
      tags: body && body.tags,
      folderId: body && body.folderId,
      tagCatalogue: snap.tags,
      folderCatalogue: snap.folders,
      workflows: snap.workflows
    });
    authorizeBulk(plan, { isAdmin: who.isAdmin, classification: snap.infra, reservedTags: RESERVED_TAGS, workflows: snap.workflows });
    const byId = new Map(snap.workflows.map((w) => [w.id, w]));
    return {
      plan,
      preview: plan.workflowIds.map((id) => ({
        id,
        name: byId.get(id)?.name || id,
        active: byId.get(id)?.active ?? null
      }))
    };
  },

  // Applies a plan. Requires the same plan to be re-sent, so a stale UI cannot
  // apply something the person did not see.
  "POST /api/bulk/apply": async (url, body, who) => {
    const snap = await snapshot();
    const plan = planBulk({
      op: body && body.op,
      workflowIds: body && body.workflowIds,
      tags: body && body.tags,
      folderId: body && body.folderId,
      tagCatalogue: snap.tags,
      folderCatalogue: snap.folders,
      workflows: snap.workflows
    });
    // Re-checked here, against a fresh snapshot: a plan approved a minute ago
    // may now include a workflow that has since become infrastructure.
    authorizeBulk(plan, { isAdmin: who.isAdmin, classification: snap.infra, reservedTags: RESERVED_TAGS, workflows: snap.workflows });
    const result = await applyBulk(n8n, plan);
    store.record(
      who.email,
      `bulk.${plan.op}`,
      `${plan.count} workflow(s)`,
      `${result.applied} applied, ${result.unchanged} unchanged, ${result.failed} failed`,
      new Date().toISOString()
    );
    return result;
  },

  "GET /api/workflow": async (url) => {
    const id = url.searchParams.get("id");
    if (!id) return { error: "id is required", status: 400 };
    const [workflow, executions] = await Promise.all([
      n8n.getWorkflow(id),
      n8n.listExecutions({ workflowId: id, limit: 20 }).then((r) => (r && r.data) || [])
    ]);
    const findings = scanWorkflows([workflow]);
    return buildWorkflowDetail({ workflow, findings, executions });
  },

  "GET /api/shepherd": async () => {
    const snap = await snapshot();
    const loopFindings = analyseExecutions(snap.executions);
    const failures = groupFailures(snap.executions);
    const byId = new Map(snap.workflows.map((w) => [w.id, w]));
    const caps = await capabilities.get(n8n, { workflowId: snap.workflows[0]?.id });

    // Every licensed probe is optional: a feature this instance does not have
    // returns null here and the guardrail card says so rather than guessing.
    const nodePolicy = isAvailable(caps, "nodePolicies")
      ? evaluateNodePolicy(caps.nodePolicies.data)
      : null;

    let evaluation = null;
    if (isAvailable(caps, "evaluation") && snap.workflows[0]) {
      const runs = await n8n.listTestRuns(snap.workflows[0].id).catch(() => null);
      evaluation = runs ? summariseEvaluation(runs) : null;
    }

    let auditFindings = null;
    if (isAvailable(caps, "securityAudit")) {
      const report = caps.securityAudit.data;
      auditFindings = normaliseAuditReport(report);
    }

    return {
      guardrails: buildGuardrails({
        caps,
        findings: snap.findings,
        loopFindings,
        failures,
        nodePolicy,
        evaluation,
        auditFindings
      }),
      capabilities: caps,
      nodePolicy,
      evaluation,
      auditFindings,
      insights: isAvailable(caps, "insights") ? caps.insights.data : null,
      runTime: runTimeStats(snap.executions),
      findings: snap.findings,
      loopFindings: loopFindings.map((f) => ({ ...f, workflowName: byId.get(f.workflowId)?.name || f.workflowId })),
      failures: failures.map((f) => ({ ...f, workflowName: byId.get(f.workflowId)?.name || f.workflowId })),
      counts: { company: snap.workflows.length, findings: snap.findings.length },
      approvals: store.pending(),
      audit: store.auditLog(30)
    };
  },

  "POST /api/approvals": async (url, body, who) => {
    const { workflowId, reason, risk } = body || {};
    if (!workflowId || !reason) return { error: "workflowId and reason are required", status: 400 };
    // A Shepherd draft is not in n8n yet, so it has no workflow to fetch.
    const workflowName =
      workflowId === "draft"
        ? String(body.draftName || "Shepherd draft").slice(0, 200)
        : (await n8n.getWorkflow(workflowId)).name;
    const approval = store.createApproval({
      id: randomUUID(),
      workflowId,
      workflowName,
      requestedBy: who.email,
      reason,
      risk: risk || "writes-company-data",
      createdAt: new Date().toISOString()
    });
    return approval;
  },

  "POST /api/approvals/decide": async (url, body, who) => {
    if (!who.isAdmin) return { error: `only ${org.adminName} can approve or deny`, status: 403 };
    const { id, decision, note } = body || {};
    if (!id || !["approved", "denied"].includes(decision)) {
      return { error: "id and decision (approved|denied) are required", status: 400 };
    }
    const row = store.decide({
      id,
      status: decision,
      decidedBy: who.email,
      note,
      at: new Date().toISOString()
    });
    if (!row) return { error: "approval not found or already decided", status: 409 };
    return row;
  },

  "POST /api/shepherd/draft": async (url, body, who) => {
    if (!llm) return { error: "Shepherd is not configured (no shepherd.apiKey)", status: 503 };
    const { request, history, currentDraft } = body || {};
    if (!request || typeof request !== "string") return { error: "request is required", status: 400 };

    const workflows = await n8n.listWorkflows();
    const draft = await llm.draftWorkflow(request.slice(0, 4000), {
      context: { workflows: workflows.map((w) => w.name) },
      history,
      currentDraft
    });
    const reply = typeof draft.reply === "string" ? draft.reply.trim().slice(0, 4000) : "";
    // A chat turn (a greeting, an answer, a question back) draws nothing.
    if (!isDraftTurn(draft)) {
      return { reply: reply || "Tell me a bit more about what it should do.", draft: null };
    }
    const payload = buildWorkflowPayload(draft);
    const vet = vetDraft(payload);
    const guard = guardDraft(payload, { workflows, isAdmin: who.isAdmin });

    // A draft is returned for review, never created here. Creation is a
    // separate, explicit call so the person sees the steps first.
    return {
      reply,
      draft: {
        name: payload.name,
        description: payload.description,
        steps: payload.nodes.map((n) => ({ name: n.name, type: n.type, why: n.notes })),
        questions: Array.isArray(draft.questions) ? draft.questions : []
      },
      vet,
      guard,
      payload
    };
  },

  "POST /api/shepherd/create": async (url, body, who) => {
    const { payload, overrideDuplicate } = body || {};
    if (!payload || typeof payload !== "object") return { error: "payload is required", status: 400 };
    // The payload comes from the browser, so it is checked again here in full:
    // node types, credentials, keys, server access and duplicates.
    const workflows = await n8n.listWorkflows();
    const guard = guardDraft(payload, { workflows, isAdmin: who.isAdmin, overrideDuplicate });
    if (!guard.ok) {
      store.record(who.email, "workflow.draft-refused", payload.name || "(unnamed)", guard.blocked.map((b) => b.rule).join(","), new Date().toISOString());
      return { error: `Flock will not create this: ${guard.blocked[0].why}`, guard, status: 422 };
    }
    const vet = vetDraft(payload);
    if (vet.findings.length) {
      return { error: "draft contains a secret literal; refusing to create", findings: vet.findings, status: 422 };
    }
    if (vet.needsApproval && !who.isAdmin) {
      return {
        error: "draft touches a high-risk system and needs an approval record first",
        risky: vet.risky,
        status: 409
      };
    }
    const created = await n8n.createWorkflow(payload);
    store.record(who.email, "workflow.draft-created", created.id, created.name, new Date().toISOString());
    return { created: { id: created.id, name: created.name, active: created.active } };
  }
};

async function serveStatic(pathname, res) {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const target = resolve(join(webRoot, rel));
  if (!target.startsWith(webRoot)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  try {
    const data = await readFile(target);
    res.writeHead(200, {
      "Content-Type": TYPES[extname(target)] || "application/octet-stream",
      "Cache-Control": "no-cache"
    });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const key = `${req.method} ${url.pathname}`;

  // /n8n/<path> opens the n8n editor, wherever this instance says it lives.
  if (url.pathname === "/n8n" || url.pathname.startsWith("/n8n/")) {
    const rest = url.pathname.slice(4) || "/home/workflows";
    if (DEMO || !org.n8nUiUrl) {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }).end("Demo mode: there is no n8n editor behind this link.");
      return;
    }
    res.writeHead(302, { Location: `${org.n8nUiUrl}${rest}` }).end();
    return;
  }

  if (!url.pathname.startsWith("/api/")) {
    await serveStatic(url.pathname, res);
    return;
  }

  const handler = routes[key];
  if (!handler) {
    json(res, 404, { error: `no route for ${key}` });
    return;
  }

  try {
    const who = await identity.identify(req);
    let body = null;
    if (req.method === "POST") {
      const raw = await readBody(req);
      body = raw ? JSON.parse(raw) : {};
    }
    const result = await handler(url, body, who);
    if (result && result.error && result.status) {
      json(res, result.status, result);
      return;
    }
    json(res, 200, result);
  } catch (err) {
    if (err instanceof AuthError) return json(res, 401, { error: err.message });
    if (err instanceof ConfigError) return json(res, 503, { error: err.message });
    if (err instanceof N8nError) return json(res, 502, { error: err.message, path: err.path });
    if (err instanceof DraftError) return json(res, 422, { error: err.message });
    if (err instanceof LlmError) return json(res, 502, { error: err.message });
    if (err instanceof BulkError) return json(res, 422, { error: err.message });
    if (err instanceof SyntaxError) return json(res, 400, { error: "request body is not valid JSON" });
    console.error("[flock]", err);
    json(res, 500, { error: "internal error" });
  }
});

boot()
  .then(() => {
    server.listen(PORT, HOST, () => {
      console.log(`Flock on http://${HOST}:${PORT}  (${DEMO ? "demo mode: sample data, nothing is real" : `n8n: ${config.n8n.baseUrl}`})`);
    });
  })
  .catch((err) => {
    console.error(`Flock failed to start: ${err.message}`);
    process.exit(1);
  });
