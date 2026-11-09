// Thin n8n REST client. Reads are unrestricted; writes go through an explicit
// allowlist so a Shepherd bug cannot reach an endpoint nobody reviewed.
const READ_PATHS = [
  /^workflows(\?|$)/,
  /^workflows\/[^/]+$/,
  /^workflows\/[^/]+\/history$/,
  /^workflows\/[^/]+\/test-runs(\?|$)/,
  /^workflows\/[^/]+\/test-runs\/[^/]+$/,
  /^workflows\/[^/]+\/test-runs\/[^/]+\/test-cases$/,
  /^workflows\/[^/]+\/tags$/,
  /^executions(\?|$)/,
  /^executions\/[^/]+$/,
  /^users(\?|$)/,
  /^credentials(\?|$)/,
  /^tags(\?|$)/,
  /^insights\/summary$/,
  /^projects\/[^/]+\/folders$/,
  /^data-tables(\?|$)/,
  /^node-type-policies\/instance$/,
  /^node-type-policies\/policies(\?|$)/,
  /^credential-type-policies\/instance$/,
  /^source-control\/status\?/
];

// Every write Flock performs, and nothing else. Creating a draft is the point
// of the Builder; the security audit is a POST that only reads the instance.
// The rest are the bulk-organisation operations, which are planned and
// confirmed before they run. Archiving and deleting are deliberately absent.
const WRITE_PATHS = [
  /^workflows$/,
  /^audit$/,
  /^workflows\/[^/]+$/, // update (folder move) — merges, never partial
  /^workflows\/[^/]+\/tags$/, // replace tag list
  /^workflows\/[^/]+\/activate$/,
  /^workflows\/[^/]+\/deactivate$/
];

export function isAllowed(method, path) {
  // Only GET reads and the listed writes are ever permitted. Anything else —
  // DELETE, PATCH, HEAD — is refused outright rather than falling through to
  // the read list, which would otherwise match a path like workflows/abc.
  if (method !== "GET" && method !== "POST" && method !== "PUT") return false;
  const allowed = method === "GET" ? READ_PATHS : WRITE_PATHS;
  return allowed.some((re) => re.test(path));
}

export class N8nError extends Error {
  constructor(message, { status, path } = {}) {
    super(message);
    this.status = status;
    this.path = path;
  }
}

export function createN8nClient({ baseUrl, apiKey, cfAccessClientId, cfAccessClientSecret, fetchImpl = fetch }) {
  if (!baseUrl) throw new N8nError("baseUrl is required");
  if (!apiKey) throw new N8nError("apiKey is required");

  const root = baseUrl.replace(/\/$/, "");

  function headers() {
    const h = { "X-N8N-API-KEY": apiKey, Accept: "application/json" };
    if (cfAccessClientId) h["CF-Access-Client-Id"] = cfAccessClientId;
    if (cfAccessClientSecret) h["CF-Access-Client-Secret"] = cfAccessClientSecret;
    return h;
  }

  async function request(method, path, body) {
    if (!isAllowed(method, path)) {
      throw new N8nError(`refused ${method} ${path}: not on the allowlist`, { path });
    }
    const init = { method, headers: headers() };
    if (body !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const res = await fetchImpl(`${root}/api/v1/${path}`, init);
    const text = await res.text();
    let parsed = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }
    if (!res.ok) {
      const detail = parsed && parsed.message ? parsed.message : `HTTP ${res.status}`;
      throw new N8nError(detail, { status: res.status, path });
    }
    return parsed;
  }

  async function listAll(path, { limit = 250, maxPages = 20 } = {}) {
    const out = [];
    let cursor = null;
    for (let page = 0; page < maxPages; page += 1) {
      const sep = path.includes("?") ? "&" : "?";
      const url = `${path}${sep}limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const body = await request("GET", url);
      if (!body || !Array.isArray(body.data)) break;
      out.push(...body.data);
      cursor = body.nextCursor;
      if (!cursor) break;
    }
    return out;
  }

  return {
    listWorkflows: () => listAll("workflows"),
    getWorkflow: (id) => request("GET", `workflows/${encodeURIComponent(id)}`),
    listExecutions: (opts = {}) => {
      const params = new URLSearchParams();
      if (opts.workflowId) params.set("workflowId", opts.workflowId);
      if (opts.status) params.set("status", opts.status);
      if (opts.limit) params.set("limit", String(opts.limit));
      const qs = params.toString();
      return request("GET", `executions${qs ? `?${qs}` : ""}`);
    },
    listUsers: () => listAll("users"),
    listCredentials: () => listAll("credentials"),
    listTags: () => listAll("tags"),
    // The folders handler answers { count, data }, not the list collection
    // shape the other endpoints use.
    listFolders: async (projectId) => {
      const body = await request("GET", `projects/${encodeURIComponent(projectId)}/folders`);
      return (body && Array.isArray(body.data)) ? body.data : [];
    },
    insightsSummary: () => request("GET", "insights/summary"),
    listTestRuns: async (workflowId) => {
      const body = await request("GET", `workflows/${encodeURIComponent(workflowId)}/test-runs`);
      return (body && Array.isArray(body.data)) ? body.data : [];
    },
    getTestRunCases: (workflowId, runId) =>
      request("GET", `workflows/${encodeURIComponent(workflowId)}/test-runs/${encodeURIComponent(runId)}/test-cases`),
    getWorkflowHistory: async (workflowId) => {
      const body = await request("GET", `workflows/${encodeURIComponent(workflowId)}/history`);
      return (body && Array.isArray(body.data)) ? body.data : [];
    },
    getWorkflowTags: async (workflowId) => {
      const body = await request("GET", `workflows/${encodeURIComponent(workflowId)}/tags`);
      // This endpoint answers with a bare array, not the { data } collection
      // shape the other list endpoints use. Reading .data here silently
      // returned [] and made add-tags replace the whole tag list.
      if (Array.isArray(body)) return body;
      return (body && Array.isArray(body.data)) ? body.data : [];
    },
    setWorkflowTags: (workflowId, tags) =>
      request("PUT", `workflows/${encodeURIComponent(workflowId)}/tags`, tags),
    updateWorkflow: (workflowId, workflow) =>
      request("PUT", `workflows/${encodeURIComponent(workflowId)}`, workflow),
    activateWorkflow: (workflowId) => request("POST", `workflows/${encodeURIComponent(workflowId)}/activate`),
    deactivateWorkflow: (workflowId) => request("POST", `workflows/${encodeURIComponent(workflowId)}/deactivate`),
    listDataTables: async () => {
      const body = await request("GET", "data-tables");
      return (body && Array.isArray(body.data)) ? body.data : [];
    },
    getNodeTypePolicy: () => request("GET", "node-type-policies/instance"),
    getCredentialTypePolicy: () => request("GET", "credential-type-policies/instance"),
    getSourceControlStatus: (direction = "push") => request("GET", `source-control/status?direction=${direction}`),
    // Read-only in effect: it inspects the instance and returns a report.
    generateAudit: (options = {}) => request("POST", "audit", { additionalOptions: options }),
    // The single write. Always lands inactive: n8n creates drafts unpublished.
    createWorkflow: (workflow) => request("POST", "workflows", workflow)
  };
}
