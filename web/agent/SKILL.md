---
name: flock
description: Read and build n8n workflows through Flock instead of n8n's API. Use when the task involves n8n workflows (what exists, what a workflow does, why runs fail, guardrail findings) or creating a new workflow. Flock checks every draft and only ever creates it unpublished.
---

# n8n through Flock

This team's n8n is reached through Flock at {{FLOCK_URL}}. Never call n8n
directly and never ask for an n8n API key: Flock is the safe way in.

## Read

```bash
curl -s {{FLOCK_URL}}/api/workflows
```

Every workflow: id, name, on/off, tags, systems, owner, and whether it is
locked as infrastructure (with the reasons).

```bash
curl -s "{{FLOCK_URL}}/api/workflow?id=WORKFLOW_ID"
```

One workflow's nodes, connections and recent runs.

```bash
curl -s {{FLOCK_URL}}/api/shepherd
```

Guardrail results (pasted keys, loops, failures) and everything that needs
attention, with the reason for each.

```bash
curl -s {{FLOCK_URL}}/api/runs
```

```bash
curl -s {{FLOCK_URL}}/api/agents
```

Recent runs, and every AI agent node with its model and tools.

```bash
curl -s {{FLOCK_URL}}/api/settings
```

Which existing n8n folders there are, and the default folder for new drafts.

## Create a workflow

New workflows are always created **unpublished**. A person reviews and
publishes them in n8n.

1. Optionally ask Shepherd for a draft. It replies, may ask a question, and
   returns a ready `payload`:

   ```bash
   curl -s -X POST {{FLOCK_URL}}/api/shepherd/draft -H 'Content-Type: application/json' -d '{"request":"When a form is submitted, add a row to the sheet and post it to Slack","history":[]}'
   ```

   Pass earlier turns back in `history` (`[{"role":"user","content":"…"},{"role":"assistant","content":"…"}]`).

2. Or write the n8n workflow JSON yourself:
   `{"name": "...", "nodes": [...], "connections": {...}, "settings": {"executionOrder": "v1"}}`.
   Use only `n8n-nodes-base.*` node types, start with a trigger, and leave
   credentials out (a person attaches them in n8n).

3. Create it. `folderId` is optional; without it the draft goes to the default
   folder from Settings:

   ```bash
   curl -s -X POST {{FLOCK_URL}}/api/shepherd/create -H 'Content-Type: application/json' -d '{"payload": PAYLOAD_JSON, "folderId": "FOLDER_ID"}'
   ```

4. If the response has `"error"`, read `guard.blocked[].why`, change the
   workflow to fix that, and try again. Flock refuses Code, shell, SSH, file
   and n8n-API nodes, pasted keys, calls to localhost or private addresses, and
   copies of existing workflows. Don't try to get around a refusal; tell the
   person why it was refused.

## Don't

- Don't call `/api/bulk/*` (switching workflows on or off, moving or retagging
  in bulk) unless the person explicitly asks for that change.
- Don't publish, activate or delete anything. Flock can't, and you shouldn't
  try another way.
