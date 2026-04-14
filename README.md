---
title: coding-tools
description: Standalone CLI tools for developer workflows — portable, minimal dependencies, built from real friction
---

# coding-tools

Small, sharp CLI tools built from actual workflow friction. Each tool is standalone with minimal dependencies (typically just bash + standard unix tools).

## CLI

| Tool | What | How | Deps |
|------|------|-----|------|
| [ccjump](ccjump/) | Claude Code project switcher | Frecency-ranked selector from shell history | bash, jq |

## Plugins

| Tool | What | How | Deps |
|------|------|-----|------|
| [cctap](cctap/) | CC runtime state reader + permission gate hook | Plugin hook writes gates; CLI reads sessions/history/Ghostty | bash, jq |

## Browser

| Tool | What | How | Deps |
|------|------|-----|------|
| [hq](hq/) | Command center | Mounts page directories from any repo into one server | bun |
| [cc-sessions](cc-sessions/) | Live session dashboard | hq page consuming cctap state | bun (via hq) |
