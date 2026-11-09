# Configuration

Flock reads `flock.config.json` (or the file in `FLOCK_CONFIG`). If there is no
file, it builds the config from `FLOCK_*` environment variables
([.env.example](../.env.example)). `npm run demo` needs neither.

**Secrets are references, never values.** Any key field takes either:

- `env:NAME`: read from the environment variable `NAME`, or
- `op://<vault-uuid>/<item-uuid>/<field>`: read with the 1Password CLI (`op`)
  when Flock starts. Use vault **UUIDs**; titles with punctuation don't resolve.

A literal key in the config file stops Flock from starting.

## The config file

| Field | Required | What it does |
| --- | --- | --- |
| `n8n.baseUrl` | yes | Where Flock calls the n8n API. |
| `n8n.apiKey` | yes | n8n API key (reference). |
| `n8n.projectId` | no | Project whose folders Organize can move workflows into. |
| `n8n.cfAccessClientId`, `n8n.cfAccessClientSecret` | no | Service token, if n8n itself sits behind Cloudflare Access. |
| `shepherd.apiKey` | no | Turns on Shepherd. Any OpenAI-compatible endpoint. |
| `shepherd.baseUrl`, `shepherd.model` | no | Default OpenRouter, `anthropic/claude-sonnet-4.5`. |
| `org.name`, `org.adminName` | no | Shown in the UI and given to Shepherd ("only Maya can approve that"). |
| `org.n8nUiUrl` | no | Where people open the n8n editor. Defaults to `n8n.baseUrl`; set it when Flock reaches n8n on a private address. |
| `org.publicUrl` | no | Flock's own address, for links in Slack alerts. |
| `org.internalHosts` | no | Your domains. A workflow calling one is treated as touching a company system. |
| `org.companySystems` | no | Replace the default list of company systems (`shopify`, `gmail`, `google-drive`, `warehouse-db`, …). |
| `access.teamDomain`, `access.audience` | no | Cloudflare Access sign-in (below). |
| `admins` | with `access` | Emails that can approve drafts, switch workflows on or off, and change infrastructure. |
| `watch.intervalMinutes` | no | Run the guardrails in the background every N minutes (2 to 1440). |
| `watch.slack.token`, `watch.slack.channel` | no | Post new problems to a Slack channel or DM (bot token reference, channel id). |

## The Settings page

Admins can change two things at `/settings.html`. Both are stored in Flock's
database, not the config file:

- **Folder for new drafts:** one of your existing n8n folders (needs
  `n8n.projectId`). It can also be chosen per draft.
- **Shepherd's model:** overrides `shepherd.model`. The endpoint and key are
  deliberately config-only.

## Sign-in with Cloudflare Access

1. Create an Access application for Flock's hostname.
2. Set `access.teamDomain` (`<team>.cloudflareaccess.com`) and `access.audience`
   (the application's 64-character AUD tag), and list `admins`.

Flock then verifies the `Cf-Access-Jwt-Assertion` header on every API request
against your team's signing keys. A request without a valid token is refused,
and a plain email header is never trusted.

Without `access`, every visitor is the admin. That's fine on `127.0.0.1`, but
don't expose it.

## Environment variables

| Variable | Default | |
| --- | --- | --- |
| `FLOCK_HOST` | `127.0.0.1` | Use `0.0.0.0` in Docker. |
| `FLOCK_PORT` | `4174` | |
| `FLOCK_CONFIG` | `./flock.config.json` | |
| `FLOCK_DB` | `./data/flock.db` | Approvals, alerts and audit log (SQLite). |
| `FLOCK_ACTOR` | `admin` | Who local, sign-in-free actions are logged as. |
| `FLOCK_DEMO` | unset | `1` runs the demo instance (what `npm run demo` does). |

Config from the environment only: `FLOCK_N8N_URL`, `FLOCK_N8N_API_KEY`,
`FLOCK_N8N_PROJECT_ID`, `FLOCK_N8N_UI_URL`, `FLOCK_SHEPHERD_API_KEY`,
`FLOCK_SHEPHERD_BASE_URL`, `FLOCK_SHEPHERD_MODEL`, `FLOCK_ORG_NAME`,
`FLOCK_ADMIN_NAME`, `FLOCK_PUBLIC_URL`, `FLOCK_INTERNAL_HOSTS` (comma list),
`FLOCK_ADMINS` (comma list), `FLOCK_WATCH_MINUTES` (default 10, `0` = off),
`FLOCK_SLACK_TOKEN`, `FLOCK_SLACK_CHANNEL`.

## What the API key needs

Flock checks each feature once and tells you what's missing, with the scope
named. Useful scopes: workflows (read, create, update, activate), executions
(read), tags (read, update), users (read), audit (generate), and where your plan
has them `insights:read`, `nodeTypePolicy:manage` and `testRun:list`.
