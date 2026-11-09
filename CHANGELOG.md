# Changelog

## 0.1.0 (2026-11-09)

First public release.

- **Builder**: workflows drawn top to bottom with real n8n branches (IF, Switch,
  loops, error outputs, AI sub-nodes), brand logos and drawn icons, zoom, pan
  and fit. Shepherd docks underneath.
- **Shepherd**: a chat that asks questions, then drafts workflows that are
  checked by fixed rules and created unpublished. Risky drafts need an admin's
  approval.
- **Guardrails**: secret scan, loop guard, grouped failures, data boundary and
  test status, with a background watcher and optional Slack alerts.
- **Runs map**, **Agents** and **Organize** (bulk tags, folders, on/off with
  an infrastructure lock).
- **Demo mode** (`npm run demo`): a made-up instance, so you can try it with no
  n8n and no keys.
- Config from a file or from environment variables; Cloudflare Access sign-in.
