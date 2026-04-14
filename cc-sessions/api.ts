/**
 * cc-sessions API handler for hq server.
 *
 * Reads ~/.cctap/state.json (written by `cctap read` or `cctap watch`).
 * All CC runtime knowledge lives in cctap — this file only joins and serves.
 */

import { readFile, open } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const HOME = homedir();
const STATE_FILE = join(HOME, ".cctap/state.json");
const HISTORY_FILE = join(HOME, ".claude/history.jsonl");

const SKIP_DISPLAY = new Set(["/clear", "exit", "/exit", "quit", "/quit", "/help", "y", "n"]);

interface HistoryEntry {
  sessionId: string;
  display: string;
  timestamp: number;
  project: string;
}

async function readHistoryEntries(): Promise<HistoryEntry[]> {
  try {
    const text = await readFile(HISTORY_FILE, "utf8");
    const entries: HistoryEntry[] = [];
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        const r = JSON.parse(line);
        if (r.sessionId) {
          entries.push({
            sessionId: r.sessionId,
            display: r.display || "",
            timestamp: r.timestamp || 0,
            project: r.project || "",
          });
        }
      } catch {}
    }
    return entries;
  } catch {
    return [];
  }
}

interface State {
  timestamp: number;
  sessions?: Array<{
    sessionId: string; pid: number; alive: boolean; busy: boolean;
    cwd: string; project: string; terminal: string; [k: string]: unknown;
  }>;
  history?: Array<{
    sessionId: string; project: string; fullPath: string;
    prompts: number; firstPrompt: string; lastPrompt: string;
    lastPromptRaw: string; prevPrompt: string;
    firstTs: number; lastTs: number;
  }>;
  ghostty?: Array<{
    tabIndex: number; terminalId: string; cwd: string; title: string;
  }>;
  gates?: Array<{
    session_id: string; cwd: string; message: string;
    title: string; timestamp: number;
  }>;
}

async function readState(): Promise<State> {
  try {
    return JSON.parse(await readFile(STATE_FILE, "utf8"));
  } catch {
    return { timestamp: 0 };
  }
}

function matchGhostty(
  cwd: string,
  terminal: string,
  ghosttyByCwd: Map<string, State["ghostty"]>,
): { tab: number; title: string; ambiguous: boolean } | null {
  if (terminal !== "Ghostty" || !cwd) return null;
  const candidates = ghosttyByCwd.get(cwd);
  if (!candidates?.length) return null;
  if (candidates.length === 1) {
    return { tab: candidates[0]!.tabIndex, title: candidates[0]!.title, ambiguous: false };
  }
  // Multiple splits share this cwd — show tab but mark ambiguous
  const tabs = [...new Set(candidates.map(c => c!.tabIndex))].sort((a, b) => a - b);
  const tabLabel = tabs.length === 1 ? `tab ${tabs[0]}` : `tabs ${tabs.join(",")}`;
  const titles = candidates.map(c => c!.title).join(" | ");
  return { tab: tabs[0]!, title: titles, ambiguous: true };
}

