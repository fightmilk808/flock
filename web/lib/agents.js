// n8n's native Agents module has no public REST endpoint — it is reachable only
// through packages export. What Flock *can* see is agents as they are actually
// built here: LangChain agent nodes inside workflows. This reads those, so the
// screen shows real agents rather than asserting a module it cannot query.
//
// Every claim below is derived from a node that exists. A workflow tagged
// sys:ai with no agent node is listed as "AI, not an agent", not counted.

const AGENT_NODE = "@n8n/n8n-nodes-langchain.agent";
const CHAT_TRIGGER = "@n8n/n8n-nodes-langchain.chatTrigger";
const MEMORY_NODE = "@n8n/n8n-nodes-langchain.memoryBufferWindow";
const MCP_CLIENT = "@n8n/n8n-nodes-langchain.mcpClientTool";

// Chat-model node types, mapped to the provider a person would recognise.
const MODEL_PROVIDERS = [
  { match: /lmChatOpenRouter/i, name: "OpenRouter" },
  { match: /lmChatAnthropic/i, name: "Anthropic" },
  { match: /lmChatOpenAi|lmChatOpenAI|\.openAi$/i, name: "OpenAI" },
  { match: /lmChatGoogleVertex/i, name: "Google Vertex" },
  { match: /lmChatGoogleGemini/i, name: "Gemini" },
  { match: /lmChatOllama/i, name: "Ollama" },
  { match: /lmChatAzureOpenAi/i, name: "Azure OpenAI" }
];

function providerFor(type) {
  const hit = MODEL_PROVIDERS.find((p) => p.match.test(type));
  return hit ? hit.name : null;
}

// Tools attach to an agent through the `ai_tool` connection, not by position, so
// the graph is the source of truth rather than node order.
function toolsForAgent(workflow, agentName) {
  const connections = workflow.connections || {};
  const tools = [];
  for (const [source, outputs] of Object.entries(connections)) {
    // The connection kind is the key (ai_tool, ai_languageModel, main, …), and
    // the target is the agent. Reading only `main` misses every tool.
    for (const [kind, branches] of Object.entries(outputs)) {
      if (kind !== "ai_tool") continue;
      for (const branch of branches || []) {
        for (const link of branch || []) {
          if (link.node !== agentName) continue;
          const node = (workflow.nodes || []).find((n) => n.name === source);
          if (node) tools.push({ name: node.name, type: node.type });
        }
      }
    }
  }
  return tools;
}

// Models and memory attach the same way, via ai_languageModel / ai_memory.
function attachedTo(workflow, agentName, wantedType) {
  const connections = workflow.connections || {};
  const found = [];
  for (const [source, outputs] of Object.entries(connections)) {
    for (const [kind, branches] of Object.entries(outputs)) {
      if (kind !== wantedType) continue;
      for (const branch of branches || []) {
        for (const link of branch || []) {
          if (link.node !== agentName) continue;
          const node = (workflow.nodes || []).find((n) => n.name === source);
          if (node) found.push(node);
        }
      }
    }
  }
  return found;
}

export function extractAgents({ workflows, executions, findings }) {
  const agents = [];
  const runCounts = new Map();
  for (const ex of executions || []) {
    runCounts.set(ex.workflowId, (runCounts.get(ex.workflowId) || 0) + 1);
  }
  const failCounts = new Map();
  for (const ex of executions || []) {
    if (ex.status === "error" || ex.status === "crashed") {
      failCounts.set(ex.workflowId, (failCounts.get(ex.workflowId) || 0) + 1);
    }
  }

  for (const wf of workflows) {
    const agentNodes = (wf.nodes || []).filter((n) => n.type === AGENT_NODE);
    if (agentNodes.length === 0) continue;
    const tags = (wf.tags || []).map((t) => t.name);

    for (const node of agentNodes) {
      const models = attachedTo(wf, node.name, "ai_languageModel");
      const memories = attachedTo(wf, node.name, "ai_memory");
      const tools = toolsForAgent(wf, node.name);
      const providers = [...new Set(models.map((m) => providerFor(m.type)).filter(Boolean))];

      agents.push({
        agentId: `${wf.id}:${node.name}`,
        name: node.name,
        workflowId: wf.id,
        workflowName: wf.name,
        active: wf.active,
        archived: wf.isArchived || false,
        updatedAt: wf.updatedAt,
        tags,
        // Stated as a fact about the node, not an inference about intent.
        hasChatTrigger: (wf.nodes || []).some((n) => n.type === CHAT_TRIGGER),
        memory: memories.length > 0,
        toolCount: tools.length,
        tools: tools.map((t) => t.name),
        usesMcp: tools.some((t) => t.type === MCP_CLIENT),
        providers,
        modelCount: models.length,
        runs: runCounts.get(wf.id) || 0,
        failures: failCounts.get(wf.id) || 0,
        findings: (findings || []).filter((f) => f.workflowId === wf.id).length
      });
    }
  }

  agents.sort((a, b) => b.runs - a.runs || a.name.localeCompare(b.name));

  const aiTagged = workflows.filter((wf) => (wf.tags || []).some((t) => t.name === "sys:ai"));
  const withAgent = new Set(agents.map((a) => a.workflowId));
  const aiWithoutAgent = aiTagged
    .filter((wf) => !withAgent.has(wf.id))
    .map((wf) => ({ id: wf.id, name: wf.name, active: wf.active }));

  return {
    agents,
    summary: {
      agentCount: agents.length,
      workflowCount: withAgent.size,
      active: agents.filter((a) => a.active).length,
      withMemory: agents.filter((a) => a.memory).length,
      withTools: agents.filter((a) => a.toolCount > 0).length,
      usingMcp: agents.filter((a) => a.usesMcp).length,
      providers: [...new Set(agents.flatMap((a) => a.providers))].sort()
    },
    // Honest disclosure: these carry the AI tag but contain no agent node.
    aiWithoutAgent
  };
}
