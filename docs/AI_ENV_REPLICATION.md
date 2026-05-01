# AI Environment Replication Package

Este pacote documenta o ecossistema de agentes, MCP, hooks e memoria observado em `/opt/PolymarketBTC15mAssistant` e define um scaffold reutilizavel para novos projetos.

## Mapa atual

### Fluxo de agentes e IDE

- `AGENTS.md` e a instrucao raiz do projeto mandam o agente consultar `MEMORY.md`, `memory/obsidian-vault/Memory Index.md`, `20-Decisions/`, `30-Runbooks/` e `40-Incidents/` antes de debugging ou implementacao relevantes.
- `.vscode/settings.json` contem apenas configuracao do Claude Code:
  - `claudeCode.allowDangerouslySkipPermissions: false`
  - `claudeCode.initialPermissionMode: default`
- `.agents/plugins/marketplace.json` registra o marketplace local `polymarket-local` e aponta o plugin `context-mode` para `./plugins/context-mode`.
- O plugin local `plugins/context-mode` contem templates para Codex, VS Code Copilot, Cursor, Gemini, Kiro, Zed e outros clientes. O projeto atual usa principalmente Codex + MCP.

### Fluxo MCP e context-mode

- `plugins/context-mode/.mcp.json` registra o servidor MCP `context-mode` usando:
  - `command: node`
  - `args: /opt/PolymarketBTC15mAssistant/plugins/context-mode/start.mjs`
- Templates alternativos do plugin:
  - VS Code Copilot: `npx -y context-mode`
  - Cursor: `context-mode`
- `start.mjs` define `CONTEXT_MODE_PROJECT_DIR` com o diretorio de trabalho original quando a variavel nao existe. Isso isola a base de conhecimento por projeto desde que o cliente MCP seja iniciado a partir do root do projeto ou receba `CONTEXT_MODE_PROJECT_DIR`.

### Fluxo de hooks

O Codex atual esta configurado em `/root/.codex/hooks.json`, com caminhos absolutos para este projeto:

- `PreToolUse`: `plugins/context-mode/hooks/codex/pretooluse.mjs`
- `PostToolUse`: `plugins/context-mode/hooks/codex/posttooluse.mjs`
- `SessionStart`: context-mode primeiro, depois `scripts/obsidian-memory-hook.mjs SessionStart`
- `UserPromptSubmit`: context-mode primeiro, depois `scripts/obsidian-memory-hook.mjs UserPromptSubmit`
- `Stop`: context-mode primeiro, depois `scripts/obsidian-memory-hook.mjs Stop`

Ponto critico: esses caminhos absolutos nao podem ser copiados literalmente para outro diretorio. O scaffold renderiza hooks a partir do caminho real do novo projeto.

### Fluxo Obsidian

Vault atual:

```text
memory/obsidian-vault/
  00-Inbox/
  10-Sessions/
  20-Decisions/
  30-Runbooks/
  40-Incidents/
  90-Templates/
  .obsidian/
  Memory Index.md
  Sessions.base
  Project Memory.canvas
```

Contrato atual:

- `10-Sessions/` recebe notas automaticas de sessoes do Codex.
- `20-Decisions/` guarda decisoes tecnicas duraveis.
- `30-Runbooks/` guarda procedimentos operacionais.
- `40-Incidents/` guarda bugs, incidentes e postmortems.
- `90-Templates/` guarda templates Obsidian.
- `.obsidian/daily-notes.json` usa `00-Inbox` e template `90-Templates/Daily Note.md`.
- `.obsidian/templates.json` aponta para `90-Templates`.
- `Sessions.base` filtra notas com `type == "chat-session"`.

## Inicializacao em novo diretorio

1. Crie ou escolha o root do novo projeto.
2. Rode o scaffold a partir deste repositorio:

```bash
/opt/PolymarketBTC15mAssistant/setup_ai_env /caminho/do/novo-projeto --project-name NomeDoProjeto
```

3. Abra o vault no Obsidian usando a pasta:

```text
memory/obsidian-vault
```

4. No Obsidian, confirme:
   - Daily Notes ativo com pasta `00-Inbox`.
   - Templates ativo com pasta `90-Templates`.
   - Canvas ativo para `Project Memory.canvas`.
   - Bases ativo se a versao do Obsidian oferecer suporte a `.base`.

5. Para Codex registrar sessoes no novo vault, instale os hooks globais somente depois de revisar:

```bash
/opt/PolymarketBTC15mAssistant/setup_ai_env /caminho/do/novo-projeto --install-codex-user-hooks
```

O script faz backup de `~/.codex/hooks.json` antes de sobrescrever.

## O que parametrizar

- `PROJECT_NAME`: nome logico gravado em frontmatter das notas.
- `CONTEXT_MODE_PROJECT_DIR`: root do projeto usado pelo context-mode.
- Caminho do plugin `context-mode`:
  - `npx -y context-mode` para instalacao limpa.
  - `plugins/context-mode/start.mjs` para plugin vendorizado/local.
- Hooks globais do Codex: devem ser regenerados por projeto; nao copie `/root/.codex/hooks.json` entre projetos.
- Portas opcionais:
  - `CONTEXT_MODE_INSIGHT_PORT`, padrao sugerido `4747`.
  - portas de servidores de app do projeto, se existirem.
- Chaves e segredos:
  - `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, `ATLASSIAN_API_TOKEN`, `LINEAR_API_KEY`, `OBSIDIAN_REST_API_KEY`.
  - chaves de dominio do app atual: `POLY_PRIVATE_KEY`, `RELAYER_API_KEY`, `RELAYER_API_KEY_ADDRESS`.
  - manter apenas em `.env`; nunca em vault Obsidian, notas de sessao ou git.

## Arquivos gerados pelo scaffold

- `AGENTS.md`: instrucao de memoria do projeto.
- `.vscode/settings.json`: defaults seguros do Claude Code.
- `.mcp.json` e `.vscode/mcp.json`: servidor MCP `context-mode`.
- `.codex/hooks.json`: template local dos hooks do Codex.
- `.agents/plugins/marketplace.json`: marketplace local para plugin vendorizado.
- `scripts/obsidian-memory-hook.mjs`: hook de memoria do Obsidian.
- `memory/obsidian-vault/**`: estrutura isolada do vault.
- `prompts/system.md`: ponto inicial para prompts customizados.
- `.env.example`: catalogo de variaveis sem segredos reais.

## Checklist DevSecOps

- Nao versionar `.env`, chaves, wallets, tokens ou dumps de sessao com segredo.
- Nao copiar hooks globais com paths absolutos de outro projeto.
- Preferir `CONTEXT_MODE_PROJECT_DIR` explicito em MCP quando o cliente nao inicia no root.
- Revisar `.agents/plugins/marketplace.json` se o plugin local nao existir no novo projeto.
- Promover conhecimento duravel de `10-Sessions/` para `20-Decisions/`, `30-Runbooks/` ou `40-Incidents/`.
