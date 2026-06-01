# ccaudit

A diagnostic for your Claude Code setup. Three things at once:

1. **A fun report card** you can screenshot and share.
2. **A hygiene linter** that surfaces what's missing.
3. **A discovery tool** that shows you which parts of Claude Code you are not using yet.

```bash
npx @uxcontinuum/ccaudit
```

Zero install. Zero dependencies. No network calls. Reads `~/.claude/` on your machine and outputs a grade card.

## Why this exists

Most Claude Code users are running on a fraction of the surface area. No hooks installed. No skills configured. No MCP servers. No idea what their token cost per shipped feature is. No concept of how often their agent fails on first try.

The hype is on the model. The actual constraint is everything around the model. The scaffolding.

ccaudit grades the scaffolding.

## What the grade is and isn't

This is a **hygiene and discovery audit**, not an outcomes audit. It measures whether your Claude Code setup is **set up well** and **uses what's available**, not whether your specific outputs are good.

Think of it as a linter for your AI workflow. Passing lint doesn't guarantee your code is good. Failing lint usually means something is missing. Same here: a high grade doesn't mean Claude is shipping perfect work for you. A low grade usually means there's surface area of Claude Code you haven't unlocked yet.

The grade can be gamed (install five no-op hooks, auto-title every session, scrub "just" from your prompts). Don't bother. The findings under the grade are the value, not the letter.

## What you get

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  CCAUDIT  your Claude Code report card
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  OVERALL GRADE   C+   (79/100)

  Hook coverage                     A+   ████████████████████
    1 PostToolUse, 2 Stop, 1 PreToolUse, autoMemory plugin.

  Project hygiene (human)            F   ████████░░░░░░░░░░░░
    0% titled, launched from 10 distinct working dirs.

  Tool balance (human)              D+   ██████████████░░░░░░
    Bash 73%, Edit+Write 10% (3,536 calls), Read 10%.

  Prompt tells                       C   ███████████████░░░░░
    Said "just" 10,236 times across 19,192 prompts (53%).

  Output signals                     B   ████████████████░░░░
    Tool error rate 4.2%, median session length 8 messages.

  Pipeline ops (agent sessions)      B   █████████████████░░░
    3,253 agent-spawned sessions, 26.93M output tokens.
```

## What it checks

| Dimension | What it measures | What it cannot see |
|-----------|------------------|-------------------|
| Hook coverage | Hooks configured in `~/.claude/settings.json` across all event types, plus `autoMemoryEnabled` plugin flag | Whether the hooks actually do anything useful |
| Project hygiene | Custom titles, auto-slugs, CWD diversity, prompt length | Whether your titles describe the work accurately |
| Tool balance | Distribution across Bash, Edit, Read, Grep, Agent. Adaptive: high Bash% is okay if absolute Edit volume is also high | Whether each tool call accomplished the goal |
| Prompt tells | Frequency of hedge words ("just", "please"), prompt clarity heuristics | Whether your prompts produce good outputs |
| Output signals | Tool-call error rate, median session length, within-session retry patterns | Whether your shipped code works in production |
| Pipeline ops | Agent-spawned session count, token spend, hook coverage relative to volume | Whether your pipeline ships features that don't break |

It separates human-driven sessions from agent-spawned worktrees via three signals (`isSidechain`, `userType`, UUID/hex dir-name pattern). Operator grade and pipeline grade get scored independently against different rubrics.

## Cross-platform support

Works on:
- macOS (`$HOME/.claude/`)
- Linux (`$HOME/.claude/`)
- Windows / WSL (`%USERPROFILE%\.claude\` or `$HOME/.claude/`)
- VPS / non-default home (uses Node's `os.homedir()`)
- Running as root with users in `/home/*` (scans all)

Tested against setups ranging from "brand new install with zero sessions" to "20,000 sessions and 4,000 agent worktrees."

## Install

```bash
# Run once without installing
npx @uxcontinuum/ccaudit

# Or install globally
npm i -g @uxcontinuum/ccaudit
ccaudit
```

Requires Node 14+. No other dependencies.

## Options

```bash
ccaudit                 # full report, last 30 days
ccaudit --days 7        # just last week
ccaudit --days 365      # full year
ccaudit --json          # programmatic output, anonymized
ccaudit --no-color      # plain text for copying
```

## Privacy

Reads `~/.claude/` on your machine. Outputs to stdout. No network calls, no telemetry, no opt-in submission. The `--json` output is anonymized (no prompts, no slugs, no CWD strings, just aggregate counts and percentages).

## Honest disclaimers

- The grade is opinionated, not objective.
- The rubric will change as the tool matures.
- High grade ≠ good outputs. Low grade ≠ bad outputs. The grade is about **scaffolding and feature coverage**, not results.
- The tool ships with a built-in nudge toward [Continuum Sprint](https://uxcontinuum.com/sprint) when it surfaces 2+ failing dimensions. That is intentional. If your setup is genuinely broken in two places, a 2-week sprint is often what fixes it. Ignore the nudge if you don't want it.

## The story behind this

Karpathy keeps saying we're entering vibe coding. Software you write in English while AI generates the code. He is not wrong about where this is going.

I bought in six months ago. Built a multi-agent pipeline. Started shipping production code through it. Six weeks of recent data: 333 PRs, $1,132 in tokens, $3.40 per shipped PR.

Then I ran ccaudit on myself, expecting an A.

I got a B-.

The findings were valid. The reason I assumed A was that I had been optimizing the agents and ignoring the room they live in. Almost everyone running Claude Code is doing the same thing. The hype is on the model. The constraint is the scaffolding.

If you want to know what your scaffolding looks like graded:

```bash
npx @uxcontinuum/ccaudit
```

---

Built by [Matt Turley](https://uxcontinuum.com).
