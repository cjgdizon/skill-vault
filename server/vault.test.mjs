import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  findAgent,
  findSkill,
  loadConfig,
  parseFrontmatter,
  resolveSafeSkillFile,
  saveConfig,
  scanVault,
  searchSkills,
  setVaultPolicy,
} from "./vault.mjs";

const SERVER_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.mjs");

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function makeFixtureEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-vault-test-"));
  const vaultDir = path.join(root, "vault");
  const pluginsDir = path.join(root, "plugins");
  const globalSkillsDir = path.join(root, "skills");
  const customDir = path.join(vaultDir, "custom");

  fs.mkdirSync(vaultDir, { recursive: true });
  fs.mkdirSync(pluginsDir, { recursive: true });
  fs.mkdirSync(globalSkillsDir, { recursive: true });
  fs.mkdirSync(customDir, { recursive: true });

  saveConfig(vaultDir, {
    vaultedPlugins: ["pstack"],
    exemptPlugins: ["ponytail", "skill-vault", "vercel-plugin"],
    customDirs: [customDir],
  });

  // Vaulted plugin: pstack
  writeFile(
    path.join(pluginsDir, "pstack", "skills", "poteto-mode", "SKILL.md"),
    `---
name: poteto-mode
description: poteto's agent style for concise responses, deliberate subagents, and verified work.
tags: [workflow, style]
---

# Poteto Mode
Use playbooks/bug-fix.md when debugging.
`
  );
  writeFile(
    path.join(pluginsDir, "pstack", "skills", "poteto-mode", "playbooks", "bug-fix.md"),
    "# Bug Fix Playbook\nReproduce before patching.\n"
  );
  writeFile(
    path.join(pluginsDir, "pstack", "skills", "poteto-mode", "references", "agy-tools.md"),
    "# Antigravity Tools\nMap Agent to invoke_subagent.\n"
  );
  writeFile(
    path.join(pluginsDir, "pstack", "skills", "principle-fix-root-causes", "SKILL.md"),
    `---
name: principle-fix-root-causes
description: "Apply when debugging. Trace each symptom back to the first place the system went wrong."
user-invocable: false
---

# Fix Root Causes
Fix the root cause, not the symptom.
`
  );
  writeFile(
    path.join(pluginsDir, "pstack", "skills", "architect", "SKILL.md"),
    `---
name: architect
description: >-
  Sketch types, signatures, and module structure before writing code,
  then stay in the loop while implementation fills in.
tags:
  - design
  - architecture
---

# Architect
`
  );
  writeFile(
    path.join(pluginsDir, "pstack", "agents", "comment-sicko.md"),
    `---
name: comment-sicko
description: A comment reviewer that removes narration and workaround comments.
---

# Comment Sicko
Delete redundant comments.
`
  );

  // Exempt plugins (must never be indexed or marked pending)
  writeFile(
    path.join(pluginsDir, "ponytail", "skills", "ponytail", "SKILL.md"),
    "---\nname: ponytail\ndescription: Lazy senior dev mode.\n---\n"
  );
  writeFile(
    path.join(pluginsDir, "vercel-plugin", "skills", "ai-sdk", "SKILL.md"),
    "---\nname: ai-sdk\ndescription: Vercel AI SDK.\n---\n"
  );
  writeFile(
    path.join(pluginsDir, "skill-vault", "plugin.json"),
    '{"name":"skill-vault"}\n'
  );

  // Newly installed plugin (should be pending until approved)
  writeFile(
    path.join(pluginsDir, "new-plugin", "skills", "secret-tool", "SKILL.md"),
    "---\nname: secret-tool\ndescription: Newly installed plugin skill.\n---\n"
  );
  writeFile(
    path.join(pluginsDir, "new-plugin", "agents", "helper.md"),
    "---\nname: helper\ndescription: Helper agent.\n---\n"
  );
  writeFile(path.join(pluginsDir, "new-plugin", "mcp_config.json"), '{"mcpServers":{}}\n');
  writeFile(path.join(pluginsDir, "new-plugin", "hooks.json"), '{"hooks":{}}\n');

  // Newly installed standalone global skill (should be pending until approved)
  writeFile(
    path.join(globalSkillsDir, "standalone-helper", "SKILL.md"),
    "---\nname: standalone-helper\ndescription: Standalone global skill.\n---\n"
  );

  // Custom skills: both flat (<dir>/<skill>/SKILL.md) and nested (<dir>/<pack>/<skill>/SKILL.md)
  writeFile(
    path.join(customDir, "my-deploy", "SKILL.md"),
    "---\nname: my-deploy\ndescription: Personal deployment checklist.\n---\n# Deploy\n"
  );
  writeFile(
    path.join(customDir, "team-pack", "sql-review", "SKILL.md"),
    "---\nname: sql-review\ndescription: Database query performance and index review.\n---\n# SQL Review\n"
  );

  // Outside file used for traversal checks
  writeFile(path.join(root, "escape.txt"), "TOP SECRET OUTSIDE VAULT\n");

  return {
    root,
    vaultDir,
    pluginsDir,
    globalSkillsDir,
    customDir,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test("parseFrontmatter handles folded (>-, |), quoted strings, user-invocable: false, and tags", () => {
  const folded = parseFrontmatter(`---
name: "architect"
description: >-
  Sketch types, signatures, and module structure
  before jumping into code.

  Stay in the loop while filling in details.
user-invocable: false
tags: [design, "types", 'review']
---

# Body
`);
  assert.equal(folded.name, "architect");
  assert.equal(
    folded.description,
    "Sketch types, signatures, and module structure before jumping into code.\nStay in the loop while filling in details."
  );
  assert.equal(folded.userInvocable, false);
  assert.deepEqual(folded.tags, ["design", "types", "review"]);

  const literal = parseFrontmatter(`---
name: 'literal-skill'
description: |
  Line one
  Line two
tags:
  - alpha
  - "beta"
---
`);
  assert.equal(literal.name, "literal-skill");
  assert.equal(literal.description, "Line one\nLine two");
  assert.equal(literal.userInvocable, true);
  assert.deepEqual(literal.tags, ["alpha", "beta"]);
});

test("searchSkills ranks exact poteto-mode #1, matches natural queries, includes principle-*, respects pack and limit", () => {
  const env = makeFixtureEnv();
  try {
    const snap = scanVault({
      vaultDir: env.vaultDir,
      pluginsDir: env.pluginsDir,
      globalSkillsDir: env.globalSkillsDir,
    });

    const exact = searchSkills(snap, { query: "poteto-mode" });
    assert.ok(exact.length >= 1);
    assert.equal(exact[0].id, "pstack/poteto-mode");
    assert.equal(exact[0].siblingCount, 2);

    const spaced = searchSkills(snap, { query: "poteto mode" });
    assert.equal(spaced[0].id, "pstack/poteto-mode");

    const naturalDebug = searchSkills(snap, { query: "debugging trace symptom root cause" });
    assert.equal(naturalDebug[0].id, "pstack/principle-fix-root-causes");

    const filteredPack = searchSkills(snap, { query: "review", pack: "team-pack" });
    assert.equal(filteredPack.length, 1);
    assert.equal(filteredPack[0].id, "team-pack/sql-review");

    const limited = searchSkills(snap, { query: "review structure debugging", limit: 1 });
    assert.equal(limited.length, 1);
  } finally {
    env.cleanup();
  }
});

test("policy boundaries: exempt plugins skipped, new items stay pending until approved via setVaultPolicy", () => {
  const env = makeFixtureEnv();
  try {
    const opts = {
      vaultDir: env.vaultDir,
      pluginsDir: env.pluginsDir,
      globalSkillsDir: env.globalSkillsDir,
    };

    const initial = scanVault(opts);

    // Exempt plugins are never indexed and never pending
    assert.equal(findSkill(initial, { name: "ponytail" }).ok, false);
    assert.equal(findSkill(initial, { name: "ai-sdk" }).ok, false);
    assert.equal(
      initial.pending.some((p) => ["ponytail", "vercel-plugin", "skill-vault"].includes(p.name)),
      false
    );

    // New plugin and standalone skill are pending and NOT searchable/loadable
    const pendingPlugin = initial.pending.find((p) => p.name === "new-plugin");
    assert.ok(pendingPlugin);
    assert.equal(pendingPlugin.kind, "plugin");
    assert.equal(pendingPlugin.skillCount, 1);
    assert.equal(pendingPlugin.agentCount, 1);
    assert.equal(pendingPlugin.hasMcp, true);
    assert.equal(pendingPlugin.hasHooks, true);

    const pendingSkill = initial.pending.find((p) => p.name === "standalone-helper");
    assert.ok(pendingSkill);
    assert.equal(pendingSkill.kind, "skill");
    assert.equal(pendingSkill.skillCount, 1);

    assert.equal(searchSkills(initial, { query: "secret-tool" }).length, 0);
    assert.equal(findSkill(initial, { name: "secret-tool" }).ok, false);
    assert.equal(findSkill(initial, { name: "standalone-helper" }).ok, false);

    // Self-plugin cannot be vaulted
    assert.throws(() => setVaultPolicy({ vaultDir: env.vaultDir, name: "skill-vault", policy: "vault" }));

    // Approve new-plugin -> vault
    setVaultPolicy({ vaultDir: env.vaultDir, name: "new-plugin", policy: "vault" });
    // Approve standalone-helper -> exempt
    setVaultPolicy({ vaultDir: env.vaultDir, name: "standalone-helper", policy: "exempt" });

    const after = scanVault(opts);
    assert.equal(after.pending.length, 0);
    assert.equal(findSkill(after, { name: "secret-tool" }).ok, true);
    assert.equal(findAgent(after, { name: "helper" }).ok, true);
    assert.equal(findSkill(after, { name: "standalone-helper" }).ok, false);

    // Verify config persisted atomically
    const persisted = loadConfig(env.vaultDir);
    assert.ok(persisted.vaultedPlugins.includes("new-plugin"));
    assert.ok(persisted.exemptPlugins.includes("standalone-helper"));
  } finally {
    env.cleanup();
  }
});

test("resolveSafeSkillFile blocks traversal, absolute paths, and missing files while allowing valid siblings", () => {
  const env = makeFixtureEnv();
  try {
    const skillDir = path.join(env.pluginsDir, "pstack", "skills", "poteto-mode");

    const ok = resolveSafeSkillFile(skillDir, "playbooks/bug-fix.md");
    assert.equal(ok.ok, true);
    assert.equal(ok.relativePath, "playbooks/bug-fix.md");

    for (const badPath of [
      "../escape.txt",
      "..\\escape.txt",
      "../../../../escape.txt",
      path.join(env.root, "escape.txt"),
      "/etc/passwd",
      "C:\\Windows\\win.ini",
      "playbooks/bug-fix.md\0.txt",
      "playbooks/does-not-exist.md",
      "",
    ]) {
      const res = resolveSafeSkillFile(skillDir, badPath);
      assert.equal(res.ok, false, `Expected "${badPath}" to be rejected`);
    }
  } finally {
    env.cleanup();
  }
});

test("custom skill directories and subagent resolution (including ambiguity handling)", () => {
  const env = makeFixtureEnv();
  try {
    const snap = scanVault({
      vaultDir: env.vaultDir,
      pluginsDir: env.pluginsDir,
      globalSkillsDir: env.globalSkillsDir,
    });

    const flat = findSkill(snap, { name: "my-deploy" });
    assert.equal(flat.ok, true);
    assert.equal(flat.skill.pack, "custom");

    const nested = findSkill(snap, { name: "sql-review" });
    assert.equal(nested.ok, true);
    assert.equal(nested.skill.pack, "team-pack");

    const agent = findAgent(snap, { name: "comment-sicko" });
    assert.equal(agent.ok, true);
    assert.equal(agent.agent.id, "pstack/comment-sicko");

    // Duplicate skill name across packs requires pack disambiguation
    writeFile(
      path.join(env.customDir, "architect", "SKILL.md"),
      "---\nname: architect\ndescription: Custom architect skill.\n---\n"
    );
    const snapWithDup = scanVault({
      vaultDir: env.vaultDir,
      pluginsDir: env.pluginsDir,
      globalSkillsDir: env.globalSkillsDir,
    });
    const ambiguous = findSkill(snapWithDup, { name: "architect" });
    assert.equal(ambiguous.ok, false);
    assert.match(ambiguous.error, /Ambiguous/i);

    const disambiguated = findSkill(snapWithDup, { name: "architect", pack: "custom" });
    assert.equal(disambiguated.ok, true);
    assert.equal(disambiguated.skill.id, "custom/architect");
  } finally {
    env.cleanup();
  }
});

test("end-to-end MCP stdio server handles lifecycle and all 6 tools", async () => {
  const env = makeFixtureEnv();
  const child = spawn(process.execPath, [SERVER_PATH], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      SKILL_VAULT_DIR: env.vaultDir,
      AGY_PLUGINS_DIR: env.pluginsDir,
      AGY_SKILLS_DIR: env.globalSkillsDir,
    },
  });

  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  const pendingResponses = new Map();
  let stderrOutput = "";
  child.stderr.on("data", (chunk) => {
    stderrOutput += chunk.toString("utf8");
  });

  rl.on("line", (line) => {
    const msg = JSON.parse(line);
    const resolver = pendingResponses.get(msg.id);
    if (resolver) {
      pendingResponses.delete(msg.id);
      resolver(msg);
    }
  });

  let nextId = 1;
  function rpc(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${method} (id=${id})`)), 5000);
      pendingResponses.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  function notify(method, params) {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  function parseToolPayload(resp) {
    assert.equal(resp.error, undefined, `Unexpected JSON-RPC error: ${JSON.stringify(resp.error)}`);
    assert.equal(resp.result.isError, undefined, `Unexpected tool error: ${JSON.stringify(resp.result)}`);
    return JSON.parse(resp.result.content[0].text);
  }

  try {
    // 1. initialize + notifications/initialized + ping
    const init = await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {} });
    assert.equal(init.result.protocolVersion, "2025-03-26");
    assert.equal(init.result.serverInfo.name, "skill-vault");
    notify("notifications/initialized", {});
    const ping = await rpc("ping", {});
    assert.deepEqual(ping.result, {});

    // 2. tools/list
    const listed = await rpc("tools/list", {});
    const toolNames = listed.result.tools.map((t) => t.name);
    assert.deepEqual(toolNames, [
      "list_packs",
      "search_skills",
      "load_skill",
      "load_skill_file",
      "load_agent",
      "set_vault_policy",
    ]);

    // 3. list_packs
    const packs = parseToolPayload(await rpc("tools/call", { name: "list_packs", arguments: {} }));
    assert.ok(packs.packs.some((p) => p.pack === "pstack" && p.skillCount === 3 && p.agentCount === 1));
    assert.ok(packs.exemptPlugins.includes("ponytail"));
    assert.ok(packs.exemptPlugins.includes("vercel-plugin"));
    assert.ok(packs.pendingApproval.some((p) => p.name === "new-plugin"));
    assert.ok(packs.reminder);

    // 4. search_skills
    const search = parseToolPayload(
      await rpc("tools/call", { name: "search_skills", arguments: { query: "poteto mode", limit: 3 } })
    );
    assert.equal(search.results[0].id, "pstack/poteto-mode");
    assert.ok(search.pendingApproval.includes("new-plugin"));

    // 5. load_skill
    const skill = parseToolPayload(
      await rpc("tools/call", { name: "load_skill", arguments: { name: "poteto-mode" } })
    );
    assert.equal(skill.id, "pstack/poteto-mode");
    assert.deepEqual(skill.siblingFiles, ["playbooks/bug-fix.md", "references/agy-tools.md"]);
    assert.match(skill.content, /# Poteto Mode/);

    // 6. load_skill_file (valid + traversal rejection)
    const sibling = parseToolPayload(
      await rpc("tools/call", {
        name: "load_skill_file",
        arguments: { name: "poteto-mode", file: "playbooks/bug-fix.md" },
      })
    );
    assert.match(sibling.content, /Reproduce before patching/);

    const traversal = await rpc("tools/call", {
      name: "load_skill_file",
      arguments: { name: "poteto-mode", file: "../../../../escape.txt" },
    });
    assert.equal(traversal.result.isError, true);
    assert.match(traversal.result.content[0].text, /traversal|escapes/i);

    // 7. load_agent
    const agent = parseToolPayload(
      await rpc("tools/call", { name: "load_agent", arguments: { name: "comment-sicko" } })
    );
    assert.equal(agent.id, "pstack/comment-sicko");
    assert.match(agent.content, /Delete redundant comments/);

    // 8. set_vault_policy -> immediately reflected in subsequent scan
    const policy = parseToolPayload(
      await rpc("tools/call", {
        name: "set_vault_policy",
        arguments: { name: "new-plugin", policy: "vault" },
      })
    );
    assert.ok(policy.config.vaultedPlugins.includes("new-plugin"));

    const afterSearch = parseToolPayload(
      await rpc("tools/call", { name: "search_skills", arguments: { query: "secret-tool" } })
    );
    assert.equal(afterSearch.results[0].id, "new-plugin/secret-tool");

    assert.equal(stderrOutput, "", `Expected empty stderr, got: ${stderrOutput}`);
  } finally {
    rl.close();
    child.stdin.end();
    child.kill();
    env.cleanup();
  }
});
