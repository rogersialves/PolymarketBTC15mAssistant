# PR #327 — JetBrains Copilot vs VS Code Copilot Adapter Comparison

## Precise Diff Table

| Aspect | VS Code Copilot | JetBrains Copilot | SAME or DIFFERENT? |
|--------|----------------|-------------------|-------------------|
| **HookAdapter class name** | `VsCodeCopilotAdapter` | `JetBrainsCopilotAdapter` | DIFFERENT (name only) |
| **`name` property** | `"VS Code Copilot"` | `"JetBrains Copilot"` | DIFFERENT (name only) |
| **Hook paradigm** | `"json-stdio"` | `"json-stdio"` | SAME |
| **Hook events (names)** | PreToolUse, PostToolUse, PreCompact, SessionStart | PreToolUse, PostToolUse, PreCompact, SessionStart | SAME |
| **Hook events (count)** | 4 core + 3 extra (Stop, SubagentStart, SubagentStop) | 4 core only | DIFFERENT — JetBrains omits Stop/SubagentStart/SubagentStop |
| **Capabilities — preToolUse** | `true` | `true` | SAME |
| **Capabilities — postToolUse** | `true` | `true` | SAME |
| **Capabilities — preCompact** | `true` | `true` | SAME |
| **Capabilities — sessionStart** | `true` | `true` | SAME |
| **Capabilities — canModifyArgs** | `true` | `true` | SAME |
| **Capabilities — canModifyOutput** | `true` | `true` | SAME |
| **Capabilities — canInjectSessionContext** | `true` | `true` | SAME |
| **Env vars for detection** | `VSCODE_PID`, `VSCODE_CWD` | `IDEA_INITIAL_DIRECTORY`, `IDEA_HOME`, `JETBRAINS_CLIENT_ID` | DIFFERENT |
| **Config dir path** | `.vscode/` | `.idea/` | DIFFERENT |
| **Session DB path** | `.github/context-mode/sessions/` or `~/.vscode/context-mode/sessions/` | `~/.config/JetBrains/context-mode/sessions/` | DIFFERENT |
| **MCP config location** | `.vscode/mcp.json` | `.idea/mcp.json` (but managed via IDE Settings UI) | DIFFERENT |
| **MCP config format** | JSON with `servers` key | JSON with `servers` key | SAME |
| **getSettingsPath** | `.github/hooks/context-mode.json` | `.github/hooks/context-mode.json` | SAME (shared Copilot agent!) |
| **generateHookConfig format** | `{ [HookName]: [{ matcher, hooks: [{ type, command }] }] }` | `{ [HookName]: [{ matcher, hooks: [{ type, command }] }] }` | SAME (identical structure) |
| **Hook command format** | `context-mode hook vscode-copilot <hookname>` | `context-mode hook jetbrains-copilot <hookname>` | DIFFERENT (platform slug only) |
| **parsePreToolUseInput** | `{ toolName: tool_name, toolInput: tool_input, sessionId, projectDir, raw }` | `{ toolName: tool_name, toolInput: tool_input, sessionId, projectDir, raw }` | SAME structure |
| **parsePostToolUseInput** | Same as above + `toolOutput`, `isError` | Same as above + `toolOutput`, `isError` | SAME structure |
| **parsePreCompactInput** | `{ sessionId, projectDir, raw }` | `{ sessionId, projectDir, raw }` | SAME |
| **parseSessionStartInput** | Switch on source: compact/resume/clear/startup | Switch on source: compact/resume/clear/startup | SAME logic |
| **formatPreToolUseResponse** | deny -> `permissionDecision: "deny"`, modify -> `hookSpecificOutput.updatedInput`, context -> `hookSpecificOutput.additionalContext`, ask -> deny | IDENTICAL | SAME |
| **formatPostToolUseResponse** | updatedOutput -> `hookSpecificOutput.decision: "block"`, additionalContext -> `hookSpecificOutput.additionalContext` | IDENTICAL | SAME |
| **formatPreCompactResponse** | `response.context ?? ""` | `response.context ?? ""` | SAME |
| **formatSessionStartResponse** | `response.context ?? ""` | `response.context ?? ""` | SAME |
| **projectDir resolution** | `process.env.CLAUDE_PROJECT_DIR \|\| process.cwd()` | `process.env.IDEA_INITIAL_DIRECTORY \|\| process.env.CLAUDE_PROJECT_DIR \|\| process.cwd()` | DIFFERENT — JetBrains prefers IDEA_INITIAL_DIRECTORY |
| **extractSessionId** | `input.sessionId` -> `vscode-${VSCODE_PID}` -> `pid-${ppid}` | `input.sessionId` -> `jetbrains-${JETBRAINS_CLIENT_ID}` -> `idea-${pid}` -> `pid-${ppid}` | DIFFERENT — different env var fallback chain |
| **readSettings** | Try `.github/hooks/context-mode.json`, then `.claude/settings.json` | Try `.github/hooks/context-mode.json`, then `.claude/settings.json` | SAME |
| **writeSettings** | Write to `.github/hooks/context-mode.json` | Write to `.github/hooks/context-mode.json` | SAME |
| **validateHooks** | Checks `.github/hooks/` dir, reads `context-mode.json`, checks each hook name | Same structure, uses JETBRAINS_HOOK_NAMES instead of VSCODE_HOOK_NAMES | SAME logic, DIFFERENT constant references |
| **checkPluginRegistration** | Reads `.vscode/mcp.json`, checks for `context-mode` in `servers` | Returns WARN: "JetBrains stores MCP config via Settings UI — not CLI-inspectable" | DIFFERENT — JetBrains cannot inspect MCP config |
| **getInstalledVersion** | Checks `~/.vscode/extensions/` for context-mode extension | Checks if hook config exists -> "configured" or "unknown" | DIFFERENT — JetBrains has no extension system to inspect |
| **getSessionDir** | `.github/context-mode/sessions/` (if `.github` exists) else `~/.vscode/context-mode/sessions/` | `~/.config/JetBrains/context-mode/sessions/` (always) | DIFFERENT |

