# SF Guardian: fix and implementation plan

Plan for taking SF Guardian from 0.5.0 to 1.0. Written on 24 Nov 2026 against the version in the `claude-mods` repo.

## 0. How to read this

| Mark | Meaning |
| --- | --- |
| ✅ | Checked against source code or published schemas. The source is named. |
| ⚠️ | An assumption or something I could not check. Treat it as a risk. |
| 🔧 | Work to do. |

Sizes are my estimates for one developer who knows the code: **S** is up to a day, **M** is two to four days, **L** is one to two weeks.

Three pieces of code in this plan (the streaming decoder, the command splitter and the org classifier) are in Appendix A. I ran them: the decoder against about 97,000 random partial inputs, the other two against table tests. The rest of the plan is a design, not finished code.

---

## 1. The short version

| Order | Version | Theme | Size | Why here |
| --- | --- | --- | --- | --- |
| 1 | **0.5.1** | Fixes to known gaps | S | Cheap, no design risk, and one of them removes a future break. |
| 2 | **0.6.0** | Live typing in the Files sidebar | M | What you asked for first. Independent of everything else. |
| 3 | **0.7.0** | Guard v2: detect production automatically, wider coverage, audit log, `/sfguard`, `/sfdoctor`, secret protection | L | The safety core. Needs real sf output fixtures first. |
| 4 | **0.8.0** | Salesforce workflow: deploy errors with file and line, validate changed files, uncovered lines, Code Analyzer, org info in the band | L | Reuses the org map and the fixtures from 0.7. |
| 5 | **0.9.0** | Windows, performance, editor integration | M | Best done after features settle. |
| 6 | **1.0.0** | Release gate | | Criteria in section 11. |

---

## 2. What I verified, and two corrections

### 2.1 Corrections to what I told you earlier

1. **Live typing is possible.** I said a mod cannot show a file while Claude writes it. That was wrong. `turn.step` is a streaming event, and a tool call's arguments arrive as partial JSON pieces. For a `Write` call, the file's content is in those pieces. ✅ Claude Code mod API types (`claude-code.d.ts`, Claude Code 2.1.331): `TurnStepToolChunk`, `TurnStepInputChunk`.
2. **`sf org display` no longer prints the access token.** I said it does, and that auth files hold tokens. In the current CLI the token is redacted, and the secrets sit behind separate commands: `sf org auth show-access-token`, `show-sfdx-auth-url` and `show-user-password`. ✅ `@salesforce/plugin-org` 7.0.17, `display.js` and its messages. Older CLI versions may still print them (⚠️ from memory, not checked). The secret guard in section 6.7 is aimed at the right commands.

### 2.2 Evidence

| Topic | Finding | Source | Effect on the plan |
| --- | --- | --- | --- |
| Streaming tool arguments | A hook on `turn.step` is a generator. Chunk kinds: `text`, `thinking`, `tool` (name and call id), `input` (partial JSON), `stop`, `engine`. A hook yields every chunk it reads. "A hook that fails mid-stream is left, the rest from beneath it." | mod API types ✅ | Phase 1 is feasible, and a bug in the hook cannot break the stream. The types header says the surface is **early access** and may change between releases. |
| No file-watch event | `$.fs` has `read`, `write`, `list`, `stat`, `exists`, `ancestors`. No watch. | mod API types ✅ | Polling stays. Phase 5 makes it cheaper. |
| Storage | `$.store`: a JSON file kept between sessions and hot reloads. `$.state`: values that survive a hot reload and redraw panes that read them. | mod API types ✅ | Audit log, org map cache. |
| Prompt from a mod | `$.prompt.submit({ text })` | mod API types ✅ | "Ask Claude to fix this" key. |
| Questions | `$.ui.ask(question, { options, header, multiSelect })`, two to four options | mod API types ✅ | No long org picker. Detect orgs automatically instead. |
| Background process | `$.process.spawn` streams output | mod API types ✅ | Optional native file watcher. |
| Apex test JSON | `summary`: `testsRan`, `passing`, `failing`, `outcome`, `testRunCoverage`. `tests[]`: `Outcome`, `FullName`, `MethodName`. `coverage.coverage[]`: `name`, `totalLines`, `lines`, `totalCovered`, `coveredPercent`. | `@salesforce/plugin-apex` 4.4.7, `jsonReporter.js` ✅ | **The current parser matches.** `lines` also gives line-by-line coverage (section 8.3). |
| Deploy JSON | `status`, `numberComponentsDeployed`, `numberComponentErrors`, `numberTestsCompleted`, `numberTestErrors`. `details.componentFailures[]`: `fileName`, `lineNumber`, `columnNumber`, `problem`, `problemType`, `componentType`, `fullName`. `details.runTestResult`. | `@salesforce/plugin-deploy-retrieve` 4.3.3, `schemas/project-deploy-start.json` ✅ | **The current parser matches.** The error list is there for section 8.1. |
| Limits | `sf limits api display` is only a **deprecated alias** of `sf org list limits`. Result: array of `{ name, max, remaining }`. | `@salesforce/plugin-limits` 4.0.6, manifest and schema ✅ | Fix F1. The parser is fine. |
| Config get | `result[]` items have `name`, `value`, `location`. | `@salesforce/plugin-settings` 3.0.30 schema ✅ | The parser is fine. |
| Org list | JSON groups: `devHubs`, `sandboxes`, `scratchOrgs`, `other`, plus a deprecated `nonScratchOrgs` that only duplicates the rest. Scratch orgs carry `expirationDate`. The flag `--skip-connection-status` exists. | `@salesforce/plugin-org` 7.0.17 ✅ | Production can be detected automatically (section 6.1). |
| Commands that change an org | See the table in section 6.2. All of them exist in the shipped manifests. | oclif manifests of the apex, data, deploy-retrieve, org and packaging plugins ✅ | Guard coverage. |
| Salesforce MCP tools | `deploy_metadata`, `assign_permission_set`, `delete_org`, `resume_tool_operation`, `create_scratch_org`, `create_org_snapshot`, `retrieve_metadata`, `run_apex_test`, `run_soql_query`, `run_agent_test`, `open_org`, `list_all_orgs`, `get_username`. `deploy_metadata` takes `usernameOrAlias`, `sourceDir`, `manifest`, `apexTests`, `testLevel` and has **no validate-only option**. | `@salesforce/mcp-provider-dx-core` 0.10.0 ✅ | The MCP guard can ask or block. It cannot turn a deploy into a validation. |
| Code Analyzer | `sf code-analyzer run` flags: `workspace`, `target`, `rule-selector`, `severity-threshold`, `output-file`, `view`, `config-file`, `include-fixes`, `include-suggestions`, `no-suppressions`, `target-org`. | `@salesforce/plugin-code-analyzer` 5.16.0, manifest ✅ | Section 8.4. |

