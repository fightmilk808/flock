// The background watcher: runs the guardrails on a timer, so they hold when
// nobody has Flock open. It raises each problem once, clears it when it goes
// away, and can post to Slack.
//
// Deliberately NOT here: individual workflow failures. n8n's own error
// workflows already handle those; alerting again would duplicate them.

import { scanWorkflows } from "./security-scan.js";
import { analyseExecutions } from "./loop-guard.js";

// Everything the watcher considers a live problem right now, keyed so the same
// problem has the same key on every tick.
export function currentProblems({ workflows, executions }) {
  const problems = [];
  for (const f of scanWorkflows(workflows)) {
    problems.push({
      key: `secret:${f.workflowId}:${f.node}:${f.secret}`,
      kind: "secret",
      workflowId: f.workflowId,
      title: `Secret pasted into "${f.workflowName}"`,
      detail: `${f.node}: ${f.secret} (${f.preview})`
    });
  }
  const names = new Map(workflows.map((w) => [w.id, w.name]));
  for (const f of analyseExecutions(executions)) {
    problems.push({
      key: `loop:${f.workflowId}`,
      kind: "loop",
      workflowId: f.workflowId,
      title: `"${names.get(f.workflowId) || f.workflowId}" looks like it is looping`,
      detail: f.detail
    });
  }
  return problems;
}

// Staff activity worth knowing about, from Flock's own audit log.
export function activityAlerts(auditRows, { admins = [] } = {}) {
  const isAdmin = (who) => admins.map((a) => a.toLowerCase()).includes(String(who).toLowerCase());
  const out = [];
  for (const r of auditRows) {
    if (r.action === "workflow.draft-created" && !isAdmin(r.actor)) {
      out.push({ key: `audit:${r.id}`, kind: "draft", workflowId: r.target, title: `${r.actor} created a draft: "${r.detail}"`, detail: "Unpublished. Review it in n8n before publishing." });
    }
    if (r.action === "workflow.draft-refused") {
      out.push({ key: `audit:${r.id}`, kind: "refused", workflowId: null, title: `Flock refused a draft from ${r.actor}: "${r.target}"`, detail: `Blocked by: ${r.detail}` });
    }
    if (r.action.startsWith("bulk.") && !isAdmin(r.actor)) {
      out.push({ key: `audit:${r.id}`, kind: "bulk", workflowId: null, title: `${r.actor} ran ${r.action.slice(5)} on ${r.target}`, detail: r.detail });
    }
  }
  return out;
}

// `baseUrl` is where Flock is reachable and `n8nUiUrl` where the n8n editor
// is; without them the message carries no links.
export function slackText(alerts, { baseUrl = null, n8nUiUrl = null } = {}) {
  const icon = { secret: "🔑", loop: "🔁", draft: "📝", refused: "🛑", bulk: "🗂️" };
  const lines = alerts.slice(0, 10).map((a) => {
    const link = n8nUiUrl && a.workflowId && !String(a.workflowId).includes(" ") ? ` <${n8nUiUrl}/workflow/${a.workflowId}|open>` : "";
    return `${icon[a.kind] || "•"} *${a.title}*${link}\n      ${a.detail || ""}`;
  });
  if (alerts.length > 10) lines.push(`…and ${alerts.length - 10} more`);
  return `🐑 *Flock* found ${alerts.length} new thing${alerts.length === 1 ? "" : "s"} · ${baseUrl ? `<${baseUrl}/shepherd.html|Shepherd>` : "Shepherd"}\n${lines.join("\n")}`;
}

// One tick. `send` is optional; without it alerts are only recorded in-app.
// The very first tick records what already exists without sending, so turning
// the watcher on does not post a backlog everyone already knows about.
export async function runWatch({ store, workflows, executions, admins, send, links = {}, now = new Date().toISOString() }) {
  const firstRun = store.getMeta("watch.lastRun") === null;
  const fresh = [];

  const problems = currentProblems({ workflows, executions });
  const liveKeys = new Set(problems.map((p) => p.key));
  for (const p of problems) {
    if (store.raiseAlert({ ...p, at: now, notified: firstRun ? "baseline" : null }) && !firstRun) fresh.push(p);
  }
  for (const kind of ["secret", "loop"]) {
    for (const key of store.openAlertKeys(kind)) if (!liveKeys.has(key)) store.clearAlert(key, now);
  }

  const lastAudit = Number(store.getMeta("watch.lastAuditId") ?? store.maxAuditId());
  const activity = activityAlerts(store.auditSince(lastAudit), { admins });
  for (const a of activity) {
    if (store.raiseAlert({ ...a, at: now, notified: null })) fresh.push(a);
    store.clearAlert(a.key, now); // activity is a one-off notice, not a standing problem
  }
  store.setMeta("watch.lastAuditId", store.maxAuditId());

  let sent = false;
  let sendError = null;
  if (fresh.length && send) {
    try {
      await send(slackText(fresh, links));
      sent = true;
    } catch (err) {
      sendError = err.message;
    }
  }
  store.setMeta("watch.lastRun", now);
  if (sendError) store.setMeta("watch.lastError", `${now} ${sendError}`);
  return { firstRun, fresh, sent, sendError, open: store.openAlerts().length };
}

export function createSlackSender({ token, channel, fetchImpl = fetch }) {
  return async (text) => {
    const res = await fetchImpl("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ channel, text, unfurl_links: false })
    });
    const body = await res.json().catch(() => ({}));
    if (!body.ok) throw new Error(`Slack: ${body.error || res.status}`);
  };
}
