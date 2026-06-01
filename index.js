#!/usr/bin/env node
'use strict';

// ccaudit: diagnostic for your Claude Code setup.
// Reads ~/.claude/ locally. Nothing leaves your machine.
// One-line install: npx @uxcontinuum/ccaudit

const fs   = require('fs');
const path = require('path');
const os   = require('os');

// ── COLOR + LAYOUT ────────────────────────────────────────────────────────────
const C = {
  bold: '\x1b[1m', dim: '\x1b[2m', reset: '\x1b[0m',
  green: '\x1b[92m', yellow: '\x1b[93m', red: '\x1b[91m',
  cyan: '\x1b[96m', white: '\x1b[97m', magenta: '\x1b[95m',
};
const hasFlag = (f) => process.argv.includes(f);
if (hasFlag('--no-color')) { for (const k in C) C[k] = ''; }
const getArg = (f, d) => {
  const i = process.argv.indexOf(f);
  return i > -1 && process.argv[i+1] ? process.argv[i+1] : d;
};
const pr = (s = '') => process.stdout.write(s + '\n');

// ── CLAUDE DIR DISCOVERY (root-aware) ─────────────────────────────────────────
function findClaudeDirs() {
  const candidates = [path.join(os.homedir(), '.claude')];
  if (os.homedir() === '/root') {
    try {
      for (const u of fs.readdirSync('/home')) {
        candidates.push(`/home/${u}/.claude`);
      }
    } catch (_) {}
  }
  const dirs = [];
  for (const c of candidates) {
    try { if (fs.statSync(c).isDirectory()) dirs.push(c); } catch (_) {}
  }
  return dirs.length ? dirs : [candidates[0]];
}
const CLAUDE_DIRS = findClaudeDirs();

// ── SESSION TYPE CLASSIFIER ───────────────────────────────────────────────────
// Agent-spawned worktrees end with a 32-char hex hash (your orchestrator's
// pattern). Named project dirs are human.
// Agent / subagent sessions are detected via the JSONL fields themselves
// (isSidechain, userType, agentId). Directory naming is a weak fallback only.
const UUID_RE     = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
const HEX_TAIL_RE = /-[0-9a-f]{20,}$/;
function fallbackAgentDirGuess(name) {
  if (UUID_RE.test(name)) return true;
  if (HEX_TAIL_RE.test(name)) return true;
  return false;
}

// ── FILE SCAN ─────────────────────────────────────────────────────────────────
function findJsonl(dir, cutoffMs, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of entries) {
    if (e.name === 'subagents') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { findJsonl(full, cutoffMs, out); continue; }
    if (!e.name.endsWith('.jsonl')) continue;
    try { if (fs.statSync(full).mtimeMs >= cutoffMs) out.push(full); } catch (_) {}
  }
  return out;
}

// ── SESSION PARSE ─────────────────────────────────────────────────────────────
function projDirName(filePath) {
  const parts = filePath.split(path.sep);
  const idx   = parts.lastIndexOf('projects');
  return idx >= 0 && idx + 1 < parts.length ? parts[idx + 1] : '';
}

// Cheap fingerprint of a tool_use input. Used to detect within-session retries.
function fpToolUse(name, input) {
  const key = typeof input === 'object' && input
    ? (input.command || input.file_path || input.path || input.pattern || JSON.stringify(input))
    : String(input ?? '');
  return name + '::' + String(key).slice(0, 200);
}

