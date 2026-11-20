# SkillVault Rules

Use the `skill-vault` MCP server to load vaulted skills on demand instead of keeping whole plugin packs in session context.

## Searching and Loading Skills

- On coding, debugging, architecture, review, deployment, or workflow tasks, run one `search_skills` call and load only the 1 to 3 matching skills with `load_skill`. Skip this for simple Q&A or casual chat.
- Always honor explicit skill requests (such as `poteto mode`, `thermos`, or `architect`) by calling `load_skill`.
- Never bulk-load an entire pack.

## Chained Hub Loading

- When a loaded hub skill (such as `poteto-mode`) references sibling files (`playbooks/...`, `references/...`, `scripts/...`), leaf skills (`principle-*`), or plugin subagents (`comment-sicko`, `thermo-nuclear-review-subagent`), load only the exact items needed for the active step via `load_skill_file`, `load_skill`, or `load_agent`.
- Register a loaded subagent prompt with `define_subagent` when you need to invoke it.

## Mandatory New-Installation Approval Rule

This rule applies to every future skill, plugin, or MCP server installation except `vercel-plugin`.

- Whenever a new skill, plugin, or MCP server is installed, or when `list_packs` or `search_skills` reports items under `pendingApproval`, never add it to the Skill Vault automatically and never call `set_vault_policy` without user approval.
- Warn the user first with a **Risks to Keep in Mind** section covering:
  - Storage usage
  - Duplicate files
  - Security concerns
  - Compatibility issues (such as bundled MCP servers, hooks, or relative file paths)
- After explaining the risks, present these exact two options and wait for the user's choice before making any changes:
  1. **Exempt from Skill Vault** – Keep the newly installed skill, plugin, or MCP server in its original installation directory without copying it to the Skill Vault.
  2. **Keep in Skill Vault** – Add it to the Skill Vault for centralized management.
- Call `set_vault_policy` only after the user picks an option. Note that `vercel-plugin` is exempt from this rule.
