import { test } from "node:test";
import assert from "node:assert/strict";
import { extractAgents } from "../web/lib/agents.js";

const AGENT = "@n8n/n8n-nodes-langchain.agent";
const CHAT = "@n8n/n8n-nodes-langchain.chatTrigger";
const MEMORY = "@n8n/n8n-nodes-langchain.memoryBufferWindow";
const TOOL = "@n8n/n8n-nodes-langchain.mcpClientTool";
const MODEL = "@n8n/n8n-nodes-langchain.lmChatAnthropic";

function workflow(overrides = {}) {
  return {
    id: "w1",
    name: "Support agent",
    active: true,
    isArchived: false,
    updatedAt: "2026-11-01T00:00:00Z",
    tags: [{ name: "sys:ai" }],
    nodes: [{ name: "AI Agent", type: AGENT, parameters: {} }],
    connections: {},
    ...overrides
  };
}

function linkTo(agentName, kind = "main") {
  return { [kind]: [[{ node: agentName, type: kind === "main" ? "main" : "ai_tool" }]] };
}

test("finds an agent node and names it", () => {
  const { agents, summary } = extractAgents({ workflows: [workflow()], executions: [], findings: [] });
  assert.equal(summary.agentCount, 1);
  assert.equal(agents[0].name, "AI Agent");
  assert.equal(agents[0].workflowId, "w1");
});

test("a workflow with no agent node contributes nothing", () => {
  const wf = workflow({ nodes: [{ name: "HTTP", type: "n8n-nodes-base.httpRequest", parameters: {} }] });
  const { agents } = extractAgents({ workflows: [wf], executions: [], findings: [] });
  assert.equal(agents.length, 0);
});

test("two agent nodes in one workflow become two agents", () => {
  const wf = workflow({
    nodes: [
      { name: "Brian", type: AGENT, parameters: {} },
      { name: "Brian (Slack)", type: AGENT, parameters: {} }
    ]
  });
  const { agents } = extractAgents({ workflows: [wf], executions: [], findings: [] });
  assert.equal(agents.length, 2);
  assert.deepEqual(agents.map((a) => a.name).sort(), ["Brian", "Brian (Slack)"]);
});

test("agent ids are unique across two agents in one workflow", () => {
  const wf = workflow({
    nodes: [
      { name: "A", type: AGENT, parameters: {} },
      { name: "B", type: AGENT, parameters: {} }
    ]
  });
  const { agents } = extractAgents({ workflows: [wf], executions: [], findings: [] });
  assert.equal(new Set(agents.map((a) => a.agentId)).size, 2);
});

test("tools are read from the ai_tool connection, not node order", () => {
  const wf = workflow({
    nodes: [
      { name: "AI Agent", type: AGENT, parameters: {} },
      { name: "Search", type: TOOL, parameters: {} }
    ],
    connections: { Search: linkTo("AI Agent", "ai_tool") }
  });
  const { agents } = extractAgents({ workflows: [wf], executions: [], findings: [] });
  assert.equal(agents[0].toolCount, 1);
  assert.deepEqual(agents[0].tools, ["Search"]);
  assert.equal(agents[0].usesMcp, true);
});

test("a tool wired to a different agent is not counted", () => {
  const wf = workflow({
    nodes: [
      { name: "AI Agent", type: AGENT, parameters: {} },
      { name: "Other", type: AGENT, parameters: {} },
      { name: "Search", type: TOOL, parameters: {} }
    ],
    connections: { Search: { ai_tool: [[{ node: "Other", type: "ai_tool" }]] } }
  });
  const { agents } = extractAgents({ workflows: [wf], executions: [], findings: [] });
  const mine = agents.find((a) => a.name === "AI Agent");
  assert.equal(mine.toolCount, 0);
});

