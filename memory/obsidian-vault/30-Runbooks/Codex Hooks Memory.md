# Codex Hooks Memory

## Arquivos

- Hook script: `scripts/obsidian-memory-hook.mjs`
- Config Codex: `/root/.codex/hooks.json`
- Vault: `memory/obsidian-vault`

## Eventos Registrados

- `SessionStart`: cria ou abre a nota da sessao.
- `UserPromptSubmit`: registra o prompt do usuario quando o payload disponibiliza texto.
- `Stop`: registra encerramento da sessao.

## Contrato de Saida

- `SessionStart` e `UserPromptSubmit` retornam `hookSpecificOutput`.
- `Stop` deve retornar `{}`. Retornar `hookSpecificOutput` no `Stop` causa erro: `hook returned invalid stop hook JSON output`.

## Modelo de Sessao

As notas ficam em `10-Sessions/` com `type: chat-session`.

Consulte:

- [[Session Lifecycle]]
- [[Sessions.base]]
- [[Project Memory.canvas]]

## Validacao

```bash
printf '{"session_id":"manual","source":"startup"}\n' | node scripts/obsidian-memory-hook.mjs SessionStart
printf '{"session_id":"manual","prompt":"teste"}\n' | node scripts/obsidian-memory-hook.mjs UserPromptSubmit
printf '{"session_id":"manual"}\n' | node scripts/obsidian-memory-hook.mjs Stop
```
