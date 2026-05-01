---
status: accepted
date: 2026-04-30
tags:
  - memory/decision
  - obsidian
  - codex-hooks
---

# Obsidian As Project Memory

## Context

O projeto passa a manter memoria operacional em um vault Obsidian local ao repositorio.

## Decision

Usar `memory/obsidian-vault` como vault do projeto e registrar eventos de chat via hooks do Codex.

## Consequences

- `SessionStart`, `UserPromptSubmit` e `Stop` adicionam entradas em `10-Sessions/`.
- Decisoes duradouras devem ser promovidas para `20-Decisions/`.
- O `MEMORY.md` continua existindo como historico tecnico legado, mas novas memorias estruturadas devem ir para o vault.

