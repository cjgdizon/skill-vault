import fs from "node:fs";
import readline from "node:readline";
import {
  findAgent,
  findSkill,
  resolveSafeSkillFile,
  scanVault,
  searchSkills,
  setVaultPolicy,
} from "./vault.mjs";

const SERVER_INFO = {
  name: "skill-vault",
  version: "1.0.0",
};

const TOOLS = [
  {
    name: "list_packs",
    description:
      "List vaulted packs (skill and agent counts), exempt plugins, and newly discovered items awaiting user approval.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "search_skills",
    description:
      "Search vaulted skills offline with BM25 ranking (includes non-user-invocable leaf skills such as principle-*).",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Task or skill keywords to search for." },
        pack: { type: "string", description: "Optional pack name filter." },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 15,
          default: 5,
          description: "Maximum results to return (1-15, default 5).",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "load_skill",
    description: "Load a vaulted skill's full SKILL.md along with its directory path and relative sibling file list.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Skill name or pack/name id." },
        pack: { type: "string", description: "Optional pack name to disambiguate." },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "load_skill_file",
    description: "Read one sibling file (playbook, reference, script) from a vaulted skill directory.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Skill name or pack/name id." },
        file: { type: "string", description: "Relative file path inside the skill folder." },
        pack: { type: "string", description: "Optional pack name to disambiguate." },
      },
      required: ["name", "file"],
      additionalProperties: false,
    },
  },
  {
    name: "load_agent",
    description: "Load a vaulted plugin subagent's prompt markdown so it can be registered with define_subagent.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Agent name or pack/name id." },
        pack: { type: "string", description: "Optional pack name to disambiguate." },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "set_vault_policy",
    description:
      "Record a user-approved vault policy ('vault' or 'exempt') in ~/.skill-vault/config.json. Never call without explicit user approval.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Plugin or standalone skill directory name." },
        policy: {
          type: "string",
          enum: ["vault", "exempt"],
          description: "Approved policy: 'vault' to index on demand or 'exempt' to keep outside the vault.",
        },
      },
      required: ["name", "policy"],
      additionalProperties: false,
    },
  },
];

