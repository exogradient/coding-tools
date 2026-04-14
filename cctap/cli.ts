#!/usr/bin/env bun
/**
 * cctap — Claude Code runtime state reader.
 *
 * Reads CC session files, history, and Ghostty terminal metadata.
 * Writes unified state to ~/.cctap/state.json for consumers.
 *
 * Usage:
 *   cctap read              # read all, write state.json
 *   cctap read sessions     # just sessions
 *   cctap read history      # just history
 *   cctap read ghostty      # just ghostty
 *   cctap watch [interval]  # poll and write continuously (default 3s)
 */

import { readdir, readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";

const HOME = homedir();
const CLAUDE_DIR = join(HOME, ".claude");
const SESSIONS_DIR = join(CLAUDE_DIR, "sessions");
const HISTORY_FILE = join(CLAUDE_DIR, "history.jsonl");
const STATE_DIR = join(HOME, ".cctap");
const STATE_FILE = join(STATE_DIR, "state.json");
const GATES_DIR = join(STATE_DIR, "gates");

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

interface SessionInfo {
  sessionId: string;
  pid: number;
  alive: boolean;
  busy: boolean;
  cwd: string;
  project: string;
  kind: string;
  entrypoint: string;
  name: string;
  startedAt: number;
  terminal: string;
}

async function detectTerminal(pid: number): Promise<string> {
  const APPS: Record<string, string> = {
    ghostty: "Ghostty", iterm: "iTerm2", "terminal.app": "Terminal.app",
    alacritty: "Alacritty", kitty: "kitty", wezterm: "WezTerm",
    warp: "Warp", code: "VS Code",
  };
  try {
    let cur = pid;
    for (let i = 0; i < 8; i++) {
      const proc = Bun.spawn(["ps", "-o", "ppid=,command=", "-p", String(cur)], {
        stdout: "pipe", stderr: "pipe",
      });
      const out = (await new Response(proc.stdout).text()).trim();
      await proc.exited;
      const idx = out.indexOf(" ");
      if (idx < 0) break;
      const ppid = parseInt(out.slice(0, idx).trim());
      const cmd = out.slice(idx + 1).toLowerCase();
      if (cmd.includes("tmux")) {
        const m = cmd.match(/-s\s+(\S+)/);
        return m ? `tmux:${m[1]}` : "tmux";
      }
      if (cmd.includes("screen")) return "screen";
      for (const [k, v] of Object.entries(APPS)) {
        if (cmd.includes(k)) return v;
      }
      if (ppid <= 1) break;
      cur = ppid;
    }
  } catch {}
  return "";
}

async function isBusy(pid: number): Promise<boolean> {
  try {
    const proc = Bun.spawn(["pgrep", "-P", String(pid), "-f", "caffeinate"], {
      stdout: "pipe", stderr: "pipe",
    });
    const out = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    return out.length > 0;
  } catch { return false; }
}

// Built by readHistory, consumed by readSessions to fix stale session files
let _latestSessionByPath = new Map<string, { sessionId: string; lastTs: number }[]>();
// Tracks which session IDs are already assigned to a PID (prevents double-claiming)
const _claimedSessionIds = new Set<string>();

async function readSessions(): Promise<SessionInfo[]> {
  if (!existsSync(SESSIONS_DIR)) return [];
  const files = await readdir(SESSIONS_DIR);
  const sessions: SessionInfo[] = [];

  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const pid = parseInt(f.replace(".json", ""));
    if (isNaN(pid)) continue;

    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch {}

    try {
      const raw = await readFile(join(SESSIONS_DIR, f), "utf8");
      const sess = JSON.parse(raw.split("\n")[0]);
      let sessionId = sess.sessionId || "";
      const cwd = sess.cwd || "";

      // Fix stale session IDs: the session file is written at process startup
      // but the user can switch sessions (/clear, resume) without restarting.
      // If the file's session ID has no history OR its last activity is old,
      // look for an unmatched session on the same path that's more recent.
      if (alive && cwd) {
        const candidates = _latestSessionByPath.get(cwd);
        if (candidates) {
          const fileEntry = candidates.find(c => c.sessionId === sessionId);
          // Only correct if the file's session looks stale:
          // - no history at all, OR
          // - another session on this path has much more recent activity
          if (!fileEntry || fileEntry.lastTs < Date.now() - 24 * 3600_000) {
            // Find the most recent session for this path that isn't already
            // claimed by another session file
            const sorted = [...candidates].sort((a, b) => b.lastTs - a.lastTs);
            for (const candidate of sorted) {
              if (candidate.sessionId !== sessionId && !_claimedSessionIds.has(candidate.sessionId)) {
                sessionId = candidate.sessionId;
                break;
              }
            }
          }
        }
      }
      _claimedSessionIds.add(sessionId);

      const terminal = alive ? await detectTerminal(pid) : "";
      const busy = alive ? await isBusy(pid) : false;
      sessions.push({
        sessionId,
        pid, alive, busy,
        cwd,
        project: cwd.split("/").pop() || "",
        kind: sess.kind || "",
        entrypoint: sess.entrypoint || "",
        name: sess.name || "",
        startedAt: sess.startedAt || 0,
        terminal,
      });
    } catch {}
  }
  return sessions;
}

