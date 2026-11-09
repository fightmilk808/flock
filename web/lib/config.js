import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// References (env: or op://) are the only credential form this app accepts. A literal
// secret in the config file is a startup error, not a warning: the whole point
// of Flock's security scan is that nobody pastes keys into configs.
const OP_REF = /^op:\/\/[^/]+\/[^/]+\/[^/]+$/;

export class ConfigError extends Error {}

export function isOpRef(value) {
  return typeof value === "string" && OP_REF.test(value);
}

// In Docker or any host without the 1Password CLI, secrets arrive as
// environment variables. `env:NAME` points at one of those. It is still a
// reference, never a literal in the config file.
const ENV_REF = /^env:[A-Z][A-Z0-9_]*$/;

export function isEnvRef(value) {
  return typeof value === "string" && ENV_REF.test(value);
}

export function isSecretRef(value) {
  return isOpRef(value) || isEnvRef(value);
}

// Vault titles containing an em dash ("Ops — Danger") do not resolve
// through op://Vault Title/... — the CLI silently fails to match. Vault UUIDs
// always work, so the config validator insists on them.
export function assertVaultUuid(ref) {
  const vault = ref.split("/")[2];
  if (!/^[a-z0-9]{26}$/.test(vault)) {
    throw new ConfigError(
      `op:// reference uses a vault title, not a UUID: ${ref.split("/").slice(0, 3).join("/")}. ` +
        `Titles with punctuation (em dashes) fail to resolve. Use the vault UUID.`
    );
  }
}

export function validateConfig(raw) {
  const errors = [];
  if (!raw || typeof raw !== "object") throw new ConfigError("config must be an object");

  const n8n = raw.n8n;
  if (!n8n || typeof n8n !== "object") {
    errors.push("missing n8n block");
  } else {
    if (typeof n8n.baseUrl !== "string" || !/^https?:\/\//.test(n8n.baseUrl)) {
      errors.push("n8n.baseUrl must be an http(s) URL");
    }
    for (const field of ["apiKey", "cfAccessClientId", "cfAccessClientSecret"]) {
      const value = n8n[field];
      if (value === undefined || value === null) continue;
      if (!isSecretRef(value)) {
        errors.push(`n8n.${field} must be an op:// or env: reference, not a literal`);
        continue;
      }
      if (isEnvRef(value)) continue;
      try {
        assertVaultUuid(value);
      } catch (err) {
        errors.push(`n8n.${field}: ${err.message}`);
      }
    }
    if (!isSecretRef(n8n.apiKey)) errors.push("n8n.apiKey is required as an op:// or env: reference");
  }

  const shepherd = raw.shepherd;
  if (shepherd) {
    if (shepherd.apiKey !== undefined && !isSecretRef(shepherd.apiKey)) {
      errors.push("shepherd.apiKey must be an op:// or env: reference, not a literal");
    }
    if (shepherd.apiKey && isOpRef(shepherd.apiKey)) {
      try {
        assertVaultUuid(shepherd.apiKey);
      } catch (err) {
        errors.push(`shepherd.apiKey: ${err.message}`);
      }
    }
  }

  // Cloudflare Access: when set, every API request must carry a valid Access
  // token for this application, and the person is identified by its email.
  if (raw.access !== undefined) {
    const a = raw.access;
    if (!a || typeof a.teamDomain !== "string" || !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(a.teamDomain)) {
      errors.push("access.teamDomain must look like <team>.cloudflareaccess.com");
    }
    if (!a || typeof a.audience !== "string" || !/^[a-f0-9]{64}$/.test(a.audience)) {
      errors.push("access.audience must be the Access application's 64-character AUD tag");
    }
  }
  if (raw.admins !== undefined) {
    if (!Array.isArray(raw.admins) || raw.admins.some((e) => typeof e !== "string" || !e.includes("@"))) {
      errors.push("admins must be a list of email addresses");
    }
  }
  if (raw.access && !(Array.isArray(raw.admins) && raw.admins.length)) {
    errors.push("admins is required when access is set: someone must be able to change infrastructure");
  }

  // The background watcher. Slack is optional; without it alerts stay in-app.
  if (raw.watch !== undefined) {
    const w = raw.watch;
    if (!w || typeof w !== "object") errors.push("watch must be an object");
    else {
      if (w.intervalMinutes !== undefined && !(Number.isInteger(w.intervalMinutes) && w.intervalMinutes >= 2 && w.intervalMinutes <= 1440)) {
        errors.push("watch.intervalMinutes must be a whole number from 2 to 1440");
      }
      if (w.slack !== undefined) {
        if (!w.slack || !isSecretRef(w.slack.token)) errors.push("watch.slack.token must be an op:// or env: reference");
        if (!w.slack || typeof w.slack.channel !== "string" || !/^[CDG][A-Z0-9]{6,}$/.test(w.slack.channel)) {
          errors.push("watch.slack.channel must be a Slack channel or DM id (C…, D… or G…)");
        }
      }
    }
  }

  // Who runs this instance: names and links shown in the UI and in alerts.
  if (raw.org !== undefined) {
    const o = raw.org;
    if (!o || typeof o !== "object") errors.push("org must be an object");
    else {
      for (const field of ["name", "adminName"]) {
        if (o[field] !== undefined && (typeof o[field] !== "string" || !o[field].trim())) errors.push(`org.${field} must be a non-empty string`);
      }
      for (const field of ["n8nUiUrl", "publicUrl"]) {
        if (o[field] !== undefined && (typeof o[field] !== "string" || !/^https?:\/\//.test(o[field]))) errors.push(`org.${field} must be an http(s) URL`);
      }
      for (const field of ["internalHosts", "companySystems"]) {
        if (o[field] !== undefined && (!Array.isArray(o[field]) || o[field].some((h) => typeof h !== "string" || !h))) errors.push(`org.${field} must be a list of strings`);
      }
    }
  }

  if (errors.length) throw new ConfigError(errors.join("\n"));
  return raw;
}

// The org block with defaults filled in. The n8n editor link defaults to the
// API base URL, which is right unless Flock reaches n8n on a private address.
export function orgSettings(config) {
  const o = (config && config.org) || {};
  const base = config && config.n8n && config.n8n.baseUrl ? config.n8n.baseUrl : "";
  return {
    name: o.name || "your team",
    adminName: o.adminName || "an admin",
    n8nUiUrl: (o.n8nUiUrl || base).replace(/\/$/, ""),
    publicUrl: o.publicUrl ? o.publicUrl.replace(/\/$/, "") : null,
    internalHosts: o.internalHosts || [],
    companySystems: o.companySystems || null
  };
}

// No config file, but the essentials are in the environment: the quickest way
// to run Flock in Docker. Secrets stay as env: references.
export function configFromEnv(env = process.env) {
  if (!env.FLOCK_N8N_URL || !env.FLOCK_N8N_API_KEY) return null;
  const raw = {
    n8n: { baseUrl: env.FLOCK_N8N_URL, apiKey: "env:FLOCK_N8N_API_KEY" }
  };
  if (env.FLOCK_N8N_PROJECT_ID) raw.n8n.projectId = env.FLOCK_N8N_PROJECT_ID;
  if (env.FLOCK_SHEPHERD_API_KEY) {
    raw.shepherd = { apiKey: "env:FLOCK_SHEPHERD_API_KEY" };
    if (env.FLOCK_SHEPHERD_BASE_URL) raw.shepherd.baseUrl = env.FLOCK_SHEPHERD_BASE_URL;
    if (env.FLOCK_SHEPHERD_MODEL) raw.shepherd.model = env.FLOCK_SHEPHERD_MODEL;
  }
  // The watcher is on by default; FLOCK_WATCH_MINUTES=0 turns it off.
  const minutes = env.FLOCK_WATCH_MINUTES === undefined ? 10 : Number(env.FLOCK_WATCH_MINUTES);
  if (minutes > 0) {
    raw.watch = { intervalMinutes: minutes };
    if (env.FLOCK_SLACK_TOKEN && env.FLOCK_SLACK_CHANNEL) {
      raw.watch.slack = { token: "env:FLOCK_SLACK_TOKEN", channel: env.FLOCK_SLACK_CHANNEL };
    }
  }
  if (env.FLOCK_ADMINS) raw.admins = env.FLOCK_ADMINS.split(",").map((e) => e.trim()).filter(Boolean);
  const org = {};
  if (env.FLOCK_ORG_NAME) org.name = env.FLOCK_ORG_NAME;
  if (env.FLOCK_ADMIN_NAME) org.adminName = env.FLOCK_ADMIN_NAME;
  if (env.FLOCK_N8N_UI_URL) org.n8nUiUrl = env.FLOCK_N8N_UI_URL;
  if (env.FLOCK_PUBLIC_URL) org.publicUrl = env.FLOCK_PUBLIC_URL;
  if (env.FLOCK_INTERNAL_HOSTS) org.internalHosts = env.FLOCK_INTERNAL_HOSTS.split(",").map((h) => h.trim()).filter(Boolean);
  if (Object.keys(org).length) raw.org = org;
  return validateConfig(raw);
}

export async function loadConfig(path, env = process.env) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") {
      const fromEnv = configFromEnv(env);
      if (fromEnv) return fromEnv;
      throw new ConfigError(
        `No config at ${path}, and FLOCK_N8N_URL / FLOCK_N8N_API_KEY are not set. ` +
          `Copy flock.config.example.json to flock.config.json, set those two variables, or run \`npm run demo\` to try Flock with sample data.`
      );
    }
    throw err;
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`config is not valid JSON: ${err.message}`);
  }
  return validateConfig(raw);
}

