// Turns an n8n workflow's `connections` into a drawable graph: which node feeds
// which, through which output (IF true/false, Switch outputs, error outputs),
// and where each node sits. Pure functions, shared by the browser and tests.
//
// Layout is top-to-bottom in layers: a node sits one layer below the deepest
// node that feeds it, branches spread side by side, and merges come back
// together. Edges that point back up (a "loop over items" loop) are kept and
// marked `back` so the canvas can route them round the side.

// Names for a node's outputs, the way n8n labels them on its canvas.
export function outputLabel(node, output, outputCount) {
  const type = (node && node.type) || "";
  const params = (node && node.parameters) || {};
  if (node && node.onError === "continueErrorOutput" && output === outputCount - 1 && outputCount > 1) {
    return "error";
  }
  if (/\.if$/i.test(type)) return output === 0 ? "true" : output === 1 ? "false" : `output ${output}`;
  if (/\.filter$/i.test(type)) return output === 0 ? "kept" : "discarded";
  if (/\.splitInBatches$/i.test(type)) return output === 0 ? "done" : "loop";
  if (/\.switch$/i.test(type)) {
    const rules = params.rules && Array.isArray(params.rules.values) ? params.rules.values : [];
    const rule = rules[output];
    if (rule && rule.renameOutput && typeof rule.outputKey === "string" && rule.outputKey.trim()) {
      return rule.outputKey.trim();
    }
    if (output === rules.length && params.options && params.options.fallbackOutput === "extra") return "fallback";
    return `output ${output}`;
  }
  return outputCount > 1 ? `output ${output}` : null;
}

// Every edge between drawn nodes. `main` edges are the flow. AI sub-nodes
// (model, memory, tools) connect *into* their agent; they are drawn hanging
// below it, so their edge is flipped and marked `ai`.
export function extractEdges(workflow, nodes) {
  const byName = new Map((nodes || []).map((n) => [n.name, n]));
  const connections = (workflow && workflow.connections) || {};
  const edges = [];
  for (const [source, kinds] of Object.entries(connections)) {
    if (!byName.has(source) || !kinds || typeof kinds !== "object") continue;
    for (const [kind, outputs] of Object.entries(kinds)) {
      if (!Array.isArray(outputs)) continue;
      const used = outputs.length;
      outputs.forEach((links, output) => {
        for (const link of links || []) {
          if (!link || !byName.has(link.node)) continue;
          if (kind === "main") {
            edges.push({
              from: source,
              to: link.node,
              output,
              outputs: used,
              kind: "main",
              label: outputLabel(byName.get(source), output, used)
            });
          } else {
            edges.push({
              from: link.node,
              to: source,
              output: 0,
              outputs: 1,
              kind: "ai",
              label: kind.replace(/^ai_/, "").replace(/([A-Z])/g, " $1").toLowerCase().trim()
            });
          }
        }
      });
    }
  }
  return edges;
}

// Marks edges that close a cycle, found by a depth-first walk in node order,
// so layering can ignore them.
function markBackEdges(names, edges) {
  const out = new Map(names.map((n) => [n, []]));
  edges.forEach((e, i) => out.get(e.from).push(i));
  const state = new Map();
  const back = new Set();
  const visit = (start) => {
    const stack = [[start, 0]];
    state.set(start, 1);
    while (stack.length) {
      const top = stack[stack.length - 1];
      const list = out.get(top[0]);
      if (top[1] >= list.length) {
        state.set(top[0], 2);
        stack.pop();
        continue;
      }
      const ei = list[top[1]++];
      const next = edges[ei].to;
      const s = state.get(next) || 0;
      if (s === 1) back.add(ei);
      else if (s === 0) {
        state.set(next, 1);
        stack.push([next, 0]);
      }
    }
  };
  // Start from nodes nothing feeds (triggers), then anything left over.
  const fed = new Set(edges.map((e) => e.to));
  for (const n of names) if (!fed.has(n) && !state.get(n)) visit(n);
  for (const n of names) if (!state.get(n)) visit(n);
  return back;
}

export const LAYOUT = { nodeWidth: 240, nodeHeight: 80, colGap: 36, rowGap: 64, pad: 24, laneWidth: 14 };

