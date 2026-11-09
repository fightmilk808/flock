// Finds secrets pasted into workflow nodes instead of referenced from a
// credential or an environment variable. Doing this by hand means opening every
// node of every workflow; Flock runs it continuously.

// Node parameters that legitimately hold a URL or a name, never a secret.
const SAFE_PARAM_KEYS = new Set([
  "url",
  "authentication",
  "resource",
  "operation",
  "method",
  "name",
  "description",
  "notes",
  "documentId",
  "sheetName",
  "range",
  "channel",
  "channelId",
  "text",
  "message",
  "subject",
  "fromEmail",
  "toEmail",
  "path",
  "fileName",
  "table",
  "schema",
  "query",
  "options",
  "conditions",
  "rules",
  "values",
  "fields",
  "columns",
  "bodyParameters"
]);

// A value that looks like a credential rather than prose or an identifier.
export const SECRET_SHAPES = [
  { name: "Shopify webhook secret", re: /\b[0-9a-f]{64}\b/i },
  { name: "Slack token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: "Slack webhook URL", re: /hooks\.slack\.com\/services\/T[A-Za-z0-9]+\/B[A-Za-z0-9]+\/[A-Za-z0-9]+/ },
  { name: "Google Chat webhook", re: /chat\.googleapis\.com\/v1\/spaces\/[^/]+\/messages\?key=[^&\s]+&token=[^&\s]+/ },
  { name: "AWS access key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{20,}/ },
  { name: "OpenAI/Anthropic key", re: /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/ },
  { name: "Bearer token literal", re: /Bearer\s+[A-Za-z0-9._-]{20,}/ },
  { name: "Private key block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "JWT", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ }
];

// A Code node reading $env is the sanctioned pattern; a literal assignment to a
// SECRET-ish name is not. The name is matched loosely and then tested, because
// a greedy prefix in one pattern would fail on a bare `SECRET`.
// The literal must be the whole right-hand side: a concatenation such as
// `const threadKey = 'dropship-' + po` is a derived identifier, not a secret.
const CODE_ASSIGN = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(['"`])([^'"`]{8,})\2\s*(?=[;\n)]|$)/gi;
const SECRET_NAME = /(SECRET|TOKEN|KEY|PASSWORD|PASSWD|CREDENTIAL|APIKEY)/i;

// A value that reads as a credential rather than a label: no whitespace, and
// long enough that a human would not have typed it as prose.
function looksLikeSecret(literal) {
  if (/\s/.test(literal)) return false;
  if (literal.length < 16) return false;
  return true;
}

function walkStrings(value, path, out) {
  if (typeof value === "string") {
    out.push({ path, value });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => walkStrings(item, `${path}[${i}]`, out));
    return;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) walkStrings(v, path ? `${path}.${k}` : k, out);
  }
}

function redact(value) {
  if (value.length <= 8) return "•".repeat(value.length);
  return `${value.slice(0, 3)}…${value.slice(-2)} (${value.length} chars)`;
}

export function scanWorkflow(workflow) {
  const findings = [];
  for (const node of workflow.nodes || []) {
    const params = node.parameters || {};

    // 1. Code nodes: literal assignment to a secret-named variable.
    const code = params.jsCode || params.functionCode || params.code || "";
    if (typeof code === "string" && code) {
      CODE_ASSIGN.lastIndex = 0;
      let m;
      while ((m = CODE_ASSIGN.exec(code)) !== null) {
        const [, varName, , literal] = m;
        if (!SECRET_NAME.test(varName)) continue;
        if (literal.includes("$env") || literal.startsWith("{{")) continue;
        if (!looksLikeSecret(literal)) continue;
        findings.push({
          workflowId: workflow.id,
          workflowName: workflow.name,
          node: node.name,
          kind: "code-literal",
          secret: varName,
          preview: redact(literal),
          fix: `Read it from the environment: const ${varName} = $env.${varName};`
        });
      }
    }

    // 2. Any parameter value shaped like a known credential.
    const strings = [];
    walkStrings(params, "", strings);
    for (const { path, value } of strings) {
      const leaf = path.split(".").pop() || "";
      if (SAFE_PARAM_KEYS.has(leaf)) continue;
      if (value.includes("$env") || value.startsWith("={{") || value.startsWith("{{")) continue;
      for (const shape of SECRET_SHAPES) {
        if (shape.re.test(value)) {
          findings.push({
            workflowId: workflow.id,
            workflowName: workflow.name,
            node: node.name,
            kind: "param-literal",
            secret: shape.name,
            preview: redact(value),
            fix: "Move the value into an n8n credential or an environment variable and reference it as $env.NAME."
          });
          break;
        }
      }
    }
  }
  return findings;
}

export function scanWorkflows(workflows) {
  const findings = [];
  for (const wf of workflows) findings.push(...scanWorkflow(wf));
  return findings;
}

// The data boundary from the Shepherd screen: which systems a workflow touches,
// and whether any of them is a write to shared company data.
const SYSTEM_TAGS = {
  "sys:shopify": "Shopify",
  "sys:cin7": "Cin7",
  "sys:slack": "Slack",
  "sys:fdo": "FreightDesk",
  "sys:unishippers": "Unishippers",
  "sys:shipstation": "ShipStation",
  "sys:google-sheets": "Google Sheets",
  "sys:google-drive": "Google Drive",
  "sys:gmail": "Gmail",
  "sys:notion": "Notion",
  "sys:metabase": "Metabase",
  "sys:warehouse-db": "Company DB",
  "sys:printing": "Printing",
  "sys:ai": "AI"
};

export function systemsFor(workflow) {
  const tags = (workflow.tags || []).map((t) => t.name);
  return tags.filter((t) => SYSTEM_TAGS[t]).map((t) => SYSTEM_TAGS[t]);
}

// A workflow writes to shared company data when it carries a write-shaped node
// against the warehouse DB. Read-only nodes are fine.
const WRITE_NODE_TYPES = [
  "n8n-nodes-base.postgres",
  "n8n-nodes-base.supabase",
  "n8n-nodes-base.mySql",
  "n8n-nodes-base.microsoftSql"
];

export function writesCompanyData(workflow) {
  const tags = (workflow.tags || []).map((t) => t.name);
  if (!tags.includes("sys:warehouse-db")) return false;
  for (const node of workflow.nodes || []) {
    if (!WRITE_NODE_TYPES.includes(node.type)) continue;
    const op = node.parameters && node.parameters.operation;
    if (op && /^(insert|update|delete|upsert|executeQuery)$/i.test(op)) {
      if (op === "executeQuery") {
        const q = String(node.parameters.query || "");
        if (/\b(insert|update|delete|truncate|drop|alter)\b/i.test(q)) return true;
        continue;
      }
      return true;
    }
  }
  return false;
}
