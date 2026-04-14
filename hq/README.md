---
title: hq
description: Command center — single Bun server that mounts page directories from any repo into a unified dashboard via a local config file
---

# hq

One server, many pages. Mount web dashboards from any directory into a single command center with a shared nav bar.

## The problem

You build small utility pages — a session monitor, an architecture explorer, a memory browser. Each runs its own dev server on its own port. You forget which port is which. You can't navigate between them.

## Usage

```bash
hq              # open dashboard in browser (refocuses existing tab)
hq dashboard    # same as above
hq serve        # start the server
```

The `hq` command is symlinked to `~/.local/bin/hq` from this directory.

Pages are declared in `pages.local.json` (gitignored — your paths stay private):

```json
{
  "port": 7391,
  "pages": [
    { "slug": "sessions", "label": "Live Sessions", "dir": "~/exogradient/coding-tools/sessions" },
    { "slug": "architecture", "label": "Architecture", "dir": "~/playground-org/a-cool-repo/pages/architecture" }
  ]
}
```

Copy `pages.example.json` to `pages.local.json` and edit it.

## Page contract

A page is a directory with:

```
my-page/
  index.html    # required
  api.ts        # optional — server-side routes
```

That's it. If `index.html` exists, it's mountable.

### Static pages

Just an `index.html`. Served at `/{slug}/`.

### Pages with APIs

Add an `api.ts` that exports a default handler:

```typescript
export default async function handler(
  req: Request,
  path: string,     // e.g. "/sessions/abc123" (prefix already stripped)
  url: URL,
): Promise<Response | null> {
  if (path === "/ping") {
    return Response.json({ pong: true });
  }
  return null; // not handled → 404
}
```

API routes are served at `/{slug}/api/*`. The handler receives the path after `/api`.

### API URL resolution

Pages should use **relative** fetch paths so they work both standalone and mounted:

```javascript
// Do this:
fetch("api/data")

// Not this:
fetch("/api/data")
```

When mounted at `/sessions/`, the browser resolves `api/data` → `/sessions/api/data`. When standalone at `/`, it resolves to `/api/data`. No configuration needed.

## Config

| Field | Description |
|-------|------------|
| `port` | Server port |
| `pages[].slug` | URL prefix (`/sessions`, `/arch`) |
| `pages[].label` | Display name in nav bar |
| `pages[].dir` | Path to page directory. Supports `~/`, absolute, or relative to `hq/` |
| `pages[].background` | Optional shell command to run in background while page is mounted. Killed on server shutdown. |

Alternatively, set `HQ_CONFIG` env var to point to a config file elsewhere.

## How it works

- Reads `pages.local.json` at startup
- For each page: resolves the directory, dynamically imports `api.ts` on each request (live reload, no restart)
- Spawns optional `background` processes, kills them on shutdown
- Injects a 36px nav bar into each page's HTML at serve time (no source files modified)
- Routes `/{slug}/` to the page, `/{slug}/api/*` to its handler
- Reads HTML from disk on each request — edit and refresh, no restart needed

## Design decisions

- **JSON config, not TypeScript** — simpler, no code execution in config. Server expands `~` paths.
- **Nav injection, not iframes** — injects a fixed top bar after `<body>`. Fragile (assumes pages tolerate 36px stolen from the top and won't conflict on z-index) but simple. Works because all pages share the same author and dark theme. If pages diverge, switch to an iframe shell or landing page.
- **No HTML caching** — `readFile` on every request. It's localhost serving 1 user; ~0.1ms per read buys live editing with no restart.
- **Relative API URLs** — pages use `fetch("api/foo")` (no leading `/`), so they work both standalone and mounted. The server redirects `/{slug}` → `/{slug}/` to ensure relative resolution works.

## Install

Requires: `bun`

```bash
cp pages.example.json pages.local.json
# edit pages.local.json with your page directories
ln -s "$(pwd)/hq" ~/.local/bin/hq
bun server.ts
```
