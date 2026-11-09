import { test } from "node:test";
import assert from "node:assert/strict";
import { validateConfig, isOpRef, assertVaultUuid, ConfigError } from "../web/lib/config.js";

const VAULT = "abcdefghijklmnopqrstuvwxyz";
const ITEM = "6us2svi4vwvw4w7f2nrwlmavwa";

function base(overrides = {}) {
  return {
    n8n: {
      baseUrl: "https://n8n.example.com",
      apiKey: `op://${VAULT}/${ITEM}/password`,
      ...overrides
    }
  };
}

test("accepts a config whose secrets are op:// references", () => {
  assert.doesNotThrow(() => validateConfig(base()));
});

test("rejects a literal API key", () => {
  assert.throws(() => validateConfig(base({ apiKey: "n8n_api_abc123" })), ConfigError);
});

test("rejects an op:// reference that uses a vault title", () => {
  const cfg = base({ apiKey: "op://Ops — Danger/abc/password" });
  assert.throws(() => validateConfig(cfg), /vault title, not a UUID/);
});

test("rejects a non-http baseUrl", () => {
  const cfg = { n8n: { baseUrl: "n8n.example.com", apiKey: `op://${VAULT}/${ITEM}/password` } };
  assert.throws(() => validateConfig(cfg), /must be an http/);
});

test("requires an n8n block", () => {
  assert.throws(() => validateConfig({}), /missing n8n block/);
});

test("isOpRef only matches full three-part references", () => {
  assert.equal(isOpRef(`op://${VAULT}/${ITEM}/password`), true);
  assert.equal(isOpRef("op://vault/item"), false);
  assert.equal(isOpRef("https://example.com"), false);
  assert.equal(isOpRef(null), false);
});

test("assertVaultUuid accepts a 26-char lowercase id", () => {
  assert.doesNotThrow(() => assertVaultUuid(`op://${VAULT}/${ITEM}/password`));
});

test("shepherd.apiKey must also be an op:// reference", () => {
  const cfg = { ...base(), shepherd: { apiKey: "sk-literal" } };
  assert.throws(() => validateConfig(cfg), /shepherd.apiKey must be an op:\/\/ or env: reference/);
});

import { configFromEnv, orgSettings } from "../web/lib/config.js";

test("config can come from the environment alone, with the watcher on", () => {
  assert.equal(configFromEnv({}), null);
  const cfg = configFromEnv({ FLOCK_N8N_URL: "https://n8n.example.com", FLOCK_N8N_API_KEY: "k", FLOCK_SHEPHERD_API_KEY: "s", FLOCK_ADMINS: "a@example.com, b@example.com", FLOCK_INTERNAL_HOSTS: "example.com" });
  assert.equal(cfg.n8n.apiKey, "env:FLOCK_N8N_API_KEY");
  assert.equal(cfg.shepherd.apiKey, "env:FLOCK_SHEPHERD_API_KEY");
  assert.equal(cfg.watch.intervalMinutes, 10);
  assert.deepEqual(cfg.admins, ["a@example.com", "b@example.com"]);
  assert.deepEqual(orgSettings(cfg).internalHosts, ["example.com"]);
  assert.equal(configFromEnv({ FLOCK_N8N_URL: "https://n8n.example.com", FLOCK_N8N_API_KEY: "k", FLOCK_WATCH_MINUTES: "0" }).watch, undefined);
});

test("org settings default to neutral names and the API URL", () => {
  const o = orgSettings({ n8n: { baseUrl: "https://n8n.example.com/" } });
  assert.deepEqual([o.name, o.adminName, o.n8nUiUrl], ["your team", "an admin", "https://n8n.example.com"]);
  assert.throws(() => validateConfig({ n8n: { baseUrl: "https://x.example", apiKey: "env:K" }, org: { n8nUiUrl: "nope" } }), /org.n8nUiUrl/);
});
