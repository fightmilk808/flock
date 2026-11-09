// Shepherd turns a sentence into a *draft* workflow. It never publishes and
// never activates: the draft lands in n8n unpublished, for a human to review.
// Everything it proposes is re-validated here before it can be sent, because an
// LLM's output is untrusted input like any other.

import { scanWorkflow } from "./security-scan.js";
import { layoutGraph, extractEdges } from "./flow-graph.js";

const ALLOWED_NODE_TYPE = /^n8n-nodes-base\.[a-zA-Z]+$/;
// Node types that could move money, message customers, or write shared data.
// A draft may contain them, but the draft is flagged and cannot be created
// without an explicit approval record.
const HIGH_RISK_NODE_TYPE = /shopify|cin7|dear|httpRequestStatus|sendEmail/i;

// Shepherd is a conversation, not a form: every turn carries a chat reply, and
// only some turns carry a drawing. "answer" turns (a greeting, a question about
// n8n, a clarifying question back) leave the canvas alone.
export const DRAFT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "reply"],
  properties: {
    kind: { type: "string", enum: ["answer", "draft"] },
    reply: { type: "string" },
    name: { type: "string" },
    description: { type: "string" },
    steps: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "nodeType", "why"],
        properties: {
          name: { type: "string" },
          nodeType: { type: "string" },
          why: { type: "string" },
          // Branching: the step this one follows (default: the step before it)
          // and which of that step's outputs (IF: 0 = true, 1 = false).
          after: { type: "string" },
          output: { type: "integer" }
        }
      }
    },
    questions: { type: "array", items: { type: "string" } }
  }
};

export class DraftError extends Error {}

function asString(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new DraftError(`Shepherd returned an invalid ${field}`);
  }
  return value.trim();
}

// Turns the model's steps into a node/connection payload n8n will accept.
// Each step follows the step before it unless it names another with `after`,
// which is how a draft branches (an IF's true and false sides) and merges.
// Positions come from the same layout Flock draws, turned left-to-right the
// way n8n's canvas reads.
export function buildWorkflowPayload(draft, { projectId } = {}) {
  if (!draft || typeof draft !== "object") throw new DraftError("draft must be an object");
  const name = asString(draft.name, "name");
  if (!Array.isArray(draft.steps) || draft.steps.length === 0) {
    throw new DraftError("a draft needs at least one step");
  }
  if (draft.steps.length > 40) throw new DraftError("a draft may have at most 40 steps");

  const nodes = [];
  const seen = new Set();
  draft.steps.forEach((step, i) => {
    const stepName = asString(step.name, `steps[${i}].name`);
    const nodeType = asString(step.nodeType, `steps[${i}].nodeType`);
    if (!ALLOWED_NODE_TYPE.test(nodeType)) {
      throw new DraftError(`step "${stepName}" uses a node type Flock will not create: ${nodeType}`);
    }
    if (seen.has(stepName)) throw new DraftError(`duplicate step name: ${stepName}`);
    seen.add(stepName);

    const isTrigger = /trigger|webhook|cron/i.test(nodeType);
    nodes.push({
      name: stepName,
      type: nodeType,
      typeVersion: 1,
      position: [0, i * 140],
      parameters: step.parameters && typeof step.parameters === "object" ? step.parameters : {},
      notes: asString(step.why, `steps[${i}].why`)
    });
    if (isTrigger && i !== 0) {
      throw new DraftError(`trigger "${stepName}" must be the first step`);
    }
  });

  const connections = {};
  draft.steps.forEach((step, i) => {
    if (i === 0) {
      if (typeof step.after === "string" && step.after.trim()) {
        throw new DraftError(`the first step "${nodes[0].name}" cannot follow another step`);
      }
      return;
    }
    const parent = typeof step.after === "string" && step.after.trim() ? step.after.trim() : nodes[i - 1].name;
    const parentIndex = nodes.findIndex((n) => n.name === parent);
    if (parentIndex === -1) throw new DraftError(`step "${nodes[i].name}" follows "${parent}", which is not a step`);
    // Only earlier steps: a draft cannot loop back on itself.
    if (parentIndex >= i) throw new DraftError(`step "${nodes[i].name}" must come after "${parent}" in the list`);
    const output = step.output === undefined || step.output === null ? 0 : step.output;
    if (!Number.isInteger(output) || output < 0 || output > 9) {
      throw new DraftError(`step "${nodes[i].name}" uses output ${step.output}; outputs are 0 to 9`);
    }
    const main = (connections[parent] ||= { main: [] }).main;
    while (main.length <= output) main.push([]);
    main[output].push({ node: nodes[i].name, type: "main", index: 0 });
  });

  // n8n reads left to right: a layer is a column, a branch is a row.
  const graph = layoutGraph(nodes, extractEdges({ connections }, nodes));
  for (const node of nodes) {
    const box = graph.boxes[node.name];
    node.position = [box.layer * 260, Math.round(((box.x - 24) / 276) * 160)];
  }

  const payload = {
    name,
    description: typeof draft.description === "string" ? draft.description : "",
    nodes,
    connections,
    settings: { executionOrder: "v1" },
    // Drafts land in the root of the given project/folder so nobody mistakes
    // them for a live workflow in a curated folder.
    ...(projectId ? { parentFolderId: null } : {})
  };

  return payload;
}

