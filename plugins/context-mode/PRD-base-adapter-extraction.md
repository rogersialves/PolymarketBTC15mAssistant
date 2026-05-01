# BaseAdapter Extraction Report

## 1. Adapter Inventory (12 adapters)

```
antigravity, claude-code, codex, cursor, gemini-cli,
jetbrains-copilot, kiro, openclaw, opencode, qwen-code,
vscode-copilot, zed
```

## 2. Extractable Methods (100% identical across all adapters)

### 2a. getSessionDBPath
```typescript
getSessionDBPath(projectDir: string): string {
  const hash = createHash("sha256")
    .update(projectDir)
    .digest("hex")
    .slice(0, 16);
  return join(this.getSessionDir(), `${hash}.db`);
}
```

### 2b. getSessionEventsPath
```typescript
getSessionEventsPath(projectDir: string): string {
  const hash = createHash("sha256")
    .update(projectDir)
    .digest("hex")
    .slice(0, 16);
  return join(this.getSessionDir(), `${hash}-events.md`);
}
```

### 2c. backupSettings
```typescript
backupSettings(): string | null {
  const settingsPath = this.getSettingsPath();
  try {
    accessSync(settingsPath, constants.R_OK);
    const backupPath = settingsPath + ".bak";
    copyFileSync(settingsPath, backupPath);
    return backupPath;
  } catch {
    return null;
  }
}
```

### 2d. setHookPermissions (split pattern)
Two variants exist:
- **No-op adapters** (antigravity, codex): `return [];`
- **chmod adapters** (claude-code, cursor, gemini-cli, etc.): iterate hook scripts, `chmodSync(path, 0o755)`

This method is NOT universally identical — the chmod variant differs in which hooks dir it uses. Cannot extract as-is into BaseAdapter without parameterization.

## 3. Required Imports for BaseAdapter

```typescript
import { createHash } from "node:crypto";
import { join } from "node:path";
import { accessSync, copyFileSync, constants, mkdirSync } from "node:fs";
```

## 4. HookAdapter Interface — Full Method List

### Properties (readonly)
- `name: string`
- `paradigm: HookParadigm`
- `capabilities: PlatformCapabilities`

### Required Methods
- `parsePreToolUseInput(raw: unknown): PreToolUseEvent`
- `parsePostToolUseInput(raw: unknown): PostToolUseEvent`
- `formatPreToolUseResponse(response: PreToolUseResponse): unknown`
- `formatPostToolUseResponse(response: PostToolUseResponse): unknown`
- `getSettingsPath(): string`
- `getSessionDir(): string`
- `getSessionDBPath(projectDir: string): string`
- `getSessionEventsPath(projectDir: string): string`
- `generateHookConfig(pluginRoot: string): HookRegistration`
- `readSettings(): Record<string, unknown> | null`
- `writeSettings(settings: Record<string, unknown>): void`
- `validateHooks(pluginRoot: string): DiagnosticResult[]`
- `checkPluginRegistration(): DiagnosticResult`
- `getInstalledVersion(): string`
- `configureAllHooks(pluginRoot: string): string[]`
- `backupSettings(): string | null`
- `setHookPermissions(pluginRoot: string): string[]`
- `updatePluginRegistry(pluginRoot: string, version: string): void`

### Optional Methods
- `parsePreCompactInput?(raw: unknown): PreCompactEvent`
- `parseSessionStartInput?(raw: unknown): SessionStartEvent`
- `formatPreCompactResponse?(response: PreCompactResponse): unknown`
- `formatSessionStartResponse?(response: SessionStartResponse): unknown`

## 5. getSessionDir Analysis — CANNOT be in BaseAdapter directly

Each adapter has a **unique dotfolder path**:

