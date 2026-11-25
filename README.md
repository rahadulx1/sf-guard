# SF Guardian

A Claude Code mod for Salesforce developers. It stops Claude from changing production by accident, gives Claude your coding standards and naming prefix, checks Claude's Apex and LWC while it is written (SOQL in loops, made-up fields), lets Claude look up your org's schema, shows every file Claude changes, and turns sf CLI output into file-and-line problems you can act on.

**Contents:** [Install](#install) · [Update](#update) · [Quick start](#quick-start) · [Manual](#manual) · [Commands](#commands) · [Settings](#settings) · [Troubleshooting](#troubleshooting) · [Development](#development)

## Install

Requires Claude Code 2.1.287 or later (`claude --version`), `git`, and the Salesforce CLI (`sf`).

From your terminal:

```bash
claude plugin marketplace add rahadulx1/sf-guard
claude plugin install sf-guardian@sf-guard
```

Or inside Claude Code:

```
/plugin marketplace add rahadulx1/sf-guard
/plugin install sf-guardian@sf-guard
```

Restart Claude Code afterwards.

**Installed it earlier from `rahadulx1/claude-mods`?** That marketplace is no longer updated. Switch once:

```bash
claude plugin uninstall sf-guardian@rahadul-mods
claude plugin marketplace remove rahadul-mods
claude plugin marketplace add rahadulx1/sf-guard
claude plugin install sf-guardian@sf-guard
```

Your settings may need to be entered again in `/config`.

## Update

```bash
claude plugin marketplace update sf-guard
claude plugin update sf-guardian@sf-guard
```

Restart Claude Code afterwards. Your settings are kept. The version you are running shows at the end of the band above the prompt (`SF Guardian v0.10.0`) and on the first line of `/sfdoctor`.

To update automatically, open `/plugin`, choose **Marketplaces**, select `sf-guard`, and choose **Enable auto-update**.

## Quick start

1. Start Claude Code **from inside your Salesforce project folder** (the one with `sfdx-project.json`).
2. Run `/sfdoctor`. Every line should be ✔. Each ⚠ or ✘ line tells you how to fix it.
3. Run `/sfguard orgs`. Check that each org has the right class (production, sandbox, scratch). If a Developer Edition or trial org shows as production, add it to **Safe orgs** in `/config`.
4. Look at the band above the prompt: it shows your default org and its class.
5. Ask Claude to change some code. The Files sidebar opens and shows the change.

---

## Manual

### 1. Production guard

**What it is for:** Claude can run sf commands. A deploy, a data delete or a permission change in production is hard to undo. The guard makes Claude stop and ask you before anything changes a production org, or an org it cannot identify.

**How it decides:**

1. **Which org.** The org named with `-o` / `--target-org` (or `-v` for package commands). If there is none, your default org.
2. **What kind of org.** SF Guardian reads `sf org list --json --skip-connection-status`. This makes no network calls. It classifies every alias **and** username, in any letter case:

   | sf lists the org under | Class |
   | --- | --- |
   | `sandboxes` | sandbox |
   | `scratchOrgs` | scratch |
   | `other`, `devHubs` | production |
   | not listed at all | **unknown, treated like production** |

   Your settings win over detection. **Production orgs** forces production. **Safe orgs** forces non-production: use it for Developer Edition and trial orgs, which sf lists like production. The org list is cached for ten minutes and refreshed after `sf org login`, `logout`, `alias set` and `config set`. If `sf` is missing or fails, only your settings are used, and the band shows `⚠ org detection off`.
3. **What the command does.**

   | Category | Commands | Production or unknown org | Sandbox or scratch org |
   | --- | --- | --- | --- |
   | Deploy | `project deploy start`, `quick` | Ask: validate only, run, or cancel. `start` without `--test-level` is refused | Allowed |
   | Metadata delete | `project delete source` | Ask | Allowed |
   | Data change | `data create/update/upsert/delete/import …` and their `resume` | Ask | Allowed |
   | Run code | `apex run` (anonymous Apex) | Ask | Allowed |
   | Permissions | `org assign permset`, `permsetlicense`, `org create user` | Ask | Allowed |
   | Packages | `package install`, `uninstall`, `delete`, `version promote` | Ask | Allowed |
   | Org lifecycle | `org delete sandbox`, `scratch`, `org refresh sandbox` | Ask | Ask |
   | Secrets | `org auth show-access-token`, `show-sfdx-auth-url`, `show-user-password` | Refused | Refused |
   | Read only | queries, `apex run test`, retrieve, `org display`, dry runs | Allowed | Allowed |

**What you see:** a question listing every risky part of the command, with the org and its class. For a deploy, choose **Validate only** to run it with `--dry-run` (nothing changes in the org), **Run as written**, or **Cancel**. If you cancel, Claude is told you declined and to ask you before trying another way.

**What it catches:**
- Chained commands (`cd x && sf … && echo ok`), judged part by part. `--dry-run` goes on the deploy part only.
- Wrapped commands: `bash -c "…"`, `sh -c '…'`, `$(…)` and backticks.
- Prefixes such as `FOO=1 sf …`, `sudo sf …`, `npx sf …`, full paths, and old `sfdx force:…` names.
- No false alarms from text: `echo "sf project deploy start"` or a commit message is not a command.

**Scripts** (setting **Guard scripts**): for `npm run x`, `yarn x`, `make`, `./script.sh` and `bash script.sh`, SF Guardian reads the script and judges the sf commands inside it. A script it cannot read asks once if the default org is production or unknown.

**Salesforce MCP tools** (setting **Guard Salesforce MCP tools**): `deploy_metadata`, `assign_permission_set`, `delete_org` and `resume_tool_operation` ask before acting on a production or unknown org. These tools have no validate-only mode, so the choices are run or cancel.

**Block mode** (setting **Guard mode** = `block`): every change to a production or unknown org is refused, with no question. Reads still work. Use it when Claude should never change production.

> The guard is a safety net, not a security boundary. A program it cannot read, or a tool it does not know, can still reach an org. Org-side controls (profiles, permission sets, deployment settings) are the real protection.

### 2. Secret protection

**What it is for:** keeping Salesforce login secrets out of the conversation, where they would be sent to the model and kept in the transcript.

- `sf org auth show-access-token`, `show-sfdx-auth-url` and `show-user-password` are refused. Turn on **Allow secret commands** if you really need them.
- Reading files under `~/.sf` and `~/.sfdx` (where sf keeps login data) asks first, whether Claude uses a file tool or a shell command such as `cat`.
- Salesforce session ids (`00D…!…`) and sfdx auth URLs (`force://…@…`) are removed from shell output before Claude reads it.

### 3. Coding standards and component names

**What it is for:** getting code that looks like your team wrote it (simple, complete, no comments) and keeping your naming rule without reminding Claude every time.

- **Coding standards** (setting **Coding standards**, on): in a Salesforce project (one with `sfdx-project.json`), Claude's system prompt carries the SF Guardian standards. Code should be simple and correct, with no comments, no placeholders, no speculative features and no over-engineering. Claude should check its work before saying it's done.
- **Name prefix** (setting **Component name prefix**, empty by default): set it to your prefix, for example `INV`, and every *new* component must use it:

  | Component | Rule | Example |
  | --- | --- | --- |
  | Apex class | `INV_` + PascalCase | `INV_ContractRequestService` |
  | Apex test class | `INV_` + name + test suffix | `INV_ContractRequestServiceTest` |
  | Apex trigger | `INV_` + PascalCase | `INV_ContractRequestTrigger` |
  | Lightning Web Component | `inv_` + camelCase | `inv_contractRequestForm`, used as `<c-inv_contract-request-form>` |

  No double underscores, and no trailing underscore. If Claude tries to create a component with the wrong name, through a file tool or with `sf apex generate class|trigger` or `sf lightning generate component --type lwc`, the call is refused and Claude is told the correct name. Existing components are never renamed or blocked.

Set the prefix with `/config`, or:

    echo '{"name_prefix":"INV"}' | claude plugin configure sf-guardian@sf-guard --values-stdin

### 4. Code checks (live)

**What it is for:** catching governor-limit bugs and made-up fields *while Claude writes the code*, before you approve it and long before a deploy fails.

Checked on drafts (live typing) and on every changed Apex class, trigger and LWC file:

| Check | Example message |
| --- | --- |
| SOQL inside a loop | `line 12  SOQL inside a loop: query once before the loop` |
| DML inside a loop | `line 14  DML inside a loop: collect records and run one DML after the loop` |
| Hard-coded record id | `line 3  Hard-coded record id 0015g00000AbCdE` |
| Class without a sharing keyword | `line 1  Class without a sharing keyword: …` |
| `System.debug` left in code | `line 20  System.debug left in code` |
| Comments in code (when the standards are on) | `line 5  Comment in code: your coding standards allow none` (tool directives such as `eslint-disable` or `NOPMD` are allowed) |
| SOQL field or object that does not exist in your default org | `line 8  Field Contact.Bogus__c does not exist in uat` |

Problems show under the draft or the file in the Files sidebar, mark the file with `✘`, and are included when you press `a` to ask Claude to fix them. Field checks use `sf sobject describe` on your default org (read only, cached for the session). Turn the checks off with **Code checks**.

### 5. Tools Claude can call: `describe_object` and `soql_query`

**What it is for:** letting Claude look things up in your org instead of guessing.

- **`describe_object`**: every field of an object with its API name, type, label, whether it is required, lookup targets and picklist values, plus child relationships. Claude uses it before writing code that references fields. Read only.
- **`soql_query`**: runs a read-only `SELECT` and returns the records as JSON. `LIMIT 50` is added when the query has none, and limits above 200 are lowered to 200. Before reading data from a **production or unknown** org, you're asked, and the answer is recorded in the audit log.

Both use your default org unless Claude names another.

### 6. `/sfguard`: see and test the guard's decisions

**What it is for:** trusting the guard, and finding out why it asked (or did not).

- `/sfguard`: the last 20 decisions: time, verdict, your answer, the outcome, the org and its class, and the command.
- `/sfguard test <command>`: shows what the guard would do and why, **without running anything**. Example: `/sfguard test sf project deploy start -o prod --test-level RunLocalTests`.
- `/sfguard orgs`: every org with alias, username and class, and whether the class came from sf or from your settings. It also marks your default org and shows scratch org expiry.
- `/sfguard export [file]`: writes the audit log to a JSON file (default `sf-guardian-audit-<date>.json`).

**Audit log** (setting **Audit log**): every guarded command is recorded locally: the last 500, with passwords, client secrets, session ids and auth URLs removed. Nothing is sent anywhere.

### 7. The band above the prompt

**What it is for:** knowing where you are at a glance, before you ask Claude to do anything.

```
● uat · sandbox │ Apex: 1 untested │ Files: 3 │ Last deploy: ✔ uat 2m ago │ SF Guardian v0.10.0
```

| Part | Meaning |
| --- | --- |
| `● uat · sandbox` | Default org and class. Red `PROD · prod` for production; yellow `? x · unknown` when the org is not listed |
| `expires in 2d` | A scratch org that expires within three days |
| `API 62.0 > org 61.0` | Your project's `sourceApiVersion` is newer than the org's API version, so some metadata may not deploy |
| `Apex: 1 untested` | Apex Claude changed that no passing test run has covered yet |
| `Files: 3` | Files changed this session (`/sffiles` to see them) |
| `⚠ 2 findings` | Code Analyzer findings on the changed files (if Code Analyzer is on) |
| `Last deploy: ✔ uat 2m ago` | The last deploy or validation and its result |
| `⚠ org detection off` | sf could not list your orgs; only your settings are used |
| `SF Guardian v0.10.0` | The mod version you are running |

Claude is also told your default org and its class with each prompt. Turn the band off with **Org status above the prompt**.

### 8. Files sidebar (`/sffiles`)

**What it is for:** seeing exactly what Claude changed, as it happens, without running `git diff`.

It lists every file Claude creates (`+`), edits (`~`) or deletes (`✕`), with added and removed lines. Changes made any way are picked up: file tools, shell commands, `sf project retrieve`, even your own editor. With git it watches `git status`. Without git it lists the folder. When `sfdx-project.json` exists, only its package directories are watched. The sidebar opens by itself at the first change (setting **Open the Files sidebar automatically**). `/sffiles` always opens it.

**Views** (press the number):

| Key | View | Use it to |
| --- | --- | --- |
| `1` | Latest change | Review the change Claude just made |
| `2` | All changes | See everything changed in this file this session |
| `3` | File | Read the file around the latest change, or around the first problem |
| `4` | Coverage | See which lines of the selected Apex class no test covers. Press `t` to ask Claude to write tests for exactly those lines |

**Keys:**

| Key | Action |
| --- | --- |
| `j` / `k` | Next / previous file |
| `f` | Follow: always select the latest change (moving by hand turns it off) |
| `x` | Clear the list. A file shows again when it next changes, diffed from what you cleared |
| `r` | Refresh now |
| `v` | Validate the changed files |
| `o` | Open the selected file in your editor, at the right line |
| `t` | In the Coverage view: ask Claude to cover the uncovered lines |
| `a` | Ask Claude to fix the problems shown |
| `Esc` | Close |

### 9. Live typing

**What it is for:** reading code while Claude writes it, so you can review it before you approve the tool.

While Claude writes or edits a file, a `✎` row shows the text as it is generated, before anything is saved. Edits show the old and new text as a diff. If you deny the tool at the permission prompt, the row says **not applied** and nothing changes on disk. When the write finishes, the row becomes a normal file row.

Drafts stay in memory only and are cleared when the turn ends. The live preview stops at 200 KB. Rows from subagents are tagged `sub`. Turn it off with **Live typing**. If it ever fails, it turns itself off for the session and says so. Claude is never affected.

### 10. Validate the changed files (`v`)

**What it is for:** checking that Claude's changes will deploy, and that their tests pass, without deploying the whole project or changing the org.

Press `v` in the Files sidebar. SF Guardian builds a dry-run deploy of **only the changed metadata**:

- LWC and Aura files are mapped to their bundle folder. `-meta.xml` files are mapped to their component. README files and `__tests__` folders are left out.
- Tests are chosen by name: a changed class `X` runs `XTest`, `X_Test` or `XTests` (whichever exists). Changed test classes run too. If none are found, it uses `RunLocalTests` and tells you.
- It runs on your **default org**. It shows the exact command and waits for you to confirm.

The result shows as a toast, in the band and in `/sfpanel` → Deploys. Failures feed the problems list.

### 11. Problems, and "Ask Claude to fix"

**What it is for:** going straight from a failure to the file and line, and getting Claude to fix it in one key.

SF Guardian collects:
- **Deploy errors** with file, line and column: `✘ AccountService.cls:34:12  Variable does not exist: foo`
- **Failing tests**, with the class and line from the stack trace
- **Code check problems** (see the live code checks section)
- **Code Analyzer findings** (if Code Analyzer is on)

A file with problems gets a red `✘2` in the sidebar, and its problems show under its view. Problems in other files are listed below. Press one to select that file. Press `a` (or **Ask Claude to fix** in `/sfpanel` → Deploys) to send Claude a short digest (at most 40 lines). This only happens when you press it.

### 12. Compact sf rows and summaries

**What it is for:** reading long sf output at a glance.

Deploys and Apex test runs draw as one short row (`🚀 Deploy → uat ✔`, `🧪 Apex tests (AccountServiceTest) → uat`). Their results draw as a summary: passed, failed, coverage, and the first failures with file and line. Production is flagged `[PROD]`. `Ctrl+O` still shows the full output. The spinner says what sf is doing, and a toast appears when a deploy or test run ends. Turn this off with **Compact sf command rows**.

### 13. Apex test tracking and coverage

**What it is for:** making sure changed Apex gets tested before you deploy.

- Classes Claude edits are listed as untested until a passing test run covers them. At the end of a turn with untested Apex, Claude gets a reminder with the exact test command.
- Coverage from `--code-coverage` runs shows per class in `/sfpanel` → Coverage. Green is at or above **Coverage target**, yellow is 75% or above, red is below 75%.
- With `--json` output, the uncovered lines are known: view `4` in the Files sidebar shows each uncovered range with its code (`12 uncovered lines: 40–44, 71`). Press `t` there to ask Claude to write tests for exactly those lines.

### 14. Code Analyzer (optional)

**What it is for:** catching security and quality issues (CRUD/FLS, SOQL in loops, and others) in the code Claude just wrote.

Turn on **Run Code Analyzer**. After a turn that changed Apex or LWC, SF Guardian runs `sf code-analyzer run` on the changed files in the background. Findings show in the band (`⚠ 3 findings`) and in the sidebar with file and line. You need the plugin (`sf plugins install code-analyzer`), and Java for some engines. `/sfdoctor` checks both.

### 15. `/sfpanel`

**What it is for:** one place for the session's Salesforce state. Tabs (press the number):

1. **Apex**: classes and triggers Claude changed, tested or not, with coverage. `c` clears the list.
2. **Deploys**: every deploy and validation this session, plus the current problems and **Ask Claude to fix**.
3. **Coverage**: coverage per class, worst first, with uncovered ranges.
4. **Limits**: key org limits (API requests, async Apex, storage, email). `r` refreshes.

### 16. `/sfdoctor`

**What it is for:** checking the setup in a few seconds, and making a bug report useful.

It prints a ✔, ⚠ or ✘ line per check, each with a fix: mod version, coding standards and prefix, Claude Code version, sf and its plugins, git, `sfdx-project.json`, default org, org detection (how many production, sandbox and scratch orgs), whether your org settings match real orgs, the file watch, sidebar width, the store, unparsed sf output, and live typing.

- `/sfdoctor record [file]`: saves the last sf output SF Guardian could not summarize (cleaned of emails, org ids and hostnames, first 2 KB) so you can attach it to a bug report. Read it first.
- `/sfdoctor perf`: times one poll of the file watch.

### 17. Smaller features

- **Token counts:** the turn line shows new and cached tokens separately (`3.1k tokens · 142k cached`), so cached tokens do not look like cost.
- **Notifications** (setting **Notify when deploys and tests end**): a system notification when a deploy, validation or test run ends. Useful while you work in another window.
- **Remember the file list** (setting): keeps the sidebar's list (paths and counts, never content) across restarts, per folder.
- **Open in editor:** `o` runs `code -g <file>:<line>`. Set **Editor command** for another editor, for example `cursor`, or with placeholders: `idea --line {line} {file}`.
- **Undo:** use Claude Code's own checkpoints (`Esc Esc` or `/rewind`). SF Guardian does not add a second undo system.
- **Windows:** paths with backslashes, `USERPROFILE`, and `del` / `Remove-Item` are handled. Please report anything that behaves differently on Windows.

---

## Commands

| Command | What it does |
| --- | --- |
| `/sffiles` | Open the Files sidebar |
| `/sfpanel` | Apex · Deploys · Coverage · Limits |
| `/sforg` | Refresh and show the default org and its class |
| `/deploys` | Deploys this session, with the last errors |
| `/sflimits [alias]` | Org limits (`sf org list limits`; on an old CLI, `sf limits api display`) |
| `/sfguard` | The last 20 guard decisions |
| `/sfguard test <command>` | What the guard would do, and why. Runs nothing |
| `/sfguard orgs` | Every org with its class and where the class came from |
| `/sfguard export [file]` | Write the audit log to a file |
| `/sfdoctor` | Check the setup |
| `/sfdoctor record [file]` | Save the last unparsed sf output, cleaned |
| `/sfdoctor perf` | Time one poll of the file watch |

Claude also gets two tools from SF Guardian: `describe_object` and `soql_query`.

## Settings

Set these in Claude Code with `/config` (look for SF Guardian), or from your shell:

    echo '{"prod_orgs":"prod, admin@acme.com","safe_orgs":"my-dev-ed"}' | claude plugin configure sf-guardian@sf-guard --values-stdin

| Setting | Key | Default | Use |
| --- | --- | --- | --- |
| Production orgs | `prod_orgs` | (none) | Orgs that are always production, whatever sf says |
| Safe orgs | `safe_orgs` | (none) | Orgs that are never production (Developer Edition, trials) |
| Guard mode | `guard_mode` | `ask` | `ask` before production changes, or `block` them |
| Guard scripts | `guard_scripts` | on | Look inside npm, make and shell scripts |
| Guard Salesforce MCP tools | `guard_mcp` | on | Ask before MCP deploys, permission sets and org deletes |
| Allow secret commands | `allow_secret_commands` | off | Let Claude print access tokens, auth URLs and passwords |
| Coding standards | `coding_standards` | on | Give Claude the coding standards in Salesforce projects; flag comments |
| Component name prefix | `name_prefix` | (none) | Prefix new Apex classes, triggers and LWCs must use, e.g. `INV` |
| Code checks | `code_checks` | on | Live checks for loops, ids, sharing, debug, comments, unknown fields |
| Audit log | `audit_log` | on | Keep a local record of guarded commands |
| Open the Files sidebar automatically | `auto_open_files` | on | Open it at the first change |
| Live typing | `live_typing` | on | Show text while Claude writes it |
| Files sidebar width | `files_pane_width` | 72 | Columns |
| Compact sf command rows | `compact_sf_rows` | on | Short rows and summaries for sf |
| Org status above the prompt | `show_band` | on | The band |
| Coverage target (%) | `coverage_target` | 85 | Green at or above this |
| Run Code Analyzer | `code_analyzer` | off | Analyze changed Apex and LWC after each turn |
| Editor command | `editor_command` | `code` | Editor for the `o` key |
| Notify when deploys and tests end | `notify` | off | System notifications |
| Remember the file list | `remember_files` | off | Keep the list across restarts |

Restart Claude Code after changing a setting.

## Troubleshooting

| Problem | What to do |
| --- | --- |
| The band says `⚠ org detection off` | Run `sf org list` in a terminal. Log in again with `sf org login web` if it fails. Meanwhile, set **Production orgs** |
| A Developer Edition org asks every time | Add it to **Safe orgs** |
| The guard asked and you are not sure why | `/sfguard test <the command>` |
| The sidebar says "tools only" | Start Claude from the project folder, not your home folder |
| The sidebar does not open by itself | The terminal must be at least 144 columns wide for a pane opened unasked. `/sffiles` always works |
| A test or deploy result shows as raw text | `/sfdoctor record`, then open an issue with the file |

## Development

```bash
claude plugin validate .
claude plugin test .
```

Pure logic lives in `hooks/lib/` (shell splitting, org classification, the guard decision, the live-typing decoder, sf parsers, diffs) with table tests in `tests/lib.test.ts`. Hook behavior is tested in `tests/sf-guardian.test.ts`. The parser fixtures in `tests/fixtures/` are schema-shaped: see `improvement.md` Appendix C to capture real ones.

See [CHANGELOG.md](CHANGELOG.md) and [SECURITY.md](SECURITY.md).
