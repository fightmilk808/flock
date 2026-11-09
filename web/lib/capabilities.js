// n8n exposes a large API surface, but an instance only enables the parts its
// licence covers. Rather than assume, probe each feature once, cache the
// answer, and let every screen say "not licensed here" instead of failing.

// Each probe names the endpoint that proves the feature works and how to read
// the answer. A 403 with a licence message means "unlicensed"; any other error
// is recorded as its own reason so a network problem is not mistaken for a
// licensing one.
export const CAPABILITY_PROBES = {
  nodePolicies: {
    label: "Node type policies",
    detail: "n8n blocks node types server-side before a workflow can use them.",
    scope: "nodeTypePolicy:manage",
    probe: (client) => client.getNodeTypePolicy().then((p) => p)
  },
  credentialPolicies: {
    label: "Credential type policies",
    detail: "n8n restricts which credential types can be attached.",
    scope: "credentialTypePolicy:manage",
    probe: (client) => client.getCredentialTypePolicy().then((p) => p)
  },
  evaluation: {
    label: "Evaluation (test runs)",
    detail: "Saved test cases a change must pass before it goes live.",
    scope: "testRun:list",
    // A workflow-scoped endpoint; proving it needs any workflow id. An empty
    // instance cannot prove it, which is reported honestly.
    probe: (client, ctx) =>
      ctx.workflowId ? client.listTestRuns(ctx.workflowId) : Promise.reject(new ProbeSkip("no workflow to probe"))
  },
  securityAudit: {
    label: "Security audit",
    detail: "n8n's own instance-wide risk report.",
    scope: "securityAudit:generate",
    // POST runs the audit; it is read-only in effect but costs CPU, so Flock
    // calls it on demand rather than on boot. The probe only checks licensing
    // by requesting the cheapest possible report.
    probe: (client) => client.generateAudit({ categories: ["instance"] })
  },
  sourceControl: {
    label: "Source control",
    detail: "Whether the instance is in sync with its git branch.",
    scope: "sourceControl:read",
    probe: (client) => client.getSourceControlStatus("push")
  },
  insights: {
    label: "Insights",
    detail: "Run totals, failure rate and average run time.",
    scope: "insights:read",
    probe: (client) => client.insightsSummary()
  },
  workflowHistory: {
    label: "Version history",
    detail: "Every published version of a workflow, for rollback.",
    scope: "workflow:read",
    probe: (client, ctx) =>
      ctx.workflowId ? client.getWorkflowHistory(ctx.workflowId) : Promise.reject(new ProbeSkip("no workflow to probe"))
  },
  dataTables: {
    label: "Data tables",
    detail: "n8n-native tables a workflow can read and write.",
    scope: "dataTable:read",
    probe: (client) => client.listDataTables()
  }
};

export class ProbeSkip extends Error {}

const UNLICENSED = /license does not allow|upgrade to a license/i;

function classify(err, scope) {
  if (err instanceof ProbeSkip) return { available: false, reason: "not-testable" };
  const message = String((err && err.message) || "");
  if (err && err.status === 403) {
    // A bare "Forbidden" means the API key lacks the scope, which is fixable
    // without a licence change. A licence message means the feature is not in
    // the plan at all. The two need different fixes, so they are not merged.
    if (UNLICENSED.test(message)) return { available: false, reason: "unlicensed" };
    return { available: false, reason: "missing-scope", scope: scope || null };
  }
  if (err && err.status === 404) return { available: false, reason: "not-found" };
  if (err && err.status === 401) return { available: false, reason: "unauthorized" };
  return { available: false, reason: "error", error: message.slice(0, 200) };
}

// Results are cached because probing POSTs an audit and lists test runs; doing
// that on every page load would be wasteful and, for the audit, slow.
export function createCapabilityCache({ ttlMs = 10 * 60_000 } = {}) {
  let cached = null;
  let cachedAt = 0;
  let inflight = null;

  async function probeAll(client, ctx = {}) {
    const entries = await Promise.all(
      Object.entries(CAPABILITY_PROBES).map(async ([key, def]) => {
        try {
          const data = await def.probe(client, ctx);
          return [key, { available: true, label: def.label, detail: def.detail, data }];
        } catch (err) {
          return [key, { label: def.label, detail: def.detail, ...classify(err, def.scope) }];
        }
      })
    );
    return Object.fromEntries(entries);
  }

  return {
    async get(client, ctx = {}, { force = false } = {}) {
      const fresh = cached && Date.now() - cachedAt < ttlMs;
      if (fresh && !force) return cached;
      if (inflight) return inflight;
      inflight = probeAll(client, ctx)
        .then((result) => {
          cached = result;
          cachedAt = Date.now();
          return result;
        })
        .finally(() => {
          inflight = null;
        });
      return inflight;
    },
    clear() {
      cached = null;
      cachedAt = 0;
    }
  };
}

// A capability is only trusted when it is available *and* returned usable data.
export function isAvailable(caps, key) {
  return Boolean(caps && caps[key] && caps[key].available);
}

export function unavailableReason(caps, key) {
  const entry = caps && caps[key];
  if (!entry) return "unknown";
  return entry.reason || "unavailable";
}
