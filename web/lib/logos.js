// One map from "what is this" to a brand mark, shared by every screen and by
// the runs map. Marks come only from web/vendor/logos (see SOURCES.md there).
// When there is no real mark the answer is null, and the caller draws a
// lettered tile instead of borrowing a logo that is not the thing's own.

const BASE = "/vendor/logos/";

// System tags (`sys:<name>`), with a label for each.
export const SYSTEMS = {
  "sys:shopify": { label: "Shopify", file: "shopify.svg" },
  "sys:cin7": { label: "Cin7", file: "cin7.svg" },
  "sys:shipstation": { label: "ShipStation", file: "shipstation.png" },
  "sys:warehouse-db": { label: "Company DB", file: "postgresql.svg" },
  "sys:slack": { label: "Slack", file: "slack.svg" },
  "sys:google-sheets": { label: "Google Sheets", file: "google-sheets.svg" },
  "sys:google-drive": { label: "Google Drive", file: "google-drive.svg" },
  "sys:fdo": { label: "FreightDesk", file: "freightdesk.png" },
  "sys:unishippers": { label: "Unishippers", file: "unishippers.png" },
  "sys:metabase": { label: "Metabase", file: "metabase.svg" },
  "sys:gmail": { label: "Gmail", file: "gmail.svg" },
  "sys:notion": { label: "Notion", file: "notion.svg" },
  "sys:ai": { label: "AI", file: null },
  "sys:printing": { label: "Printing", file: null }
};

export function logoForSystem(tag) {
  const s = SYSTEMS[tag];
  return s && s.file ? BASE + s.file : null;
}

export function systemLabel(tag) {
  return (SYSTEMS[tag] && SYSTEMS[tag].label) || String(tag).replace(/^sys:/, "");
}

// The systems a tag list names, in a stable order, as {tag, label, logo}.
export function systemsFromTags(tags) {
  const names = (tags || []).map((t) => (typeof t === "string" ? t : t && t.name)).filter(Boolean);
  return Object.keys(SYSTEMS)
    .filter((tag) => names.includes(tag))
    .map((tag) => ({ tag, label: systemLabel(tag), logo: logoForSystem(tag) }));
}

// A host an HTTP Request node calls. Bare names (no dot) are services on the
// same Docker network as n8n.
const HOSTS = [
  [/(^|\.)slack\.com$/i, "slack.svg", "Slack"],
  [/(^|\.)dearsystems\.com$|(^|\.)dearinventory\.com$|(^|\.)cin7\.com$/i, "cin7.svg", "Cin7"],
  [/(^|\.)shipstation\.com$/i, "shipstation.png", "ShipStation"],
  [/(^|\.)freightdesk\.online$/i, "freightdesk.png", "FreightDesk"],
  [/(^|\.)unishippers\.com$/i, "unishippers.png", "Unishippers"],
  [/(^|\.)myshopify\.com$|(^|\.)shopify\.com$/i, "shopify.svg", "Shopify"],
  [/^gmail\.googleapis\.com$/i, "gmail.svg", "Gmail"],
  [/(^|\.)googleapis\.com$/i, "google-cloud.svg", "Google"],
  [/(^|\.)anthropic\.com$/i, "anthropic.svg", "Anthropic"],
  [/(^|\.)openai\.com$/i, "openai.svg", "OpenAI"],
  [/(^|\.)openrouter\.ai$/i, "openrouter.svg", "OpenRouter"],
  [/(^|\.)notion\.com$/i, "notion.svg", "Notion"],
  [/(^|\.)github\.com$/i, "github.svg", "GitHub"],
  [/^metabase(\.|$)/i, "metabase.svg", "Metabase"],
  [/^n8n(\.|$)/i, "n8n.svg", "n8n"],
  // A bare name is a service on the same Docker network.
  [/^[a-z0-9-]+$/i, "docker.svg", "Internal service"]
];

