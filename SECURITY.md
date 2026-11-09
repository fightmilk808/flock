# Security

Flock holds an n8n API key and can create drafts, change tags and switch
workflows on or off, so security reports are taken seriously.

## Reporting a problem

Please **don't open a public issue**. Use GitHub's private
[security advisory form](https://github.com/fightmilk808/flock/security/advisories/new).
You should get a reply within a week.

## How Flock is meant to be run

- It listens on `127.0.0.1` by default. If you expose it, put it behind an
  identity-aware proxy. Flock supports **Cloudflare Access** directly: with an
  `access` block in the config, every API request must carry a valid Access
  token, and admins are a list of emails.
- Without an `access` block, every visitor is treated as the admin. Don't
  expose an instance like that.
- Secrets are only ever `env:NAME` or `op://` references. A literal key in the
  config stops Flock from starting.
- Writes to n8n go through a fixed allowlist (`web/lib/n8n-client.js`). Flock
  can't publish, archive or delete workflows, or read credential values.
- Shepherd's model output is treated as untrusted input. Every draft is
  re-validated by `web/lib/shepherd.js` and `web/lib/draft-guard.js` before it
  can be created, and it's always created unpublished.
