# ccaudit

A diagnostic for your Claude Code setup. Mostly for fun, partly genuinely useful. It reads `~/.claude/` locally and grades you across hook coverage, project hygiene, tool balance, prompt tells, and pipeline ops.

```bash
npx @uxcontinuum/ccaudit
```

Zero install, zero dependencies, no network calls.

## What the grade is and isn't

This is a hygiene audit, not an outcomes audit. It measures whether your Claude Code setup is **set up well**, not whether your outputs are good.

Think of it as a linter for your AI workflow. Passing lint doesn't guarantee your code is good. Failing lint usually means something is missing. Same here: a high grade doesn't mean Claude is shipping perfect work for you; a low grade usually means the scaffolding around your AI is sparse.

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
- High grade ≠ good outputs. Low grade ≠ bad outputs. The grade is about scaffolding, not results.
- The tool ships with a built-in nudge toward [Continuum Sprint](https://uxcontinuum.com/sprint) when it surfaces 2+ failing dimensions. That's intentional. If your setup is genuinely broken in two places, a 2-week sprint is often what fixes it. Ignore the nudge if you don't want it.

---

Built by [Matt Turley](https://uxcontinuum.com).
