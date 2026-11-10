// Builds a ready-to-publish GitHub wiki tree in dist/wiki/ from this repo's README and docs.
// Generic: nothing in here names the repo. Node built-ins only; git is optional.
// Run: node .github/scripts/build-wiki.mjs      Published by .github/workflows/wiki-sync.yml.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const IMAGE_EXT = /\.(png|gif|jpe?g|svg|webp)$/i;
const SKIP_DIRS = new Set(["node_modules", "superpowers", "archive", "dist", "vendor"]);
// Root files that are not pages: the README is Home, the rest are instructions for agents.
const SKIP_ROOT = new Set(["readme.md", "claude.md", "agents.md", "gemini.md"]);
const RESERVED = new Set(["home", "changelog", "_sidebar", "_footer"]);
const MAX_PAGES = 80;
const MAX_BYTES = 400000;
const SIDEBAR_PAGES = 30;
/** The publish step only overwrites a wiki that holds this file (or a fresh placeholder). */
export const MARKER = ".wiki-sync";

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

/** owner/name from the Actions environment, else from the origin remote, else the folder name. */
export function repoSlug(root = ROOT) {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  try {
    const m = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(git(["remote", "get-url", "origin"], root));
    if (m) return m[1];
  } catch {}
  return path.basename(root);
}

function walkMarkdown(dir, rel = "") {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name.startsWith(".")) continue;
    const child = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name.toLowerCase())) out.push(...walkMarkdown(path.join(dir, e.name), child));
    } else if (/\.md$/i.test(e.name) && fs.statSync(path.join(dir, e.name)).size <= MAX_BYTES) {
      out.push(child);
    }
  }
  return out;
}

function titleOf(text, fallback) {
  const m = /^#\s+(.+?)\s*#*\s*$/m.exec(text.replace(/```[\s\S]*?```/g, ""));
  return (m ? m[1].replace(/[*_`]|<[^>]+>|!?\[([^\]]*)\]\([^)]*\)/g, "$1").trim() : "") || fallback;
}

/** The pages to publish: [{ src, name, title }]. Home is first and may have no src. */
export function collectPages(root = ROOT) {
  const rootFiles = fs.readdirSync(root).filter((f) => /\.md$/i.test(f) && fs.statSync(path.join(root, f)).isFile());
  const readme = rootFiles.find((f) => f.toLowerCase() === "readme.md");
  const sources = rootFiles.filter((f) => !SKIP_ROOT.has(f.toLowerCase()) && fs.statSync(path.join(root, f)).size <= MAX_BYTES).sort();
  const docs = path.join(root, "docs");
  if (fs.existsSync(docs) && fs.statSync(docs).isDirectory()) sources.push(...walkMarkdown(docs).map((f) => `docs/${f}`));

  const pages = [{ src: readme || null, name: "Home", title: "Home" }];
  const used = new Set(["home"]);
  for (const src of sources.slice(0, MAX_PAGES)) {
    let name = src.replace(/^docs\//, "").replace(/\.md$/i, "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "Page";
    if (RESERVED.has(name.toLowerCase())) name = `Doc-${name}`;
    let unique = name;
    for (let n = 2; used.has(unique.toLowerCase()); n++) unique = `${name}-${n}`;
    used.add(unique.toLowerCase());
    pages.push({ src, name: unique, title: titleOf(fs.readFileSync(path.join(root, src), "utf8"), unique) });
  }
  return { pages, skipped: Math.max(0, sources.length - MAX_PAGES) };
}

function rewriteTarget(target, ctx) {
  if (/^([a-z][a-z0-9+.-]*:|#|\/\/)/i.test(target)) return target;
  const m = /^([^#?]*)([#?].*)?$/.exec(target);
  let decoded = m[1];
  try { decoded = decodeURI(m[1]); } catch {}
  const rel = decoded.startsWith("/") ? path.posix.normalize(decoded.slice(1)) : path.posix.normalize(path.posix.join(ctx.baseDir, decoded));
  const tail = m[2] || "";
  if (rel.startsWith("..")) return target;
  const page = ctx.byPath.get(rel.toLowerCase());
  if (page) return page + tail;
  const onDisk = path.join(ctx.root, rel);
  if (IMAGE_EXT.test(rel) && fs.existsSync(onDisk)) {
    const flat = rel.replace(/[^A-Za-z0-9._-]+/g, "_");
    ctx.media.set(flat, onDisk);
    return "media/" + flat;
  }
  const kind = decoded.endsWith("/") || (fs.existsSync(onDisk) && fs.statSync(onDisk).isDirectory()) ? "tree" : "blob";
  return `${ctx.repoUrl}/${kind}/${ctx.branch}/${encodeURI(rel.replace(/\/$/, ""))}${tail}`;
}

/** Rewrite relative links and image paths so a page works inside the wiki. */
export function rewriteForWiki(markdown, ctx) {
  // Odd entries of the split are fenced blocks or inline code: leave them byte-identical.
  return markdown
    .split(/(```[\s\S]*?```|~~~[\s\S]*?~~~|``[^`]+``|`[^`\n]+`)/)
    .map((seg, i) =>
      i % 2
        ? seg
        : seg
            .replace(/\]\(<([^>]+)>((?:\s+"[^"]*")?)\)/g, (_, t, title) => `](${rewriteTarget(t, ctx).replace(/ /g, "%20")}${title})`)
            .replace(/\]\(([^)\s<]+)((?:\s+"[^"]*")?)\)/g, (_, t, title) => `](${rewriteTarget(t, ctx)}${title})`)
            .replace(/\b(src|href)="([^"]*)"/g, (_, attr, t) => `${attr}="${rewriteTarget(t, ctx)}"`)
    )
    .join("");
}

/** Changelog page from git log --first-parent; one line if history is unavailable. */
export function changelogPage(root, repoUrl) {
  let log = "";
  try {
    log = git(["log", "--first-parent", "-n", "200", "--format=%h%x09%ad%x09%s", "--date=format:%Y-%m-%d"], root);
  } catch {}
  const head = "# 🗒 Changelog\n\n";
  if (!log) return head + "Git history is not available, so this page is empty.\n";
  const rows = log.split("\n").map((line) => {
    const [sha, date, ...rest] = line.split("\t");
    const subject = rest.join("\t").replace(/\|/g, "\\|").replace(/</g, "&lt;");
    const linked = subject.replace(/#(\d+)/, (_, n) => `[#${n}](${repoUrl}/pull/${n})`);
    return `| ${date} | ${linked} | [\`${sha}\`](${repoUrl}/commit/${sha}) |`;
  });
  return `${head}Newest first, the last ${rows.length} changes on the main branch.\n\n| Date | Change | Commit |\n|---|---|---|\n${rows.join("\n")}\n`;
}