function parseSession(filePath, cutoffMs) {
  let lines;
  try { lines = fs.readFileSync(filePath, 'utf8').split('\n'); } catch (_) { return null; }

  const userPrompts = [];
  const toolCalls   = [];
  const timestamps  = [];
  let title = null;
  let slug  = null;
  let cwd   = null;
  let outputTokens = 0;
  let inputTokens  = 0;
  let isSidechain  = false;
  let userType     = null;
  let entrypoint   = null;
  let claudeVersion = null;
  let messageCount = 0;
  let toolErrors   = 0;
  const fpCounts = new Map(); // tool_use fingerprint → count, for retry detection

  for (const raw of lines) {
    if (!raw) continue;
    let msg;
    try { msg = JSON.parse(raw); } catch (_) { continue; }

    // Capture session-level metadata from the first message that has it.
    if (cwd === null && typeof msg.cwd === 'string')               cwd = msg.cwd;
    if (slug === null && typeof msg.slug === 'string')             slug = msg.slug;
    if (userType === null && typeof msg.userType === 'string')     userType = msg.userType;
    if (entrypoint === null && typeof msg.entrypoint === 'string') entrypoint = msg.entrypoint;
    if (claudeVersion === null && typeof msg.version === 'string') claudeVersion = msg.version;
    if (msg.isSidechain === true) isSidechain = true;

    if (msg.type === 'custom-title') { title = msg.title || ''; continue; }
    if (msg.type !== 'user' && msg.type !== 'assistant') continue;

    messageCount++;

    if (msg.timestamp) {
      const t = Date.parse(msg.timestamp);
      if (!isNaN(t) && t >= cutoffMs) timestamps.push(t);
    }

    if (msg.type === 'user') {
      const c = msg.message?.content;
      if (Array.isArray(c)) {
        for (const b of c) {
          if (b?.type === 'text' && b.text?.trim()) userPrompts.push(b.text.trim());
          // tool_result blocks appear in user messages. is_error true = the tool call failed.
          if (b?.type === 'tool_result' && b.is_error === true) toolErrors++;
        }
      } else if (typeof c === 'string' && c.trim()) {
        userPrompts.push(c.trim());
      }
    }

    if (msg.type === 'assistant') {
      const c = msg.message?.content;
      if (Array.isArray(c)) {
        for (const b of c) {
          if (b?.type === 'tool_use') {
            toolCalls.push(b.name || 'unknown');
            const fp = fpToolUse(b.name || 'unknown', b.input);
            fpCounts.set(fp, (fpCounts.get(fp) || 0) + 1);
          }
        }
      }
      const u = msg.message?.usage;
      if (u) {
        outputTokens += u.output_tokens || 0;
        inputTokens  += u.input_tokens || 0;
      }
    }
  }

  if (!timestamps.length) return null;

  const projDir = projDirName(filePath);
  const isAgent = isSidechain ||
                  (userType && userType !== 'external') ||
                  fallbackAgentDirGuess(projDir);

  // Within-session retries: any fingerprint that fired >1 time. Count the
  // excess fires beyond the first as retries.
  let retries = 0;
  for (const c of fpCounts.values()) if (c > 1) retries += (c - 1);

  return {
    projDir,
    isAgent,
    title: title || '',
    slug: slug || '',
    cwd: cwd || '',
    userPrompts,
    toolCalls,
    toolErrors,
    retries,
    timestamps,
    outputTokens,
    inputTokens,
    claudeVersion,
    entrypoint,
    messageCount,
  };
}

// ── SETTINGS / HOOK AUDIT ─────────────────────────────────────────────────────
function inspectClaudeDir(claudeDir) {
  const out = {
    claudeDir,
    hasSettings: false,
    settingsValid: false,
    settingsParseError: null,
    hooksByEvent: {},   // dynamic, captures any event type configured
    totalHooks: 0,
    autoMemoryEnabled: false,
    mcpServers: 0,
    hookFiles: [],
    hasClaudeMd: false,
    claudeMdBytes: 0,
    skillCount: 0,
    skillNames: [],
  };

  const settingsPath = path.join(claudeDir, 'settings.json');
  try {
    if (fs.statSync(settingsPath).isFile()) {
      out.hasSettings = true;
      try {
        const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        out.settingsValid = true;
        const hooks = s.hooks || {};
        for (const [evt, entries] of Object.entries(hooks)) {
          if (!Array.isArray(entries)) continue;
          const n = entries.reduce((acc, e) => acc + (Array.isArray(e?.hooks) ? e.hooks.length : 0), 0);
          if (n > 0) {
            out.hooksByEvent[evt] = n;
            out.totalHooks += n;
          }
        }
        out.autoMemoryEnabled = s.autoMemoryEnabled === true;
        // MCP servers can live in settings.json or ~/.claude.json. Count both.
        if (s.mcpServers && typeof s.mcpServers === 'object') {
          out.mcpServers = Object.keys(s.mcpServers).length;
        }
      } catch (e) {
        out.settingsParseError = e.message;
      }
    }
  } catch (_) {}

  // ~/.claude.json (user-level MCP + global config). Optional.
  try {
    const cj = path.join(claudeDir, '..', '.claude.json');
    const st = fs.statSync(cj);
    if (st.isFile()) {
      const parsed = JSON.parse(fs.readFileSync(cj, 'utf8'));
      if (parsed?.mcpServers && typeof parsed.mcpServers === 'object') {
        out.mcpServers = Math.max(out.mcpServers, Object.keys(parsed.mcpServers).length);
      }
    }
  } catch (_) {}

  try {
    const hooksDir = path.join(claudeDir, 'hooks');
    if (fs.statSync(hooksDir).isDirectory()) {
      for (const f of fs.readdirSync(hooksDir)) {
        if (!f.startsWith('.')) out.hookFiles.push(f);
      }
    }
  } catch (_) {}

  for (const md of ['CLAUDE.md', 'CLAUDE-personal.md']) {
    try {
      const p = path.join(claudeDir, md);
      const st = fs.statSync(p);
      if (st.isFile()) {
        out.hasClaudeMd = true;
        out.claudeMdBytes += st.size;
      }
    } catch (_) {}
  }

  try {
    const skillsDir = path.join(claudeDir, 'skills');
    if (fs.statSync(skillsDir).isDirectory()) {
      const skills = fs.readdirSync(skillsDir).filter(d => {
        try { return fs.statSync(path.join(skillsDir, d)).isDirectory(); } catch (_) { return false; }
      });
      out.skillCount = skills.length;
      out.skillNames = skills;
    }
  } catch (_) {}

  return out;
}