function getScanOptions() {
  return {
    vaultDir: process.env.SKILL_VAULT_DIR || undefined,
    pluginsDir: process.env.AGY_PLUGINS_DIR || undefined,
    globalSkillsDir: process.env.AGY_SKILLS_DIR || undefined,
  };
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendResult(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function toolOk(payload) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

function toolErr(message) {
  return {
    isError: true,
    content: [{ type: "text", text: message }],
  };
}

function requireStringArg(args, key) {
  if (!args || typeof args[key] !== "string" || !args[key].trim()) {
    throw { code: -32602, message: `Invalid params: "${key}" must be a non-empty string.` };
  }
  return args[key];
}

function optionalStringArg(args, key) {
  if (args?.[key] === undefined) return undefined;
  if (typeof args[key] !== "string") {
    throw { code: -32602, message: `Invalid params: "${key}" must be a string.` };
  }
  return args[key].trim() || undefined;
}

function handleToolCall(toolName, args = {}) {
  if (args !== null && typeof args !== "object") {
    throw { code: -32602, message: "Invalid params: arguments must be an object." };
  }

  const scanOptions = getScanOptions();

  switch (toolName) {
    case "list_packs": {
      const snapshot = scanVault(scanOptions);
      const payload = {
        packs: snapshot.packs,
        exemptPlugins: snapshot.config.exemptPlugins,
        pendingApproval: snapshot.pending,
      };
      if (snapshot.pending.length > 0) {
        payload.reminder =
          "Items in pendingApproval are NOT indexed. Warn the user of risks and wait for explicit approval before calling set_vault_policy.";
      }
      return toolOk(payload);
    }

    case "search_skills": {
      const query = requireStringArg(args, "query");
      const pack = optionalStringArg(args, "pack");
      let limit = 5;
      if (args.limit !== undefined) {
        if (!Number.isInteger(args.limit)) {
          throw { code: -32602, message: 'Invalid params: "limit" must be an integer.' };
        }
        limit = args.limit;
      }
      const snapshot = scanVault(scanOptions);
      const results = searchSkills(snapshot, { query, pack, limit });
      const payload = { query, results };
      if (snapshot.pending.length > 0) {
        payload.pendingApproval = snapshot.pending.map((item) => item.name);
      }
      return toolOk(payload);
    }

    case "load_skill": {
      const name = requireStringArg(args, "name");
      const pack = optionalStringArg(args, "pack");
      const snapshot = scanVault(scanOptions);
      const found = findSkill(snapshot, { name, pack });
      if (!found.ok) return toolErr(found.error);
      const { skill } = found;
      const content = fs.readFileSync(skill.skillFilePath, "utf8");
      return toolOk({
        id: skill.id,
        name: skill.name,
        pack: skill.pack,
        dirPath: skill.dirPath,
        siblingFiles: skill.siblingFiles,
        content,
      });
    }

    case "load_skill_file": {
      const name = requireStringArg(args, "name");
      const file = requireStringArg(args, "file");
      const pack = optionalStringArg(args, "pack");
      const snapshot = scanVault(scanOptions);
      const found = findSkill(snapshot, { name, pack });
      if (!found.ok) return toolErr(found.error);
      const resolved = resolveSafeSkillFile(found.skill.dirPath, file);
      if (!resolved.ok) return toolErr(resolved.error);
      const content = fs.readFileSync(resolved.filePath, "utf8");
      return toolOk({
        skill: found.skill.id,
        file: resolved.relativePath,
        filePath: resolved.filePath,
        content,
      });
    }

    case "load_agent": {
      const name = requireStringArg(args, "name");
      const pack = optionalStringArg(args, "pack");
      const snapshot = scanVault(scanOptions);
      const found = findAgent(snapshot, { name, pack });
      if (!found.ok) return toolErr(found.error);
      const { agent } = found;
      const content = fs.readFileSync(agent.filePath, "utf8");
      return toolOk({
        id: agent.id,
        name: agent.name,
        pack: agent.pack,
        filePath: agent.filePath,
        content,
      });
    }

    case "set_vault_policy": {
      const name = requireStringArg(args, "name");
      const policy = requireStringArg(args, "policy");
      if (policy !== "vault" && policy !== "exempt") {
        throw { code: -32602, message: 'Invalid params: "policy" must be "vault" or "exempt".' };
      }
      try {
        const config = setVaultPolicy({
          vaultDir: scanOptions.vaultDir,
          name,
          policy,
        });
        return toolOk({ name: name.trim(), policy, config });
      } catch (err) {
        return toolErr(err.message);
      }
    }

    default:
      throw { code: -32602, message: `Unknown tool: ${toolName}` };
  }
}

function handleMessage(msg) {
  if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    if (msg && msg.id !== undefined) {
      sendError(msg.id, -32600, "Invalid Request");
    }
    return;
  }

  const isNotification = msg.id === undefined;

  if (msg.method === "notifications/initialized" || msg.method.startsWith("notifications/")) {
    return;
  }

  try {
    switch (msg.method) {
      case "initialize": {
        const protocolVersion =
          typeof msg.params?.protocolVersion === "string" ? msg.params.protocolVersion : "2024-11-05";
        sendResult(msg.id, {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        });
        return;
      }

      case "ping": {
        sendResult(msg.id, {});
        return;
      }

      case "tools/list": {
        sendResult(msg.id, { tools: TOOLS });
        return;
      }

      case "tools/call": {
        const toolName = msg.params?.name;
        if (typeof toolName !== "string" || !toolName) {
          sendError(msg.id, -32602, 'Invalid params: "name" must be a non-empty string.');
          return;
        }
        const result = handleToolCall(toolName, msg.params?.arguments ?? {});
        sendResult(msg.id, result);
        return;
      }

      default: {
        if (!isNotification) {
          sendError(msg.id, -32601, `Method not found: ${msg.method}`);
        }
      }
    }
  } catch (err) {
    if (isNotification) return;
    if (err && typeof err.code === "number" && typeof err.message === "string") {
      sendError(msg.id, err.code, err.message);
      return;
    }
    process.stderr.write(`skill-vault internal error: ${err?.stack || err}\n`);
    sendError(msg.id, -32603, err?.message || "Internal error");
  }
}

const rl = readline.createInterface({
  input: process.stdin,
  terminal: false,
  crlfDelay: Infinity,
});

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    sendError(null, -32700, "Parse error");
    return;
  }
  handleMessage(parsed);
});
