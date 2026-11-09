// Bulk operations against n8n. This is the only place Flock writes to things
// that are already live, so every operation is planned first, reported as a
// list of concrete changes, and applied only on an explicit confirm.
//
// Two n8n behaviours make this delicate:
//   1. PUT /workflows/:id replaces the whole workflow document. Every op here
//      re-reads the current workflow and merges, never sends a partial body.
//   2. PUT /workflows/:id/tags replaces the entire tag list. Adding a tag is
//      therefore read-modify-write, and a failure between the two leaves the
//      list untouched, which is why the read happens inside the same call.

export class BulkError extends Error {}

export const BULK_OPS = {
  "add-tags": {
    label: "Add tags",
    detail: "Adds tags to every selected workflow, keeping the tags it already has.",
    needs: "tags",
    verb: "add"
  },
  "remove-tags": {
    label: "Remove tags",
    detail: "Removes the named tags from every selected workflow.",
    needs: "tags",
    verb: "remove"
  },
  "move-folder": {
    label: "Move to folder",
    detail: "Moves every selected workflow into one folder.",
    needs: "folderId",
    verb: "move"
  },
  activate: {
    label: "Activate",
    detail: "Turns every selected workflow on.",
    needs: null,
    verb: "activate"
  },
  deactivate: {
    label: "Deactivate",
    detail: "Turns every selected workflow off.",
    needs: null,
    verb: "deactivate"
  }
};

// Organising operations that change what a workflow *is* are refused outright.
// Archiving and deleting are destructive and are not offered in bulk.
const REFUSED = new Set(["archive", "delete", "publish"]);

export function describeOp(op) {
  if (REFUSED.has(op)) throw new BulkError(`${op} is not available in bulk`);
  const def = BULK_OPS[op];
  if (!def) throw new BulkError(`unknown bulk operation: ${op}`);
  return def;
}

// Validates a request and returns the normalised plan. Throws rather than
// silently correcting, so the person sees exactly what would happen.
export function planBulk({ op, workflowIds, tags, folderId, tagCatalogue, folderCatalogue, workflows }) {
  const def = describeOp(op);
  if (!Array.isArray(workflowIds) || workflowIds.length === 0) {
    throw new BulkError("select at least one workflow");
  }
  if (workflowIds.length > 200) {
    throw new BulkError("at most 200 workflows per operation");
  }

  const known = new Set((workflows || []).map((w) => w.id));
  const unknown = workflowIds.filter((id) => !known.has(id));
  if (unknown.length) {
    throw new BulkError(`${unknown.length} selected workflow(s) no longer exist`);
  }

  let resolvedTags = null;
  let resolvedFolder = null;

  if (def.needs === "tags") {
    if (!Array.isArray(tags) || tags.length === 0) throw new BulkError("name at least one tag");
    if (tags.length > 20) throw new BulkError("at most 20 tags per operation");
    const cleaned = tags.map((t) => String(t).trim()).filter(Boolean);
    if (cleaned.length === 0) throw new BulkError("tag names cannot be empty");
    for (const t of cleaned) {
      if (t.length > 64) throw new BulkError(`tag too long: ${t.slice(0, 20)}…`);
      // A comma in a tag name is legal in n8n but makes the bulk UI ambiguous.
      if (t.includes(",")) throw new BulkError(`tag names cannot contain a comma: ${t}`);
    }
    // Resolve to ids; a tag that does not exist yet is reported, not created,
    // because creating tags silently is a surprise the person did not ask for.
    const byName = new Map((tagCatalogue || []).map((t) => [t.name, t.id]));
    const missing = cleaned.filter((t) => !byName.has(t));
    if (missing.length) {
      throw new BulkError(`unknown tag(s): ${missing.join(", ")}. Create them first.`);
    }
    resolvedTags = cleaned.map((name) => ({ id: byName.get(name), name }));
  }

  if (def.needs === "folderId") {
    if (!folderId) throw new BulkError("choose a destination folder");
    const found = (folderCatalogue || []).find((f) => f.id === folderId);
    if (!found) throw new BulkError("destination folder not found");
    resolvedFolder = { id: found.id, name: found.name };
  }

  return {
    op,
    label: def.label,
    verb: def.verb,
    workflowIds: [...workflowIds],
    count: workflowIds.length,
    tags: resolvedTags,
    folder: resolvedFolder
  };
}