interface HistorySession {
  sessionId: string;
  project: string;
  fullPath: string;
  prompts: number;
  firstPrompt: string;
  lastPrompt: string;
  lastPromptRaw: string;
  prevPrompt: string;
  firstTs: number;
  lastTs: number;
}

const THROWAWAY = new Set(["/clear", "exit", "/exit", "quit", "/quit", "/help", "y", "n"]);

async function readHistory(hours: number = 24): Promise<HistorySession[]> {
  if (!existsSync(HISTORY_FILE)) return [];
  const cutoff = Date.now() - hours * 3600_000;
  const text = await readFile(HISTORY_FILE, "utf8");
  const index = new Map<string, {
    project: string; prompts: number;
    firstPrompt: string; lastPrompt: string; prevPrompt: string;
    firstTs: number; lastTs: number;
  }>();

  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const r = JSON.parse(line);
      const sid = r.sessionId;
      if (!sid) continue;
      const ts = r.timestamp || 0;
      const display = r.display || "";
      const existing = index.get(sid);
      if (!existing) {
        index.set(sid, {
          project: r.project || "",
          prompts: 1,
          firstPrompt: display,
          lastPrompt: display,
          prevPrompt: "",
          firstTs: ts, lastTs: ts,
        });
      } else {
        existing.prompts++;
        if (ts < existing.firstTs) { existing.firstTs = ts; existing.firstPrompt = display; }
        if (ts > existing.lastTs) {
          existing.lastTs = ts;
          existing.prevPrompt = existing.lastPrompt;
          existing.lastPrompt = display;
          existing.project = r.project || existing.project;
        }
      }
    } catch {}
  }

  // Build path → sessions lookup for stale session ID correction
  const byPath = new Map<string, { sessionId: string; lastTs: number }[]>();
  for (const [sid, s] of index) {
    const path = s.project;
    if (!path) continue;
    const list = byPath.get(path) || [];
    list.push({ sessionId: sid, lastTs: s.lastTs });
    byPath.set(path, list);
  }
  _latestSessionByPath = byPath;

  const result: HistorySession[] = [];
  for (const [sid, s] of index) {
    if (s.lastTs < cutoff) continue;
    const lastRaw = s.lastPrompt;
    const effective = THROWAWAY.has(lastRaw.trim().toLowerCase()) && s.prevPrompt
      ? s.prevPrompt : lastRaw;
    result.push({
      sessionId: sid,
      project: s.project.split("/").pop() || "",
      fullPath: s.project,
      prompts: s.prompts,
      firstPrompt: s.firstPrompt.slice(0, 200),
      lastPrompt: effective.slice(0, 200),
      lastPromptRaw: lastRaw.slice(0, 200),
      prevPrompt: s.prevPrompt.slice(0, 200),
      firstTs: s.firstTs,
      lastTs: s.lastTs,
    });
  }
  return result;
}

interface GhosttyTerminal {
  tabIndex: number;
  terminalId: string;
  cwd: string;
  title: string;
}

