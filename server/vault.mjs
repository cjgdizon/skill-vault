import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const SELF_PLUGIN = "skill-organizer";
export const DEFAULT_VAULT_DIR = path.join(os.homedir(), ".skill-vault");
export const DEFAULT_PLUGINS_DIR = path.join(os.homedir(), ".gemini", "config", "plugins");
export const DEFAULT_GLOBAL_SKILLS_DIR = path.join(os.homedir(), ".gemini", "config", "skills");

export const DEFAULT_CONFIG = Object.freeze({
  vaultedPlugins: ["pstack"],
  exemptPlugins: ["ponytail", SELF_PLUGIN, "vercel-plugin"],
  customDirs: ["~/.skill-vault/custom"],
});

const IGNORED_DIRS = new Set([".git", "node_modules"]);

export function expandHome(inputPath) {
  if (typeof inputPath !== "string") return "";
  if (inputPath === "~") return os.homedir();
  if (inputPath.startsWith("~/") || inputPath.startsWith("~\\")) {
    return path.join(os.homedir(), inputPath.slice(2));
  }
  return inputPath;
}

function uniqueStrings(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function normalizeConfig(raw) {
  const vaulted = uniqueStrings(raw?.vaultedPlugins).filter((n) => n !== SELF_PLUGIN);
  const exempt = uniqueStrings(raw?.exemptPlugins);
  if (!exempt.includes(SELF_PLUGIN)) exempt.push(SELF_PLUGIN);
  const exemptSet = new Set(exempt);
  const cleanVaulted = vaulted.filter((n) => !exemptSet.has(n));
  const customDirs = uniqueStrings(raw?.customDirs);
  return {
    vaultedPlugins: cleanVaulted,
    exemptPlugins: exempt,
    customDirs,
  };
}

export function loadConfig(vaultDir = DEFAULT_VAULT_DIR) {
  const configPath = path.join(vaultDir, "config.json");
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return {
        vaultedPlugins: [...DEFAULT_CONFIG.vaultedPlugins],
        exemptPlugins: [...DEFAULT_CONFIG.exemptPlugins],
        customDirs: [...DEFAULT_CONFIG.customDirs],
      };
    }
    throw new Error(`Failed to read vault config at ${configPath}: ${err.message}`);
  }
  return normalizeConfig({
    vaultedPlugins: Array.isArray(raw?.vaultedPlugins) ? raw.vaultedPlugins : DEFAULT_CONFIG.vaultedPlugins,
    exemptPlugins: Array.isArray(raw?.exemptPlugins) ? raw.exemptPlugins : DEFAULT_CONFIG.exemptPlugins,
    customDirs: Array.isArray(raw?.customDirs) ? raw.customDirs : DEFAULT_CONFIG.customDirs,
  });
}

