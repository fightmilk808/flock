import { glyphSvg } from "./glyphs.js";
// Shared browser helpers. Everything renders through textContent or explicit
// element construction — no innerHTML with server data, so a workflow name
// containing markup cannot become markup.

export async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options
  });
  const text = await res.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { error: text };
    }
  }
  if (!res.ok) {
    const err = new Error((body && body.error) || `HTTP ${res.status}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

// Who runs this instance (admin name, org name) and whether it is the demo.
// Fetched once per page.
let orgPromise = null;
export function orgInfo() {
  if (!orgPromise) {
    orgPromise = api("/api/health")
      .then((h) => ({ adminName: "an admin", name: "your team", ...(h.org || {}), demo: Boolean(h.demo) }))
      .catch(() => ({ adminName: "an admin", name: "your team", demo: false }));
  }
  return orgPromise;
}

export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "style" && typeof value === "object") Object.assign(node.style, value);
    else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === "dataset") Object.assign(node.dataset, value);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function relativeTime(iso) {
  if (!iso) return "never";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "unknown";
  const diff = Date.now() - then;
  const mins = Math.round(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

export function initials(name) {
  return String(name || "?")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

export function toneClass(tone) {
  if (tone === "ok") return "chip chip-ok";
  if (tone === "warn") return "chip chip-warn";
  if (tone === "stop") return "chip chip-stop";
  return "chip chip-muted";
}

// A brand mark, or a lettered tile when the thing has no real logo.
// size: "sm" (20px, inline in lists), "" (28px), "lg" (40px, step tiles).
export function logo({ src, label, initials: text, color, glyph }, size = "") {
  const cls = size ? ` logo-${size}` : "";
  if (src) return el("img", { class: `logo${cls}`, src, alt: label || "", title: label || null, loading: "lazy", decoding: "async" });
  const svg = glyph ? glyphSvg(glyph) : null;
  if (svg) {
    const tile = el("span", { class: `logo-tile logo-glyph${cls}`, style: { background: color || "#8A8F9A" }, title: label || null, "aria-label": label || null });
    tile.innerHTML = svg; // our own constant markup from glyphs.js, never data
    return tile;
  }
  return el("span", {
    class: `logo-tile${cls}`,
    style: { background: color || "#8A8F9A" },
    title: label || null,
    "aria-label": label || null,
    text: text || initials(label || "?")
  });
}

// The systems a workflow touches, as a row of small marks.
export function systemStrip(systems, { max = 6 } = {}) {
  const shown = systems.slice(0, max).map((s) => logo({ src: s.logo, label: s.label, initials: initials(s.label), color: "#5B6170" }, "sm"));
  if (systems.length > max) shown.push(el("span", { class: "tag-mini", text: `+${systems.length - max}` }));
  return el("span", { class: "logo-row" }, shown);
}

// Who is signed in, from the server (the verified Cloudflare Access email).
let viewerPromise = null;
export function viewer() {
  if (!viewerPromise) {
    viewerPromise = api("/api/health")
      .then((h) => ({ email: h.actor, isAdmin: Boolean(h.isAdmin) }))
      .catch(() => ({ email: null, isAdmin: false }));
  }
  return viewerPromise;
}

function displayName(email) {
  if (!email) return "Signed in";
  const local = String(email).split("@")[0];
  return local.split(/[._-]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ") || email;
}

// The sidebar is identical on every screen; building it once keeps the nav
// honest about which page is current.
export function renderSidebar(active, counts = {}) {
  const brand = el("div", { class: "brand" }, [
    el("div", { class: "brand-mark", text: "F" }),
    el("div", { class: "brand-name", text: "Flock" })
  ]);
  orgInfo().then((o) => {
    if (o.demo) brand.append(el("span", { class: "demo-pill", title: "Sample data: nothing here is a real workflow", text: "Demo" }));
  });
  const foot = el("div", { class: "sidebar-foot" }, [el("div", { class: "avatar", text: "·" })]);
  viewer().then((v) => {
    clear(foot);
    foot.append(
      el("div", { class: "avatar", text: initials(displayName(v.email)) }),
      el("div", { class: "viewer" }, [
        el("div", { style: { minWidth: "0" } }, [
          el("div", { style: { fontSize: "13px", fontWeight: "600" }, text: displayName(v.email) }),
          el("div", { class: "viewer-email", text: v.isAdmin ? "Admin" : "Can organize open workflows" })
        ])
      ])
    );
  });

  return el("nav", { class: "sidebar", "aria-label": "Main" }, [
    brand,
    el("div", { class: "nav-group" }, [
      el("div", { class: "nav-label", text: "Workflows" }),
      navItem("/", "Builder", active === "builder", counts.company),
      navItem("/runs.html", "Runs map", active === "runs"),
      navItem("/agents.html", "Agents", active === "agents", counts.agents)
    ]),
    el("div", { class: "nav-group" }, [
      el("div", { class: "nav-label", text: "Guardrails" }),
      navItem("/shepherd.html", "Shepherd", active === "shepherd", counts.findings),
      navItem("/organize.html", "Organize", active === "organize")
    ]),
    el("div", { class: "nav-group" }, [
      el("div", { class: "nav-label", text: "Elsewhere" }),
      el("a", { class: "nav-item", href: "/n8n/home/workflows", target: "_blank", rel: "noopener" }, [
        el("span", { class: "logo-row" }, [logo({ src: "/vendor/logos/n8n.svg", label: "n8n" }, "sm"), el("span", { text: "Open n8n" })])
      ])
    ]),
    foot
  ]);
}

function navItem(href, label, current, count) {
  const children = [el("span", { text: label })];
  if (count) children.push(el("span", { class: "nav-count", text: String(count) }));
  return el("a", { class: "nav-item", href, "aria-current": current ? "page" : null }, children);
}

export function errorBanner(message) {
  return el("div", { class: "error-banner", role: "alert", text: message });
}
