# Security

## What SF Guardian can access

SF Guardian is a Claude Code mod that runs inside your Claude Code session, on your machine, with these capabilities (as `claude plugin validate` lists them):

| It… | For |
| --- | --- |
| Runs `sf` commands: `org list --skip-connection-status`, `config get`, `org list limits`, `plugins`, `--version`; and, only when you confirm, `project deploy start --dry-run` / `deploy report`; with `code_analyzer` on, `code-analyzer run` | Org detection, the band, `/sflimits`, `/sfdoctor`, validation |
| Runs `git rev-parse`, `git status`, `git show HEAD:<file>` | The Files sidebar |
| Runs your editor command | The `o` key, only when pressed |
| Reads files in your project | Diffs, coverage view, scripts the guard inspects |
| Writes files only when you ask: `/sfguard export`, `/sfdoctor record`; and `.sfdx/sf-guardian-analyzer.json` when Code Analyzer is on | |
| Stores in Claude Code's plugin store (a JSON file under your Claude configuration directory) | The audit log (500 entries, secrets removed), the org list cache (aliases, usernames, org type and API version, **never tokens**), the file list if `remember_files` is on (paths and counts only) |
| Sends a prompt to Claude | Only when you press "Ask Claude to fix" |

It makes **no network requests** of its own and sends nothing anywhere. `sf org list --skip-connection-status` does not contact your orgs.

Drafts shown by live typing stay in memory only and are cleared when the turn ends.

## What it protects, and what it does not

The guard is a safety net, not a security boundary. It sees what Claude runs through Bash, file tools and the known Salesforce MCP tools. It cannot see inside a program it cannot read (a compiled tool, a script outside the project, a tool it does not know). Use org-side controls (profiles, permission sets, deployment settings, sandboxes) as the real protection.

Secrets: `sf org auth show-*` commands are refused by default; reading `~/.sf` and `~/.sfdx` asks first; Salesforce session ids and sfdx auth URLs are removed from shell output. Patterns are best effort.

## Reporting a problem

Please report security problems privately, not in a public issue: use GitHub's **Report a vulnerability** on the repository (Security tab → Advisories), or contact the maintainer listed in `plugin.json`. Include the SF Guardian version, `/sfdoctor` output, and the smallest command that shows the problem (`/sfguard test <command>` is a safe way to reproduce a guard decision without running anything).

A case where the guard stays silent when it should have asked is treated as a security bug.
