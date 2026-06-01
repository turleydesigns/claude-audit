# ccaudit

A diagnostic for your Claude Code setup. Run it, get graded across five dimensions, find the specific fixes.

```bash
npx @uxcontinuum/ccaudit
```

Reads `~/.claude/` locally. Zero dependencies. Nothing leaves your machine.

## What you get

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  CCAUDIT  your Claude Code report card
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  OVERALL GRADE   D+   (67/100)

  Hook coverage                     B-   ████████████████░░░░
    1 PreToolUse, 1 PostToolUse, 0 UserPromptSubmit hook(s).

  Project hygiene (human)            F   ████████░░░░░░░░░░░░
    0% of your human sessions are titled. Avg prompt: 2350 chars.
    → Title your sessions. Untitled sessions are unsearchable history.

  Tool balance (human)               F   ███████████░░░░░░░░░
    Bash 73%, Edit+Write 10%, Read 10%, Grep+Glob 2%, Agent/Task 0%.
    → You are running things, not editing things. Use Edit/Write more.

  Prompt tells                       C   ███████████████░░░░░
    You said "just" 10243 times across 19199 prompts (53%).
    → The word "just" telegraphs that you think the task is simple. It is not.

  Pipeline ops (agent sessions)      B   █████████████████░░░
    3253 agent-spawned sessions, 26.93M output tokens.
```

## What it checks

| Dimension | Source |
|-----------|--------|
| Hook coverage | `~/.claude/settings.json` (PreToolUse, PostToolUse, UserPromptSubmit hook counts) |
| Project hygiene | session titles, average prompt length, untitled rate (human sessions only) |
| Tool balance | distribution across Bash, Edit/Write, Read, Grep/Glob, Agent/Task (human sessions only) |
| Prompt tells | "just" frequency, "please" frequency, total prompt count |
| Pipeline ops | agent-spawned session stats: count, token spend, hook coverage relative to volume |

It separates human-driven sessions from agent-spawned worktrees (UUID and ULID-suffix dirs in your projects folder). Your operator-grade and your pipeline-grade get scored independently against different rubrics.

## Install

```bash
# Run once without installing
npx @uxcontinuum/ccaudit

# Or globally
npm i -g @uxcontinuum/ccaudit
ccaudit
```

Requires Node 14+. No other dependencies.

## Options

```bash
ccaudit                 # full report, last 30 days of activity
ccaudit --days 7        # just last week
ccaudit --days 365      # full year
ccaudit --no-color      # plain text for copying
```

## How it grades

Each dimension produces a 0-100 score and a letter grade (A+ through F). The overall grade is the mean of the dimension scores. The rubric weights:

- Hook coverage is hard-floored at 35 if you have zero hooks. Anything could happen overnight.
- Project hygiene scales linearly with titled-session percentage and penalizes both ultra-terse (<80 chars) and wall-of-text (>1500 chars) average prompts.
- Tool balance penalizes Bash dominance above 65% and rewards healthy editing (10-55% Edit+Write).
- Prompt tells subtract for high "just" frequency. "Just" telegraphs that you think the task is simple. It usually is not.
- Pipeline ops rewards low tokens-per-session and penalizes running an agent pipeline without runtime hooks.

The grade is opinionated, not objective. Read it as a diagnostic, not a judgment.

## Why this exists

There is no public benchmark for "is my Claude Code setup any good." People burn weeks reading other people's CLAUDE.md files trying to figure out what they're doing wrong. This tool answers that question in 30 seconds.

If the audit flags two or more dimensions, the fix is usually a few days of work, not a rebuild. [Continuum](https://continuum.build) runs structured 2-week sprints for setups that need them.

## Privacy

Reads `~/.claude/` on your machine. Outputs to stdout. Makes no network calls. No telemetry, no analytics, no opt-in submission (yet).

---

Built by [Matt Turley](https://uxcontinuum.com) / [Continuum](https://continuum.build).