// Aggregate setup data across multiple ~/.claude/ candidates so root + user
// installs (or any multi-home setup) all get counted. Hooks, skills, MCP, and
// CLAUDE.md bytes sum across dirs; skill names dedupe.
function inspectAllClaudeDirs(claudeDirs) {
  const merged = {
    primary: claudeDirs[0],
    hooksByEvent: {},
    totalHooks: 0,
    autoMemoryEnabled: false,
    mcpServers: 0,
    hookFiles: [],
    hasClaudeMd: false,
    claudeMdBytes: 0,
    skillCount: 0,
    skillNames: [],
    settingsParseError: null,
    perDir: [],
  };
  const seenSkills = new Set();
  for (const d of claudeDirs) {
    const r = inspectClaudeDir(d);
    merged.perDir.push(r);
    for (const [evt, n] of Object.entries(r.hooksByEvent)) {
      merged.hooksByEvent[evt] = (merged.hooksByEvent[evt] || 0) + n;
      merged.totalHooks += n;
    }
    merged.autoMemoryEnabled = merged.autoMemoryEnabled || r.autoMemoryEnabled;
    merged.mcpServers        = Math.max(merged.mcpServers, r.mcpServers);
    merged.hookFiles         = merged.hookFiles.concat(r.hookFiles);
    merged.hasClaudeMd       = merged.hasClaudeMd || r.hasClaudeMd;
    merged.claudeMdBytes    += r.claudeMdBytes;
    for (const s of r.skillNames) if (!seenSkills.has(s)) { seenSkills.add(s); merged.skillNames.push(s); }
    if (r.settingsParseError && !merged.settingsParseError) merged.settingsParseError = r.settingsParseError;
  }
  merged.skillCount = merged.skillNames.length;
  return merged;
}

// ── AGGREGATE ─────────────────────────────────────────────────────────────────
function aggregate(sessions) {
  const human = sessions.filter(s => !s.isAgent);
  const agent = sessions.filter(s => s.isAgent);

  const bucket = (subset) => {
    if (!subset.length) return null;
    const prompts = subset.flatMap(s => s.userPrompts);
    const tools = subset.flatMap(s => s.toolCalls);
    const titled = subset.filter(s => s.title).length;
    const slugged = subset.filter(s => s.slug).length;

    const cwds = new Set();
    for (const s of subset) if (s.cwd) cwds.add(s.cwd);

    const toolCounts = {};
    for (const t of tools) toolCounts[t] = (toolCounts[t] || 0) + 1;
    const totalTools = tools.length || 1;
    const pct = (k) => Math.round(100 * (toolCounts[k] || 0) / totalTools);

    const totalChars = prompts.reduce((n, p) => n + p.length, 0);
    const avgPromptLen = prompts.length ? Math.round(totalChars / prompts.length) : 0;

    const justCount = prompts.reduce((n, p) => n + (p.toLowerCase().match(/\bjust\b/g)?.length || 0), 0);
    const pleaseCount = prompts.reduce((n, p) => n + (p.toLowerCase().match(/\bplease\b/g)?.length || 0), 0);

    const outputTokens = subset.reduce((n, s) => n + s.outputTokens, 0);
    const inputTokens  = subset.reduce((n, s) => n + s.inputTokens, 0);

    const toolErrorsTotal = subset.reduce((n, s) => n + (s.toolErrors || 0), 0);
    const retriesTotal    = subset.reduce((n, s) => n + (s.retries || 0), 0);
    const toolErrorRate   = tools.length ? (100 * toolErrorsTotal / tools.length) : 0;
    const retriesPerSession = subset.length ? (retriesTotal / subset.length) : 0;

    // Median session length (message count). Cheaper proxy for first-shot success.
    const lengths = subset.map(s => s.messageCount).sort((a, b) => a - b);
    const medianLen = lengths.length
      ? (lengths.length % 2 === 1
          ? lengths[(lengths.length - 1) / 2]
          : Math.round((lengths[lengths.length / 2 - 1] + lengths[lengths.length / 2]) / 2))
      : 0;

    return {
      sessions: subset.length,
      prompts: prompts.length,
      titledPct: Math.round(100 * titled / subset.length),
      sluggedPct: Math.round(100 * slugged / subset.length),
      uniqueCwds: cwds.size,
      avgPromptLen,
      justCount,
      pleaseCount,
      bashPct: pct('Bash'),
      editPct: pct('Edit') + pct('Write'),
      readPct: pct('Read'),
      grepPct: pct('Grep') + pct('Glob'),
      agentPct: pct('Agent') + pct('Task'),
      outputTokens,
      inputTokens,
      totalTools: tools.length,
      toolErrorRate: Math.round(toolErrorRate * 10) / 10,
      toolErrorsTotal,
      retriesTotal,
      retriesPerSession: Math.round(retriesPerSession * 10) / 10,
      medianSessionLength: medianLen,
    };
  };

  return { human: bucket(human), agent: bucket(agent), totalSessions: sessions.length };
}