export function saveConfig(vaultDir = DEFAULT_VAULT_DIR, config) {
  const normalized = normalizeConfig(config);
  fs.mkdirSync(vaultDir, { recursive: true });
  const targetPath = path.join(vaultDir, "config.json");
  const tmpName = `config.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  const tmpPath = path.join(vaultDir, tmpName);
  const payload = `${JSON.stringify(normalized, null, 2)}\n`;
  try {
    fs.writeFileSync(tmpPath, payload, "utf8");
    fs.renameSync(tmpPath, targetPath);
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // Best-effort cleanup of temp file.
    }
    throw err;
  }
  return normalized;
}

export function getPolicyState(config, name) {
  if (name === SELF_PLUGIN || config.exemptPlugins.includes(name)) return "exempt";
  if (config.vaultedPlugins.includes(name)) return "vault";
  return "pending";
}

export function setVaultPolicy({ vaultDir = DEFAULT_VAULT_DIR, name, policy }) {
  if (typeof name !== "string" || !name.trim()) {
    throw new Error("Policy name must be a non-empty string.");
  }
  const cleanName = name.trim();
  if (/[/\\\0]/.test(cleanName) || cleanName === "." || cleanName === ".." || cleanName.includes("..")) {
    throw new Error(`Invalid policy name "${cleanName}": must not contain path separators or traversal segments.`);
  }
  if (policy !== "vault" && policy !== "exempt") {
    throw new Error(`Invalid policy "${policy}": must be "vault" or "exempt".`);
  }
  if (cleanName === SELF_PLUGIN && policy === "vault") {
    throw new Error(`"${SELF_PLUGIN}" is always exempt and cannot be vaulted.`);
  }

  const current = loadConfig(vaultDir);
  const vaultedPlugins = current.vaultedPlugins.filter((n) => n !== cleanName);
  const exemptPlugins = current.exemptPlugins.filter((n) => n !== cleanName);

  if (policy === "vault") {
    vaultedPlugins.push(cleanName);
  } else {
    exemptPlugins.push(cleanName);
  }

  return saveConfig(vaultDir, {
    vaultedPlugins,
    exemptPlugins,
    customDirs: current.customDirs,
  });
}

function unquoteYamlScalar(raw) {
  const value = raw.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value
      .slice(1, -1)
      .replace(/\\(["\\ntr])/g, (_, ch) => {
        if (ch === "n") return "\n";
        if (ch === "t") return "\t";
        if (ch === "r") return "\r";
        return ch;
      });
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

function parseBlockScalar(lines, startIndex, style) {
  const isFolded = style.startsWith(">");
  const rawBlock = [];
  let idx = startIndex;

  while (idx < lines.length) {
    const line = lines[idx];
    if (line.trim() === "") {
      rawBlock.push("");
      idx++;
      continue;
    }
    const indent = line.match(/^[ \t]*/)[0].length;
    if (indent === 0) break;
    rawBlock.push(line);
    idx++;
  }

  let baseIndent = Infinity;
  for (const line of rawBlock) {
    if (line.trim() === "") continue;
    const indent = line.match(/^ */)[0].length;
    if (indent < baseIndent) baseIndent = indent;
  }
  if (!Number.isFinite(baseIndent)) baseIndent = 0;

  const stripped = rawBlock.map((line) => (line === "" ? "" : line.slice(Math.min(baseIndent, line.length))));

  while (stripped.length > 0 && stripped[stripped.length - 1] === "") {
    stripped.pop();
  }

  let text;
  if (!isFolded) {
    text = stripped.join("\n");
  } else {
    const parts = [];
    for (let i = 0; i < stripped.length; i++) {
      const line = stripped[i];
      if (line === "") {
        parts.push("\n");
        continue;
      }
      if (parts.length === 0 || parts[parts.length - 1] === "\n") {
        parts.push(line);
      } else {
        parts.push(" ", line);
      }
    }
    text = parts.join("");
  }

  return { value: text.trim(), nextIndex: idx };
}

function parseInlineList(raw) {
  const inner = raw.trim().slice(1, -1).trim();
  if (!inner) return [];
  const items = [];
  let current = "";
  let quote = null;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (quote) {
      if (ch === "\\" && quote === '"' && i + 1 < inner.length) {
        current += ch + inner[++i];
      } else if (ch === quote) {
        quote = null;
        current += ch;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
    } else if (ch === ",") {
      const parsed = unquoteYamlScalar(current);
      if (parsed) items.push(parsed);
      current = "";
    } else {
      current += ch;
    }
  }
  const tail = unquoteYamlScalar(current);
  if (tail) items.push(tail);
  return items;
}

export function parseFrontmatter(markdown) {
  const result = {
    name: "",
    description: "",
    userInvocable: true,
    tags: [],
  };
  if (typeof markdown !== "string") return result;

  const normalized = markdown.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return result;

  const closeIndex = normalized.indexOf("\n---", 4);
  if (closeIndex === -1) return result;

  const afterClose = normalized.slice(closeIndex + 4);
  if (afterClose.length > 0 && !afterClose.startsWith("\n")) return result;

  const lines = normalized.slice(4, closeIndex).split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) {
      i++;
      continue;
    }

    const match = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!match) {
      i++;
      continue;
    }

    const key = match[1];
    const rest = match[2].trim();
    i++;

    if (/^[>|][0-9]*[-+]?$/.test(rest)) {
      const { value, nextIndex } = parseBlockScalar(lines, i, rest);
      i = nextIndex;
      if (key === "description") result.description = value;
      else if (key === "name") result.name = value;
      continue;
    }

    if (key === "tags") {
      if (rest.startsWith("[") && rest.endsWith("]")) {
        result.tags = parseInlineList(rest);
      } else if (rest === "") {
        const items = [];
        while (i < lines.length) {
          const itemMatch = lines[i].match(/^[ \t]+-\s+(.*)$/);
          if (itemMatch) {
            const val = unquoteYamlScalar(itemMatch[1]);
            if (val) items.push(val);
            i++;
          } else if (lines[i].trim() === "") {
            i++;
          } else {
            break;
          }
        }
        result.tags = items;
      } else {
        const single = unquoteYamlScalar(rest);
        if (single) result.tags = [single];
      }
      continue;
    }

    // Consume indented continuations for non-block scalars so unknown keys never misparse.
    const continuations = [];
    while (i < lines.length && (/^[ \t]+/.test(lines[i]) || lines[i].trim() === "")) {
      if (lines[i].trim() !== "") continuations.push(lines[i].trim());
      i++;
    }

    if (key === "name") {
      result.name = unquoteYamlScalar(rest);
    } else if (key === "description") {
      const combined = continuations.length > 0 ? `${rest} ${continuations.join(" ")}`.trim() : rest;
      result.description = unquoteYamlScalar(combined);
    } else if (key === "user-invocable") {
      const val = unquoteYamlScalar(rest).toLowerCase();
      if (val === "false") result.userInvocable = false;
      else if (val === "true") result.userInvocable = true;
    }
  }

  return result;
}

function isDirectory(targetPath) {
  try {
    return fs.statSync(targetPath).isDirectory();
  } catch {
    return false;
  }
}

function isFile(targetPath) {
  try {
    return fs.statSync(targetPath).isFile();
  } catch {
    return false;
  }
}

function listDirSorted(dirPath) {
  try {
    return fs.readdirSync(dirPath).sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

export function collectSiblingFiles(skillDir) {
  const files = [];
  function walk(currentDir, prefix) {
    for (const entry of listDirSorted(currentDir)) {
      if (IGNORED_DIRS.has(entry)) continue;
      const fullPath = path.join(currentDir, entry);
      const rel = prefix ? `${prefix}/${entry}` : entry;
      let stat;
      try {
        stat = fs.lstatSync(fullPath);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        walk(fullPath, rel);
      } else if (stat.isFile()) {
        if (rel === "SKILL.md") continue;
        files.push(rel);
      }
    }
  }
  walk(skillDir, "");
  return files;
}

function readSkillRecord(skillDir, pack, fallbackName) {
  const skillFilePath = path.join(skillDir, "SKILL.md");
  if (!isFile(skillFilePath)) return null;
  const content = fs.readFileSync(skillFilePath, "utf8");
  const fm = parseFrontmatter(content);
  const name = fm.name || fallbackName;
  return {
    id: `${pack}/${name}`,
    name,
    pack,
    description: fm.description || "",
    userInvocable: fm.userInvocable,
    tags: fm.tags,
    dirPath: skillDir,
    skillFilePath,
    siblingFiles: collectSiblingFiles(skillDir),
  };
}

function readAgentRecord(filePath, pack) {
  if (!isFile(filePath)) return null;
  const content = fs.readFileSync(filePath, "utf8");
  const fm = parseFrontmatter(content);
  const fallbackName = path.basename(filePath, ".md");
  const name = fm.name || fallbackName;
  return {
    id: `${pack}/${name}`,
    name,
    pack,
    description: fm.description || "",
    filePath,
  };
}

function inspectPluginDir(dirPath) {
  const skillsRoot = path.join(dirPath, "skills");
  let skillCount = 0;
  if (isDirectory(skillsRoot)) {
    for (const entry of listDirSorted(skillsRoot)) {
      if (isFile(path.join(skillsRoot, entry, "SKILL.md"))) skillCount++;
    }
  }
  const agentsRoot = path.join(dirPath, "agents");
  let agentCount = 0;
  if (isDirectory(agentsRoot)) {
    for (const entry of listDirSorted(agentsRoot)) {
      if (entry.endsWith(".md") && isFile(path.join(agentsRoot, entry))) agentCount++;
    }
  }
  return {
    skillCount,
    agentCount,
    hasMcp: isFile(path.join(dirPath, "mcp_config.json")),
    hasHooks: isFile(path.join(dirPath, "hooks.json")),
  };
}

export function scanVault({
  pluginsDir = DEFAULT_PLUGINS_DIR,
  globalSkillsDir = DEFAULT_GLOBAL_SKILLS_DIR,
  vaultDir = DEFAULT_VAULT_DIR,
} = {}) {
  const config = loadConfig(vaultDir);
  const skills = [];
  const agents = [];
  const pending = [];
  const seenSkillIds = new Set();
  const seenAgentIds = new Set();
  const packCounts = new Map();

  function ensurePack(pack) {
    if (!packCounts.has(pack)) packCounts.set(pack, { pack, skillCount: 0, agentCount: 0 });
    return packCounts.get(pack);
  }

  function addSkill(record) {
    if (!record || seenSkillIds.has(record.id)) return;
    seenSkillIds.add(record.id);
    skills.push(record);
    ensurePack(record.pack).skillCount++;
  }

  function addAgent(record) {
    if (!record || seenAgentIds.has(record.id)) return;
    seenAgentIds.add(record.id);
    agents.push(record);
    ensurePack(record.pack).agentCount++;
  }

  // 1. Plugins directory
  if (isDirectory(pluginsDir)) {
    for (const entry of listDirSorted(pluginsDir)) {
      const pluginPath = path.join(pluginsDir, entry);
      if (!isDirectory(pluginPath)) continue;

      const policy = getPolicyState(config, entry);
      if (policy === "exempt") continue;

      if (policy === "vault") {
        ensurePack(entry);
        const skillsRoot = path.join(pluginPath, "skills");
        if (isDirectory(skillsRoot)) {
          for (const skillFolder of listDirSorted(skillsRoot)) {
            const skillDir = path.join(skillsRoot, skillFolder);
            if (!isDirectory(skillDir)) continue;
            addSkill(readSkillRecord(skillDir, entry, skillFolder));
          }
        }
        const agentsRoot = path.join(pluginPath, "agents");
        if (isDirectory(agentsRoot)) {
          for (const agentFile of listDirSorted(agentsRoot)) {
            if (!agentFile.endsWith(".md")) continue;
            addAgent(readAgentRecord(path.join(agentsRoot, agentFile), entry));
          }
        }
      } else {
        const meta = inspectPluginDir(pluginPath);
        pending.push({
          name: entry,
          kind: "plugin",
          path: pluginPath,
          ...meta,
        });
      }
    }
  }

  // 2. Global standalone skills directory
  if (isDirectory(globalSkillsDir)) {
    for (const entry of listDirSorted(globalSkillsDir)) {
      const skillDir = path.join(globalSkillsDir, entry);
      if (!isDirectory(skillDir) || !isFile(path.join(skillDir, "SKILL.md"))) continue;

      const policy = getPolicyState(config, entry);
      if (policy === "exempt") continue;

      if (policy === "vault") {
        addSkill(readSkillRecord(skillDir, "global-skills", entry));
      } else {
        pending.push({
          name: entry,
          kind: "skill",
          path: skillDir,
          skillCount: 1,
          agentCount: 0,
          hasMcp: false,
          hasHooks: false,
        });
      }
    }
  }

  // 3. Custom skill directories
  for (const rawDir of config.customDirs) {
    const customRoot = path.resolve(expandHome(rawDir));
    if (!isDirectory(customRoot)) continue;

    for (const entry of listDirSorted(customRoot)) {
      const entryPath = path.join(customRoot, entry);
      if (!isDirectory(entryPath)) continue;

      if (isFile(path.join(entryPath, "SKILL.md"))) {
        addSkill(readSkillRecord(entryPath, "custom", entry));
      } else {
        for (const subEntry of listDirSorted(entryPath)) {
          const nestedDir = path.join(entryPath, subEntry);
          if (!isDirectory(nestedDir)) continue;
          addSkill(readSkillRecord(nestedDir, entry, subEntry));
        }
      }
    }
  }

  const packs = Array.from(packCounts.values()).sort((a, b) => a.pack.localeCompare(b.pack));
  return { config, skills, agents, packs, pending };
}

function tokenize(text) {
  if (!text) return [];
  return String(text)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

export function searchSkills(snapshot, { query, pack, limit = 5 } = {}) {
  const rawQuery = typeof query === "string" ? query.trim().toLowerCase() : "";
  const queryTokens = tokenize(rawQuery);
  if (queryTokens.length === 0) return [];

  const normQuery = queryTokens.join(" ");
  const uniqueQueryTokens = Array.from(new Set(queryTokens));
  const maxResults = Math.max(1, Math.min(15, Number.isInteger(limit) ? limit : 5));

  const pool = pack ? snapshot.skills.filter((s) => s.pack === pack) : snapshot.skills;
  if (pool.length === 0) return [];

  const docs = pool.map((skill) => {
    const nameTokens = tokenize(skill.name);
    const tagTokens = tokenize(skill.tags.join(" "));
    const packTokens = tokenize(skill.pack);
    const descTokens = tokenize(skill.description);
    const terms = [
      ...nameTokens,
      ...nameTokens,
      ...nameTokens,
      ...tagTokens,
      ...tagTokens,
      ...packTokens,
      ...descTokens,
    ];
    const tf = new Map();
    for (const term of terms) tf.set(term, (tf.get(term) || 0) + 1);
    return {
      skill,
      tf,
      len: terms.length,
      rawName: skill.name.toLowerCase(),
      rawId: skill.id.toLowerCase(),
      normName: nameTokens.join(" "),
    };
  });

  const N = docs.length;
  const avgdl = docs.reduce((sum, d) => sum + d.len, 0) / N || 1;
  const df = new Map();
  for (const term of uniqueQueryTokens) {
    let count = 0;
    for (const doc of docs) {
      if (doc.tf.has(term)) count++;
    }
    df.set(term, count);
  }

  const k1 = 1.5;
  const b = 0.75;
  const scored = [];

  for (const doc of docs) {
    let score = 0;
    for (const term of uniqueQueryTokens) {
      const freq = doc.tf.get(term) || 0;
      if (freq === 0) continue;
      const docFreq = df.get(term) || 0;
      const idf = Math.log(1 + (N - docFreq + 0.5) / (docFreq + 0.5));
      score += idf * ((freq * (k1 + 1)) / (freq + k1 * (1 - b + b * (doc.len / avgdl))));
    }

    if (doc.rawName === rawQuery || doc.normName === normQuery || doc.rawId === rawQuery) {
      score += 100;
    } else if (doc.rawName.includes(rawQuery) || doc.normName.includes(normQuery)) {
      score += 25;
    }

    if (score > 0) scored.push({ skill: doc.skill, score });
  }

  scored.sort((a, b) => b.score - a.score || a.skill.id.localeCompare(b.skill.id));

  return scored.slice(0, maxResults).map(({ skill }) => ({
    id: skill.id,
    name: skill.name,
    pack: skill.pack,
    description: skill.description,
    siblingCount: skill.siblingFiles.length,
  }));
}

function findEntry(items, kindLabel, { name, pack }) {
  if (typeof name !== "string" || !name.trim()) {
    return { ok: false, error: `${kindLabel} name must be a non-empty string.` };
  }
  const target = name.trim();
  const pool = pack ? items.filter((item) => item.pack === pack) : items;

  const byId = pool.find((item) => item.id === target);
  if (byId) return { ok: true, item: byId };

  const matches = pool.filter((item) => item.name === target);
  if (matches.length === 1) return { ok: true, item: matches[0] };
  if (matches.length > 1) {
    const packList = matches.map((m) => m.pack).join(", ");
    return {
      ok: false,
      error: `Ambiguous ${kindLabel.toLowerCase()} "${target}" found in packs: ${packList}. Specify "pack".`,
    };
  }
  return {
    ok: false,
    error: `${kindLabel} "${target}" not found${pack ? ` in pack "${pack}"` : ""}.`,
  };
}

export function findSkill(snapshot, { name, pack } = {}) {
  const res = findEntry(snapshot.skills, "Skill", { name, pack });
  return res.ok ? { ok: true, skill: res.item } : res;
}

export function findAgent(snapshot, { name, pack } = {}) {
  const res = findEntry(snapshot.agents, "Agent", { name, pack });
  return res.ok ? { ok: true, agent: res.item } : res;
}

export function resolveSafeSkillFile(skillDir, relPath) {
  if (typeof relPath !== "string" || !relPath.trim()) {
    return { ok: false, error: "File path must be a non-empty string." };
  }
  if (relPath.includes("\0")) {
    return { ok: false, error: "Invalid file path: null byte is not allowed." };
  }
  const trimmed = relPath.trim();
  if (
    path.isAbsolute(trimmed) ||
    trimmed.startsWith("/") ||
    trimmed.startsWith("\\") ||
    /^[A-Za-z]:/.test(trimmed)
  ) {
    return { ok: false, error: `Invalid file path "${trimmed}": absolute paths are not allowed.` };
  }

  let rootReal;
  try {
    rootReal = fs.realpathSync(skillDir);
  } catch {
    return { ok: false, error: `Skill directory does not exist: ${skillDir}` };
  }

  const candidate = path.resolve(rootReal, trimmed);
  const initialRel = path.relative(rootReal, candidate);
  if (!initialRel || initialRel.startsWith("..") || path.isAbsolute(initialRel)) {
    return { ok: false, error: `Path traversal rejected: "${trimmed}" escapes the skill directory.` };
  }

  if (!fs.existsSync(candidate)) {
    return { ok: false, error: `File "${trimmed}" not found in skill directory.` };
  }

  const targetReal = fs.realpathSync(candidate);
  const realRel = path.relative(rootReal, targetReal);
  if (!realRel || realRel.startsWith("..") || path.isAbsolute(realRel)) {
    return { ok: false, error: `Path traversal rejected: "${trimmed}" resolves outside the skill directory.` };
  }

  if (!isFile(targetReal)) {
    return { ok: false, error: `Path "${trimmed}" is not a regular file.` };
  }

  return {
    ok: true,
    filePath: targetReal,
    relativePath: realRel.split(path.sep).join("/"),
  };
}
