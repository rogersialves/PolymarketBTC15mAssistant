#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vaultRoot = join(repoRoot, "memory", "obsidian-vault");
const sessionsDir = join(vaultRoot, "10-Sessions");
const inboxDir = join(vaultRoot, "00-Inbox");
const indexPath = join(vaultRoot, "Memory Index.md");
const monthNames = [
  "Janeiro",
  "Fevereiro",
  "Marco",
  "Abril",
  "Maio",
  "Junho",
  "Julho",
  "Agosto",
  "Setembro",
  "Outubro",
  "Novembro",
  "Dezembro",
];

function readStdin() {
  try {
    return readFileSync(0, "utf8").trim();
  } catch {
    return "";
  }
}

function parseInput(raw) {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}

function slug(value) {
  return String(value || "unknown")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96) || "unknown";
}

function titleSlug(value) {
  return String(value || "Sessao iniciada")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[`*_#[\](){}:;,.!?/\\|<>"'=+~]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 72)
    .replace(/\s+$/g, "") || "Sessao iniciada";
}

function nowIso() {
  return new Date().toISOString();
}

function eventName(input) {
  return process.argv[2] || input.hook_event_name || input.hookEventName || "event";
}

function sessionId(input) {
  return (
    input.session_id ||
    input.sessionId ||
    process.env.CODEX_SESSION_ID ||
    process.env.CODEX_THREAD_ID ||
    "manual"
  );
}

function projectDir(input) {
  return input.cwd || input.project_dir || input.projectDir || process.env.CONTEXT_MODE_PROJECT_DIR || repoRoot;
}

function userPrompt(input) {
  return input.prompt || input.user_prompt || input.userPrompt || input.message || input.raw_prompt || "";
}

function jsonScalar(value) {
  return JSON.stringify(String(value ?? ""));
}

function dateParts(iso) {
  const date = new Date(iso);
  const year = String(date.getUTCFullYear());
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const monthName = monthNames[date.getUTCMonth()];
  const hour = String(date.getUTCHours()).padStart(2, "0");
  const minute = String(date.getUTCMinutes()).padStart(2, "0");
  const second = String(date.getUTCSeconds()).padStart(2, "0");
  return { year, monthFolder: `${month}-${monthName}`, time: `${hour}-${minute}-${second}` };
}

function sessionTitle(input, fallback = "Sessao iniciada") {
  return titleSlug(userPrompt(input) || input.description || input.summary || fallback);
}

function sessionPathFor(input, created, title) {
  const parts = dateParts(created);
  return join(sessionsDir, parts.year, parts.monthFolder, `${parts.time} - ${title}.md`);
}

function ensureVault() {
  for (const dir of [vaultRoot, sessionsDir, inboxDir]) {
    mkdirSync(dir, { recursive: true });
  }
  if (!existsSync(indexPath)) {
    writeFileSync(
      indexPath,
      [
        "# Memory Index",
        "",
        "Vault Obsidian do projeto PolymarketBTC15mAssistant.",
        "",
        "## Sessões",
        "",
        "- Cada sessão do chat cria/atualiza uma nota em `10-Sessions/`.",
        "- Decisões estáveis devem ser promovidas para `20-Decisions/`.",
        "- Runbooks e procedimentos ficam em `30-Runbooks/`.",
        "",
      ].join("\n"),
      "utf8",
    );
  }
}

function sessionFile(input) {
  const existing = findSessionFile(sessionId(input));
  if (existing) return existing;
  return sessionPathFor(input, nowIso(), sessionTitle(input));
}

function findSessionFile(id) {
  const needle = `session_id: ${jsonScalar(String(id))}`;
  return findMarkdownWith(sessionsDir, needle);
}

function findMarkdownWith(dir, needle) {
  if (!existsSync(dir)) return null;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findMarkdownWith(path, needle);
      if (found) return found;
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".md")) {
      try {
        if (readFileSync(path, "utf8").includes(needle)) return path;
      } catch {}
    }
  }
  return null;
}

function ensureSessionNote(input, event) {
  let file = sessionFile(input);
  if (!existsSync(file)) {
    const created = nowIso();
    const id = String(sessionId(input));
    const title = sessionTitle(input);
    file = sessionPathFor(input, created, title);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      [
        "---",
        `title: ${jsonScalar(title)}`,
        "type: chat-session",
        "status: active",
        `session_id: ${jsonScalar(id)}`,
        `project: ${jsonScalar("PolymarketBTC15mAssistant")}`,
        `project_dir: ${jsonScalar(projectDir(input))}`,
        `created: ${jsonScalar(created)}`,
        `updated: ${jsonScalar(created)}`,
        `source: ${jsonScalar(input.source || "startup")}`,
        "tags:",
        "  - memory/session",
        "  - codex",
        "aliases:",
        `  - ${jsonScalar(id)}`,
        "---",
        "",
        `# ${title}`,
        "",
        "Links: [[Memory Index]]",
        "",
        "## Timeline",
        "",
      ].join("\n"),
      "utf8",
    );
    appendFileSync(indexPath, `- [[${vaultRelative(file)}|${title}]] - ${created}\n`);
  }
  file = maybeRenameSessionFile(file, input, event);
  touchSessionNote(file, input, event);
  appendFileSync(file, `\n### ${nowIso()} - ${event}\n\n`);
  return file;
}