// ── GRADING ───────────────────────────────────────────────────────────────────
const LETTERS = ['F','D-','D','D+','C-','C','C+','B-','B','B+','A-','A','A+'];
function letterFor(score /* 0..100 */) {
  if (score >= 97) return 'A+';
  if (score >= 93) return 'A';
  if (score >= 90) return 'A-';
  if (score >= 87) return 'B+';
  if (score >= 83) return 'B';
  if (score >= 80) return 'B-';
  if (score >= 77) return 'C+';
  if (score >= 73) return 'C';
  if (score >= 70) return 'C-';
  if (score >= 67) return 'D+';
  if (score >= 63) return 'D';
  if (score >= 60) return 'D-';
  return 'F';
}
function colorForLetter(L) {
  if (L.startsWith('A')) return C.green;
  if (L.startsWith('B')) return C.cyan;
  if (L.startsWith('C')) return C.yellow;
  return C.red;
}

function grade(stats, setup) {
  const dims = [];
  const human = stats.human || {};
  const agent = stats.agent || {};

  // 1. Hook coverage. Generic count across whatever event types are configured.
  const hookSignals = setup.totalHooks;
  let hookScore;
  if (hookSignals === 0) hookScore = 35;
  else if (hookSignals === 1) hookScore = 68;
  else if (hookSignals === 2) hookScore = 82;
  else if (hookSignals === 3) hookScore = 90;
  else hookScore = Math.min(100, 92 + hookSignals);
  if (setup.autoMemoryEnabled) hookScore = Math.min(100, hookScore + 3);
  const hookBreakdown = Object.entries(setup.hooksByEvent)
    .map(([evt, n]) => `${n} ${evt}`)
    .concat(setup.autoMemoryEnabled ? ['autoMemory plugin'] : [])
    .join(', ');
  dims.push({
    name: 'Hook coverage',
    score: hookScore,
    detail: hookSignals === 0
      ? 'No hooks installed across any event. Anything could happen overnight.'
      : `${hookBreakdown}.`,
    fix: hookSignals === 0
      ? 'Install claude-loop-sentinel for runaway-loop protection: https://github.com/turleydesigns/claude-loop-sentinel'
      : null,
  });

  // 2. Project hygiene (human sessions only).
  // Three signals: custom titles (strongest), slugs (informal auto-titles),
  // and CWD diversity (project-scoped work via tmux or shell). Any of these
  // counts as organizational hygiene. Long prompts are a tell only when CWD
  // count is low (single project + walls of text = unscoped sprawl).
  if (human.sessions) {
    let hScore = 50;
    hScore += Math.round(human.titledPct * 0.35);      // formal title bonus
    hScore += Math.round(human.sluggedPct * 0.15);     // slug bonus
    // CWD diversity: launching from named project dirs is real hygiene.
    if (human.uniqueCwds >= 3)  hScore += 10;
    if (human.uniqueCwds >= 10) hScore += 10;
    if (human.uniqueCwds >= 25) hScore += 6;
    if (human.avgPromptLen > 0 && human.avgPromptLen < 80) hScore -= 6;
    // Walls of text are only a problem when work is unscoped.
    if (human.avgPromptLen > 2500 && human.uniqueCwds < 5) hScore -= 8;
    hScore = Math.max(0, Math.min(100, hScore));
    const titleNote = human.titledPct > 0
      ? `${human.titledPct}% titled`
      : (human.sluggedPct > 0 ? `${human.sluggedPct}% have auto-slugs` : 'no titles, no slugs');
    dims.push({
      name: 'Project hygiene (human)',
      score: hScore,
      detail: `${titleNote}, launched from ${human.uniqueCwds} distinct working dirs. Avg prompt: ${human.avgPromptLen} chars.`,
      fix: (human.titledPct < 20 && human.uniqueCwds < 5)
        ? 'Title your important sessions, or launch from project dirs so each session is scoped.'
        : null,
    });
  }

  // 3. Tool balance (human sessions only). Adaptive: don't punish Bash
  // dominance if absolute Edit volume is high, because that's "busy operator"
  // not "bash hammer." Only penalize when Edit absolute volume is also low.
  if (human.sessions && human.totalTools > 0) {
    let bScore = 75;
    const editAbs = Math.round(human.editPct * human.totalTools / 100);
    const readAbs = Math.round(human.readPct * human.totalTools / 100);

    // Bash dominance penalty scales with how thin the rest of the toolkit is.
    if (human.bashPct > 65) {
      if (editAbs > 500) bScore -= 6;   // big absolute Edit volume — busy operator
      else if (editAbs > 100) bScore -= 12;
      else bScore -= 18;                // truly a bash hammer
    } else if (human.bashPct > 50) {
      bScore -= 4;
    }

    if (human.readPct + human.grepPct + human.editPct < 15) bScore -= 10;
    if (human.editPct > 10 && human.editPct < 55) bScore += 8;
    if (human.agentPct > 2) bScore += 7;
    if (human.agentPct > 5) bScore += 5;

    bScore = Math.max(0, Math.min(100, bScore));

    const fix = human.bashPct > 65 && editAbs < 200
      ? 'You are running things, not editing things. Use Edit/Write more.'
      : null;

    dims.push({
      name: 'Tool balance (human)',
      score: bScore,
      detail: `Bash ${human.bashPct}%, Edit+Write ${human.editPct}% (${editAbs} calls), Read ${human.readPct}%, Grep+Glob ${human.grepPct}%, Agent/Task ${human.agentPct}%.`,
      fix,
    });
  }

  // 4. Prompt tells (the "just"/"please" tax).
  if (human.sessions && human.prompts > 0) {
    const justRate = human.justCount / human.prompts;
    const pleaseRate = human.pleaseCount / human.prompts;
    let pScore = 85;
    if (justRate > 0.5) pScore -= 12;
    if (justRate > 1.0) pScore -= 15;
    if (pleaseRate > 0.3) pScore -= 6;
    pScore = Math.max(0, Math.min(100, pScore));

    // Build a data-driven fix message that names the actual ratios.
    let pFix = null;
    if (justRate > 1.0) {
      pFix = `${(justRate*100).toFixed(0)}% of your prompts contain "just" (often multiple times). You are telegraphing that you think every task is trivial. They are not. Strip it from the next 10 prompts and watch what changes.`;
    } else if (justRate > 0.5) {
      pFix = `Roughly one in two of your prompts contains "just" (${human.justCount} out of ${human.prompts}). It is the most reliable signal that you think the task is simpler than it is. Worth dropping.`;
    } else if (pleaseRate > 0.3) {
      pFix = `You said "please" in ${(pleaseRate*100).toFixed(0)}% of your prompts. Politeness costs tokens and confuses scope. Direct prompts work better.`;
    }

    dims.push({
      name: 'Prompt tells',
      score: pScore,
      detail: `"just" appears in ${(justRate*100).toFixed(0)}% of prompts (${human.justCount}x). "please" in ${(pleaseRate*100).toFixed(0)}% (${human.pleaseCount}x).`,
      fix: pFix,
    });
  }

  // 5. Output signals (human sessions only). Best available local proxy for
  // whether your sessions actually produce results vs grinding. Three inputs:
  //   - tool error rate (lower = cleaner runs)
  //   - retries per session (lower = first-shot success)
  //   - median session length (very long = stuck, very short = trivial)
  if (human.sessions && human.totalTools > 0) {
    let oScore = 80;
    if (human.toolErrorRate > 15) oScore -= 18;
    else if (human.toolErrorRate > 8) oScore -= 10;
    else if (human.toolErrorRate > 4) oScore -= 4;

    if (human.retriesPerSession > 6) oScore -= 12;
    else if (human.retriesPerSession > 3) oScore -= 6;

    if      (human.medianSessionLength > 100) oScore -= 15; // genuinely stuck
    else if (human.medianSessionLength > 50)  oScore -= 6;  // long grinds
    else if (human.medianSessionLength >= 2 && human.medianSessionLength <= 20) oScore += 4; // healthy

    oScore = Math.max(0, Math.min(100, oScore));

    dims.push({
      name: 'Output signals',
      score: oScore,
      detail: `Tool error rate ${human.toolErrorRate}%, ${human.retriesPerSession} retries per session, median session ${human.medianSessionLength} messages.`,
      fix: human.toolErrorRate > 15
        ? 'Your tool error rate is high. Sessions are fighting the environment more than producing output.'
        : null,
    });
  }

  // 6. Agent pipeline grade (only if agent sessions exist).
  if (agent.sessions) {
    let aScore = 75;
    if (agent.sessions > 50) aScore += 8;
    if (agent.outputTokens > 0 && agent.sessions > 0) {
      const tokensPerSession = agent.outputTokens / agent.sessions;
      if (tokensPerSession < 5000) aScore += 5; // efficient
      if (tokensPerSession > 50000) aScore -= 8; // bloated
    }
    if (hookSignals === 0) aScore -= 12; // running pipeline with no safety net is reckless
    aScore = Math.max(0, Math.min(100, aScore));
    dims.push({
      name: 'Pipeline ops (agent sessions)',
      score: aScore,
      detail: `${agent.sessions} agent-spawned sessions, ${(agent.outputTokens / 1e6).toFixed(2)}M output tokens.`,
      fix: hookSignals === 0 ? 'Your pipeline has no runtime hooks. Install claude-loop-sentinel before the next overnight run.' : null,
    });
  }

  const overall = Math.round(dims.reduce((s, d) => s + d.score, 0) / dims.length);
  return { overall, letter: letterFor(overall), dims };
}

