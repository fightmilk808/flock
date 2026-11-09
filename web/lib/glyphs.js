// Icons for what a step *does* when it is not a branded system: branch,
// filter, code, web call, wait, loop, PDF… Drawn here as plain 24px stroke
// icons (our own, not anyone's brand), so a logic node gets a picture
// instead of a letter. Brand marks stay in logos.js.

const P = {
  branch: '<path d="M6 3v12"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
  switch: '<path d="M4 12h6"/><path d="M10 12l5-6h5"/><path d="M10 12h10"/><path d="M10 12l5 6h5"/>',
  filter: '<path d="M3 4h18l-7 8.5V19l-4 2v-8.5z"/>',
  code: '<path d="M9 7l-5 5 5 5"/><path d="M15 7l5 5-5 5"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18"/>',
  merge: '<path d="M6 3v4a5 5 0 0 0 5 5h2a5 5 0 0 1 5 5v4"/><path d="M18 3v4a5 5 0 0 1-5 5"/><path d="M15 18l3 3 3-3"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  pencil: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
  loop: '<path d="M17 2l4 4-4 4"/><path d="M3 11V9a3 3 0 0 1 3-3h15"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a3 3 0 0 1-3 3H3"/>',
  arrow: '<path d="M5 12h14"/><path d="M13 6l6 6-6 6"/>',
  play: '<path d="M7 4l13 8-13 8z"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3 6h.01M3 12h.01M3 18h.01"/>',
  sort: '<path d="M7 4v16M3 16l4 4 4-4"/><path d="M17 20V4M13 8l4-4 4 4"/>',
  stop: '<circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 16.5v.5"/>',
  form: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/>',
  file: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/>',
  pdf: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/><text x="12" y="17.5" text-anchor="middle" font-size="6.5" font-weight="700" font-family="system-ui, sans-serif" fill="currentColor" stroke="none">PDF</text>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>',
  terminal: '<path d="M4 17l6-5-6-5"/><path d="M12 19h8"/>',
  ai: '<path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
  tool: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z"/>',
  memory: '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6"/><path d="M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>'
};

// Last segment of an n8n node type → [glyph, tile colour].
const BY_TYPE = [
  [/^if$/i, "branch", "#A16207"],
  [/^switch$/i, "switch", "#A16207"],
  [/^filter$/i, "filter", "#A16207"],
  [/^(code|function|functionItem)$/i, "code", "#5B6170"],
  [/^(httpRequest|httpRequestTool|graphql)$/i, "globe", "#0E7490"],
  [/^(merge|compareDatasets)$/i, "merge", "#0F766E"],
  [/^wait$/i, "clock", "#6D28D9"],
  [/^(scheduleTrigger|cron|interval)$/i, "calendar", "#6D28D9"],
  [/^(set|editFields|renameKeys)$/i, "pencil", "#475569"],
  [/^(splitInBatches|loop)$/i, "loop", "#0F766E"],
  [/^noOp$/i, "arrow", "#8A8F9A"],
  [/^manualTrigger$/i, "play", "#4A55C7"],
  [/^(splitOut|aggregate|itemLists|summarize|limit|removeDuplicates)$/i, "list", "#475569"],
  [/^sort$/i, "sort", "#475569"],
  [/^stopAndError$/i, "stop", "#B91C1C"],
  [/^(formTrigger|form)$/i, "form", "#4A55C7"],
  [/^(readPdf|extractFromFile|convertToFile|readWriteFile|readBinaryFile|writeBinaryFile|moveBinaryData|compression)$/i, "file", "#B91C1C"],
  [/^(emailSend|sendEmail)$/i, "mail", "#0E7490"],
  [/^(executeCommand|ssh)$/i, "terminal", "#334155"],
  [/^(agent|chainLlm|chainSummarization|informationExtractor|textClassifier|sentimentAnalysis|chatTrigger)$/i, "ai", "#BE185D"],
  [/Tool$|^tool[A-Z]/, "tool", "#BE185D"],
  [/^memory/i, "memory", "#BE185D"]
];

// Steps that move a PDF say so in their name or type; show a PDF either way.
const PDF = /(^|[^a-z])pdf([^a-z]|$)/i;

// {glyph, color} for a node, or null when nothing fits (the lettered tile stays).
export function glyphFor(type, name = "") {
  const kind = String(type || "").split(".").pop();
  const fileish = /^(httpRequest|code|readPdf|extractFromFile|convertToFile|readWriteFile|readBinaryFile|writeBinaryFile|moveBinaryData)$/i.test(kind);
  if (fileish && (PDF.test(name) || /pdf/i.test(kind))) return { glyph: "pdf", color: "#B91C1C" };
  for (const [re, glyph, color] of BY_TYPE) if (re.test(kind)) return { glyph, color };
  return null;
}

// The SVG markup for a glyph. Only ever our own constant strings.
export function glyphSvg(glyph) {
  const body = P[glyph];
  if (!body) return null;
  return `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

export const GLYPHS = Object.keys(P);
