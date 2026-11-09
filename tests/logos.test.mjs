import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SYSTEMS, logoForNode, logoForHost, logoForProvider, systemsFromTags } from "../web/lib/logos.js";

const file = (p) => fileURLToPath(new URL(`../web${p}`, import.meta.url));

test("every mapped logo file exists in the vendored set", () => {
  const paths = [
    ...Object.keys(SYSTEMS).map((t) => SYSTEMS[t].file && `/vendor/logos/${SYSTEMS[t].file}`),
    ...["n8n-nodes-base.postgres", "n8n-nodes-base.slack", "n8n-nodes-base.webhook", "n8n-nodes-base.gmail", "n8n-nodes-base.executeWorkflow",
        "@n8n/n8n-nodes-langchain.lmChatAnthropic", "@n8n/n8n-nodes-langchain.lmChatOpenRouter", "@n8n/n8n-nodes-langchain.lmChatGoogleVertex", "@n8n/n8n-nodes-langchain.openAi"]
      .map((t) => logoForNode(t).logo),
    ...["Anthropic", "OpenRouter", "Google Vertex", "OpenAI"].map(logoForProvider)
  ].filter(Boolean);
  for (const p of paths) assert.ok(existsSync(file(p)), p);
});

test("HTTP nodes take the logo of the host they call", () => {
  const http = (url) => logoForNode("n8n-nodes-base.httpRequest", { url });
  assert.equal(http("https://slack.com/api/chat.postMessage").label, "Slack");
  assert.equal(http("=https://inventory.dearsystems.com/ExternalApi/v2/sale").label, "Cin7");
  assert.equal(http("https://gmail.googleapis.com/gmail/v1/users/me").label, "Gmail");
  assert.equal(http("http://packship:8080/x").label, "Internal service");
  assert.equal(http("http://localhost:5678"), null);
  assert.equal(http("http://127.0.0.1:5678"), null);
  assert.equal(http("={{ $json.url }}"), null);
});

test("logic nodes get no logo, so they keep their lettered tile", () => {
  for (const t of ["n8n-nodes-base.if", "n8n-nodes-base.code", "n8n-nodes-base.scheduleTrigger", "n8n-nodes-base.set"]) {
    assert.equal(logoForNode(t), null, t);
  }
});

test("systemsFromTags keeps a stable order and ignores non-system tags", () => {
  const s = systemsFromTags([{ name: "trigger:webhook" }, { name: "sys:slack" }, { name: "sys:cin7" }, "sys:printing"]);
  assert.deepEqual(s.map((x) => x.tag), ["sys:cin7", "sys:slack", "sys:printing"]);
  assert.equal(s[2].logo, null);
});

test("unknown hosts and providers have no logo", () => {
  assert.equal(logoForHost("t.17track.net"), null);
  assert.equal(logoForProvider("Mistral"), null);
});
