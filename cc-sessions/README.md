---
title: cc-sessions
description: Live Claude Code session dashboard — hq page consuming cctap state
---

# cc-sessions

hq page that displays active/inactive Claude Code sessions, permission gates, and Ghostty terminal metadata.

## Data sources

All data comes from `cctap`:
- `~/.cctap/state.json` — sessions, history, ghostty terminals (written by `cctap watch`)
- `~/.cctap/gates/*.json` — pending permission prompts (written by cctap plugin hook)

This page never reads `~/.claude/` directly.

## API endpoints

- `GET /cc-sessions/api/sessions?hours=24` — unified session list (active + inactive)
- `GET /cc-sessions/api/feed?limit=30` — recent prompt feed
- `GET /cc-sessions/api/gates` — pending permission gates

## hq config

```json
{
  "slug": "cc-sessions",
  "label": "CC Sessions",
  "dir": "~/exogradient/coding-tools/cc-sessions",
  "background": "~/exogradient/coding-tools/cctap/cctap watch"
}
```

The `background` field tells hq to start `cctap watch` on mount and kill it on shutdown.