### 2.3 What I could not check

- ⚠️ The **human-readable tables** that `sf apex run test` and `sf project deploy start` print without `--json`. The parser has a fallback for them, written from memory.
- ⚠️ **Older Salesforce CLI versions.** I read the current packages only.
- ⚠️ **Windows**, in every part of the mod.
- ⚠️ Whether the sidebar can **redraw fast enough** while text streams in.
- ⚠️ Whether the plugin **testing kit** can feed chunks into a streaming event.
- ⚠️ Whether **relative imports** work between files inside a mod (section 5.5, step 0).
- ⚠️ The JSON shape of Code Analyzer results, and whether it needs Java on the machine.
- ⚠️ Whether a hook can **rewrite a tool's result** (used for removing session ids in section 6.7).
- ⚠️ The GitHub parts of the earlier publishing guide.

---

## 3. Rules for every change

1. **Tracking and drawing fail open. The guard fails closed.** A bug in a view must never change a command's result. A bug in the guard must stop the command, not let it through. This is how 0.5.0 already works.
2. **Observe, do not alter.** The streaming hook yields each chunk exactly as it received it. A test proves it.
3. **Every guard decision can be explained.** `/sfguard` shows why, and an audit entry records it.
4. **No new required setup.** New settings have safe defaults. Existing settings keep their meaning.
5. **Unknown means cautious.** If the mod cannot tell whether an org is production, it asks.
6. **A budget.** The guard adds no noticeable delay (target: under 50 ms using a cached org map). A poll takes under 150 ms on a 5,000-file project. Redraws during streaming stay at or below four per second. These are targets to measure, not measured facts.
7. **Logic in pure functions.** Decoder, splitter, classifier, diff, decision. Each has table-driven tests. Hooks stay thin.
8. **No parser ships without a fixture from a real `sf` run.**
9. **Cross-platform by construction.** No shell strings, `find`, `touch` or `/tmp`.
10. **Release gate.** Validation passes, all tests pass, and the smoke checklist in Appendix D is done.

---

## 4. Phase 0: version 0.5.1, fixes (size S)

| ID | Problem | Change | Test |
| --- | --- | --- | --- |
| **F1** | `/sflimits` and the Limits tab run `sf limits api display`, a **deprecated alias** ✅. Deprecated aliases get removed in a later CLI release. | Run `sf org list limits --json`. If it fails because the command is unknown (an old CLI), fall back to the old name. | Argv used. Fallback taken on an "unknown command" failure. |
| **F2** | The guard misses commands that change an org: `sf data create record`, `sf data create file`, `sf project delete source`, `sf package install`, `uninstall`, `delete`, `version promote`, `sf org assign permset`, `permsetlicense`, `sf org delete sandbox`, `scratch`, `sf org refresh sandbox`. All ✅ exist. | Extend the pattern list to the table in section 6.2. | One case per command, on a production org and a sandbox. |
| **F3** | A chained command is judged as one string. In `sf project deploy start -o prod && echo ok`, `--dry-run` lands after `echo ok`. A command wrapped in `bash -c "…"` or `$(…)` is not seen at all. The patterns also match **anywhere in the text**, so `echo "sf project deploy start"` or `git commit -m "sf data delete …"` raise a false alarm. | Split into simple commands with the quote-aware splitter (Appendix A2). Judge each. Match the command word at the **start** of a simple command, after any `VAR=value` prefixes, not inside quoted text. Add `--dry-run` to the deploy command itself. Scan inside `bash -c` and `$(…)`. | The splitter table tests, guard cases for chains and wrappers, and cases where the words appear only inside quotes (no alarm). |
| **F4** | The default org is read at session start. `sf config set target-org` mid-session leaves it stale until `/sforg`. | Refresh after any command that changes it (`config set`, `org login`, `org logout`, `alias set`, flags that set a default). | Default org changes after such a command. |
| **F5** | The turn line shows "18.4k tokens", which includes cached tokens. It looks like a cost and is not. | Show new tokens (input, output, cache writes) and cached tokens separately: `3.1k tokens · 142k cached`. | Line text for a turn with and without cache. |
| **F6** | Folder watch writes a marker file in `/tmp` and never removes it. | Remove it on `session.end`. (Phase 5 removes the marker completely.) | Marker removed at session end. |
| **F7** | `sf org auth show-access-token`, `show-sfdx-auth-url` and `show-user-password` print secrets into Claude's context. | Refuse them by default, with a reason Claude can read. A setting `allow_secret_commands` (default off) lifts it. | Each of the three is refused. A normal `sf org display` is not. |

**Done when:** all 27 existing tests pass, the new cases pass, `claude plugin validate` passes, and the version in `plugin.json` is `0.5.1`.

---

## 5. Phase 1: version 0.6.0, live typing (size M)

### 5.1 Goal

When Claude writes or edits a file, the Files sidebar shows the new text appearing as the model generates it, before the file is touched on disk.

