---
title: cctap
description: Claude Code runtime state reader and permission gate hook
---

# cctap

Thin interface layer between Claude Code's runtime and external consumers.

**Writes**: permission gate state (`~/.cctap/gates/`) via CC plugin hook
**Reads**: session files, history, Ghostty terminal metadata via CLI

## Usage

```bash
# Read all state, write to ~/.cctap/state.json
./cctap read

# Continuous polling (default 3s)
./cctap watch

# Read specific section
./cctap read sessions
./cctap read history
./cctap read ghostty
```

## Dependencies

- bash 4+
- jq
- osascript (macOS, for Ghostty reader)

## Stale session file correction

**Problem**: Claude Code writes `~/.claude/sessions/{PID}.json` at process startup with a session ID. But users can switch sessions within the same process (`/clear`, resume). The session file never updates — it keeps the original ID.

**Effect**: PID 50300 starts as session `bf38915a`. User does `/clear`, starts new session `1af38dd4` with 70 prompts. Session file still says `bf38915a`. Dashboard shows `1af38dd4` as inactive (no PID) and `bf38915a` as active (has PID, 0 recent prompts).

**Fix**: `read_history` builds a map of `project_path → [{sessionId, lastTs}]`. `read_sessions` cross-references: if a session file's ID has no recent history, it adopts the most recent unclaimed session ID for that path. A claimed-set prevents two PIDs from grabbing the same session.

## Plugin hook

`hooks/permission-gate.sh` fires on `Notification(permission_prompt)`. Writes a gate file to `~/.cctap/gates/{session_id}.json` with the permission message and timestamp.

## Install

```bash
/plugin marketplace add ~/exogradient/coding-tools/cctap
/plugin install cctap@cctap-local
```

## Architecture

```
cctap (this)           → writes ~/.cctap/state.json + gates/
cc-sessions (hq page)  → reads state.json, serves dashboard UI
```

Viewer never touches `~/.claude/` directly.
