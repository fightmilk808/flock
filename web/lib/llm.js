// Minimal OpenAI-compatible chat client. Provider-agnostic on purpose: any
// endpoint that speaks the OpenAI chat API (OpenRouter, OpenAI, a local model
// server) works, so the provider is a config choice, not a code change.

import { systemPrompt, DRAFT_SCHEMA, parseDraft, sanitizeHistory, describeCurrentDraft } from "./shepherd.js";

export class LlmError extends Error {}

export function createLlmClient({ baseUrl, apiKey, model, org = {}, fetchImpl = fetch }) {
  if (!baseUrl) throw new LlmError("llm baseUrl is required");
  if (!apiKey) throw new LlmError("llm apiKey is required");
  if (!model) throw new LlmError("llm model is required");

  const root = baseUrl.replace(/\/$/, "");
  const prompt = systemPrompt(org);

  return {
    async draftWorkflow(request, { context, history, currentDraft } = {}) {
      // Background facts go in a second system message so the chat turns stay
      // exactly what the person and Shepherd said.
      const facts = [];
      if (context && context.workflows) {
        facts.push(
          `Existing workflow names (for reuse, do not duplicate):\n` +
            context.workflows.slice(0, 60).map((n) => `- ${n}`).join("\n")
        );
      }
      const current = describeCurrentDraft(currentDraft);
      facts.push(current || "There is no current draft yet.");
      const body = {
        model,
        messages: [
          { role: "system", content: prompt },
          { role: "system", content: facts.join("\n\n") },
          ...sanitizeHistory(history),
          { role: "user", content: request }
        ],
        response_format: {
          type: "json_schema",
          json_schema: { name: "workflow_draft", strict: true, schema: DRAFT_SCHEMA }
        },
        temperature: 0.2
      };
      const res = await fetchImpl(`${root}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new LlmError(`Model request failed (HTTP ${res.status}): ${text.slice(0, 300)}`);
      }
      const json = await res.json();
      const content = json?.choices?.[0]?.message?.content;
      if (typeof content !== "string" || !content) {
        throw new LlmError("Model returned an empty reply");
      }
      return parseDraft(content);
    }
  };
}