export default async function handler(
  req: Request,
  path: string,
  url: URL,
): Promise<Response | null> {
  if (path === "/sessions" || path === "/sessions/") {
    if (req.method !== "GET") return null;
    const state = await readState();
    const sessions = state.sessions || [];
    const history = state.history || [];
    const ghostty = state.ghostty || [];
    const gates = state.gates || [];

    const histMap = new Map(history.map(h => [h.sessionId, h]));
    const gateMap = new Map(gates.map(g => [g.session_id, g]));

    const ghosttyByCwd = new Map<string, typeof ghostty>();
    for (const g of ghostty) {
      const list = ghosttyByCwd.get(g.cwd) || [];
      list.push(g);
      ghosttyByCwd.set(g.cwd, list);
    }

    const seenSids = new Set<string>();
    const result: Record<string, unknown>[] = [];

    for (const s of sessions) {
      seenSids.add(s.sessionId);
      const h = histMap.get(s.sessionId);
      const gate = gateMap.get(s.sessionId);
      const gm = matchGhostty(s.cwd, s.terminal, ghosttyByCwd);

      result.push({
        sessionId: s.sessionId.slice(0, 8),
        sessionIdFull: s.sessionId,
        active: !!s.alive,
        busy: s.busy || false,
        project: s.project,
        fullPath: s.cwd,
        kind: s.kind || "",
        name: s.name || "",
        prompts: h?.prompts || 0,
        firstPrompt: h?.firstPrompt || "",
        lastPrompt: h?.lastPrompt || "",
        lastPromptRaw: h?.lastPromptRaw || "",
        prevPrompt: h?.prevPrompt || "",
        firstTs: h?.firstTs || s.startedAt,
        lastTs: h?.lastTs || s.startedAt,
        startedAt: s.startedAt,
        durationMin: h ? Math.round((h.lastTs - h.firstTs) / 60000) : 0,
        terminal: gm ? `Ghostty ${gm.ambiguous ? `tab ${gm.tab}*` : `tab ${gm.tab}`}` : s.terminal,
        ghosttyTitle: gm?.title || "",
        gate: gate || null,
      });
    }

    // Inactive sessions from history
    for (const h of history) {
      if (seenSids.has(h.sessionId)) continue;
      result.push({
        sessionId: h.sessionId.slice(0, 8),
        sessionIdFull: h.sessionId,
        active: false,
        project: h.project,
        fullPath: h.fullPath,
        kind: "", name: "",
        prompts: h.prompts,
        firstPrompt: h.firstPrompt,
        lastPrompt: h.lastPrompt,
        lastPromptRaw: h.lastPromptRaw,
        prevPrompt: h.prevPrompt,
        firstTs: h.firstTs, lastTs: h.lastTs,
        startedAt: h.firstTs,
        durationMin: Math.round((h.lastTs - h.firstTs) / 60000),
        terminal: "", ghosttyTitle: "",
        gate: gateMap.get(h.sessionId) || null,
      });
    }

    return Response.json(result, {
      headers: { "X-State-Age": String(Date.now() - (state.timestamp || 0)) },
    });
  }

  // Detail for a single session
  const detailMatch = path.match(/^\/sessions\/([^/]+)\/detail\/?$/);
  if (detailMatch && req.method === "GET") {
    const sidParam = decodeURIComponent(detailMatch[1]);
    const entries = await readHistoryEntries();

    // Match by prefix (8-char short ID) or full ID
    const sessionEntries = entries
      .filter(e => e.sessionId === sidParam || e.sessionId.startsWith(sidParam))
      .sort((a, b) => a.timestamp - b.timestamp);

    if (sessionEntries.length === 0) {
      return Response.json({ error: "not found" }, { status: 404 });
    }

    const fullSid = sessionEntries[0].sessionId;
    const project = sessionEntries[0].project;

    // First meaningful prompt
    const firstPrompt = sessionEntries.find(
      e => !SKIP_DISPLAY.has(e.display.trim().toLowerCase()),
    )?.display || "";

    // /clear detection: find last /clear in session, get next real prompt
    let postClearPrompt: string | null = null;
    for (let i = sessionEntries.length - 1; i >= 0; i--) {
      if (sessionEntries[i].display.trim().toLowerCase() === "/clear") {
        for (let j = i + 1; j < sessionEntries.length; j++) {
          if (!SKIP_DISPLAY.has(sessionEntries[j].display.trim().toLowerCase())) {
            postClearPrompt = sessionEntries[j].display.slice(0, 500);
            break;
          }
        }
        break;
      }
    }

    // Cross-session /clear: if prev session on same path ended with /clear
    const firstTs = sessionEntries[0].timestamp;
    if (!postClearPrompt) {
      const prevEntries = entries
        .filter(e => e.project === project && e.sessionId !== fullSid && e.timestamp < firstTs)
        .sort((a, b) => b.timestamp - a.timestamp);
      if (prevEntries.length > 0 && prevEntries[0].display.trim().toLowerCase() === "/clear") {
        postClearPrompt = firstPrompt;
      }
    }

    // Resume detection: look for /resume in entries near this session's start
    let resumedFrom: string | null = null;
    const resumeEntries = entries.filter(
      e =>
        e.project === project &&
        e.display.trim().toLowerCase().startsWith("/resume") &&
        e.timestamp <= firstTs &&
        e.timestamp > firstTs - 60000,
    );
    if (resumeEntries.length > 0) {
      const parts = resumeEntries[0].display.trim().split(/\s+/);
      resumedFrom = parts.length > 1 ? parts[1] : "previous";
    }

    // Latest 10 non-throwaway prompts
    const realPrompts = sessionEntries.filter(
      e => !SKIP_DISPLAY.has(e.display.trim().toLowerCase()),
    );
    const latest10 = realPrompts.slice(-10);

    return Response.json({
      sessionId: fullSid.slice(0, 8),
      fullSessionId: fullSid,
      project: project.split("/").pop() || "",
      fullPath: project,
      firstPrompt: firstPrompt.slice(0, 500),
      postClearPrompt,
      resumedFrom,
      prompts: latest10.map(e => ({
        display: e.display.slice(0, 500),
        timestamp: e.timestamp,
      })),
      totalPrompts: realPrompts.length,
    });
  }

  if ((path === "/feed" || path === "/feed/") && req.method === "GET") {
    const limit = parseInt(url.searchParams.get("limit") || "30");
    try {
      const fh = await open(HISTORY_FILE, "r");
      try {
        const stat = await fh.stat();
        // Read last ~64KB — enough for hundreds of JSONL lines
        const tailBytes = Math.min(stat.size, 65536);
        const buf = Buffer.alloc(tailBytes);
        await fh.read(buf, 0, tailBytes, stat.size - tailBytes);
        const chunk = buf.toString("utf8");
        // Drop first partial line (unless we read from start of file)
        const lines = chunk.split("\n").filter(Boolean);
        if (tailBytes < stat.size) lines.shift();
        return Response.json(
          lines.slice(-limit).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
        );
      } finally {
        await fh.close();
      }
    } catch {
      return Response.json([]);
    }
  }

  // POST /focus — bring terminal to foreground or attach tmux
  if (path === "/focus" || path === "/focus/") {
    if (req.method !== "POST") return null;
    const body = await req.json() as { terminal?: string; cwd?: string };
    const terminal = body.terminal || "";
    const cwd = body.cwd || "";

    if (terminal.startsWith("tmux:")) {
      const session = terminal.slice(5);
      // Check if tmux session is already attached
      const check = Bun.spawn(["tmux", "list-clients", "-t", session], { stdout: "pipe", stderr: "pipe" });
      const clients = (await new Response(check.stdout).text()).trim();
      await check.exited;
      if (clients) {
        // Already attached — just activate Ghostty
        const proc = Bun.spawn(["osascript", "-e", 'tell application "Ghostty" to activate'], {
          stdout: "ignore", stderr: "ignore",
        });
        await proc.exited;
        return Response.json({ ok: true, action: "ghostty-activate", hint: `tmux:${session} already attached` });
      }
      // Not attached — open new Ghostty window
      const proc = Bun.spawn(
        ["open", "-na", "Ghostty.app", "--args", "-e", "tmux", "attach", "-t", session],
        { stdout: "ignore", stderr: "ignore" },
      );
      await proc.exited;
      return Response.json({ ok: true, action: "tmux-attach", session });
    }

    if (terminal.startsWith("Ghostty")) {
      // Activate Ghostty, extract tab number for user hint
      const tabMatch = terminal.match(/tab (\d+)/);
      const tab = tabMatch ? parseInt(tabMatch[1]) : null;
      const proc = Bun.spawn(["osascript", "-e", 'tell application "Ghostty" to activate'], {
        stdout: "ignore", stderr: "ignore",
      });
      await proc.exited;
      return Response.json({ ok: true, action: "ghostty-activate", tab });
    }

    return Response.json({ ok: false, error: "unknown terminal type" }, { status: 400 });
  }

  return null;
}
