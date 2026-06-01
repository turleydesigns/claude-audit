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
// Agent worktrees use either UUIDv4 names (orchestrator-spawned) or ULID-style
// hex suffixes appended to a path. Human dirs are word-segmented.
const UUID_RE     = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
const HEX_TAIL_RE = /-[0-9a-f]{20,}$/;
function isAgentProjectDir(name) {
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

function parseSession(filePath, cutoffMs) {
  let lines;
  try { lines = fs.readFileSync(filePath, 'utf8').split('\n'); } catch (_) { return null; }

  const userPrompts = [];
  const toolCalls   = [];
  const timestamps  = [];
  let title = null;
  let outputTokens = 0;
  let inputTokens  = 0;

  for (const raw of lines) {
    if (!raw) continue;
    let msg;
    try { msg = JSON.parse(raw); } catch (_) { continue; }

    if (msg.type === 'custom-title') { title = msg.title || ''; continue; }
    if (msg.type !== 'user' && msg.type !== 'assistant') continue;

    if (msg.timestamp) {
      const t = Date.parse(msg.timestamp);
      if (!isNaN(t) && t >= cutoffMs) timestamps.push(t);
    }

    if (msg.type === 'user') {
      const c = msg.message?.content;
      if (Array.isArray(c)) {
        for (const b of c) if (b?.type === 'text' && b.text?.trim()) userPrompts.push(b.text.trim());
      } else if (typeof c === 'string' && c.trim()) {
        userPrompts.push(c.trim());
      }
    }

    if (msg.type === 'assistant') {
      const c = msg.message?.content;
      if (Array.isArray(c)) {
        for (const b of c) if (b?.type === 'tool_use') toolCalls.push(b.name || 'unknown');
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
  return {
    projDir,
    isAgent: isAgentProjectDir(projDir),
    title: title || '',
    userPrompts,
    toolCalls,
    timestamps,
    outputTokens,
    inputTokens,
  };
}

// ── SETTINGS / HOOK AUDIT ─────────────────────────────────────────────────────
function inspectClaudeDir(claudeDir) {
  const out = {
    claudeDir,
    hasSettings: false,
    settingsValid: false,
    preToolUseHooks: 0,
    postToolUseHooks: 0,
    userPromptSubmitHooks: 0,
    stopHooks: 0,
    subagentStopHooks: 0,
    notificationHooks: 0,
    autoMemoryEnabled: false,
    hookFiles: [],
    hasClaudeMd: false,
    claudeMdBytes: 0,
    skillCount: 0,
  };

  const settingsPath = path.join(claudeDir, 'settings.json');
  try {
    if (fs.statSync(settingsPath).isFile()) {
      out.hasSettings = true;
      try {
        const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        out.settingsValid = true;
        const hooks = s.hooks || {};
        const count = (entries) => (entries || []).reduce((n, e) => n + (e.hooks || []).length, 0);
        out.preToolUseHooks       = count(hooks.PreToolUse);
        out.postToolUseHooks      = count(hooks.PostToolUse);
        out.userPromptSubmitHooks = count(hooks.UserPromptSubmit);
        out.stopHooks             = count(hooks.Stop);
        out.subagentStopHooks     = count(hooks.SubagentStop);
        out.notificationHooks     = count(hooks.Notification);
        out.autoMemoryEnabled     = s.autoMemoryEnabled === true;
      } catch (_) {}
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
      out.skillCount = fs.readdirSync(skillsDir).filter(d => {
        try { return fs.statSync(path.join(skillsDir, d)).isDirectory(); } catch (_) { return false; }
      }).length;
    }
  } catch (_) {}

  return out;
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

    return {
      sessions: subset.length,
      prompts: prompts.length,
      titledPct: Math.round(100 * titled / subset.length),
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

  // 1. Hook coverage. Lives at the setup layer, applies to everyone.
  const hookSignals =
    setup.preToolUseHooks + setup.postToolUseHooks + setup.userPromptSubmitHooks +
    setup.stopHooks + setup.subagentStopHooks + setup.notificationHooks;
  let hookScore;
  if (hookSignals === 0) hookScore = 35;
  else if (hookSignals === 1) hookScore = 68;
  else if (hookSignals === 2) hookScore = 82;
  else if (hookSignals === 3) hookScore = 90;
  else hookScore = Math.min(100, 92 + hookSignals);
  if (setup.autoMemoryEnabled) hookScore = Math.min(100, hookScore + 3);
  const hookBreakdown = [
    setup.preToolUseHooks ? `${setup.preToolUseHooks} PreToolUse` : null,
    setup.postToolUseHooks ? `${setup.postToolUseHooks} PostToolUse` : null,
    setup.userPromptSubmitHooks ? `${setup.userPromptSubmitHooks} UserPromptSubmit` : null,
    setup.stopHooks ? `${setup.stopHooks} Stop` : null,
    setup.subagentStopHooks ? `${setup.subagentStopHooks} SubagentStop` : null,
    setup.notificationHooks ? `${setup.notificationHooks} Notification` : null,
    setup.autoMemoryEnabled ? 'autoMemory plugin' : null,
  ].filter(Boolean).join(', ');
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
  if (human.sessions) {
    let hScore = 50;
    hScore += Math.round(human.titledPct * 0.5); // titled sessions help up to +50
    if (human.avgPromptLen > 0 && human.avgPromptLen < 80) hScore -= 10; // too terse
    if (human.avgPromptLen > 1500) hScore -= 8; // walls of text
    hScore = Math.max(0, Math.min(100, hScore));
    dims.push({
      name: 'Project hygiene (human)',
      score: hScore,
      detail: `${human.titledPct}% of your human sessions are titled. Avg prompt: ${human.avgPromptLen} chars.`,
      fix: human.titledPct < 30
        ? 'Title your sessions. Untitled sessions are unsearchable history.'
        : null,
    });
  }

  // 3. Tool balance (human sessions only).
  if (human.sessions && human.totalTools > 0) {
    let bScore = 75;
    if (human.bashPct > 65) bScore -= 18; // bash hammer
    if (human.readPct + human.grepPct + human.editPct < 15) bScore -= 12;
    if (human.editPct > 10 && human.editPct < 55) bScore += 8; // healthy editing
    if (human.agentPct > 2) bScore += 7; // delegates work
    bScore = Math.max(0, Math.min(100, bScore));
    dims.push({
      name: 'Tool balance (human)',
      score: bScore,
      detail: `Bash ${human.bashPct}%, Edit+Write ${human.editPct}%, Read ${human.readPct}%, Grep+Glob ${human.grepPct}%, Agent/Task ${human.agentPct}%.`,
      fix: human.bashPct > 65
        ? 'You are running things, not editing things. Use Edit/Write more.'
        : null,
    });
  }

  // 4. Prompt tells (the "just"/"please" tax).
  if (human.sessions && human.prompts > 0) {
    const justRate = human.justCount / human.prompts;
    let pScore = 85;
    if (justRate > 0.5) pScore -= 12;
    if (justRate > 1.0) pScore -= 15;
    if (human.pleaseCount / human.prompts > 0.3) pScore -= 6;
    pScore = Math.max(0, Math.min(100, pScore));
    dims.push({
      name: 'Prompt tells',
      score: pScore,
      detail: `You said "just" ${human.justCount} times across ${human.prompts} prompts (${(justRate * 100).toFixed(0)}%).`,
      fix: justRate > 0.5
        ? 'The word "just" telegraphs that you think the task is simple. It is not. Strip it.'
        : null,
    });
  }

  // 5. Agent pipeline grade (only if agent sessions exist).
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
function renderCard(stats, setup, graded) {
  const bar = (n) => {
    const filled = Math.round(n / 5);
    return '█'.repeat(filled) + '░'.repeat(20 - filled);
  };

  pr();
  pr(`  ${C.bold}${C.white}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C.reset}`);
  pr(`  ${C.bold}${C.white}  CCAUDIT${C.reset}${C.dim}  your Claude Code report card${C.reset}`);
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
  pr(`    ${C.dim}Hooks installed:${C.reset} ${setup.preToolUseHooks + setup.postToolUseHooks + setup.userPromptSubmitHooks + setup.stopHooks + setup.subagentStopHooks + setup.notificationHooks} across all event types (${setup.hookFiles.length} hook file(s) in ~/.claude/hooks/)`);
  pr(`    ${C.dim}CLAUDE.md:${C.reset}       ${setup.hasClaudeMd ? `${setup.claudeMdBytes} bytes` : 'not found'}`);
  pr(`    ${C.dim}Skills installed:${C.reset} ${setup.skillCount}`);

  pr();
  pr(`  ${C.dim}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C.reset}`);
  pr(`  ${C.dim}Run it on your own machine: ${C.reset}${C.bold}npx @uxcontinuum/ccaudit${C.reset}`);
  pr(`  ${C.dim}Source + fixes:${C.reset}             github.com/turleydesigns/claude-audit`);

  const failingDims = graded.dims.filter(d => d.score < 75).length;
  if (failingDims >= 2) {
    pr();
    pr(`  ${C.bold}${C.yellow}${failingDims} dimensions flagged. The Continuum Sprint fixes setups like this in 2 weeks.${C.reset}`);
    pr(`  ${C.dim}continuum.build${C.reset}`);
  }
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
  pr(`No Claude Code sessions found in the last ${days} days.`);
  pr(`Looked in: ${projectsDirs.join(', ') || CLAUDE_DIRS.join(', ')}`);
  process.exit(0);
}

const stats  = aggregate(sessions);
const setup  = inspectClaudeDir(CLAUDE_DIRS[0]);
const graded = grade(stats, setup);

renderCard(stats, setup, graded);
