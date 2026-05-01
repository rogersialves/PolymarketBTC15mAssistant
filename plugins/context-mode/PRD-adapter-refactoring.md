# PRD: Adapter Architecture Refactoring — Evidence-Based

> 12 agent ile kanıtlanmış analiz. 11 adapter, 5,137 satır.

## Kritik Bulgu: Adapter Aileleri

```
┌─────────────────────────────────────────────────────────────┐
│                    11 ADAPTER = 4 AİLE                      │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  AİLE 1: Claude Code Protocol                              │
│  ─────────────────────────────────                          │
│  Format: permissionDecision:"deny", updatedInput            │
│  Input:  tool_name + tool_input (snake_case)                │
│  Config: ~/.{platform}/settings.json                        │
│  ┌─────────────┐  ┌─────────────┐                           │
│  │ Claude Code  │  │  Qwen Code  │ ← Gemini CLI fork ama   │
│  │   697 LOC    │  │   377 LOC   │   Claude Code protocol   │
│  └─────────────┘  └─────────────┘   kullanıyor              │
│  10 method IDENTICAL. Qwen = Claude Code wire protocol.     │
│  Fark: Qwen stubs out configureAllHooks, setHookPermissions │
│                                                             │
│  AİLE 2: Copilot Protocol                                  │
│  ────────────────────────                                   │
│  Format: hookSpecificOutput:{hookEventName, updatedInput}   │
│  Input:  tool_name + tool_input (sessionId camelCase)       │
│  Config: .github/hooks/context-mode.json                    │
│  ┌─────────────────┐  ┌─────────────────────┐               │
│  │  VS Code Copilot │  │ JetBrains Copilot   │ (PR #327)   │
│  │     590 LOC      │  │    ~456 LOC         │               │
│  └─────────────────┘  └─────────────────────┘               │
│  Same agent runtime, same hook events, same formatters.     │
│  Fark: config paths, MCP registration, session storage      │
│                                                             │
│  AİLE 3: Platform-Specific Protocol                         │
│  ──────────────────────────────────                         │
│  Her biri kendine özgü format — paylaşılamaz                │
│  ┌─────────┐ ┌──────────┐ ┌───────┐ ┌─────────┐            │
│  │ Gemini  │ │  Cursor   │ │ Codex │ │  Kiro   │            │
│  │ 554 LOC │ │  565 LOC  │ │402 LOC│ │ 390 LOC │            │
│  └─────────┘ └──────────┘ └───────┘ └─────────┘            │
│  decision:   permission:   hookSpec   exitCode:2            │
│  "deny"      "deny"        Output     (no JSON)             │
│  ┌──────────┐ ┌──────────┐                                  │
│  │ OpenCode │ │ OpenClaw │ ← ts-plugin paradigm             │
│  │  526 LOC │ │  519 LOC │   (throw Error / block:true)     │
│  └──────────┘ └──────────┘                                  │
│                                                             │
│  AİLE 4: MCP-Only (no hooks)                                │
│  ──────────────────────────                                 │
│  ┌──────┐ ┌─────────────┐                                   │
│  │ Zed  │ │ Antigravity │  ← all capabilities: false        │
│  │252LOC│ │   254 LOC   │    stub everything                │
│  └──────┘ └─────────────┘                                   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## Kanıtlanmış Duplication Tablosu

| Method | Identical Copies | Lines/impl | Duplicate Lines | Savings |
|--------|:---:|:---:|:---:|:---:|
| `getSessionDBPath` | **11/11** | 7 | 70 | **70** |
| `getSessionEventsPath` | **11/11** | 7 | 70 | **70** |
| `backupSettings` | **8/11** | 11 | 77 | **77** |
| `setHookPermissions` | **4/11** + 7 stub | 14 | 51 | **51** |
| `readSettings` | **6/11** | 8 | 32 | **32** |
| `writeSettings` | **3/11** | 5 | 10 | **10** |
| **BaseAdapter TOPLAM** | | | | **310 satır** |

| CopilotAdapter Sharing | VS Code → JetBrains | Lines |
|------------------------|:---:|:---:|
| Shared methods | 8 methods | **102 satır** |
| Shared hook scripts | 4 scripts | **~80 satır** |
| **CopilotAdapter TOPLAM** | | **~182 satır** |

| ClaudeCodeAdapter Sharing | Claude → Qwen | Lines |
|---------------------------|:---:|:---:|
| Identical parse/format | 10 methods | **~120 satır** |
| **ClaudeCodeAdapter TOPLAM** | | **~120 satır** |

## Net Tasarruf

| Extraction | Eklenen | Silinen | Net |
|------------|:---:|:---:|:---:|
| BaseAdapter (tüm 11 adapter) | +60 | -310 | **-250** |
| CopilotAdapter (vscode + jetbrains) | +100 | -182 | **-82** |
| ClaudeCodeAdapter (claude + qwen) | +80 | -120 | **-40** |
| **TOPLAM** | **+240** | **-612** | **-372 satır** |

## Yeni Adapter Ekleme Maliyeti

| Senaryo | Şu An | Refactoring Sonrası |
|---------|:---:|:---:|
| Yeni Claude-protocol adapter (ör: Windsurf) | ~400 satır | ~80 satır |
| Yeni Copilot IDE adapter (ör: Neovim Copilot) | ~500 satır | ~60 satır |
| Yeni unique-protocol adapter (ör: Amp) | ~400 satır | ~300 satır |
| Yeni MCP-only adapter (ör: Continue) | ~250 satır | ~50 satır |

## Hedef Mimari

```
BaseAdapter (abstract) — 60 LOC
│   getSessionDBPath()        ← 11 → 1
│   getSessionEventsPath()    ← 11 → 1
│   backupSettings()          ← 8 → 1 (default, override OK)
│   setHookPermissions()      ← parameterized default
│   readSettings()            ← shared JSON read
│   writeSettings()           ← shared JSON write
│
├── ClaudeCodeBaseAdapter — 80 LOC
│   │   formatPreToolUseResponse()   ← permissionDecision pattern
│   │   formatPostToolUseResponse()  ← updatedMCPToolOutput pattern
│   │   parsePreToolUseInput()       ← tool_name + tool_input
│   │
│   ├── ClaudeCodeAdapter (697→~450 LOC)
│   │     configureAllHooks()  ← 131 lines, plugin registry, self-heal
│   │     checkPluginRegistration() ← installed_plugins.json
│   │
│   └── QwenCodeAdapter (377→~150 LOC)
│         configureAllHooks()  ← stub (return [])
│         checkPluginRegistration() ← mcpServers check
│
├── CopilotBaseAdapter — 100 LOC
│   │   formatPreToolUseResponse()   ← hookSpecificOutput wrapper
│   │   configureHooks()             ← .github/hooks/ pattern
│   │   generateHookConfig()         ← shared JSON structure
│   │
│   ├── VSCodeCopilotAdapter (590→~350 LOC)
│   │     configDir: ".vscode"
│   │     checkPluginRegistration() → reads .vscode/mcp.json
│   │
│   └── JetBrainsCopilotAdapter (~456→~150 LOC)
│         configDir: ".config/JetBrains"
│         checkPluginRegistration() → WARN (Settings UI)
│
├── GeminiCLIAdapter (554 LOC — unique, decision:"deny")
├── CursorAdapter (565 LOC — unique, permission:"deny")
├── CodexAdapter (402 LOC — unique, hookSpecificOutput+hookEventName)
├── KiroAdapter (390 LOC — unique, exit codes)
├── OpenCodeAdapter (526 LOC — unique, throw Error)
├── OpenClawAdapter (519 LOC — unique, block:true)
├── ZedAdapter (252→~50 LOC via BaseAdapter)
└── AntigravityAdapter (254→~50 LOC via BaseAdapter)
```

## QWEN UYARISI

**Qwen Code = Gemini CLI fork** (Google LLC copyright in mcp-tool.ts, setGeminiMdFilename artifacts).
Ama adapter'ımız **Claude Code protocol** kullanıyor (`permissionDecision`, `updatedInput`).

Qwen Code refs'te hook naming: `PreToolUse`, `PostToolUse` (Claude Code names).
Ama Gemini CLI uses: `BeforeTool`, `AfterTool` (different names).

**Doğrulanması gereken**: Qwen Code runtime'da gerçekten `permissionDecision` mı yoksa `decision` mı kabul ediyor?
Bu yanlışsa adapter tamamen broken. Qwen Code'u test eden birinin doğrulaması şart.

## Uygulama Sırası

| Step | İş | Risk | Bağımlılık |
|:---:|------|:---:|:---:|
| 1 | PR #327 (JetBrains) fixle + merge | LOW | — |
| 2 | Qwen adapter protocol doğrula (refs'ten) | **HIGH** | — |
| 3 | `BaseAdapter` extract (11 adapter) | LOW | — |
| 4 | `ClaudeCodeBaseAdapter` extract (claude + qwen) | LOW | Step 2, 3 |
| 5 | `CopilotBaseAdapter` extract (vscode + jetbrains) | LOW | Step 1, 3 |

## Başarı Kriterleri

- [ ] 1600+ test geçer
- [ ] `npm run typecheck` clean
- [ ] Her adapter aynı davranış (before/after diff)
- [ ] Yeni adapter: ~50-150 satır (şu an ~400-500)
- [ ] 3 OS CI green
- [ ] Qwen protocol doğrulanmış