// Whatever the model produced, re-scan it. A draft is not exempt from the
// security rule just because Shepherd wrote it.
export function vetDraft(payload) {
  const findings = scanWorkflow({ id: "draft", name: payload.name, nodes: payload.nodes });
  const risky = payload.nodes
    .filter((n) => HIGH_RISK_NODE_TYPE.test(n.type))
    .map((n) => ({ node: n.name, type: n.type }));
  return {
    findings,
    risky,
    safeToCreate: findings.length === 0 && risky.length === 0,
    needsApproval: risky.length > 0
  };
}

// The system prompt is the contract: draft only, never invent credentials,
// never place a secret in a parameter.
export function systemPrompt({ name = "your team", adminName = "an admin" } = {}) {
  return `You are Shepherd. You help people at ${name} design n8n workflows,
and you talk with them like a helpful colleague while you do it.

How a turn works:
- Return only the JSON described by the provided schema. No prose outside it.
- "reply" is what you say in the chat: short, plain, friendly. Always fill it.
- Use kind "answer" (no name or steps) when the person is chatting, asking you a question
  (what a node does, how n8n works, what an existing automation is for), or when you need
  to ask them something before you can draw anything useful. Ask at most two questions, in "reply".
- Use kind "draft" (with name and steps) only when you know enough to draw a workflow, or when
  they ask you to change the current draft. Say in "reply" what you drew or changed.
- You see the conversation so far and the current draft, if any. When they answer one of your
  questions or ask for a change, revise the current draft rather than starting over.
- Never claim you created, published, ran or activated anything: you only draw drafts, and a
  person creates them in n8n.

Rules for drafts:
- The first step must be a trigger node (n8n-nodes-base.webhook, .scheduleTrigger, or .manualTrigger).
- Use only n8n-nodes-base.* node types. Never invent a node type.
- Never put a secret, API key, token, password, or webhook URL in a step, and never read one
  from $env, $secrets or process.env. If a step needs a login, write in its "why" field that
  ${adminName} must attach a credential in n8n, and add a matching entry to "questions".
- Never use Code, Function, Execute Command, SSH, file, n8n-API or Execute Workflow nodes.
- Never call localhost, a private IP, or an internal service name.
- You are given the names of every automation that already exists. If the request overlaps one,
  do not draw a copy: return a single step that explains the overlap and put
  "This looks like <existing name> — extend that instead?" in "questions".
- If the request is ambiguous (which sheet, which database, which channel), do not guess:
  put the ambiguity in "questions" instead.
- Keep workflows small and legible. Prefer fewer, clearer steps.
- Steps run in list order, each after the one before it. To branch, use an IF
  (n8n-nodes-base.if) or Switch (n8n-nodes-base.switch) step, then give each branch's first step
  "after": "<the IF's name>" and "output": 0 for true or 1 for false (Switch: 0, 1, 2… per rule).
  To join branches back up, give the joining step "after" naming one branch's last step and add an
  n8n-nodes-base.merge step if both sides must arrive. "after" may only name an earlier step.
- Never propose writing to the shared company database. If a step would, say so in "questions".`;
}

export const SYSTEM_PROMPT = systemPrompt();

export function parseDraft(text) {
  let parsed;
  try {
    // Models sometimes wrap JSON in a fence despite being told not to.
    const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new DraftError(`Shepherd's reply was not valid JSON: ${err.message}`);
  }
  return parsed;
}

// Chat history comes from the browser, so it is trimmed and re-shaped here:
// only user/assistant turns, plain strings, bounded in count and length. The
// system prompt is never taken from the client.
export const MAX_HISTORY_TURNS = 16;
export const MAX_TURN_CHARS = 2000;

export function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((t) => t && (t.role === "user" || t.role === "assistant") && typeof t.content === "string" && t.content.trim())
    .slice(-MAX_HISTORY_TURNS)
    .map((t) => ({ role: t.role, content: t.content.trim().slice(0, MAX_TURN_CHARS) }));
}

// The current draft, summarised for the model so "change step 2" means something.
export function describeCurrentDraft(draft) {
  if (!draft || typeof draft !== "object" || !Array.isArray(draft.steps) || !draft.steps.length) return null;
  const name = typeof draft.name === "string" ? draft.name.slice(0, 200) : "(unnamed)";
  const lines = draft.steps.slice(0, 40).map((s, i) => {
    const type = typeof s.type === "string" ? s.type : typeof s.nodeType === "string" ? s.nodeType : "?";
    const why = typeof s.why === "string" ? s.why.slice(0, 300) : "";
    return `${i + 1}. ${String(s.name || "").slice(0, 120)} (${type})${why ? ` — ${why}` : ""}`;
  });
  return `Current draft "${name}":\n${lines.join("\n")}`;
}

// A turn is a drawing only if the model said so and gave steps.
export function isDraftTurn(result) {
  return Boolean(result && result.kind === "draft" && Array.isArray(result.steps) && result.steps.length);
}
