---
title: "Obsidian Skills Installed"
status: accepted
date: 2026-04-30
type: decision
tags:
  - memory/decision
  - obsidian
  - skills
---

# Obsidian Skills Installed

## Context

O projeto usa um vault Obsidian local como memoria duravel. Para trabalhar melhor com arquivos e recursos nativos do Obsidian, foram instaladas as skills de `kepano/obsidian-skills`.

## Decision

Instalar no Codex as skills:

- `defuddle`
- `json-canvas`
- `obsidian-bases`
- `obsidian-cli`
- `obsidian-markdown`

## Consequences

- Reiniciar o Codex para as novas skills aparecerem na lista ativa.
- Usar `obsidian-markdown` ao editar notas do vault.
- Usar `obsidian-bases` ao criar/editar `.base`.
- Usar `json-canvas` ao criar/editar `.canvas`.
- Usar `obsidian-cli` quando uma instancia do Obsidian estiver aberta e for necessario interagir com o vault pela CLI.