// ── OUTPUT ────────────────────────────────────────────────────────────────────
const LOGO = [
  '  ██████  ██████  ██████   ██  ██  ██████   ██  ██████████',
  '  ██      ██      ██   ██  ██  ██  ██   ██  ██      ██    ',
  '  ██      ██      ██████   ██  ██  ██   ██  ██      ██    ',
  '  ██      ██      ██   ██  ██  ██  ██   ██  ██      ██    ',
  '  ██████  ██████  ██   ██  ██████  ██████   ██      ██    ',
];

function renderCard(stats, setup, graded) {
  const bar = (n) => {
    const filled = Math.round(n / 5);
    return '█'.repeat(filled) + '░'.repeat(20 - filled);
  };

  pr();
  for (const line of LOGO) pr(`${C.bold}${C.cyan}${line}${C.reset}`);
  pr();
  pr(`  ${C.dim}your claude code report card${C.reset}    ${C.dim}·${C.reset}    ${C.dim}npx @uxcontinuum/ccaudit${C.reset}`);
  pr(`  ${C.bold}${C.white}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C.reset}`);
  pr();

  const L = graded.letter;
  const lc = colorForLetter(L);
  pr(`  ${C.bold}OVERALL GRADE   ${lc}${C.bold}${L}${C.reset}   ${C.dim}(${graded.overall}/100)${C.reset}`);
  pr();

  for (const d of graded.dims) {
    const dL = letterFor(d.score);
    const dc = colorForLetter(dL);
    pr(`  ${C.bold}${d.name.padEnd(34)}${C.reset}${dc}${C.bold}${dL.padStart(3)}${C.reset}   ${C.dim}${bar(d.score)}${C.reset}`);
    pr(`    ${C.dim}${d.detail}${C.reset}`);
    if (d.fix) pr(`    ${C.yellow}→ ${d.fix}${C.reset}`);
    pr();
  }

  pr(`  ${C.dim}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C.reset}`);
  pr(`  ${C.bold}YOUR DATA${C.reset}`);
  if (stats.human) {
    pr(`    ${C.dim}Human sessions:${C.reset}  ${stats.human.sessions} sessions, ${stats.human.prompts} prompts, ${(stats.human.outputTokens / 1e6).toFixed(2)}M output tokens`);
  }
  if (stats.agent) {
    pr(`    ${C.dim}Agent sessions:${C.reset}  ${stats.agent.sessions} sessions, ${(stats.agent.outputTokens / 1e6).toFixed(2)}M output tokens`);
  }
  pr(`    ${C.dim}Hooks installed:${C.reset} ${setup.totalHooks} across ${Object.keys(setup.hooksByEvent).length} event type(s) (${setup.hookFiles.length} hook file(s) in ~/.claude/hooks/)`);
  pr(`    ${C.dim}CLAUDE.md:${C.reset}       ${setup.hasClaudeMd ? `${setup.claudeMdBytes} bytes` : 'not found'}`);
  pr(`    ${C.dim}MCP servers:${C.reset}     ${setup.mcpServers}`);
  pr(`    ${C.dim}Skills installed:${C.reset} ${setup.skillCount}`);
  if (setup.settingsParseError) {
    pr(`    ${C.yellow}settings.json parse error:${C.reset} ${setup.settingsParseError}`);
  }

  pr();
  pr(`  ${C.dim}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C.reset}`);
  pr(`  ${C.dim}Run it yourself:${C.reset}    ${C.bold}npx @uxcontinuum/ccaudit${C.reset}`);
  pr(`  ${C.dim}See next steps:${C.reset}     ${C.bold}npx @uxcontinuum/ccaudit --next-steps${C.reset}`);
  pr(`  ${C.dim}Source + fixes:${C.reset}     github.com/turleydesigns/claude-audit`);

  const failingDims = graded.dims.filter(d => d.score < 75).length;
  if (failingDims >= 2) {
    pr();
    pr(`  ${C.bold}${C.yellow}${failingDims} dimensions flagged.${C.reset} ${C.dim}Need help with your setup?${C.reset} ${C.bold}uxcontinuum.com${C.reset}`);
  }
  pr();
}