```
Files  ● live  3 files  +41  −2

▸ ✎ AccountService.cls     drafting… line 58           ← new, updates about 4 times a second
  ~ LeadHandler.cls        +6 −1                  12s
  + card.js                +22                    1m
──────────────────────────────────────────────────────
force-app/main/default/classes/AccountService.cls · drafting · 58 lines so far
   54 │   public static void sync(List<Account> accts) {
   55 │     Set<Id> ids = new Set<Id>();
   56 │     for (Account a : accts) {
   57 │       ids.add(a.Id);
   58 │       █
```

One honest limit: the text shown is what the model **intends** to write, before you approve it. If you deny the tool, the draft disappears and the row says "not applied". That is also a feature, because you can read the code before you approve it.

### 5.2 How it works ✅

```js
on('turn.step', async function* ($, e, next) {
  for await (const chunk of next(e)) {
    try { reducer.ingest(chunk, e) } catch { /* never touch the stream */ }
    yield chunk                       // exactly as received
  }
})
```

- A `tool` chunk starts a block: tool name, call id, block index.
- `input` chunks for the same index carry the arguments' JSON text in pieces.
- A `stop` chunk ends the step.
- The reducer keeps the raw JSON per block and reads fields out of it with `readStringField` (Appendix A1). That function is tolerant of text cut anywhere, including in the middle of an escape sequence or an emoji. It never returns half a character.

Tools to handle, found by their arguments, not only by name (the same approach 0.5.0 uses for finished edits):

| Arguments | Treated as |
| --- | --- |
| `file_path` and `content` | A full write. Show the text as it grows. |
| `file_path`, `old_string`, `new_string` | An edit. Show the old text as removed and the new text as added. |
| `file_path` and `edits[]` | Several edits. Show them one after another. |
| `file_path` only | "Drafting" without text. |
| Anything else, `mcp__*` tools | Ignored. |

### 5.3 Data model

```
drafts: Map<toolUseId, {
  path, tool, agentId,
  raw,            // JSON text so far (capped, keeps the tail)
  text,           // decoded text so far
  oldText,        // for edits
  startedAt, lastDecodeAt,
  state           // 'drafting' | 'writing' | 'committed' | 'discarded'
}>
```

