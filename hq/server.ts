#!/usr/bin/env bun
/**
 * hq — command center server
 *
 * Mounts page directories from any location into a single server.
 * Each page is a directory with an index.html and optional api.ts.
 *
 * Config: pages.local.json (gitignored) or HQ_CONFIG env var.
 * Usage: bun server.ts
 */

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PageConfig {
  slug: string;
  label: string;
  dir: string;
  background?: string;
}

interface Config {
  port: number;
  pages: PageConfig[];
}

interface MountedPage {
  slug: string;
  label: string;
  dir: string;
  prefix: string;      // "/{slug}"
  prefixSlash: string;  // "/{slug}/"
  apiPrefix: string;    // "/{slug}/api/"
  nav: string;          // prebuilt nav HTML for this page
  handler: ((req: Request, path: string, url: URL) => Promise<Response | null>) | null;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const HOME = homedir();

function expandPath(p: string): string {
  if (p.startsWith("~/")) return join(HOME, p.slice(2));
  if (p.startsWith("/")) return p;
  return resolve(import.meta.dir, p);
}

const configPath = process.env.HQ_CONFIG || join(import.meta.dir, "pages.local.json");
if (!existsSync(configPath)) {
  console.error(`Config not found: ${configPath}`);
  console.error("Copy pages.example.json to pages.local.json and edit it.");
  process.exit(1);
}

const config: Config = JSON.parse(await readFile(configPath, "utf8"));

// ---------------------------------------------------------------------------
// Mount pages
// ---------------------------------------------------------------------------

const pages: MountedPage[] = [];
const bgProcs: ReturnType<typeof Bun.spawn>[] = [];

for (const page of config.pages) {
  const dir = expandPath(page.dir);
  const htmlPath = join(dir, "index.html");

  if (!existsSync(htmlPath)) {
    console.warn(`Skipping "${page.slug}": no index.html at ${htmlPath}`);
    continue;
  }

  let handler: MountedPage["handler"] = null;
  const apiPath = join(dir, "api.ts");
  if (existsSync(apiPath)) {
    // Dynamic re-import on each request for live reload during development
    handler = async (req, path, url) => {
      try {
        const mod = await import(apiPath + "?t=" + Date.now());
        return mod.default(req, path, url);
      } catch (e) {
        console.warn(`api.ts error for "${page.slug}":`, e);
        return null;
      }
    };
  }

  // Spawn background process if configured
  let bgProc: ReturnType<typeof Bun.spawn> | null = null;
  if (page.background) {
    const cmd = expandPath(page.background);
    bgProc = Bun.spawn(["sh", "-c", cmd], { stdout: "ignore", stderr: "pipe" });
    bgProcs.push(bgProc);
  }

  const prefix = `/${page.slug}`;
  pages.push({
    slug: page.slug, label: page.label, dir, handler,
    prefix,
    prefixSlash: `${prefix}/`,
    apiPrefix: `${prefix}/api/`,
    nav: "",  // filled after all pages are mounted
  });
  const flags = [handler ? "api" : "", bgProc ? "bg" : ""].filter(Boolean).join(", ");
  console.log(`  ${page.slug} → ${dir}${flags ? ` (${flags})` : ""}`);
}

if (pages.length === 0) {
  console.error("No pages mounted. Check your config.");
  process.exit(1);
}

// Build nav HTML once — it's static after startup
for (const page of pages) {
  page.nav = buildNav(page.slug);
}

// ---------------------------------------------------------------------------
// Nav injection
//
// TRADEOFF: This is fragile. It assumes pages have a <body> tag, won't
// conflict on z-index:9999, and tolerate 36px stolen from the top. This
// works because all pages are authored by the same person, share the same
// dark theme, and the page count is small (~5). If pages diverge in style
// or authorship, replace this with an iframe shell or a landing page with
// links. See plan for discussion.
// ---------------------------------------------------------------------------

function buildNav(activeSlug: string): string {
  const links = pages
    .map((p) => {
      const cls = p.slug === activeSlug ? ' class="hq-active"' : "";
      return `<a href="/${p.slug}/"${cls}>${p.label}</a>`;
    })
    .join("");

  return `<nav id="hq-nav">
<span class="hq-brand">HQ</span>${links}
<style>
#hq-nav{position:fixed;top:0;left:0;right:0;z-index:9999;height:36px;
  display:flex;align-items:center;gap:0;background:#0d1117;
  border-bottom:1px solid #21262d;padding:0 12px;
  font-family:-apple-system,BlinkMacSystemFont,sans-serif;font-size:12px}
#hq-nav .hq-brand{font-weight:700;color:#e6edf3;margin-right:16px;font-size:13px}
#hq-nav a{color:#8b949e;text-decoration:none;padding:8px 14px;
  font-weight:500;border-bottom:2px solid transparent;transition:all .15s}
#hq-nav a:hover{color:#c9d1d9}
#hq-nav a.hq-active{color:#e6edf3;border-bottom-color:#1f6feb}
body{padding-top:36px !important}
</style>
</nav>`;
}

function injectNav(html: string, nav: string): string {
  const injected = html.replace(/(<body[^>]*>)/i, `$1\n${nav}\n`);
  if (injected === html) return nav + "\n" + html;
  return injected;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

Bun.serve({
  port: config.port,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    // Localhost-only
    const origin = req.headers.get("origin");
    if (origin && !origin.includes("localhost") && !origin.includes("127.0.0.1")) {
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }

    // Root → first page
    if (path === "/") {
      return Response.redirect(`/${pages[0].slug}/`, 302);
    }

    for (const page of pages) {
      // Trailing slash redirect
      if (path === page.prefix) {
        return Response.redirect(page.prefixSlash, 301);
      }

      // Serve page HTML
      if (path === page.prefixSlash) {
        try {
          const html = await readFile(join(page.dir, "index.html"), "utf8");
          return new Response(injectNav(html, page.nav), {
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        } catch {
          return Response.json({ error: `Page "${page.slug}" unavailable` }, { status: 503 });
        }
      }

      // API routes: /{slug}/api/...
      if (path.startsWith(page.apiPrefix) && page.handler) {
        const subPath = path.slice(page.prefix.length + 4); // strip "/{slug}/api"
        const result = await page.handler(req, subPath, url);
        if (result) return result;
      }
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  },
});

// Clean up background processes on exit
function cleanup() {
  for (const proc of bgProcs) {
    try { proc.kill(); } catch {}
  }
}
process.on("SIGINT", () => { cleanup(); process.exit(0); });
process.on("SIGTERM", () => { cleanup(); process.exit(0); });

console.log(`\nhq running at http://localhost:${config.port}/`);