async function readGhostty(): Promise<GhosttyTerminal[]> {
  try {
    const proc = Bun.spawn(["osascript", "-e", `
tell application "Ghostty"
    set output to ""
    repeat with w in every window
        repeat with t in every tab of w
            set tIdx to index of t
            repeat with term in every terminal of t
                set termId to id of term
                set termName to name of term
                set termDir to «class Gwdr» of term
                set output to output & tIdx & "|" & termId & "|" & termDir & "|" & termName & linefeed
            end repeat
        end repeat
    end repeat
    return output
end tell
`], { stdout: "pipe", stderr: "pipe" });
    const out = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    return out.split("\n").filter(l => l.includes("|")).map(line => {
      const [tab, id, cwd, ...rest] = line.split("|");
      return { tabIndex: parseInt(tab), terminalId: id, cwd, title: rest.join("|") };
    });
  } catch { return []; }
}

async function readGates(): Promise<Record<string, unknown>[]> {
  if (!existsSync(GATES_DIR)) return [];
  const gates: Record<string, unknown>[] = [];
  try {
    for (const f of await readdir(GATES_DIR)) {
      if (!f.endsWith(".json")) continue;
      try { gates.push(JSON.parse(await readFile(join(GATES_DIR, f), "utf8"))); } catch {}
    }
  } catch {}
  return gates;
}

/** Remove stale gate files. A gate is stale if:
 *  1. The session has had activity after the gate timestamp, OR
 *  2. The session is no longer alive (process exited).
 *  Returns the gates that are still active. */
async function cleanupResolvedGates(
  gates: Record<string, unknown>[],
  history: HistorySession[],
  aliveSids: Set<string>,
): Promise<Record<string, unknown>[]> {
  const histMap = new Map(history.map(h => [h.sessionId, h]));
  const remaining: Record<string, unknown>[] = [];
  for (const gate of gates) {
    const sid = gate.session_id as string;
    const gateTs = gate.timestamp as number;
    const h = histMap.get(sid);
    const resolved = h && h.lastTs > gateTs;
    const dead = !aliveSids.has(sid);
    if (resolved || dead) {
      try { await unlink(join(GATES_DIR, `${sid}.json`)); } catch {}
    } else {
      remaining.push(gate);
    }
  }
  return remaining;
}

// ---------------------------------------------------------------------------
// State writer
// ---------------------------------------------------------------------------

async function writeState(
  sections?: Set<string>,
  hours: number = 24,
): Promise<Record<string, unknown>> {
  await mkdir(STATE_DIR, { recursive: true });

  const all = !sections || sections.size === 0;
  const state: Record<string, unknown> = { timestamp: Date.now() };

  // History must run first — it populates _latestSessionByPath used by readSessions
  if (all || sections?.has("history") || sections?.has("sessions")) {
    state.history = await readHistory(hours);
  }

  const promises: Promise<void>[] = [];
  if (all || sections?.has("sessions")) {
    promises.push(readSessions().then(d => { state.sessions = d; }));
  }
  if (all || sections?.has("ghostty")) {
    promises.push(readGhostty().then(d => { state.ghostty = d; }));
  }
  if (all || sections?.has("gates")) {
    promises.push(readGates().then(d => { state.gates = d; }));
  }

  await Promise.all(promises);

  // Clean up stale gate files and remove them from state
  if (state.gates && state.history) {
    const aliveSids = new Set(
      ((state.sessions as any[]) || [])
        .filter(s => s.alive)
        .map(s => s.sessionId as string),
    );
    state.gates = await cleanupResolvedGates(
      state.gates as Record<string, unknown>[],
      state.history as HistorySession[],
      aliveSids,
    );
  }

  await writeFile(STATE_FILE, JSON.stringify(state));
  return state;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const [cmd, ...args] = process.argv.slice(2);

if (cmd === "read") {
  const sections = args.length > 0 ? new Set(args) : undefined;
  const state = await writeState(sections);
  console.log(JSON.stringify(state, null, 2));
} else if (cmd === "watch") {
  const interval = parseInt(args[0] || "3") * 1000;
  console.log(`cctap watching every ${interval / 1000}s → ${STATE_FILE}`);
  const tick = async () => {
    try { await writeState(); } catch (e) { console.error("tick failed:", e); }
  };
  await tick();
  setInterval(tick, interval);
} else {
  console.log(`usage: cctap <read|watch> [sections|interval]`);
  process.exit(1);
}