test("a chat model is detected and its provider named", () => {
  const wf = workflow({
    nodes: [
      { name: "AI Agent", type: AGENT, parameters: {} },
      { name: "Claude", type: MODEL, parameters: {} }
    ],
    connections: { Claude: { ai_languageModel: [[{ node: "AI Agent", type: "ai_languageModel" }]] } }
  });
  const { agents, summary } = extractAgents({ workflows: [wf], executions: [], findings: [] });
  assert.deepEqual(agents[0].providers, ["Anthropic"]);
  assert.deepEqual(summary.providers, ["Anthropic"]);
});

test("an agent with no model says so rather than guessing a provider", () => {
  const { agents } = extractAgents({ workflows: [workflow()], executions: [], findings: [] });
  assert.deepEqual(agents[0].providers, []);
  assert.equal(agents[0].modelCount, 0);
});

test("memory is detected from the ai_memory connection", () => {
  const wf = workflow({
    nodes: [
      { name: "AI Agent", type: AGENT, parameters: {} },
      { name: "Memory", type: MEMORY, parameters: {} }
    ],
    connections: { Memory: { ai_memory: [[{ node: "AI Agent", type: "ai_memory" }]] } }
  });
  const { agents, summary } = extractAgents({ workflows: [wf], executions: [], findings: [] });
  assert.equal(agents[0].memory, true);
  assert.equal(summary.withMemory, 1);
  assert.equal(summary.withTools, 0);
});

test("a chat trigger on the workflow is reported", () => {
  const wf = workflow({ nodes: [{ name: "Chat", type: CHAT, parameters: {} }, { name: "AI Agent", type: AGENT, parameters: {} }] });
  const { agents } = extractAgents({ workflows: [wf], executions: [], findings: [] });
  assert.equal(agents[0].hasChatTrigger, true);
});

test("run and failure counts come from the workflow's executions", () => {
  const executions = [
    { workflowId: "w1", status: "success" },
    { workflowId: "w1", status: "error" },
    { workflowId: "w2", status: "success" }
  ];
  const { agents } = extractAgents({ workflows: [workflow()], executions, findings: [] });
  assert.equal(agents[0].runs, 2);
  assert.equal(agents[0].failures, 1);
});

test("secret findings on the workflow are attached to the agent", () => {
  const findings = [{ workflowId: "w1", node: "X" }, { workflowId: "w9", node: "Y" }];
  const { agents } = extractAgents({ workflows: [workflow()], executions: [], findings });
  assert.equal(agents[0].findings, 1);
});

test("a sys:ai workflow with no agent node is listed separately", () => {
  const wf = workflow({ id: "w2", name: "AI-ish workflow", nodes: [{ name: "HTTP", type: "n8n-nodes-base.httpRequest", parameters: {} }] });
  const { agents, aiWithoutAgent } = extractAgents({ workflows: [workflow(), wf], executions: [], findings: [] });
  assert.equal(agents.length, 1);
  assert.deepEqual(aiWithoutAgent.map((w) => w.name), ["AI-ish workflow"]);
});

test("agents are ordered by run volume", () => {
  const a = workflow({ id: "wa", name: "Quiet", nodes: [{ name: "AI Agent", type: AGENT, parameters: {} }] });
  const b = workflow({ id: "wb", name: "Busy", nodes: [{ name: "AI Agent", type: AGENT, parameters: {} }] });
  const executions = [{ workflowId: "wb", status: "success" }, { workflowId: "wb", status: "success" }];
  const { agents } = extractAgents({ workflows: [a, b], executions, findings: [] });
  assert.deepEqual(agents.map((x) => x.workflowName), ["Busy", "Quiet"]);
});

test("summary counts only agents, not every AI-tagged workflow", () => {
  const wf = workflow({ id: "w2", name: "Other", nodes: [] });
  const { summary } = extractAgents({ workflows: [workflow(), wf], executions: [], findings: [] });
  assert.equal(summary.agentCount, 1);
  assert.equal(summary.workflowCount, 1);
});
