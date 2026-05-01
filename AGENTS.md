# Project Memory

This project uses an Obsidian vault as durable project memory.

Before non-trivial debugging or implementation, check:

- `MEMORY.md`
- `memory/obsidian-vault/Memory Index.md`
- relevant notes in `memory/obsidian-vault/20-Decisions/`, `30-Runbooks/`, and `40-Incidents/`

During work:

- Keep chat/session events flowing through the Codex hooks into `memory/obsidian-vault/10-Sessions/`.
- Promote durable decisions, incidents, and runbooks from session notes into the matching vault folders.
- Do not store secrets, private keys, API tokens, or wallet credentials in the vault.

Installed Obsidian skills become available after Codex restart:

- `obsidian-markdown` for Obsidian-flavored Markdown notes.
- `obsidian-bases` for `.base` views.
- `json-canvas` for `.canvas` maps.
- `obsidian-cli` when a running Obsidian instance should be controlled through its CLI.
- `defuddle` for clean Markdown extraction from web pages.
