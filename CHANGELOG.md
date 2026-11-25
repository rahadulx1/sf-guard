# Changelog

All notable changes to SF Guardian. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [Semantic Versioning](https://semver.org/) (patch for fixes, minor for features). Settings keys are never repurposed.

## [0.11.0] - 2026-11-25

### Added
- Backup before production deploys (`backup_before_deploy`, on): when you choose "Run as written" for a deploy to a production or unknown org, SF Guardian first retrieves what it will overwrite (same scope as the deploy) into `.sfdx/sf-guardian/backups/<time>-<org>`, in metadata format. `/sfguard backups` lists each backup with its restore command. A failed backup asks before deploying without one.
- Org changes not in git: after the backup, each retrieved Apex, Visualforce, LWC and Aura file is compared with your files and their git history. Files changed in the org that git never had (a hotfix made in the org) are listed and the deploy asks again before overwriting them.
- Permission checks: changed profiles and permission sets show their changes in plain words in the Files sidebar ("+ grants Modify All on Account"). Risky grants (Modify All Data, View All Data, Manage Users, Author Apex, Modify/View All records and others) are problems, and a deploy that includes them asks even on a sandbox.
- Team policy file `.sfguard.json` in the project root, shared through git. It can only tighten your settings: add production orgs, turn on block mode, backups, code checks, coding standards, script and MCP guards, the audit log, forbid secret commands, and set the name prefix. `/sfdoctor` shows it.
- `d` in the Files sidebar deletes components you removed locally from the default org, through `destructiveChanges.xml` and an empty `package.xml`, after a confirmation, with a dry-run option and a backup on production.

## [0.10.0] - 2026-11-25

### Added
- Coding standards (`coding_standards`, on): in Salesforce projects, Claude's system prompt carries the SF Guardian coding standards: simple, complete and correct code, no comments, no placeholders, no over-engineering.
- Component name prefix (`name_prefix`, empty by default): new Apex classes, triggers and LWCs must use it (`INV_Name`, `inv_name`), with no double or trailing underscores. A file tool or `sf apex generate` / `sf lightning generate component --type lwc` with a wrong name is refused with the correct name. Existing components are never touched.
- Code checks (`code_checks`, on), on drafts while Claude writes and on every changed file: SOQL or DML inside loops, hard-coded record ids, classes without a sharing keyword, `System.debug`, comments (when the standards are on), and SOQL fields or objects that do not exist in the default org. They join the problems list and "Ask Claude to fix".
- Two tools Claude can call: `describe_object` (fields, types, required, lookups, picklist values, child relationships) and `soql_query` (read only, `LIMIT` added, asks first on production or unknown orgs).
- The coverage view's `t` key asks Claude to write tests for the uncovered lines.


### Changed
- SF Guardian is now installed and updated from its own repository: `claude plugin marketplace add rahadulx1/sf-guard`, then `claude plugin install sf-guardian@sf-guard`. The `rahadulx1/claude-mods` marketplace is no longer updated; the README shows how to switch.

## [0.9.0] - 2026-11-24

### Added
- The band ends with the mod version (`SF Guardian v0.9.0`); `/sfdoctor` prints it first.
- The README is now a full manual: what each feature is for and how to use it.
- Windows support by construction: paths are normalized to forward slashes, the home folder comes from `HOME` or `USERPROFILE`, and `del`, `erase` and `Remove-Item` count as deletes.
- Adaptive polling: every 2 s right after a change, 5 s for the next two minutes, then 15 s. The poll after a shell command stays immediate.
- `/sfdoctor perf` times one poll.
- `o` in the Files sidebar opens the selected file in your editor at its line (`editor_command`, default `code`; `{file}` and `{line}` placeholders supported).
- `notify` (off): a system notification when a deploy, validation or test run ends.
- `remember_files` (off): keep the file list (paths and counts, never content) across restarts, per folder.

### Changed
- The folder watch no longer uses `find`, `touch` or a marker file in `/tmp`: it keeps a map of modified times and polls with `$.fs.list` alone, which also removes the leftover marker file.
- The watch (git and folder) is narrowed to the package directories in `sfdx-project.json` when it exists.
- Only the 50 most recently changed files keep their full text; older ones keep their diffs and counts.

## [0.8.0] - 2026-11-24

### Added
- Deploy failures with file, line and column (`details.componentFailures`) in the sf row, the Files sidebar (a `✘` mark on the file and the problem under its view) and `/deploys`. Failed tests show their class and line from the stack trace.
- `v` in the Files sidebar validates only the changed metadata with a dry run, picking tests by name, after showing the exact command. Long validations are followed with `sf project deploy report`.
- Coverage view (`4`): uncovered line ranges of the selected Apex class, from `coverage.coverage[].lines`.
- `code_analyzer` (off): runs `sf code-analyzer run` on changed Apex and LWC after a turn; findings show in the band and the sidebar.
- The band shows the org class, scratch org expiry (three days or fewer), and a warning when the project's `sourceApiVersion` is newer than the org's API.
- `a` (Files sidebar) and the Deploys tab send Claude a short digest of the problems, only when pressed.

## [0.7.0] - 2026-11-24

### Added
- Guard v2: orgs are classified from `sf org list --json --skip-connection-status` by alias and username alike, cached for ten minutes, refreshed after login changes. Unknown orgs are treated like production. `/sforg` shows the class.
- `safe_orgs`, `guard_mode` (`ask` or `block`), `guard_scripts`, `guard_mcp`, `audit_log`.
- The guard covers metadata deletes, every data-changing command, anonymous Apex, permission sets and licenses, user creation, packages, and org lifecycle commands (which always ask).
- Scripts: `npm run`, `yarn`, `make` and shell scripts are read and the sf commands inside them judged; an unreadable script asks while the default org is production or unknown.
- Salesforce MCP tools `deploy_metadata`, `assign_permission_set`, `delete_org` and `resume_tool_operation` are guarded.
- `/sfguard`, `/sfguard test <command>`, `/sfguard orgs`, `/sfguard export [file]`.
- A local audit log (ring buffer of 500), with passwords, client secrets, session ids and auth URLs removed.
- Reading `~/.sf` and `~/.sfdx` asks first. Salesforce session ids and auth URLs are removed from shell output before Claude reads it.
- `/sfdoctor` and `/sfdoctor record`; sf output that cannot be summarized is counted and a cleaned sample kept in memory.
- Pure logic split into `hooks/lib/` with table tests (90+ guard cases).

## [0.6.0] - 2026-11-24

### Added
- Live typing: the Files sidebar shows a file's text while Claude writes it, from the streaming `turn.step` event, before the file is touched. Edits show old and new text. A denied tool shows "not applied". Chunks pass through unchanged; any error turns the feature off for the session. Setting `live_typing` (on).

## [0.5.1] - 2026-11-24

### Fixed
- `/sflimits` and the Limits tab use `sf org list limits`; `sf limits api display` is a deprecated alias and is used only when the new command is unknown.
- The guard judges each part of a chained command, finds commands inside `bash -c` and `$(…)`, puts `--dry-run` on the deploy part itself, and matches the command word only (no false alarms from quoted text).
- The guard covers `data create record`, `data create file`, `project delete source`, package install/uninstall/delete/version promote, permission set assignment, and sandbox and scratch org delete and refresh.
- The default org refreshes after `sf config set`, `org login`, `org logout` and `alias set`.
- The turn line shows new and cached tokens apart instead of one number that looked like a cost.
- `sf org auth show-access-token`, `show-sfdx-auth-url` and `show-user-password` are refused by default (`allow_secret_commands`).

## [0.5.0]

First public version: production guard, org badge, live Files sidebar with diffs, compact sf rows and test summaries, Apex test tracking, coverage, org limits.