// Places every node. Returns pixel boxes, the edges (each with the points it
// passes through and a `back` flag), and the overall size, so the canvas only
// has to draw.
//
// An edge that skips rows gets a lane of its own: a thin virtual node in each
// row it crosses, so it runs beside the cards instead of behind them.
export function layoutGraph(nodes, edges, opts = {}) {
  const L = { ...LAYOUT, ...opts };
  const names = (nodes || []).map((n) => n.name);
  const known = new Set(names);
  const all = (edges || []).filter((e) => known.has(e.from) && known.has(e.to) && e.from !== e.to);
  const back = markBackEdges(names, all);
  const fwd = all.filter((_, i) => !back.has(i));

  // Longest-path layering: a node sits below everything that feeds it.
  const indeg = new Map(names.map((n) => [n, 0]));
  fwd.forEach((e) => indeg.set(e.to, indeg.get(e.to) + 1));
  const layer = new Map(names.map((n) => [n, 0]));
  const queue = names.filter((n) => indeg.get(n) === 0);
  while (queue.length) {
    const n = queue.shift();
    for (const e of fwd) {
      if (e.from !== n) continue;
      layer.set(e.to, Math.max(layer.get(e.to), layer.get(n) + 1));
      indeg.set(e.to, indeg.get(e.to) - 1);
      if (indeg.get(e.to) === 0) queue.push(e.to);
    }
  }

  // Split long edges into one-row segments through virtual lane nodes.
  const width = new Map(names.map((n) => [n, L.nodeWidth]));
  const segs = []; // { from, to, output, outputs, first }
  const lanes = new Map(); // forward edge index -> [virtual names]
  fwd.forEach((e, ei) => {
    const span = layer.get(e.to) - layer.get(e.from);
    if (span <= 1) {
      segs.push({ from: e.from, to: e.to, output: e.output, outputs: e.outputs, first: true });
      return;
    }
    const chain = [];
    let prev = e.from;
    for (let k = 1; k < span; k += 1) {
      const v = `\u0000lane:${ei}:${k}`;
      layer.set(v, layer.get(e.from) + k);
      width.set(v, L.laneWidth);
      chain.push(v);
      segs.push({ from: prev, to: v, output: e.output, outputs: e.outputs, first: k === 1 });
      prev = v;
    }
    segs.push({ from: prev, to: e.to, output: 0, outputs: 1, first: false });
    lanes.set(e, chain);
  });

  const every = [...layer.keys()];
  const layerCount = every.length ? Math.max(...layer.values()) + 1 : 0;
  const rows = Array.from({ length: layerCount }, () => []);
  every.forEach((n) => rows[layer.get(n)].push(n));
  const parents = new Map(every.map((n) => [n, []]));
  segs.forEach((s) => parents.get(s.to).push(s));
  const seq = new Map(every.map((n, i) => [n, i]));

  // Order within a row: follow the parents' order, then the output used
  // (IF true on the left, false on the right), then the original node order.
  const order = new Map();
  rows.forEach((row) => {
    const key = (n) => {
      const ps = parents.get(n);
      if (!ps.length) return [Infinity, 0, seq.get(n)];
      const avg = ps.reduce((s, e) => s + order.get(e.from), 0) / ps.length;
      return [avg, Math.min(...ps.map((e) => (e.first ? e.output : 0))), seq.get(n)];
    };
    const keyed = row.map((n) => [n, key(n)]);
    keyed.sort((a, b) => a[1][0] - b[1][0] || a[1][1] - b[1][1] || a[1][2] - b[1][2]);
    row.length = 0;
    keyed.forEach(([n], i) => { row.push(n); order.set(n, i); });
  });

  // Centres: sit under the parents (a chain stays straight, a merge centres,
  // a branch fans out by output), then push apart anything that would touch.
  const step = L.nodeWidth + L.colGap;
  const cx = new Map();
  rows.forEach((row) => {
    const want = row.map((n, i) => {
      const ps = parents.get(n);
      if (!ps.length) return i * step;
      const base = ps.reduce((s, e) => s + cx.get(e.from), 0) / ps.length;
      const p = ps[0];
      const fan = ps.length === 1 && p.first && p.outputs > 1 ? (p.output - (p.outputs - 1) / 2) * step : 0;
      return base + fan;
    });
    const placed = want.slice();
    const gapAfter = (i) => (width.get(row[i]) + width.get(row[i + 1])) / 2 + L.colGap / (width.get(row[i]) === L.laneWidth || width.get(row[i + 1]) === L.laneWidth ? 2 : 1);
    for (let i = 1; i < placed.length; i += 1) placed[i] = Math.max(placed[i], placed[i - 1] + gapAfter(i - 1));
    // Pushing only goes right; pull the row back so on average it sits where it wanted.
    const drift = placed.reduce((a, b, i) => a + b - want[i], 0) / placed.length;
    row.forEach((n, i) => cx.set(n, placed[i] - drift));
  });

  const minLeft = every.length ? Math.min(...every.map((n) => cx.get(n) - width.get(n) / 2)) : 0;
  const rowH = L.nodeHeight + L.rowGap;
  const top = (n) => layer.get(n) * rowH + L.pad;
  const left = (n) => cx.get(n) - width.get(n) / 2 - minLeft + L.pad;

  const boxes = {};
  for (const n of names) {
    boxes[n] = { x: left(n), y: top(n), w: L.nodeWidth, h: L.nodeHeight, layer: layer.get(n) };
  }
  const maxRight = every.length ? Math.max(...every.map((n) => left(n) + width.get(n))) : 0;
  const hasBack = back.size > 0;

  const outEdges = all.map((e, i) => {
    const chain = back.has(i) ? [] : lanes.get(e) || [];
    return {
      ...e,
      back: back.has(i),
      // Where the edge runs through its lane: one vertical stretch per row it skips.
      via: chain.map((v) => ({ x: left(v) + L.laneWidth / 2, top: top(v), bottom: top(v) + L.nodeHeight }))
    };
  });

  return {
    boxes,
    edges: outEdges,
    width: maxRight + L.pad + (hasBack ? 48 : 0),
    height: layerCount * rowH - L.rowGap + L.pad * 2,
    layers: layerCount,
    branches: all.some((e) => e.kind === "main" && e.outputs > 1) ||
      names.some((n) => all.filter((e) => e.from === n && e.kind === "main").length > 1)
  };
}