// Resolves an op:// reference through the 1Password CLI. The value is returned
// to the caller and never logged, cached to disk, or included in an error.
export async function resolveSecret(ref, { opBinary = "op", env = process.env } = {}) {
  if (isEnvRef(ref)) {
    const name = ref.slice(4);
    const value = env[name];
    if (!value) throw new ConfigError(`environment variable ${name} is not set (reference: ${ref})`);
    return value;
  }
  if (!isOpRef(ref)) throw new ConfigError(`not an op:// reference: ${ref}`);
  try {
    const { stdout } = await execFileAsync(opBinary, ["read", ref], {
      maxBuffer: 1024 * 1024,
      timeout: 30_000
    });
    const value = stdout.replace(/\r?\n$/, "");
    if (!value) throw new ConfigError(`1Password returned an empty value for ${ref}`);
    return value;
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    // Never surface stderr verbatim: it can echo the reference path.
    const reason = /not signed in|authorization timeout/i.test(err.stderr || "")
      ? "1Password is locked or not signed in. Run `op signin`."
      : "1Password read failed.";
    throw new ConfigError(`${reason} (reference: ${ref})`);
  }
}

export async function resolveN8nCredentials(config, options) {
  const n8n = config.n8n;
  const resolved = {
    baseUrl: n8n.baseUrl.replace(/\/$/, ""),
    apiKey: await resolveSecret(n8n.apiKey, options)
  };
  if (n8n.cfAccessClientId) {
    resolved.cfAccessClientId = await resolveSecret(n8n.cfAccessClientId, options);
  }
  if (n8n.cfAccessClientSecret) {
    resolved.cfAccessClientSecret = await resolveSecret(n8n.cfAccessClientSecret, options);
  }
  return resolved;
}
