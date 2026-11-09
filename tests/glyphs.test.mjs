import { test } from "node:test";
import assert from "node:assert/strict";
import { glyphFor, glyphSvg, GLYPHS } from "../web/lib/glyphs.js";
import { logoForNode, logoFromName } from "../web/lib/logos.js";

const t = (k) => `n8n-nodes-base.${k}`;

test("core logic nodes get a picture, not a letter", () => {
  assert.equal(glyphFor(t("if")).glyph, "branch");
  assert.equal(glyphFor(t("switch")).glyph, "switch");
  assert.equal(glyphFor(t("filter")).glyph, "filter");
  assert.equal(glyphFor(t("code")).glyph, "code");
  assert.equal(glyphFor(t("httpRequest")).glyph, "globe");
  assert.equal(glyphFor(t("wait")).glyph, "clock");
  assert.equal(glyphFor(t("splitInBatches")).glyph, "loop");
  assert.equal(glyphFor("@n8n/n8n-nodes-langchain.agent").glyph, "ai");
  assert.equal(glyphFor(t("somethingNew")), null);
});

test("steps that handle a PDF show a PDF", () => {
  assert.equal(glyphFor(t("httpRequest"), "Download Packing PDF").glyph, "pdf");
  assert.equal(glyphFor(t("code"), "Reattach packing PDF").glyph, "pdf");
  assert.equal(glyphFor(t("extractFromFile"), "Read it").glyph, "file");
  // "pdf" inside another word is not a PDF.
  assert.equal(glyphFor(t("code"), "Update pdfx cache").glyph, "code");
  // An IF named after a PDF is still a branch.
  assert.equal(glyphFor(t("if"), "IF: Has packing PDF?").glyph, "branch");
});

test("every glyph renders as our own SVG", () => {
  for (const g of GLYPHS) assert.match(glyphSvg(g), /^<svg [^>]*viewBox="0 0 24 24"/);
  assert.equal(glyphSvg("nope"), null);
});

test("a web call with an expression URL takes its logo from the step name", () => {
  const http = (name, url = "={{ $json.uploadUrl }}") => logoForNode(t("httpRequest"), { url }, name);
  assert.equal(http("Slack: Post Pre Book").label, "Slack");
  assert.equal(http("FDO: Create LTL Order").label, "FreightDesk");
  assert.equal(http("PG: FDO URL").label, "Postgres");
  assert.equal(http("Download Packing PDF"), null);
  // A real URL still wins over the name.
  assert.equal(http("Slack: odd", "https://api.shipstation.com/x").label, "ShipStation");
  // The name rule is for web calls only: a Code node named "Slack: …" is code.
  assert.equal(logoForNode(t("code"), {}, "Slack: Build blocks"), null);
  assert.equal(logoFromName("Slackline"), null);
});