// SVG path for one edge, between the boxes from layoutGraph. Forward edges
// leave the bottom of the source (spread across it by output), run down any
// lane they were given, and enter the top of the target; back edges go round
// the right-hand side.
export function edgePath(edge, boxes, width) {
  const a = boxes[edge.from];
  const b = boxes[edge.to];
  if (!a || !b) return null;
  const spread = edge.outputs > 1 ? (edge.output + 1) / (edge.outputs + 1) : 0.5;
  const sx = a.x + a.w * spread;
  const sy = a.y + a.h;
  const tx = b.x + b.w / 2;
  const ty = b.y;
  if (edge.back) {
    const rx = width - 20;
    return {
      d: `M ${sx} ${sy} C ${sx} ${sy + 30}, ${rx} ${sy + 30}, ${rx} ${sy} L ${rx} ${ty - 10} C ${rx} ${ty - 30}, ${tx} ${ty - 30}, ${tx} ${ty}`,
      labelAt: { x: sx, y: sy + 14 }
    };
  }
  const curve = (x0, y0, x1, y1) => {
    const mid = (y1 - y0) / 2;
    return `C ${x0} ${y0 + mid}, ${x1} ${y1 - mid}, ${x1} ${y1}`;
  };
  let d = `M ${sx} ${sy}`;
  let x = sx;
  let y = sy;
  for (const v of edge.via || []) {
    d += ` ${curve(x, y, v.x, v.top)} L ${v.x} ${v.bottom}`;
    x = v.x;
    y = v.bottom;
  }
  d += ` ${curve(x, y, tx, ty)}`;
  const firstX = edge.via && edge.via.length ? edge.via[0].x : tx;
  const firstY = edge.via && edge.via.length ? edge.via[0].top : ty;
  const mid = (firstY - sy) / 2;
  return { d, labelAt: { x: sx + (firstX - sx) * 0.15, y: sy + Math.min(18, mid) } };
}