## Hook Scripts (.mjs)

| Script | VS Code Copilot | JetBrains Copilot | SAME or DIFFERENT? |
|--------|----------------|-------------------|-------------------|
| **pretooluse.mjs** | imports `VSCODE_OPTS`, uses `routePreToolUse` + `formatDecision("vscode-copilot")`, reads `VSCODE_CWD` for project dir | imports nothing from session-helpers (inlines `readStdin`), uses `routePreToolUse` + `formatDecision("jetbrains-copilot")`, reads `IDEA_INITIAL_DIRECTORY` for project dir | DIFFERENT — platform slug + env var + import style |
| **posttooluse.mjs** | imports `VSCODE_OPTS`, debug dir `~/.vscode/context-mode/` | imports `JETBRAINS_OPTS`, debug dir `~/.config/JetBrains/context-mode/` | DIFFERENT — OPTS constant + debug dir path |
| **precompact.mjs** | imports `VSCODE_OPTS`, debug dir `~/.vscode/context-mode/` | imports `JETBRAINS_OPTS`, debug dir `~/.config/JetBrains/context-mode/` | DIFFERENT — OPTS constant + debug dir path |
| **sessionstart.mjs** | imports `VSCODE_OPTS`, debug dir `~/.vscode/context-mode/`, reads `.vscode/copilot-instructions.md` or `.github/copilot-instructions.md` | imports `JETBRAINS_OPTS`, debug dir `~/.config/JetBrains/context-mode/`, reads `.idea/copilot-instructions.md` or `.github/copilot-instructions.md` | DIFFERENT — OPTS + debug dir + rule file path |

## Session OPTS

| Field | VSCODE_OPTS | JETBRAINS_OPTS | SAME or DIFFERENT? |
|-------|------------|----------------|-------------------|
| **configDir** | `.vscode` | `.config/JetBrains` | DIFFERENT |
| **configDirEnv** | `undefined` | (not defined — omitted) | SAME (both undefined) |
| **projectDirEnv** | `VSCODE_CWD` | `IDEA_INITIAL_DIRECTORY` | DIFFERENT |
| **sessionIdEnv** | `undefined` | `JETBRAINS_CLIENT_ID` | DIFFERENT |

