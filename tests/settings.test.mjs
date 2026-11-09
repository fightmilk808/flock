import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateSettings, resolveDraftFolder, folderPaths, renderSkill, readSettings, writeSettings, SettingsError } from "../web/lib/settings.js";

const folders = [
  { id: "f1", name: "Orders", parentFolderId: null },
  { id: "f2", name: "Wholesale", parentFolderId: "f1" }
];

test("only known settings, existing folders and sane model ids are accepted", () => {
  assert.deepEqual(validateSettings({ draftsFolderId: "f2", shepherdModel: "anthropic/claude-sonnet-4.5" }, { folders }), { draftsFolderId: "f2", shepherdModel: "anthropic/claude-sonnet-4.5" });
  assert.deepEqual(validateSettings({ draftsFolderId: "" }, { folders }), { draftsFolderId: null });
  assert.throws(() => validateSettings({ draftsFolderId: "nope" }, { folders }), SettingsError);
  assert.throws(() => validateSettings({ shepherdModel: "x; rm -rf /" }, { folders }), SettingsError);
  assert.throws(() => validateSettings({ shepherdBaseUrl: "https://evil.example" }, { folders }), /unknown setting/);
});

test("a draft goes to the folder asked for, else the default, else the top level", () => {
  assert.deepEqual(resolveDraftFolder({ requested: undefined, settings: { draftsFolderId: "f1" }, folders }), { id: "f1", name: "Orders" });
  assert.deepEqual(resolveDraftFolder({ requested: "f2", settings: { draftsFolderId: "f1" }, folders }), { id: "f2", name: "Wholesale" });
  assert.equal(resolveDraftFolder({ requested: null, settings: { draftsFolderId: "f1" }, folders }), null);
  assert.equal(resolveDraftFolder({ requested: undefined, settings: { draftsFolderId: null }, folders }), null);
  assert.throws(() => resolveDraftFolder({ requested: "gone", settings: {}, folders }), SettingsError);
});

test("folder pickers show the full path", () => {
  assert.deepEqual(folderPaths(folders).map((f) => f.path), ["Orders", "Orders / Wholesale"]);
});

test("settings round-trip through the store", () => {
  const meta = new Map();
  const store = { getMeta: (k) => meta.get(k) ?? null, setMeta: (k, v) => meta.set(k, String(v)) };
  writeSettings(store, { draftsFolderId: "f1", shepherdModel: null });
  assert.deepEqual(readSettings(store), { draftsFolderId: "f1", shepherdModel: null });
});

test("the shipped skill copies match the template with the default address", () => {
  const want = renderSkill(readFileSync("web/agent/SKILL.md", "utf8"), "http://127.0.0.1:4174");
  assert.ok(!want.includes("{{FLOCK_URL}}"));
  for (const p of [".claude/skills/flock/SKILL.md", ".agents/skills/flock/SKILL.md"]) {
    assert.equal(readFileSync(p, "utf8"), want, `${p} is out of date: regenerate it from web/agent/SKILL.md`);
  }
});

test("the shipped Claude settings never pre-allow writes", () => {
  const s = JSON.parse(readFileSync(".claude/settings.json", "utf8"));
  for (const rule of s.permissions.allow) assert.ok(!/shepherd\/create|bulk|POST \S*settings/.test(rule), rule);
});
