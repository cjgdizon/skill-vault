# Skill Organizer

Global Antigravity plugin that indexes vaulted plugins and custom skills on demand through a zero-dependency Node.js stdio MCP server (`skill-organizer-vault`).

## How It Works

- Vault policy lives in `~/.skill-vault/config.json` (`vaultedPlugins`, `exemptPlugins`, `customDirs`).
- Vaulted plugins (such as `pstack`) are read in place from `~/.gemini/config/plugins/<pack>/` without copying files.
- Exempt plugins (`ponytail`, `skill-organizer`, `vercel-plugin`) are never indexed or marked pending.
- Newly discovered plugins or standalone skills under `~/.gemini/config/skills/` appear under `pendingApproval` and stay unindexed until the user approves `vault` or `exempt`.

## MCP Tools

- `list_packs`: Lists vaulted packs, exempt plugins, and items awaiting approval.
- `search_skills`: Offline BM25 search across vaulted skills (including non-user-invocable leaf skills).
- `load_skill`: Returns a skill's full `SKILL.md` and relative sibling file paths.
- `load_skill_file`: Reads a single sibling file inside a skill directory with path-traversal protection.
- `load_agent`: Returns a vaulted plugin subagent's prompt markdown for `define_subagent`.
- `set_vault_policy`: Records a user-approved `vault` or `exempt` choice in `~/.skill-vault/config.json`.

## Custom Skills

Drop custom skills into `~/.skill-vault/custom/<skill>/SKILL.md` (pack `custom`) or `~/.skill-vault/custom/<pack>/<skill>/SKILL.md` (pack `<pack>`).

## Install

Clone into your Antigravity plugins directory and point `mcp_config.json` to your local `server/index.mjs` path:

```bash
git clone https://github.com/cjgdizon/skill-organizer.git ~/.gemini/config/plugins/skill-organizer
```

## Tests

```bash
node --test ~/.gemini/config/plugins/skill-organizer/server/vault.test.mjs
```
