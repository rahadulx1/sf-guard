# SF Guardian

A Claude Code mod for Salesforce developers. It guards production orgs, shows which org you are in, keeps a live sidebar of the files Claude changes, and makes sf CLI output easy to read.

## Install

Requires Claude Code 2.1.287 or later (`claude --version`), `git`, and the Salesforce CLI (`sf`).

From your terminal:

```bash
claude plugin marketplace add rahadulx1/claude-mods
claude plugin install sf-guardian@rahadul-mods
echo '{"prod_orgs":"your-prod-alias, admin@yourcompany.com"}' | claude plugin configure sf-guardian@rahadul-mods --values-stdin
```

Or inside Claude Code:

```
/plugin marketplace add rahadulx1/claude-mods
/plugin install sf-guardian@rahadul-mods
```

Then restart Claude Code, start it from inside your Salesforce project folder, and type `/sffiles`.

## Update

```bash
claude plugin marketplace update rahadul-mods
claude plugin update sf-guardian@rahadul-mods
```

Restart Claude Code afterwards. Your settings are kept. To update automatically, open `/plugin`, choose **Marketplaces**, select `rahadul-mods`, and choose **Enable auto-update**.

## Settings

Set these in Claude Code with `/config` (look for SF Guardian), or from your shell:

    echo '{"prod_orgs":"prod, admin@acme.com"}' | claude plugin configure sf-guardian@rahadul-mods --values-stdin

| Setting | What it does | Default |
| --- | --- | --- |
| Production orgs | Aliases or usernames of production orgs, comma-separated | (none) |
| Open the Files sidebar automatically | Opens the sidebar the first time a file changes | on |
| Files sidebar width | Columns | 72 |
| Compact sf command rows | Short rows and summaries for deploys and test runs | on |
| Org status above the prompt | The band with org, Apex, files and last deploy | on |
| Coverage target (%) | Green at or above this | 85 |

Restart Claude Code after changing a setting.

## Features

- Production guard: deploys and data commands aimed at a production or unknown org ask first (validate only, run, or cancel). Production deploys without `--test-level` are refused.
- Live Files sidebar (`/sffiles`): every file Claude creates, edits or deletes, with added and removed lines. Views: 1 latest change, 2 all changes this session, 3 the file around the latest change. Changes made any way are picked up: file tools, shell commands, `sf project retrieve`. Uses git when the project is a repo, otherwise watches the folder.
- Band above the prompt: org badge (red for production), untested Apex, changed files, last deploy.
- Compact rows and summaries for sf deploys and Apex test runs, a spinner that says what sf is doing, token counts on the turn line, toasts when deploys and tests finish.
- Apex tracking: classes Claude edits are marked tested when a passing run covers them; a warning shows at the end of a turn otherwise.
- `/sfpanel`: Apex, Deploys, Coverage, Limits. `/sforg`, `/deploys`, `/sflimits [alias]`.

## Keys in the Files sidebar

`j`/`k` move · `1` `2` `3` switch view · `f` follow the latest change · `x` clear · `r` refresh · `Esc` close

Requires Claude Code v2.1.287 or later and the Salesforce CLI (`sf`). Run the tests with `claude plugin test`.