// ── NEXT STEPS RENDERER ───────────────────────────────────────────────────────
function renderNextSteps(stats, setup, graded) {
  pr();
  pr(`  ${C.bold}${C.cyan}NEXT STEPS${C.reset}    ${C.dim}prioritized actions based on your audit${C.reset}`);
  pr(`  ${C.dim}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C.reset}`);
  pr();

  const steps = [];

  if (setup.totalHooks === 0) {
    steps.push({ p: 'HIGH', a: 'Install at least one PreToolUse hook',
      d: 'You have zero hooks. Runaway agent loops will burn money overnight if you let them.',
      link: 'github.com/turleydesigns/claude-loop-sentinel' });
  } else if (setup.totalHooks < 3) {
    steps.push({ p: 'MED', a: 'Expand hook coverage',
      d: `${setup.totalHooks} hook(s) configured. Most healthy setups have at least PreToolUse, PostToolUse, and Stop.`,
      link: 'docs.anthropic.com/en/docs/claude-code/hooks' });
  }

  const pipeDim = graded.dims.find(d => d.name === 'Pipeline ops (agent sessions)');
  if (pipeDim && setup.totalHooks === 0) {
    steps.push({ p: 'HIGH', a: 'Add hooks before next overnight run',
      d: 'You are running an agent pipeline with no runtime guards. This is how bills explode.',
      link: 'github.com/turleydesigns/claude-loop-sentinel' });
  }

  if (stats.human && stats.human.titledPct < 20 && stats.human.uniqueCwds < 5) {
    steps.push({ p: 'MED', a: 'Title your important sessions or scope by CWD',
      d: `${stats.human.titledPct}% titled, ${stats.human.uniqueCwds} distinct working dirs. You will not find this work later.`,
      link: null });
  }

  if (stats.human && stats.human.bashPct > 65) {
    const editAbs = Math.round(stats.human.editPct * stats.human.totalTools / 100);
    if (editAbs < 200) {
      steps.push({ p: 'MED', a: 'Edit/Write instead of running commands',
        d: `Bash is ${stats.human.bashPct}% of your tool calls (${editAbs} Edit calls total). You are running things, not editing them.`,
        link: null });
    }
  }

  if (stats.human && stats.human.justCount / stats.human.prompts > 0.5) {
    const rate = Math.round(100 * stats.human.justCount / stats.human.prompts);
    steps.push({ p: 'LOW', a: 'Drop "just" from your prompts',
      d: `"just" in ${rate}% of your prompts. Try the next 10 without it and watch the responses change.`,
      link: null });
  }

  if (stats.human && stats.human.toolErrorRate > 8) {
    steps.push({ p: 'MED', a: 'Investigate tool error rate',
      d: `${stats.human.toolErrorRate}% of your tool calls error. Sessions are fighting the environment.`,
      link: null });
  }

  if (setup.mcpServers === 0) {
    steps.push({ p: 'LOW', a: 'Try an MCP server',
      d: 'Zero MCP servers configured. They unlock work Claude Code cannot do alone (filesystem, browser, API access).',
      link: 'docs.anthropic.com/en/docs/claude-code/mcp' });
  }

  if (setup.skillCount < 3) {
    steps.push({ p: 'LOW', a: 'Install a few Claude Code skills',
      d: `${setup.skillCount} skill(s) installed. Skills let you invoke domain expertise with /name.`,
      link: 'docs.anthropic.com/en/docs/claude-code/skills' });
  }

  if (!steps.length) {
    pr(`  ${C.green}Your setup looks healthy. No critical next steps surfaced.${C.reset}`);
    pr();
    return;
  }

  const order = { HIGH: 0, MED: 1, LOW: 2 };
  steps.sort((a, b) => order[a.p] - order[b.p]);

  let i = 1;
  for (const s of steps) {
    const pColor = s.p === 'HIGH' ? C.red : (s.p === 'MED' ? C.yellow : C.cyan);
    pr(`  ${C.bold}${String(i).padStart(2)}.${C.reset} ${pColor}${C.bold}[${s.p}]${C.reset}  ${C.bold}${s.a}${C.reset}`);
    pr(`      ${C.dim}${s.d}${C.reset}`);
    if (s.link) pr(`      ${C.dim}→ ${s.link}${C.reset}`);
    pr();
    i++;
  }

  pr(`  ${C.dim}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C.reset}`);
  pr(`  ${C.dim}Need help working through these?${C.reset}  ${C.bold}uxcontinuum.com${C.reset}`);
  pr();
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
const days     = parseInt(getArg('--days', '30'), 10);
const cutoffMs = Date.now() - days * 86400000;

const projectsDirs = CLAUDE_DIRS.map(d => path.join(d, 'projects'))
  .filter(d => { try { return fs.statSync(d).isDirectory(); } catch (_) { return false; } });

const files = projectsDirs.flatMap(d => findJsonl(d, cutoffMs));
const sessions = files.map(f => parseSession(f, cutoffMs)).filter(Boolean);

if (!sessions.length) {
  pr();
  pr(`  ${C.bold}ccaudit${C.reset}: no Claude Code session activity in the last ${days} days.`);
  if (!projectsDirs.length) {
    pr(`  ${C.dim}No ~/.claude/projects/ directory found. Looked in: ${CLAUDE_DIRS.join(', ')}${C.reset}`);
    pr(`  ${C.dim}Either Claude Code is not installed, you have a non-default home dir, or this is a brand-new setup.${C.reset}`);
  } else {
    pr(`  ${C.dim}Scanned: ${projectsDirs.join(', ')}${C.reset}`);
    pr(`  ${C.dim}Try --days 90 or --days 365 to widen the window.${C.reset}`);
  }
  // Still surface the setup audit even with no sessions, so brand-new users get value.
  const setupOnly = inspectAllClaudeDirs(CLAUDE_DIRS);
  pr();
  pr(`  ${C.bold}Setup snapshot:${C.reset}`);
  pr(`    Hooks: ${setupOnly.totalHooks} (${Object.keys(setupOnly.hooksByEvent).join(', ') || 'none'})`);
  pr(`    CLAUDE.md: ${setupOnly.hasClaudeMd ? `${setupOnly.claudeMdBytes} bytes` : 'not found'}`);
  pr(`    MCP servers: ${setupOnly.mcpServers}`);
  pr(`    Skills: ${setupOnly.skillCount}`);
  pr();
  process.exit(0);
}

const stats  = aggregate(sessions);
const setup  = inspectAllClaudeDirs(CLAUDE_DIRS);
const graded = grade(stats, setup);

if (hasFlag('--next-steps')) {
  renderCard(stats, setup, graded);
  renderNextSteps(stats, setup, graded);
} else if (hasFlag('--json')) {
  // Programmatic output. Stable shape for downstream tools and the future
  // public-benchmark backend. No personal content (prompts, slugs, CWDs).
  const payload = {
    schema: 'ccaudit/1',
    generated_at: new Date().toISOString(),
    window_days: days,
    overall: { score: graded.overall, letter: graded.letter },
    dimensions: graded.dims.map(d => ({
      name: d.name,
      score: d.score,
      letter: letterFor(d.score),
      detail: d.detail,
      fix: d.fix,
    })),
    setup: {
      total_hooks: setup.totalHooks,
      hooks_by_event: setup.hooksByEvent,
      auto_memory_enabled: setup.autoMemoryEnabled,
      mcp_servers: setup.mcpServers,
      hook_files: setup.hookFiles.length,
      has_claude_md: setup.hasClaudeMd,
      claude_md_bytes: setup.claudeMdBytes,
      skills_installed: setup.skillCount,
      settings_parse_error: setup.settingsParseError,
    },
    human: stats.human ? {
      sessions: stats.human.sessions,
      prompts: stats.human.prompts,
      titled_pct: stats.human.titledPct,
      slugged_pct: stats.human.sluggedPct,
      unique_cwds: stats.human.uniqueCwds,
      avg_prompt_len: stats.human.avgPromptLen,
      just_count: stats.human.justCount,
      please_count: stats.human.pleaseCount,
      total_tools: stats.human.totalTools,
      tool_distribution: {
        bash_pct: stats.human.bashPct,
        edit_write_pct: stats.human.editPct,
        read_pct: stats.human.readPct,
        grep_glob_pct: stats.human.grepPct,
        agent_task_pct: stats.human.agentPct,
      },
      output_tokens: stats.human.outputTokens,
      input_tokens: stats.human.inputTokens,
      tool_error_rate_pct: stats.human.toolErrorRate,
      tool_errors_total: stats.human.toolErrorsTotal,
      retries_total: stats.human.retriesTotal,
      retries_per_session: stats.human.retriesPerSession,
      median_session_length: stats.human.medianSessionLength,
    } : null,
    agent: stats.agent ? {
      sessions: stats.agent.sessions,
      prompts: stats.agent.prompts,
      output_tokens: stats.agent.outputTokens,
      input_tokens: stats.agent.inputTokens,
    } : null,
  };
  process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
} else {
  renderCard(stats, setup, graded);
}