| Adapter | Session Dir Path |
|---------|-----------------|
| antigravity | `~/.gemini/context-mode/sessions/` |
| claude-code | `~/.claude/context-mode/sessions/` |
| codex | `~/.codex/context-mode/sessions/` |
| cursor | `~/.cursor/context-mode/sessions/` |
| gemini-cli | `~/.gemini/context-mode/sessions/` |
| jetbrains-copilot | `~/.config/JetBrains/context-mode/sessions/` |
| kiro | `~/.kiro/context-mode/sessions/` |
| openclaw | `~/.openclaw/context-mode/sessions/` |
| qwen-code | `~/.qwen/context-mode/sessions/` |
| vscode-copilot | uses `configDir` property |
| zed | `~/.config/zed/context-mode/sessions/` |

**Pattern**: `join(homedir(), <dotfolder>, "context-mode", "sessions")` with `mkdirSync(dir, { recursive: true })`.

**Solution**: BaseAdapter takes a `sessionDirSegments: string[]` constructor param (e.g. `[".claude"]` or `[".config", "JetBrains"]`), then implements getSessionDir once:

```typescript
getSessionDir(): string {
  const dir = join(homedir(), ...this.sessionDirSegments, "context-mode", "sessions");
  mkdirSync(dir, { recursive: true });
  return dir;
}
```

## 6. Recommended BaseAdapter Skeleton

```typescript
// src/adapters/base.ts
import { createHash } from "node:crypto";
import { join } from "node:path";
import { accessSync, copyFileSync, constants, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import type { HookAdapter, HookRegistration, ... } from "./types.js";

export abstract class BaseAdapter implements Partial<HookAdapter> {
  abstract readonly name: string;
  abstract readonly paradigm: HookParadigm;
  abstract readonly capabilities: PlatformCapabilities;

  constructor(protected readonly sessionDirSegments: string[]) {}

  // ── Shared implementations (3 methods) ─────────────────

  getSessionDir(): string {
    const dir = join(homedir(), ...this.sessionDirSegments, "context-mode", "sessions");
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  getSessionDBPath(projectDir: string): string {
    const hash = createHash("sha256")
      .update(projectDir).digest("hex").slice(0, 16);
    return join(this.getSessionDir(), `${hash}.db`);
  }

  getSessionEventsPath(projectDir: string): string {
    const hash = createHash("sha256")
      .update(projectDir).digest("hex").slice(0, 16);
    return join(this.getSessionDir(), `${hash}-events.md`);
  }

  backupSettings(): string | null {
    const settingsPath = this.getSettingsPath();
    try {
      accessSync(settingsPath, constants.R_OK);
      const backupPath = settingsPath + ".bak";
      copyFileSync(settingsPath, backupPath);
      return backupPath;
    } catch { return null; }
  }

  // ── Abstract (must be per-adapter) ─────────────────────

  abstract getSettingsPath(): string;
  abstract parsePreToolUseInput(raw: unknown): PreToolUseEvent;
  abstract parsePostToolUseInput(raw: unknown): PostToolUseEvent;
  abstract formatPreToolUseResponse(response: PreToolUseResponse): unknown;
  abstract formatPostToolUseResponse(response: PostToolUseResponse): unknown;
  abstract generateHookConfig(pluginRoot: string): HookRegistration;
  abstract readSettings(): Record<string, unknown> | null;
  abstract writeSettings(settings: Record<string, unknown>): void;
  abstract validateHooks(pluginRoot: string): DiagnosticResult[];
  abstract checkPluginRegistration(): DiagnosticResult;
  abstract getInstalledVersion(): string;
  abstract configureAllHooks(pluginRoot: string): string[];
  abstract setHookPermissions(pluginRoot: string): string[];
  abstract updatePluginRegistry(pluginRoot: string, version: string): void;
}
```

## 7. Impact Summary

| What | Lines saved per adapter | Adapters | Total |
|------|------------------------|----------|-------|
| getSessionDir | 4 | 12 | 48 |
| getSessionDBPath | 6 | 12 | 72 |
| getSessionEventsPath | 6 | 12 | 72 |
| backupSettings | 8 | 12 | 96 |
| **Total** | **24** | **12** | **288 lines** |

setHookPermissions is NOT recommended for extraction — the two variants (no-op vs chmod) differ in hook directory structure per adapter.