Lifecycle, linked by the tool call id (the `tool` chunk's `id` equals `tool_use_id` in the later `tool.call`):

1. `drafting`: chunks are arriving.
2. `writing`: the `tool.call` hook for the same id has started. The file is about to change.
3. `committed`: the existing finished-edit tracking (`trackEnd`) ran. The draft row is replaced by the normal row. For a full write, a check compares the last draft text with the file on disk.
4. `discarded`: the tool was denied or errored, or the turn was interrupted. The row shows "not applied" for a few seconds, then goes.

### 5.4 Design details

- **Cost.** Decode on a timer, not on every chunk. Chunks only append to `raw` (cheap). A draw at most every 250 ms decodes once. This keeps total work linear in the size of the text.
- **View.** Tail-follow the draft with line numbers and a cursor block. For an edit of an existing file, show the old and new text as a small diff. For a full write over an existing file, diff against the current content only while the file is under 2,000 lines. Beyond that, show the tail only.
- **Opening.** Open the sidebar at the first draft, not the first finished change, if auto-open is on.
- **Follow mode.** Follow selects the draft row. Selecting another row turns follow off, as now.
- **Keys out of order.** If `content` arrives before `file_path`, show "drafting…" until the path is known.
- **Parallel calls.** Several blocks in one step make several draft rows.
- **Subagents.** `turn.step` carries `agentId`. Tag each draft with it. The row shows a small tag.
- **Interrupt.** An aborted turn discards its drafts.
- **Memory and privacy.** Drafts stay in memory only. They are never written to `$.store` or a log. They are cleared at turn end. `raw` is capped (default 200 KB, tail kept).

### 5.5 Steps

0. 🔧 **Split `register.js` into modules** before adding more code: `lib/diff.js`, `lib/sf.js`, `lib/files.js`, `lib/ui.js`, `lib/draft.js`, `hooks/register.js`. ⚠️ First check that relative `import` works between files in a mod, with a one-line test. If it does not, keep one file and keep the sections clearly marked.
1. 🔧 `lib/draft.js`: `readStringField` (Appendix A1) and the reducer `ingest(chunk, stepInput)`.
2. 🔧 The `turn.step` generator hook above.
3. 🔧 Draft rows and the live view in the Files pane. Draw at most four times a second.
4. 🔧 Link drafts to `tool.call` and `trackEnd` by call id (state changes 2 to 4).
5. 🔧 Setting `live_typing` (boolean, default on). If the hook ever errors, turn the feature off for the session and show a toast once.
6. 🔧 Tests (below).
7. 🔧 Bump to `0.6.0`, update the README, record a short screen capture.

### 5.6 Tests

- **Decoder fuzz** (Appendix A1): already passing. Keep it in the repo.
- **Reducer with scripted chunks:** tool start, pieces, stop. Keys in both orders. Two parallel blocks. A subagent id. An unknown tool. Broken JSON that never closes.
- **Pass-through:** every chunk the reducer saw comes out unchanged. ⚠️ If the testing kit cannot drive a streaming event, test the reducer directly and add this to the manual checklist.
- **Pane:** a draft row appears, grows, and turns into a normal row. A denied tool turns it into "not applied".
- **Interrupt:** drafts are gone after an aborted turn.

### 5.7 Done when

- A 300-line `Write` shows its first lines within half a second of the first chunk, and never trails the model by more than about a second.
- The last draft text equals the file on disk for a full write.
- Chunks pass through byte for byte.
- Denying the tool leaves no draft and no file change.
- The turn does not feel slower with the sidebar open (check by eye on a large write).

### 5.8 Risks

| Risk | Handling |
| --- | --- |
| The streaming API is early access. | Feature flag. If the hook fails, the mod keeps working without live typing. |
| Redraws are too heavy. | The 250 ms throttle, the 200 KB cap, and tail-only view for large text. |
| Showing text before approval surprises people. | The row says "drafting". The README explains it. |

---

## 6. Phase 2: version 0.7.0, guard v2 (size L)

### 6.1 Detect production automatically

Today the guard compares the org in a command with a list you typed. If Claude uses the **username** and you typed the **alias**, the guard stays silent. Production is also guessed from names.

**Plan:**

1. 🔧 Run `sf org list --json --skip-connection-status` ✅ (the flag exists, so no network calls per org).
2. 🔧 Build a lookup from **alias and username** to a class, using the groups the CLI returns:

   | Group | Class |
   | --- | --- |
   | `sandboxes` | sandbox |
   | `scratchOrgs` | scratch |
   | `other` | **production** (not a sandbox, not a scratch org) |
   | `devHubs` | **production** (a Dev Hub is often production) |
   | not in the list | **unknown**, treated like production |

   The tested code is in Appendix A3.
3. 🔧 Two settings override it: `prod_orgs` (force production, exists) and the new `safe_orgs` (force non-production, for Developer Edition and trial orgs, which the CLI files under `other`). Both match the alias and the username of the same org.
4. 🔧 Cache the lookup in `$.store` for ten minutes. Refresh it at session start in the background and after commands that change logins (`org login`, `org logout`, `alias set`, `config set`).
5. 🔧 If `sf` is missing or the call fails, use the manual lists only, and show `⚠ org detection off` in the band.

**Safe by direction:** every failure leads to "ask", never to "allow". An org whose authorization is too old to say whether it is a sandbox lands in `other` and is asked about.

### 6.2 What counts as a change to an org ✅

All of these exist in the shipped manifests.

| Category | Commands | On production or unknown | On sandbox or scratch |
| --- | --- | --- | --- |
| Deploy | `project deploy start`, `project deploy quick` | Ask: validate only, run, cancel. `start` without `--test-level` is refused. | Allow |
| Metadata delete | `project delete source` | Ask | Allow |
| Data change | `data create record`, `data create file`, `data update record` and `bulk`, `data upsert bulk`, `data delete record` and `bulk`, `data import tree` and `bulk`, and the `resume` forms | Ask | Allow |
| Run code | `apex run` (anonymous Apex) | Ask | Allow |
| Permissions | `org assign permset`, `org assign permsetlicense`, `org create user` | Ask | Allow |
| Packages | `package install`, `uninstall`, `delete`, `version promote` | Ask | Allow |
| Org lifecycle | `org delete sandbox`, `org delete scratch`, `org refresh sandbox` | Ask | Ask |
| Secrets | `org auth show-access-token`, `show-sfdx-auth-url`, `show-user-password` | Refuse | Refuse |
| Read only | `data query`, `apex run test`, `project retrieve start`, `org list`, `org display`, `org list limits`, `code-analyzer run` | Allow | Allow |
| Log only | `project deploy resume`, `report`, `cancel` | Allow, record it | Allow |

### 6.3 Where the guard looks

| Where | How |
| --- | --- |
| Bash | Split the line into simple commands (Appendix A2). Look inside `bash -c`, `sh -c` and `$(…)`. Judge each. One question per command line, listing every risky part. |
| Scripts | `npm run …`, `make`, `./something.sh` while the **default org** is production or unknown. The mod cannot see inside the script, so it asks once and names the org. Setting `guard_scripts`, on by default. |
| MCP | Tools ending in `__deploy_metadata`, `__assign_permission_set`, `__delete_org`, `__resume_tool_operation`. Match the end of the name, because the server name is up to the user. The org is `input.usernameOrAlias`, or the default org if it is missing. ✅ `deploy_metadata` has no validate-only option, so the choices are run or cancel. Setting `guard_mcp`, on by default. |

### 6.4 Decision function

One pure function, no I/O:

```
decide({ command | mcpCall, orgMap, defaultOrg, settings })
  -> [ { segment, category, org, class, verdict, reason, rewrite? } ]
```

Verdicts: `allow`, `ask`, `refuse`. The hook asks the person once, applies a rewrite (the `--dry-run` for a deploy) and records the result. A table of examples is in Appendix B. Those examples become table tests.

### 6.5 `/sfguard`

- `/sfguard`: the last 20 decisions: time, command, org, class, verdict, answer, result.
- `/sfguard test <command>`: shows what the guard would do, without running anything. It is how you trust it, and how you reproduce a report.
- `/sfguard orgs`: every detected org with alias, username, class, and whether the class came from the CLI or from your settings.

### 6.6 Audit log

- 🔧 A ring buffer of 500 entries in `$.store`, written for every guarded command: time, session, folder, command, org, class, verdict, answer, outcome.
- 🔧 Command text is cleaned before it is stored: the values after `--password`, `--client-secret` and anything shaped like a session id are replaced.
- 🔧 `/sfguard export` writes the entries to a file you choose. The mod never sends anything anywhere.
- 🔧 Setting `audit_log`, on by default.

### 6.7 Secret protection

- 🔧 Refuse the three `org auth show-*` commands (F7 ships this early).
- 🔧 Ask before Claude reads files under `~/.sfdx` and `~/.sf`, which hold auth data. ⚠️ I believe the tokens there are encrypted with a local key, so reading is lower risk than before. They are still sensitive.
- 🔧 Remove Salesforce session ids from Bash output before Claude sees it. A session id looks like an org id, an exclamation mark and a long token. The pattern is `00D[A-Za-z0-9]{12,15}![A-Za-z0-9._]{20,}` ⚠️ (from memory). ⚠️ First check that a hook can rewrite a tool's result. If it cannot, leave this out and say so in the README.

### 6.8 Settings added in 0.7.0

`safe_orgs`, `guard_mode` (`ask` by default, or `block`, which refuses every change to a production org and lets only reads through), `guard_scripts`, `guard_mcp`, `audit_log`, `allow_secret_commands`.

### 6.9 Tests

- Table tests for `decide`: at least 60 cases (Appendix B is the start).
- Org classification: the fixture is shaped like the real `sf org list` result. It must include an alias and username used interchangeably, a Dev Hub, a trial org, and an org that is not listed.
- Guard hook: ask, validate-only, run, cancel, nobody to ask (refuse), classifier failure (ask).
- MCP tools, with the org given and missing.
- Audit log: entries written, ring buffer trimmed, secrets cleaned.

### 6.10 Done when

- The alias and the username of one org behave the same, in any letter case.
- `cd x && sf project deploy start -o prod --test-level RunLocalTests` asks.
- `bash -c "sf project deploy start -o prod --test-level RunLocalTests"` asks.
- An MCP `deploy_metadata` to production asks.
- A sandbox never asks.
- With `sf` missing, the guard falls back to your lists and the band says so.
- `/sfguard test` agrees with what really happens for every example in Appendix B.

---

## 7. Phase 3: version 0.7.0, parsers, fixtures and `/sfdoctor` (size M)

### 7.1 What is already settled ✅

The JSON field names for Apex tests, deploys, limits and config match the code (section 2.2). The parts that remain unverified are the human-readable tables and older CLI versions.

### 7.2 Plan

1. 🔧 **Fixtures from real runs.** Appendix C gives the commands to capture them, with the cleaning step. Add them to `tests/fixtures/` and make the parsers' tests read them. This is the biggest improvement in confidence per hour.
2. 🔧 **Contract tests.** For each fixture, assert the exact summary the mod would show.
3. 🔧 **Unparsed counter.** When the mod fails to summarize an `sf` output, count it and keep the first 2 KB of that output (cleaned) in memory.
4. 🔧 **`/sfdoctor`.** One command that checks the setup and prints a line per check with ✔, ⚠ or ✘ and a fix:

| Check | Fix shown |
| --- | --- |
| Claude Code is 2.1.287 or later | Update Claude Code |
| `sf` is installed, with its version | Install the Salesforce CLI |
| The apex and deploy plugins are present | `sf plugins install …` |
| `git` is installed | Install git |
| The folder contains `sfdx-project.json` | Start Claude inside your project |
| The default org resolves | `sf config set target-org <alias>` |
| Org detection works, and how many orgs are production, sandbox, scratch, unknown | Re-run `sf org login web` |
| `prod_orgs` and `safe_orgs` match real orgs | Edit in `/config` |
| Watch mode (git, folder, off) and why | Start from the project folder |
| The terminal is wide enough for the sidebar | Widen it, or use `/sffiles` |
| The store is writable | Check permissions on `~/.claude` |
| Unparsed outputs this session: a count, and `/sfdoctor record` to save them | Send them in a bug report |

5. 🔧 `/sfdoctor record` saves the last unparsed output, cleaned, to a file the person can attach to a bug report.

### 7.3 Done when

Every parser has at least one real fixture for success and one for failure. `/sfdoctor` runs in under three seconds and its output is safe to paste into an issue.

---

## 8. Phase 4: version 0.8.0, Salesforce workflow (size L)

### 8.1 Deploy errors with file and line

**Today** a failed deploy shows "Failed · 3 component errors".
**Plan:** show the first five failures: `✘ AccountService.cls:34:12  Variable does not exist: foo`. They come from `details.componentFailures[]` ✅ (`fileName`, `lineNumber`, `columnNumber`, `problem`). Failed test methods come from `details.runTestResult.failures`.

- In the Files pane, a file with a failure gets a red mark, and the problem text appears under the line in the diff.
- Pressing a key on an error selects that file.
- JSON output only at first. For the human-readable form, wait for a real fixture (section 7).

### 8.2 Validate the changed files

A key in the Files pane (`v`) runs a validation of **only the files Claude changed**:

```
sf project deploy start --dry-run --json --wait 30 -o <org>
   --source-dir <each changed metadata path>
   [--test-level RunSpecifiedTests --tests <tests for the changed classes>]
```

- The mod shows the exact command first and asks for confirmation. A dry run is safe on any org, but the confirmation shows which org.
- Paths are filtered to real metadata. README files and the `tests/` folder are left out. LWC and Aura changes are mapped to their bundle folder.
- Tests are chosen by name: `X` gives `XTest`, `X_Test`, `XTests`. If none of those exist, the command uses `RunLocalTests` and says so. ⚠️ Searching test classes by their `@IsTest` content would be more exact and slower. Not planned.
- The result shows in a toast and in the Deploys tab, and failures feed section 8.1.
- The command runs through the guard like any other.

### 8.3 Uncovered lines

`coverage.coverage[].lines` is a map of line number to 1 (covered) or 0 (not covered) ✅. With `--code-coverage` alone, the mod can mark uncovered lines.

- A fourth view in the Files pane, **Coverage**: the uncovered ranges of the selected class, each with a few lines of context, and a line like `12 uncovered lines: 40–44, 71`.
- ⚠️ Whether the code view can color single lines is unknown. The plan does not depend on it.

### 8.4 Code Analyzer

After a turn in which Apex or LWC changed, run `sf code-analyzer run --workspace . --target <changed files> --output-file <temp file>`. ✅ All of those flags exist.

- The band shows `⚠ 3 findings`. The Files pane lists them with file and line.
- Setting `code_analyzer`, **off by default**. ⚠️ It needs the plugin installed, and I believe Java on the machine for some engines. `/sfdoctor` checks both.
- ⚠️ The JSON shape of results is not verified. Capture a fixture first (Appendix C).

### 8.5 More in the band

- **Org type** chip from section 6.1: `● uat · sandbox`.
- **Scratch org expiry.** Scratch orgs carry `expirationDate` ✅. Warn at three days or fewer.
- **API version.** The project's `sourceApiVersion` in `sfdx-project.json` against the org's `apiVersion` (✅ `sf org display --json` returns `apiVersion`). Warn when the project is newer than the org. ⚠️ I have not checked every case where that matters.

### 8.6 Ask Claude to fix it

A key on a failed test or deploy sends Claude a short digest (at most 40 lines) with `$.prompt.submit({ text })` ✅. It only happens when the person presses the key. ⚠️ A hook that awaits its own prompt can hang, according to the API notes. Call it from the key handler, not from inside a hook, and test it.

### 8.7 Done when

A failing deploy and a failing test each show their file and line in the sidebar. `v` validates only the changed files, using the right tests, after a confirmation. Uncovered lines show for a class after a coverage run. All of it works from fixtures, then on one real project.

---

## 9. Phase 5: version 0.9.0, Windows, performance, editor (size M)

### 9.1 Windows

Today's folder watch uses `find`, `touch`, `/tmp` and a regular expression for `/Users/…`. Those will not work on Windows.

1. 🔧 Replace the marker file with a stored map of file to modified time, taken at the start. Poll with `$.fs.list` and `$.fs.stat` only.
2. 🔧 Watch only the folders named in `sfdx-project.json` under `packageDirectories` ✅ (a standard file). This is also a large speed gain.
3. 🔧 Read the home folder from `HOME` or `USERPROFILE`. Turn backslashes into slashes before matching paths.
4. 🔧 `rm` detection also covers `del` and `Remove-Item`. ⚠️ Which shell tool Claude Code uses on Windows is not something I checked.
5. 🔧 Add a `windows-latest` job to the GitHub check. The tests are mock based, so they run anywhere. Then try the mod by hand on a real Windows machine.

### 9.2 Performance

- **Adaptive polling:** every 2 seconds while something changed in the last 30 seconds, every 5 seconds for the next two minutes, every 15 seconds after that. The poll after a Bash command stays immediate.
- **Narrow `git status`** to the package directories.
- **Memory:** keep full text for the 50 most recent files. Older ones keep only the diff and counts.
- **Measure:** `/sfdoctor perf` times one poll and prints it, so the budget in section 3 is a number.

### 9.3 Native watcher (optional)

`$.process.spawn` ✅ can run `fswatch` (macOS) or `inotifywait` (Linux) and stream events. It needs an extra tool installed and falls back to polling without it. Build it only if measuring shows polling is too slow or too heavy.

### 9.4 Open in editor

Key `o` runs `code -g <file>:<line>` with an argument list, not a shell string, so paths with spaces are safe. Setting `editor_command`. If it is missing, show how to install the `code` command.

### 9.5 Undo (evaluate before building)

A key that restores a file to its state before Claude's latest change, after confirmation, and only if the file has not changed on disk since. ⚠️ Check first whether Claude Code already offers a rewind or checkpoint feature. Two undo systems can disagree. If it does, skip this.

### 9.6 Smaller items (optional)

- OS notification when a deploy or test run finishes while the terminal is in the background. macOS only at first. Setting `notify`, off by default.
- Remember the file list across restarts in `$.store`, keyed by folder. Store paths and counts, not content. Setting `remember_files`, off by default.

---

## 10. Docs and release process (continuous)

- `CHANGELOG.md` in the "keep a changelog" style. One entry per version.
- A GitHub release per tag (`claude plugin tag ./sf-guardian --push` makes `sf-guardian--vX.Y.Z`).
- README: a screen capture of the sidebar, and a short "how the guard decides" section.
- `SECURITY.md`: what the mod can access, and how to report a problem.
- Issue template that asks for `/sfdoctor` output.
- CI: validate and test on Linux, macOS and Windows.
- Version rules: patch for fixes, minor for features. Never rename the plugin. Settings keys are never repurposed. A key that must go is kept and ignored for one minor version.
- Test layers: pure functions, then hooks with the testing kit, then fixture contract tests, then the manual smoke checklist (Appendix D).

---

## 11. Release gate for 1.0.0

- Daily use for at least two weeks by at least three Salesforce developers, with **no case of the guard staying silent** when it should have asked.
- Every parser has real fixtures.
- Verified by hand on macOS and Windows.
- `/sfdoctor` output has been used to solve at least one real problem.
- README, CHANGELOG and SECURITY are complete.
- No open bug that changes a command's result.

---

## 12. Risks

| Risk | Likelihood | Handling |
| --- | --- | --- |
| The mod API is early access and changes. | Medium | Pin a minimum Claude Code version. Keep the CI job on the latest release. Feature flags around the newest parts (live typing). |
| A real sf output differs from the fixtures I have. | Medium | Section 7. `/sfdoctor record`. Fall back to the plain output on any parse failure, never an error. |
| The guard gives false confidence. | Medium | The README says it is a safety net, not a security boundary: a script the mod cannot read, or a tool it does not know, can still reach an org. Org-side controls (permissions, deployment rules) are the real protection. |
| False alarms annoy people into turning it off. | Medium | `safe_orgs`, `/sfguard test`, and read-only commands never ask. |
| Heavy redraws while streaming. | Low to medium | Throttle, caps, measure. |
| Windows has more surprises than listed. | High | Test on a real machine before 0.9.0 ships. |

---

## 13. What I need from you

1. **Real sf output**, cleaned (Appendix C): an org list, a passing and a failing Apex test run, a successful and a failed deploy dry run, org limits, and a Code Analyzer run if you use it.
2. **Which systems your team uses:** macOS, Windows, Linux.
3. **Your editor:** VS Code, Cursor or another.
4. **Policy:** should Claude be able to change production at all, with a question first (`ask`), or never (`block`)?
5. **Who will use it:** only you, your team, or the public. That decides how much Windows and documentation work comes first.
6. **Whether you use the Salesforce MCP server.** That decides whether the MCP guard is a priority.

Recommended order if you want only one decision from this list: send item 1 and answer item 4. Those two unblock the most.

---

## Appendix A: tested code

These are in the plan because they are the parts most likely to be wrong. Each one passed its tests before I put it here.

### A1. Read one string field out of partial JSON

Tested by streaming 4,000 random objects (quotes, backslashes, tabs, `é`, Japanese, emoji, text that looks like JSON) in random pieces. Over about 97,000 partial inputs, the decoded text was always the start of the real text, and the final text was always exact.

```js
// ── 1. Read one string field out of a PARTIAL JSON object (a tool call's arguments as they stream) ──
export function readStringField(partial, key) {
  const m = new RegExp('"' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"\\s*:\\s*"').exec(partial)
  if (!m) return { found: false, text: '', done: false }
  let out = ''
  let i = m.index + m[0].length
  for (; i < partial.length; i++) {
    const c = partial[i]
    if (c === '"') return { found: true, text: out, done: true }
    if (c !== '\\') { out += c; continue }
    const n = partial[i + 1]
    if (n === undefined) break // a lone backslash at the end: wait for the next piece
    if (n === 'u') {
      const hex = partial.slice(i + 2, i + 6)
      if (hex.length < 4) break // \uXX cut off: wait
      let code = parseInt(hex, 16)
      i += 5
      // a high surrogate needs its low half; wait for it rather than emit half a character
      if (code >= 0xd800 && code <= 0xdbff) {
        const lo = partial.slice(i + 1, i + 7)
        if (!/^\\u[dD][c-fC-F][0-9a-fA-F]{2}$/.test(lo)) { if (lo.length < 6) break; }
        else { out += String.fromCharCode(code, parseInt(lo.slice(2), 16)); i += 6; continue }
      }
      out += String.fromCharCode(code)
      continue
    }
    out += { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/' }[n] ?? n
    i += 1
  }
  return { found: true, text: out, done: false }
}
```

### A2. Split a shell line into simple commands

Tested on chains with `&&`, `||`, `;`, `|`, `&` and newlines, with operators inside quotes, and with `bash -c`, `sh -c` and `$(…)`.

```js
// ── 2. Split a shell line into simple commands, aware of quotes, so each can be judged alone ──
export function splitCommands(line) {
  const out = []
  let cur = '', q = null
  const push = () => { if (cur.trim()) out.push(cur.trim()); cur = '' }
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (q) { cur += c; if (c === '\\' && q === '"') cur += line[++i] ?? ''; else if (c === q) q = null; continue }
    if (c === '\\') { cur += c + (line[++i] ?? ''); continue }
    if (c === "'" || c === '"' || c === '`') { q = c; cur += c; continue }
    if (c === '\n' || c === ';') { push(); continue }
    if ((c === '&' || c === '|') ) { if (line[i + 1] === c) i++; push(); continue }
    cur += c
  }
  push()
  return out
}
// the text inside bash -c "…", sh -c '…' and $(…), so a wrapped command is not missed
export function innerScripts(cmd) {
  const found = []
  for (const m of cmd.matchAll(/\b(?:bash|sh|zsh)\s+-l?c\s+("(?:[^"\\]|\\.)*"|'[^']*')/g)) found.push(m[1].slice(1, -1))
  for (const m of cmd.matchAll(/\$\(([^()]*)\)/g)) found.push(m[1])
  return found
}
```

### A3. Classify orgs

Tested on a fixture shaped like the real `sf org list` result: alias and username used interchangeably in any case, a Dev Hub, a sandbox with no alias, a scratch org, a trial org, an unlisted org, both override lists, and no `sf` at all.

```js
// Turn `sf org list --json --skip-connection-status` into a lookup: alias OR username -> class.
// Groups are the ones the CLI itself returns (plugin-org OrgListResult): sandboxes, scratchOrgs, devHubs, other.
// `nonScratchOrgs` only duplicates the others (deprecated), so it is ignored.
export function classifyOrgs(listResult, { prodOrgs = [], safeOrgs = [] } = {}) {
  const map = new Map()
  const add = (org, cls) => {
    const entry = { cls, alias: org.alias ?? null, username: org.username ?? null }
    for (const key of [org.alias, org.username]) if (key) map.set(String(key).toLowerCase(), entry)
  }
  for (const o of listResult.other ?? []) add(o, 'production') // not a sandbox, not a scratch org
  for (const o of listResult.devHubs ?? []) add(o, 'production') // a Dev Hub is often production
  for (const o of listResult.sandboxes ?? []) add(o, 'sandbox')
  for (const o of listResult.scratchOrgs ?? []) add(o, 'scratch')
  // the person's own lists win, and apply to the alias and the username of the same org
  const force = (names, cls) => {
    for (const n of names) {
      const hit = map.get(String(n).toLowerCase())
      const entry = hit ? { ...hit, cls } : { cls, alias: null, username: String(n) }
      for (const key of [entry.alias, entry.username, n]) if (key) map.set(String(key).toLowerCase(), entry)
    }
  }
  force(safeOrgs, 'sandbox')
  force(prodOrgs, 'production')
  return map
}
// Unknown means "we cannot tell", and the guard treats it like production.
export function orgClass(map, name) {
  if (!name) return 'unknown'
  return map.get(String(name).toLowerCase())?.cls ?? 'unknown'
}
export const needsAsk = (cls) => cls !== 'sandbox' && cls !== 'scratch'
```

---

## Appendix B: guard examples (they become tests)

"Default org" means no `-o` in the command, so the default org is used.

| Command | Org and class | Verdict |
| --- | --- | --- |
| `sf project deploy start -o prod --test-level RunLocalTests` | prod, production | Ask: validate only, run, cancel |
| `sf project deploy start -o prod` | prod, production | Refuse: no test level |
| `sf project deploy start -o uat` | uat, sandbox | Allow |
| `sf project deploy start` | default org is production | Same as the first two rows |
| `sf data delete record -s Account -i 001… -o release@acme.com` | username of the production org | Ask |
| `cd force-app && sf project deploy start -o prod --test-level RunLocalTests` | prod | Ask. `--dry-run` goes on the deploy part only |
| `sf project deploy start -o prod --test-level RunLocalTests && sf data update record … -o prod` | prod, twice | One question listing both parts |
| `bash -c "sf project deploy start -o prod --test-level RunLocalTests"` | prod, wrapped | Ask |
| `echo "sf project deploy start -o prod"` | text only | Allow |
| `sf data query -q "SELECT Id FROM Account" -o prod` | prod | Allow (read only) |
| `sf apex run test -n AccountServiceTest -o prod --wait 10` | prod | Allow |
| `sf apex run -f script.apex -o prod` | prod | Ask |
| `sf org assign permset -n Admin_Access -o prod` | prod | Ask |
| `sf package install -p 04t… -o prod` | prod | Ask |
| `sf org delete sandbox -o uat` | uat, sandbox | Ask (lifecycle always asks) |
| `sf org auth show-access-token -o uat` | any | Refuse |
| `sf org display -o prod` | prod | Allow |
| `npm run deploy` while the default org is production | default org | Ask once, naming the org |
| MCP `deploy_metadata` with `usernameOrAlias: "prod"` | prod | Ask: run or cancel |
| MCP `deploy_metadata` with no org given | default org | Judged on the default org |
| `-o somewhere` and the org is not in the list | unknown | Ask |
| `sf` missing and `-o prod` with no `prod_orgs` set | unknown | Ask, and the band shows `org detection off` |

---

## Appendix C: capture real sf output safely

Run these from your Salesforce project. Replace `<sandbox>` and the class names. Use a **sandbox** for everything except the org list.

```bash
mkdir -p ~/sf-fixtures
sf org list --json --skip-connection-status                      > ~/sf-fixtures/org-list.json
sf apex run test --class-names YourPassingTest --code-coverage --json --wait 10 -o <sandbox> > ~/sf-fixtures/apex-pass.json
sf apex run test --class-names YourFailingTest --code-coverage --json --wait 10 -o <sandbox> > ~/sf-fixtures/apex-fail.json
sf project deploy start --dry-run --json --wait 30 -o <sandbox> --source-dir force-app/main/default/classes > ~/sf-fixtures/deploy-ok.json
# a deploy that fails: change one class so it does not compile, run the same command, then undo the change
sf project deploy start --dry-run --json --wait 30 -o <sandbox> --source-dir force-app/main/default/classes > ~/sf-fixtures/deploy-fail.json
sf org list limits --json -o <sandbox>                            > ~/sf-fixtures/limits.json
sf code-analyzer run --workspace . --target force-app --output-file ~/sf-fixtures/analyzer.json
```

A failing test or deploy makes `sf` exit with an error. The `>` still saves the output.

Then remove personal details before sharing. On macOS or Linux:

```bash
cd ~/sf-fixtures
for f in *.json; do
  sed -E \
    -e 's/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/user@example.com/g' \
    -e 's/00[DO][A-Za-z0-9]{12,15}/00DXXXXXXXXXXXXXXX/g' \
    -e 's#https://[A-Za-z0-9.-]+\.salesforce\.com#https://example.my.salesforce.com#g' \
    "$f" > "clean-$f"
done
```

Open one clean file and read it before you send it. The patterns catch email addresses, org ids and Salesforce web addresses. They will not catch names of your own classes or fields. Look for anything you would not want public.

---

## Appendix D: release smoke checklist

Run in a real sandbox project, in a terminal at least 144 columns wide, before each release.

1. `claude plugin validate`, then `claude plugin test`: all green.
2. Start Claude in the project. `/plugin` shows the mod. The band shows the right org and class.
3. `/sfdoctor` shows no ✘.
4. Ask Claude to create a new class. The sidebar shows it **while it is written**, then as `new file`.
5. Ask for a change to an existing class. Latest, All and File views show the right text.
6. Press `x` to clear, then make another change. Only the new change appears.
7. Change a file yourself in your editor. It shows within a few seconds.
8. Delete a file with `rm`. It shows as deleted, with what it held.
9. Ask Claude to deploy to the sandbox. No question. The row is compact and the toast appears.
10. Ask Claude to deploy to production. The question appears. Choose Cancel. Nothing deploys.
11. Do the same with the org's **username** instead of its alias. The question still appears.
12. Run a passing and a failing test. Summaries and coverage are right.
13. Deny a file edit at the permission prompt. No draft is left behind.
14. Close the sidebar with `Esc`, reopen it with `/sffiles`.
15. `/sfguard` shows the decisions from steps 9 to 11.

---

## Appendix E: settings

**Today (0.5.0)**

| Key | Default | Purpose |
| --- | --- | --- |
| `prod_orgs` | empty | Aliases or usernames that are production |
| `auto_open_files` | on | Open the Files sidebar at the first change |
| `files_pane_width` | 72 | Sidebar width in columns |
| `compact_sf_rows` | on | Short rows and summaries for sf |
| `show_band` | on | The status line above the prompt |
| `coverage_target` | 85 | Green coverage threshold |

**Planned**

| Key | Default | Version | Purpose |
| --- | --- | --- | --- |
| `allow_secret_commands` | off | 0.5.1 | Lets Claude run `sf org auth show-*` |
| `live_typing` | on | 0.6.0 | Show text as it is written |
| `safe_orgs` | empty | 0.7.0 | Orgs that are never production |
| `guard_mode` | `ask` | 0.7.0 | `ask`, or `block` for no changes to production |
| `guard_scripts` | on | 0.7.0 | Ask before scripts while the default org is production |
| `guard_mcp` | on | 0.7.0 | Guard the Salesforce MCP tools |
| `audit_log` | on | 0.7.0 | Local record of guarded commands |
| `code_analyzer` | off | 0.8.0 | Run Code Analyzer after Apex and LWC changes |
| `editor_command` | `code` | 0.9.0 | Editor for the open-in-editor key |
| `notify` | off | 0.9.0 | System notification when a deploy or test ends |
| `remember_files` | off | 0.9.0 | Keep the file list across restarts |
