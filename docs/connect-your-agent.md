# Connect your agent

There are three ways to bring an AI agent into Flock:

1. **[Give Shepherd a model](#1-give-shepherd-a-model)**, so the chat in the
   Builder can draft workflows.
2. **[Let your coding agent use Flock](#2-let-your-coding-agent-use-flock)**
   (Claude Code, Codex, Cursor, Copilot…) to read your n8n and create drafts,
   with the same checks Shepherd gets, instead of giving it your n8n API key.
3. **[Let your coding agent work on Flock](#3-let-your-coding-agent-work-on-flock)**
   itself.

## 1. Give Shepherd a model

Shepherd works with any endpoint that speaks the OpenAI chat API and supports
structured outputs (`response_format` with a JSON schema). Set the key, and
optionally the endpoint and model:

| Provider | `FLOCK_SHEPHERD_BASE_URL` | `FLOCK_SHEPHERD_MODEL` |
| --- | --- | --- |
| OpenRouter (default) | *(leave unset)* | *(leave unset: `anthropic/claude-sonnet-4.5`)*, or any OpenRouter model id |
| OpenAI | `https://api.openai.com/v1` | an OpenAI model that supports structured outputs |
| A local server (Ollama, vLLM, LM Studio…) | its OpenAI-compatible URL, e.g. `http://localhost:11434/v1` | a model it serves; it must honour JSON-schema output |

```bash
export FLOCK_SHEPHERD_API_KEY=your-provider-key
```

```bash
npm start
```

In a config file, the same settings go in the `shepherd` block (see
[configuration.md](configuration.md)). The key is always a reference
(`env:NAME` or `op://…`), never the key itself.

On the **Settings** page an admin can switch the model and click **Test
connection**. The endpoint and key can only be changed in the config, so the
page can never send the key somewhere new.

Whatever the model says is treated as untrusted. Every draft goes through
Flock's fixed checks before it can be created, and it is always created
unpublished. To try the chat without any key, run `npm run demo`: Shepherd is
scripted there.

## 2. Let your coding agent use Flock

**Give your agent Flock's address, not your n8n API key.** With a raw key, an
agent can delete, publish or rewrite any workflow. Through Flock it can read
everything, but it can only create **unpublished drafts** that pass the same
checks as Shepherd's:

- no Code, shell, SSH, file or n8n-API nodes;
- no pasted keys and no attached credentials;
- no calls to localhost or private addresses;
- no copies of a workflow that already exists.

Everything it does is written to Flock's audit log.

### Set it up

The quickest way is Flock's **Settings** page (`/settings.html`), which has
copy buttons with your instance's address already filled in. By hand:

1. Run Flock on the same machine as the agent (or try the demo):

   ```bash
   npm run demo
   ```

2. Install the **Flock skill** in your project. Claude Code reads
   `.claude/skills/`; Codex and other agents read `.agents/skills/`. Flock serves
   the skill with its own address filled in:

   ```bash
   mkdir -p .claude/skills/flock .agents/skills/flock
   ```

   ```bash
   curl -s http://127.0.0.1:4174/agent/SKILL.md -o .claude/skills/flock/SKILL.md
   ```

   ```bash
   cp .claude/skills/flock/SKILL.md .agents/skills/flock/SKILL.md
   ```

   The skill tells the agent how to read workflows, ask Shepherd for a draft,
   create it, and handle a refusal. ([Template](../web/agent/SKILL.md).)

3. **Claude Code only:** let it call Flock without asking each time. Add to your
   project's `.claude/settings.json`:

   ```json
   {
     "permissions": {
       "allow": [
         "Bash(curl -s http://127.0.0.1:4174/api/workflows)",
         "Bash(curl -s \"http://127.0.0.1:4174/api/workflow?id=:*)",
         "Bash(curl -s http://127.0.0.1:4174/api/shepherd)",
         "Bash(curl -s http://127.0.0.1:4174/api/runs)",
         "Bash(curl -s http://127.0.0.1:4174/api/agents)",
         "Bash(curl -s http://127.0.0.1:4174/api/settings)",
         "Bash(curl -s -X POST http://127.0.0.1:4174/api/shepherd/draft :*)"
       ],
       "ask": [
         "Bash(curl -s -X POST http://127.0.0.1:4174/api/shepherd/create :*)",
         "Bash(curl -s -X POST http://127.0.0.1:4174/api/bulk/:*)"
       ]
     }
   }
   ```

   Reading and drafting run freely. Creating a draft and any bulk change still
   ask you first. Flock's own repo ships this file in
   [`.claude/settings.json`](../.claude/settings.json).

### Where drafts land

Drafts go into one of your **existing n8n folders**:

- the folder named in the request (`"folderId"` in `POST /api/shepherd/create`), or
- the default set on the Settings page, or
- the top level if neither is set.

`GET /api/settings` lists the folders. In the Builder there's a **Lands in**
picker next to *Create draft in n8n*. Folders need `n8n.projectId` (or
`FLOCK_N8N_PROJECT_ID`).

### What it looks like

A draft that passes:

```json
{"created":{"id":"demo-draft-1","name":"Big wholesale orders → Slack","active":false},"folder":{"id":"f-orders","name":"Orders"}}
```

A draft that doesn't, with the reason the agent should fix:

```json
{"error":"Flock will not create this: step \"Call\" calls localhost, which is the server or its private network",
 "guard":{"ok":false,"blocked":[{"rule":"server-access","why":"step \"Call\" calls localhost, which is the server or its private network"}],
 "warnings":[{"rule":"public-endpoint","why":"step \"Hook\" is a webhook with no authentication; an admin must add it before publishing"}]}}
```

### Who the agent counts as

- **Flock on `127.0.0.1` with no sign-in** (the setup above): the agent acts as
  the local admin (`FLOCK_ACTOR`), so set `FLOCK_ACTOR=coding-agent` to label its
  entries in the audit log. Admins can also switch workflows on or off and
  change locked ones through `/api/bulk/*`. If that's more than you want an
  agent to do, don't put those endpoints in its instructions, or run it against
  an instance behind sign-in.
- **Flock behind Cloudflare Access:** Flock identifies people by the email on
  their Access token, and service tokens carry no email, so an unattended agent
  can't sign in there yet. Run a local Flock for it instead.

There's no MCP server yet: the agent uses the HTTP API with `curl`, as the
skill shows. If you'd like one, open an issue.

## 3. Let your coding agent work on Flock

Nothing to set up. Claude Code reads [`CLAUDE.md`](../CLAUDE.md), and Codex,
Cursor, Copilot and most other agents read [`AGENTS.md`](../AGENTS.md): the
commands, the layout, the rules, and what to check before calling something
done. Point your agent at the repo and ask.
