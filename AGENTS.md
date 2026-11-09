# AGENTS.md

Guidance for coding agents (and people) working on Flock. Read this before
changing anything.

## What Flock is

A web app that runs beside a self-hosted n8n and talks to it only through n8n's
public REST API. It draws workflows, runs guardrails, hosts the Shepherd drafting
chat and does bulk tidying. n8n stays the engine: Flock never runs workflows.

## Commands

| Task | Command |
| --- | --- |
| Run with sample data (no n8n, no keys) | `npm run demo` → http://127.0.0.1:4174 |
| Run against a real n8n | `FLOCK_N8N_URL=… FLOCK_N8N_API_KEY=… npm start` |
| Tests (no network) | `npm test` |
| Second instance | `FLOCK_PORT=4175 npm run demo` |

There is no install step, no build and no npm dependencies. Node 22.13+
(`node:sqlite`). Check a running server with `curl -s 127.0.0.1:4174/api/health`.

## Layout

- `scripts/serve.mjs`: the HTTP server, API routes (`routes` object), boot, watcher.
- `web/lib/*.js`: all logic, as pure ES modules shared by server and browser.
  - `n8n-client.js`: REST client with the **write allowlist**.
  - `flow-graph.js`: n8n connections → layered graph layout.
  - `shepherd.js`, `llm.js`, `draft-guard.js`: the chat, its prompt and schema, and the
    deterministic checks every draft must pass.
  - `security-scan.js`, `loop-guard.js`, `guardrails.js`, `watch.js`: guardrails.
  - `infra.js`, `bulk.js`, `identity.js`, `approvals.js`: roles, the infrastructure
    lock, Cloudflare Access sign-in, and the SQLite approvals and audit log.
  - `config.js`: config file / env loading, `org` settings, secret references.
  - `demo.js`: the made-up instance behind `npm run demo`.
- `web/*.html`: one page per screen, each an inline module that only renders.
- `tests/*.test.mjs`: `node:test`, one file per module.

## Rules

1. **Logic in `web/lib/`, with a test.** Pages render; they don't decide.
2. **No new dependencies** without a reason in the PR. Vendored files live in
   `web/vendor/` with their source noted.
3. **Never widen what Flock writes to n8n** (`WRITE_PATHS` in `n8n-client.js`)
   without an issue first. Flock must never publish, archive or delete
   workflows, or read credential values.
4. **Treat model output as untrusted.** Anything Shepherd returns goes through
   `buildWorkflowPayload` and `guardDraft` before it can reach n8n, and drafts
   are always created inactive.
5. **No server data as HTML.** Build DOM with `el()` from `web/lib/ui.js`
   (`textContent`). `innerHTML` is only for our own constant SVG strings.
6. **Secrets are references** (`env:NAME` or `op://…`), never literals in
   config, code, tests or docs.
7. **No real data.** Fixtures use invented names and `example.com`. Screenshots
   come from demo mode. Don't hard-code an organisation's names, people or
   hosts; they belong in the config's `org` block.
8. **A missing value shows as "unknown"**, never a plausible guess (demo mode
   aside, which is labelled).

## Before you say it's done

- `npm test` passes, and new logic has tests.
- For UI changes, run `npm run demo` and check the screen, including the
  narrow layout (under 900px). If the look changed, retake the matching
  `docs/media/*.png` at 1440×900, 2× scale, and keep the README images current.
- Update `README.md`, `docs/configuration.md` and `CHANGELOG.md` when
  behaviour, config or env vars change.
