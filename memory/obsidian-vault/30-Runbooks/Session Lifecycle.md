---
title: "Session Lifecycle"
type: runbook
tags:
  - memory/runbook
  - codex-hooks
  - obsidian
---

# Session Lifecycle

## Creation

`/root/.codex/hooks.json` runs `scripts/obsidian-memory-hook.mjs` after the `context-mode` hooks.

The hook receives JSON on stdin from Codex and derives the session id from:

1. `session_id`
2. `sessionId`
3. `CODEX_SESSION_ID`
4. `CODEX_THREAD_ID`
5. `manual`

It writes one note per session using date folders:

`10-Sessions/YYYY/MM-Mes/HH-mm-ss - Descricao da sessao.md`

At `SessionStart`, the fallback description is `Sessao iniciada`. On the first `UserPromptSubmit`, the hook renames the file using a clean description derived from the prompt when the file still has the fallback name.

## Connection

Each note receives Obsidian properties:

- `type: chat-session`
- `status: active` or `ended`
- `session_id`
- `project`
- `project_dir`
- `created`
- `updated`
- `source`
- `tags`
- `aliases`

`Memory Index.md` links every created session note. `Sessions.base` provides a table view over notes with `type == "chat-session"`.

## Events

- `SessionStart`: creates/opens session note and records source/project.
- `UserPromptSubmit`: appends user prompt when Codex provides text in the hook payload.
- `Stop`: marks note as `status: ended` and sets `ended`.

`Stop` output must be `{}`. Codex rejects `hookSpecificOutput` for this event.

## Durable Knowledge

Session notes are raw memory. Promote stable knowledge into:

- `20-Decisions/`
- `30-Runbooks/`
- `40-Incidents/`