export function hostFromUrl(url) {
  if (typeof url !== "string") return null;
  const m = url.match(/^\s*=?\s*https?:\/\/([^/:?#\s{}]+)/i);
  return m ? m[1].toLowerCase() : null;
}

export function logoForHost(host) {
  if (!host || host === "localhost" || /^\d/.test(host)) return null;
  for (const [re, file, label] of HOSTS) if (re.test(host)) return { logo: BASE + file, label };
  return null;
}

// Node types, matched on the last segment of the type name.
const NODES = [
  [/^postgres(Tool|Trigger)?$/i, "postgresql.svg", "Postgres"],
  [/^slack(Trigger)?$/i, "slack.svg", "Slack"],
  [/^googleSheets(Trigger)?$/i, "google-sheets.svg", "Google Sheets"],
  [/^googleDrive(Trigger)?$/i, "google-drive.svg", "Google Drive"],
  [/^(gmail|gmailTrigger|emailReadImap)$/i, "gmail.svg", "Gmail"],
  [/^shopify(Trigger)?$/i, "shopify.svg", "Shopify"],
  [/^notion(Trigger)?$/i, "notion.svg", "Notion"],
  [/^github(Trigger)?$/i, "github.svg", "GitHub"],
  [/^(webhook|respondToWebhook)$/i, "webhook.svg", "Webhook"],
  [/^(executeWorkflow|executeWorkflowTrigger|errorTrigger|n8n|dataTable|messageAnAgent)$/i, "n8n.svg", "n8n"],
  [/^lmChatAnthropic$/i, "anthropic.svg", "Anthropic"],
  [/^(lmChatOpenAi|openAi)$/i, "openai.svg", "OpenAI"],
  [/^lmChatOpenRouter$/i, "openrouter.svg", "OpenRouter"],
  [/^lmChatGoogleVertex$/i, "google-cloud.svg", "Google Vertex"],
  [/^lmChatGoogleGemini$/i, "google-gemini.svg", "Gemini"]
];

// Names people give web-call steps ("Slack: Post Pre Book", "PG: …",
// "FDO: Create LTL Order"). Used only for HTTP steps whose URL is built in an
// expression, where the address alone cannot say which system it is.
const NAME_PREFIXES = [
  [/^slack\b/i, "slack.svg", "Slack"],
  [/^(cin7|dear)\b/i, "cin7.svg", "Cin7"],
  [/^(fdo|freightdesk)\b/i, "freightdesk.png", "FreightDesk"],
  [/^shipstation\b/i, "shipstation.png", "ShipStation"],
  [/^shopify\b/i, "shopify.svg", "Shopify"],
  [/^unishippers\b/i, "unishippers.png", "Unishippers"],
  [/^(pg|postgres)\b/i, "postgresql.svg", "Postgres"],
  [/^gmail\b/i, "gmail.svg", "Gmail"],
  [/^notion\b/i, "notion.svg", "Notion"],
  [/^metabase\b/i, "metabase.svg", "Metabase"],
  [/^github\b/i, "github.svg", "GitHub"],
  [/^(drive|google drive)\b/i, "google-drive.svg", "Google Drive"],
  [/^(sheets?|google sheets)\b/i, "google-sheets.svg", "Google Sheets"]
];

export function logoFromName(name) {
  const n = String(name || "").trim();
  for (const [re, file, label] of NAME_PREFIXES) if (re.test(n)) return { logo: BASE + file, label };
  return null;
}

// {logo, label} for a node, or null when only a lettered tile is honest.
export function logoForNode(type, parameters = {}, name = "") {
  const kind = String(type || "").split(".").pop();
  if (/^httpRequest(Tool)?$/i.test(kind)) {
    return logoForHost(hostFromUrl(parameters && parameters.url)) || logoFromName(name);
  }
  for (const [re, file, label] of NODES) if (re.test(kind)) return { logo: BASE + file, label };
  return null;
}

const PROVIDERS = {
  anthropic: "anthropic.svg",
  openai: "openai.svg",
  openrouter: "openrouter.svg",
  "google vertex": "google-cloud.svg",
  "google gemini": "google-gemini.svg",
  gemini: "google-gemini.svg"
};

export function logoForProvider(name) {
  const file = PROVIDERS[String(name || "").toLowerCase()];
  return file ? BASE + file : null;
}
