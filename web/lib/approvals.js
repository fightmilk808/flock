import { DatabaseSync } from "node:sqlite";

// Flock's own state. Keeping approvals here (not in n8n) is deliberate: an
// approval record must survive an n8n restart and must be readable when n8n is
// down, and n8n has no place to put one.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  workflow_name TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  reason TEXT NOT NULL,
  risk TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  decided_by TEXT,
  decided_at TEXT,
  created_at TEXT NOT NULL,
  note TEXT
);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status, created_at DESC);

CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit(at DESC);

-- What the background watcher has already raised, so each problem alerts once.
CREATE TABLE IF NOT EXISTS alerts (
  key TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  workflow_id TEXT,
  title TEXT NOT NULL,
  detail TEXT,
  first_seen TEXT NOT NULL,
  notified TEXT,
  cleared_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_alerts_seen ON alerts(first_seen DESC);

CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
`;

export function openStore(path = ":memory:") {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);

  const insertApproval = db.prepare(
    `INSERT INTO approvals (id, workflow_id, workflow_name, requested_by, reason, risk, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`
  );
  const selectPending = db.prepare(`SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at DESC`);
  const selectAll = db.prepare(`SELECT * FROM approvals ORDER BY created_at DESC LIMIT ?`);
  const getById = db.prepare(`SELECT * FROM approvals WHERE id = ?`);
  const decide = db.prepare(
    `UPDATE approvals SET status = ?, decided_by = ?, decided_at = ?, note = ? WHERE id = ? AND status = 'pending'`
  );
  const insertAudit = db.prepare(`INSERT INTO audit (at, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)`);
  const recentAudit = db.prepare(`SELECT * FROM audit ORDER BY at DESC LIMIT ?`);
  const auditSince = db.prepare(`SELECT * FROM audit WHERE id > ? ORDER BY id ASC`);
  const maxAuditId = db.prepare(`SELECT COALESCE(MAX(id), 0) AS id FROM audit`);
  const getAlert = db.prepare(`SELECT * FROM alerts WHERE key = ?`);
  const insertAlert = db.prepare(
    `INSERT INTO alerts (key, kind, workflow_id, title, detail, first_seen, notified) VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const reopenAlert = db.prepare(`UPDATE alerts SET cleared_at = NULL, first_seen = ?, notified = ? WHERE key = ?`);
  const openAlerts = db.prepare(`SELECT * FROM alerts WHERE cleared_at IS NULL ORDER BY first_seen DESC LIMIT ?`);
  const openKeys = db.prepare(`SELECT key FROM alerts WHERE cleared_at IS NULL AND kind = ?`);
  const clearAlert = db.prepare(`UPDATE alerts SET cleared_at = ? WHERE key = ?`);
  const getMeta = db.prepare(`SELECT v FROM meta WHERE k = ?`);
  const setMeta = db.prepare(`INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`);

  return {
    createApproval({ id, workflowId, workflowName, requestedBy, reason, risk, createdAt }) {
      insertApproval.run(id, workflowId, workflowName, requestedBy, reason, risk, createdAt);
      insertAudit.run(createdAt, requestedBy, "approval.requested", workflowId, reason);
      return getById.get(id);
    },
    pending: () => selectPending.all(),
    recent: (limit = 50) => selectAll.all(limit),
    get: (id) => getById.get(id),
    // Returns false when the approval was already decided — prevents a double
    // click from logging two decisions.
    decide({ id, status, decidedBy, note, at }) {
      const result = decide.run(status, decidedBy, at, note ?? null, id);
      if (result.changes === 0) return false;
      const row = getById.get(id);
      insertAudit.run(at, decidedBy, `approval.${status}`, row.workflow_id, note ?? null);
      return row;
    },
    record(actor, action, target, detail, at) {
      insertAudit.run(at, actor, action, target, detail ?? null);
    },
    auditLog: (limit = 100) => recentAudit.all(limit),
    auditSince: (id) => auditSince.all(id),
    maxAuditId: () => maxAuditId.get().id,
    // Returns true when this is a new (or returning) problem worth raising.
    raiseAlert({ key, kind, workflowId, title, detail, at, notified }) {
      const row = getAlert.get(key);
      if (!row) {
        insertAlert.run(key, kind, workflowId ?? null, title, detail ?? null, at, notified ?? null);
        return true;
      }
      if (row.cleared_at) {
        reopenAlert.run(at, notified ?? null, key);
        return true;
      }
      return false;
    },
    openAlerts: (limit = 50) => openAlerts.all(limit),
    openAlertKeys: (kind) => openKeys.all(kind).map((r) => r.key),
    clearAlert: (key, at) => clearAlert.run(at, key),
    getMeta: (k) => (getMeta.get(k) || {}).v ?? null,
    setMeta: (k, v) => setMeta.run(k, String(v)),
    close: () => db.close()
  };
}
