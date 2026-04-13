---
title: ccjump
description: Fast project switcher for Claude Code — frecency-ranked, arrow-key selection, zero dependencies beyond bash and jq
---

# ccjump

Jump between Claude Code projects without remembering paths. Ranks projects by frecency (frequency + recency) using Claude Code's own history data.

## The problem

```
# Every time you want to switch projects:
cd ~/some-org/some-repo    # hope you remember the path
claude                      # hope you remember the org
```

With many repos across multiple orgs, this breaks down fast. Older projects? You don't even remember the name.

## Usage

```bash
ccjump              # arrow-key selector → cd + claude
ccjump api          # jump to best match for "api" → cd + claude
ccjump ls           # list all projects, sorted by recency
```

### `ccjump` — interactive selector

Opens a frecency-ranked list of every project you've used with Claude. Arrow keys to navigate, Enter to select, Esc to cancel.

```
  ❯ web-api              acme-corp        2m ago   ●
    data-pipeline        acme-corp       20m ago   ●
    mobile-app           side-projects   10h ago   ●
    research-kit         lab-org          9d ago
    old-prototype        experiments     44d ago
```

- `●` marks projects with an active Claude session
- Frecency scoring: recent + frequently used projects rank highest
- Single match auto-selects (no arrow keys needed)

### `ccjump <query>` — direct jump

Substring match on project name and org. If one match, jumps immediately. If multiple, opens the selector pre-filtered.

### `ccjump ls` — project overview

All projects sorted by last use, active sessions highlighted in green.

```
 PROJECT                ORG                LAST
 web-api                acme-corp        2m ago   ●
 data-pipeline          acme-corp       20m ago   ●
 mobile-app             side-projects   10h ago   ●
 research-kit           lab-org          9d ago
 old-prototype          experiments     44d ago
```

## How it works

Reads Claude Code's own data — no manual registry:

- **`~/.claude/history.jsonl`** — every interaction timestamped with project path. Drives frecency scoring.
- **`~/.claude/sessions/*.json`** — active session PIDs. Drives the `●` active indicator.

### Frecency algorithm

```
score = sum(time_weight(age_of_each_interaction)) × (1 + 0.1 × ln(unique_sessions))
```

| Interaction age | Weight |
|----------------|--------|
| < 4 hours | 100 |
| < 1 day | 70 |
| < 1 week | 50 |
| < 1 month | 30 |
| > 1 month | 10 |

Projects with more unique sessions get a logarithmic bonus — rewards breadth of engagement over a single long session.

## Install

Requires: `bash`, `jq`

```bash
# Clone and symlink
git clone https://github.com/exogradient/coding-tools.git
ln -s /path/to/coding-tools/ccjump/ccjump ~/.local/bin/ccjump

# Fish shell: install the cd + claude wrapper
cp /path/to/coding-tools/ccjump/ccjump.fish ~/.config/fish/functions/
```

The fish function is needed because only a shell function can `cd` the current shell. It calls the `ccjump` binary for all computation, then does `cd` + `claude`.

### Other shells

For bash/zsh, add a wrapper function to your rc file:

```bash
ccjump() {
  if [[ "${1:-}" == "ls" ]]; then
    command ccjump ls
    return
  fi
  local path
  path=$(command ccjump "$@")
  if [[ $? -eq 0 && -n "$path" && -d "$path" ]]; then
    cd "$path" && claude
  fi
}
```

## Design decisions

- **Bash + jq, not Python/Node** — instant startup (~50ms total), no package manager, no virtual env. The jq expression computes frecency over 7000+ history entries in under 50ms.
- **No manual registry** — derives everything from Claude's own history. Zero maintenance.
- **Arrow-key nav, not fzf** — no external dependency. The project list is small enough (tens, not hundreds) that a simple selector works fine.
- **Fish wrapper pattern** — the binary outputs a path to stdout; the shell function handles `cd`. Clean separation of computation from shell state mutation.