function maybeRenameSessionFile(file, input, event) {
  if (event !== "UserPromptSubmit") return file;
  const prompt = userPrompt(input);
  if (!prompt) return file;
  const currentName = basename(file, ".md");
  if (!currentName.includes("Sessao iniciada") && !currentName.includes("unknown")) return file;
  const created = frontmatterValue(readFileSync(file, "utf8"), "created") || nowIso();
  const title = sessionTitle(input);
  const nextFile = sessionPathFor(input, created, title);
  if (nextFile === file || existsSync(nextFile)) return file;
  mkdirSync(dirname(nextFile), { recursive: true });
  renameSync(file, nextFile);
  replaceIndexLink(file, nextFile, title);
  return nextFile;
}

function vaultRelative(file) {
  return file.replace(vaultRoot + "/", "").replace(/\.md$/, "");
}

function replaceIndexLink(oldFile, newFile, title) {
  if (!existsSync(indexPath)) return;
  const oldRel = vaultRelative(oldFile);
  const nextRel = vaultRelative(newFile);
  const text = readFileSync(indexPath, "utf8");
  const updated = text.replace(new RegExp(`\\[\\[${escapeRegExp(oldRel)}\\|[^\\]]+\\]\\]`, "g"), `[[${nextRel}|${title}]]`);
  writeFileSync(indexPath, updated, "utf8");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function frontmatterValue(text, key) {
  const match = text.match(new RegExp(`^${key}:\\s*"?([^"\\n]+)"?\\s*$`, "m"));
  return match ? match[1] : null;
}

function touchSessionNote(file, input, event) {
  const text = readFileSync(file, "utf8");
  if (!text.startsWith("---\n")) return;
  const end = text.indexOf("\n---", 4);
  if (end === -1) return;
  const now = nowIso();
  let frontmatter = text.slice(4, end);
  const body = text.slice(end);
  const id = String(sessionId(input));
  const title = basename(file, ".md").replace(/^\d{2}-\d{2}-\d{2} - /, "");
  frontmatter = setFrontmatterValue(frontmatter, "title", jsonScalar(title));
  frontmatter = ensureFrontmatterValue(frontmatter, "type", "chat-session");
  frontmatter = ensureFrontmatterValue(frontmatter, "status", "active");
  frontmatter = ensureFrontmatterValue(frontmatter, "session_id", jsonScalar(id));
  frontmatter = ensureFrontmatterValue(frontmatter, "project", jsonScalar("PolymarketBTC15mAssistant"));
  frontmatter = ensureFrontmatterValue(frontmatter, "project_dir", jsonScalar(projectDir(input)));
  frontmatter = ensureFrontmatterValue(frontmatter, "source", jsonScalar(input.source || "startup"));
  frontmatter = setFrontmatterValue(frontmatter, "updated", jsonScalar(now));
  if (event === "Stop") {
    frontmatter = setFrontmatterValue(frontmatter, "status", "ended");
    frontmatter = setFrontmatterValue(frontmatter, "ended", jsonScalar(now));
  } else {
    frontmatter = setFrontmatterValue(frontmatter, "status", "active");
    frontmatter = removeFrontmatterValue(frontmatter, "ended");
  }
  writeFileSync(file, `---\n${frontmatter}${body}`, "utf8");
}

function ensureFrontmatterValue(frontmatter, key, value) {
  const pattern = new RegExp(`^${key}:`, "m");
  if (pattern.test(frontmatter)) return frontmatter;
  return `${frontmatter.trimEnd()}\n${key}: ${value}\n`;
}

function setFrontmatterValue(frontmatter, key, value) {
  const line = `${key}: ${value}`;
  const pattern = new RegExp(`^${key}:.*$`, "m");
  if (pattern.test(frontmatter)) {
    return frontmatter.replace(pattern, line);
  }
  return `${frontmatter.trimEnd()}\n${line}\n`;
}

function removeFrontmatterValue(frontmatter, key) {
  return frontmatter.replace(new RegExp(`^${key}:.*\\n?`, "m"), "");
}

function appendEvent(input, event) {
  if (event === "Stop" && !findSessionFile(sessionId(input))) {
    return;
  }
  const file = ensureSessionNote(input, event);
  if (event === "SessionStart") {
    appendFileSync(file, `- Fonte: ${input.source || "startup"}\n- Projeto: ${projectDir(input)}\n`);
    return;
  }
  if (event === "UserPromptSubmit") {
    const prompt = userPrompt(input);
    appendFileSync(file, prompt ? `#### User Prompt\n\n${prompt}\n` : "- User prompt recebido sem campo textual no payload do hook.\n");
    return;
  }
  if (event === "Stop") {
    appendFileSync(file, "- Sessao encerrada pelo hook Stop.\n");
    return;
  }
  appendFileSync(file, "```json\n" + JSON.stringify(input, null, 2) + "\n```\n");
}

function main() {
  const raw = readStdin();
  const input = parseInput(raw);
  const event = eventName(input);
  ensureVault();
  appendEvent(input, event);
  if (event === "Stop") {
    process.stdout.write("{}");
    return;
  }
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event } }));
}

main();
