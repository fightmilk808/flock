// Settings an admin can change from the Settings screen, kept in Flock's own
// database. Deliberately small: only values that can't leak a secret or point a
// key somewhere new. Shepherd's endpoint and key stay in the config file or the
// environment; only its model name can change here.

export class SettingsError extends Error {}

export const SETTINGS = {
  draftsFolderId: { label: "Folder for new drafts", type: "folder" },
  shepherdModel: { label: "Shepherd's model", type: "model" }
};

const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,119}$/;

// Checks a change from the browser. Returns only the known keys, cleaned.
// `null` or "" clears a setting back to its default.
export function validateSettings(input, { folders = [] } = {}) {
  if (!input || typeof input !== "object") throw new SettingsError("settings must be an object");
  const out = {};
  for (const [key, value] of Object.entries(input)) {
    if (!SETTINGS[key]) throw new SettingsError(`unknown setting: ${key}`);
    if (value === null || value === "") {
      out[key] = null;
      continue;
    }
    if (typeof value !== "string") throw new SettingsError(`${key} must be a string`);
    if (key === "draftsFolderId" && !folders.some((f) => f.id === value)) {
      throw new SettingsError("that folder no longer exists in n8n");
    }
    if (key === "shepherdModel" && !MODEL.test(value)) {
      throw new SettingsError("model must be a model id like anthropic/claude-sonnet-4.5");
    }
    out[key] = value;
  }
  return out;
}

// Stored settings, read through the store's meta table.
export function readSettings(store) {
  const out = {};
  for (const key of Object.keys(SETTINGS)) out[key] = store.getMeta(`settings.${key}`) || null;
  return out;
}

export function writeSettings(store, changes) {
  for (const [key, value] of Object.entries(changes)) store.setMeta(`settings.${key}`, value ?? "");
}

// The folder a new draft lands in: the one asked for, else the default, else
// the top level. An unknown id is an error rather than a silent fallback.
export function resolveDraftFolder({ requested, settings, folders }) {
  const id = requested === undefined ? settings.draftsFolderId : requested;
  if (!id) return null;
  const folder = folders.find((f) => f.id === id);
  if (!folder) throw new SettingsError("the drafts folder no longer exists in n8n; pick another in Settings");
  return { id: folder.id, name: folder.name };
}

// Folder names with their parents, for pickers: "Orders / Wholesale".
export function folderPaths(folders) {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const path = (f, seen = new Set()) => {
    if (!f.parentFolderId || !byId.has(f.parentFolderId) || seen.has(f.id)) return f.name;
    seen.add(f.id);
    return `${path(byId.get(f.parentFolderId), seen)} / ${f.name}`;
  };
  return folders.map((f) => ({ id: f.id, name: f.name, path: path(f) })).sort((a, b) => a.path.localeCompare(b.path));
}

// The instructions a coding agent needs to use this Flock, with its address
// filled in. The same text ships as .claude/skills/flock/SKILL.md and
// .agents/skills/flock/SKILL.md, built from web/agent/SKILL.md.
export function renderSkill(template, flockUrl) {
  return template.replaceAll("{{FLOCK_URL}}", flockUrl.replace(/\/$/, ""));
}