/** Build the whole tree and return its folder. */
export function build({ root = ROOT, out = path.join(root, "dist", "wiki"), branch = process.env.DEFAULT_BRANCH || "main" } = {}) {
  const slug = repoSlug(root);
  const repoUrl = `https://github.com/${slug}`;
  const repoName = slug.split("/").pop();
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(path.join(out, "media"), { recursive: true });

  const { pages, skipped } = collectPages(root);
  const byPath = new Map(pages.filter((p) => p.src).map((p) => [p.src.toLowerCase(), p.name]));
  const media = new Map();
  for (const p of pages) {
    const ctx = { root, repoUrl, branch, byPath, media, baseDir: p.src ? path.posix.dirname(p.src).replace(/^\.$/, "") : "" };
    const text = p.src
      ? rewriteForWiki(fs.readFileSync(path.join(root, p.src), "utf8"), ctx)
      : `# ${repoName}\n\nThis repo has no README yet. Add a \`README.md\` and this page becomes it.\n\n[Open the repo on GitHub](${repoUrl})\n`;
    fs.writeFileSync(path.join(out, `${p.name}.md`), text);
  }
  for (const [flat, src] of media) fs.copyFileSync(src, path.join(out, "media", flat));
  fs.writeFileSync(path.join(out, "Changelog.md"), changelogPage(root, repoUrl));

  const listed = pages.slice(1, SIDEBAR_PAGES + 1).map((p) => `- [${p.title.replace(/[[\]]/g, "")}](${p.name})`);
  const more = pages.length - 1 - listed.length + skipped;
  if (more > 0) listed.push(`- …and ${more} more in [docs](${repoUrl}/tree/${branch}/docs)`);
  fs.writeFileSync(
    path.join(out, "_Sidebar.md"),
    `**📚 ${repoName}**\n\n- [🏠 Home](Home)\n${listed.join("\n")}${listed.length ? "\n" : ""}- [🗒 Changelog](Changelog)\n\n` +
      `**🔗 On GitHub**\n\n- [📦 Repo](${repoUrl})\n- [🔀 Pull requests](${repoUrl}/pulls)\n- [⚙️ Actions](${repoUrl}/actions)\n`
  );

  let sha = process.env.GITHUB_SHA || "";
  try {
    sha = git(["rev-parse", "HEAD"], root); // the checked-out commit wins over GITHUB_SHA
  } catch {}
  const shaText = sha ? `[\`${sha.slice(0, 7)}\`](${repoUrl}/commit/${sha})` : "an unknown commit";
  fs.writeFileSync(path.join(out, "_Footer.md"), `Generated from ${shaText} by the wiki-sync action. Edit the repo, not the wiki.\n`);
  fs.writeFileSync(path.join(out, MARKER), "Written by .github/workflows/wiki-sync.yml. Do not edit this wiki by hand.\n");
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const out = build();
    console.log(`wiki tree ready: ${path.relative(ROOT, out)}/ (${fs.readdirSync(out).length} entries)`);
  } catch (e) {
    console.error(`build-wiki: ${e.message}`);
    process.exit(1);
  }
}