// Who may apply a plan. An admin may do anything planBulk allows. Everyone
// else may tag and move workflows that are not infrastructure, and nothing
// more: switching a workflow on or off changes what runs in production, and
// the reserved tags define the infrastructure lock itself.
export const ADMIN_ONLY_OPS = new Set(["activate", "deactivate"]);

export function authorizeBulk(plan, { isAdmin, classification, reservedTags = new Set(), workflows = [] }) {
  if (isAdmin) return;
  if (ADMIN_ONLY_OPS.has(plan.op)) {
    throw new BulkError(`${plan.label} is admin-only: turning workflows on or off changes what runs in production`);
  }
  const reserved = (plan.tags || []).filter((t) => reservedTags.has(t.name));
  if (reserved.length) {
    throw new BulkError(`the ${reserved.map((t) => t.name).join(", ")} tag is admin-only: it marks infrastructure`);
  }
  const names = new Map(workflows.map((w) => [w.id, w.name]));
  const locked = plan.workflowIds.filter((id) => classification.get(id)?.infra);
  if (locked.length) {
    const shown = locked.slice(0, 5).map((id) => `"${names.get(id) || id}"`).join(", ");
    const more = locked.length > 5 ? ` and ${locked.length - 5} more` : "";
    throw new BulkError(
      `${locked.length} selected workflow(s) are infrastructure and only an admin can change them: ${shown}${more}. Deselect them to continue.`
    );
  }
}

// Applies a plan through the client. Each item is applied independently and the
// result reports per-workflow success, so one failure does not hide the rest.
export async function applyBulk(client, plan, { onProgress } = {}) {
  const results = [];
  let index = 0;

  for (const id of plan.workflowIds) {
    index += 1;
    try {
      if (plan.verb === "add" || plan.verb === "remove") {
        const current = await client.getWorkflowTags(id);
        const currentIds = (current || []).map((t) => t.id);
        const wanted = plan.tags.map((t) => t.id);
        let next;
        if (plan.verb === "add") {
          next = [...new Set([...currentIds, ...wanted])];
        } else {
          const drop = new Set(wanted);
          next = currentIds.filter((tid) => !drop.has(tid));
        }
        if (next.length === currentIds.length && next.every((v) => currentIds.includes(v))) {
          results.push({ id, status: "unchanged" });
        } else {
          await client.setWorkflowTags(id, next.map((tagId) => ({ id: tagId })));
          results.push({ id, status: "applied" });
        }
      } else if (plan.verb === "move") {
        // parentFolderId is write-only on n8n's API, so the current folder
        // cannot be read back to detect a no-op. The move is sent every time.
        const wf = await client.getWorkflow(id);
        await client.updateWorkflow(id, {
          name: wf.name,
          nodes: wf.nodes,
          connections: wf.connections,
          settings: wf.settings,
          parentFolderId: plan.folder.id
        });
        results.push({ id, status: "applied" });
      } else if (plan.verb === "activate") {
        await client.activateWorkflow(id);
        results.push({ id, status: "applied" });
      } else if (plan.verb === "deactivate") {
        await client.deactivateWorkflow(id);
        results.push({ id, status: "applied" });
      }
    } catch (err) {
      results.push({ id, status: "failed", error: String(err.message || err).slice(0, 200) });
    }
    if (onProgress) onProgress({ done: index, total: plan.workflowIds.length, id });
  }

  return {
    op: plan.op,
    label: plan.label,
    applied: results.filter((r) => r.status === "applied").length,
    unchanged: results.filter((r) => r.status === "unchanged").length,
    failed: results.filter((r) => r.status === "failed").length,
    results
  };
}