## Config Files

| File | VS Code Copilot | JetBrains Copilot | SAME or DIFFERENT? |
|------|----------------|-------------------|-------------------|
| **hooks.json** | `context-mode hook vscode-copilot <type>` | `context-mode hook jetbrains-copilot <type>` | DIFFERENT (slug only) |
| **mcp.json** | `npx -y context-mode` | `npx -y context-mode` | SAME |

## Tool Naming & Formatter

| Aspect | VS Code Copilot | JetBrains Copilot | Notes |
|--------|----------------|-------------------|-------|
| **Tool naming** | `tool-naming.mjs` adds `"jetbrains-copilot"` to the supported platforms list (+1 line) | N/A | PR adds JetBrains to shared infrastructure |
| **Formatter** | `formatters.mjs` adds JetBrains-specific formatting (+26 lines) | N/A | PR adds JetBrains format to shared `formatDecision()` |

## hooks.ts Comparison

| Aspect | VS Code Copilot | JetBrains Copilot | SAME or DIFFERENT? |
|--------|----------------|-------------------|-------------------|
| **HOOK_TYPES** | 7 types (4 core + Stop, SubagentStart, SubagentStop) | 4 types (core only) | DIFFERENT — JetBrains lacks VS Code-unique hooks |
| **HOOK_SCRIPTS** | 4 entries (same 4 core) | 4 entries (same 4 core) | SAME |
| **REQUIRED_HOOKS** | `[PreToolUse, SessionStart]` | `[PreToolUse, SessionStart]` | SAME |
| **OPTIONAL_HOOKS** | `[PostToolUse, PreCompact]` | `[PostToolUse, PreCompact]` | SAME |
| **isContextModeHook()** | Checks `command` for script name or CLI command | Same logic, with `jetbrains-copilot` slug | SAME logic |
| **buildHookCommand()** | `context-mode hook vscode-copilot <type>` | `context-mode hook jetbrains-copilot <type>` | DIFFERENT (slug only) |

---

## Verdict

**Could these be the SAME adapter with different detection env vars?**

**Almost, but NOT quite.** There are genuine behavioral differences beyond just env vars:

1. **Session storage strategy**: VS Code uses project-local `.github/context-mode/sessions/` with fallback to `~/.vscode/`. JetBrains always uses `~/.config/JetBrains/context-mode/sessions/`. This is a real architectural difference — JetBrains centralizes session data globally.

2. **MCP registration inspection**: VS Code can inspect `.vscode/mcp.json` programmatically. JetBrains cannot — MCP config lives in the IDE's Settings UI (not file-based in a project-inspectable location). `checkPluginRegistration()` returns a WARN instead of pass/fail.

3. **getInstalledVersion()**: VS Code scans `~/.vscode/extensions/`. JetBrains has no equivalent — it just checks if hook config exists.

4. **Rule file path**: SessionStart reads `.vscode/copilot-instructions.md` vs `.idea/copilot-instructions.md`.

5. **Extra hook types**: VS Code defines `Stop`, `SubagentStart`, `SubagentStop` (even if unused by context-mode). JetBrains omits them entirely.

6. **extractSessionId fallback chain**: VS Code has 3 levels (sessionId -> VSCODE_PID -> ppid). JetBrains has 4 levels (sessionId -> JETBRAINS_CLIENT_ID -> IDEA_HOME/pid -> ppid).

**However**, the core hook I/O contract is identical: same JSON stdin/stdout paradigm, same input field names (`tool_name`, `tool_input`, `is_error`, `sessionId`, `source`), same response shapes (`permissionDecision`, `hookSpecificOutput`, `updatedInput`, `additionalContext`), same `getSettingsPath()`, and same `generateHookConfig()` format. The adapter is genuinely a copy-paste-customize of the VS Code adapter with ~15 platform-specific customizations.

**Refactoring opportunity**: A shared `CopilotBaseAdapter` could hold ~80% of the logic, with subclasses overriding only: detection env vars, session dir path, MCP config path, checkPluginRegistration, getInstalledVersion, extractSessionId, and getProjectDir.
