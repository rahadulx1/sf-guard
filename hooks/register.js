// SF Guardian v0.9 — a Claude Code mod for Salesforce developers
//
// Settings live in /config (or `claude plugin configure sf-guardian@sf-guard`),
// so updating the mod never touches them.
//
// Safety      Guard v2: orgs are classified from `sf org list` (production, sandbox,
//             scratch, unknown). Changes aimed at production or unknown orgs ask
//             first; secret-printing commands are refused; chains, wrappers
//             (bash -c, $(…)), scripts and the Salesforce MCP tools are judged.
//             Every decision is explained (/sfguard) and logged locally.
// Awareness   Band above the prompt: org and its class, scratch expiry, API version,
//             untested Apex, changed files, analyzer findings, last deploy.
// Live files  Sidebar listing every file Claude creates, edits or deletes, with the
//             text appearing while the model writes it (live typing).
// Workflow    Deploy and test failures with file and line, validate the changed
//             files, uncovered lines, Code Analyzer, ask Claude to fix, open in editor.
// Commands    /sffiles /sfpanel /sforg /deploys /sflimits /sfguard /sfdoctor
//
// Rules: tracking and drawing fail open; the guard fails closed. Logic lives in
// ./lib as pure functions; the hooks here stay thin.

import { splitLines, unifiedDiff } from './lib/diff.js'
import { createDrafts, tailLines } from './lib/draft.js'
import { allSimpleCommands, flagValue, programName, tokenize } from './lib/shell.js'
import { classifyOrgs, compareApi, daysUntil, needsAsk, orgClass, orgEntry, slimOrgList, uniqueOrgs } from './lib/orgs.js'
import { CATEGORY_LABEL, applyDryRun, changesLogins, choicesFor, decide, mcpToolOf, questionFor, scriptRefOf, sfCommandOf } from './lib/guard.js'
import { componentOf, lintSource, namingProblem, soqlFields } from './lib/lint.js'
import { normalizePrefix, standardsText } from './lib/standards.js'
import { deployScope, manifestXml, memberOf, retrieveArgs, sameText, typeFolderTail } from './lib/metadata.js'
import { isPermissionFile, permissionChanges } from './lib/permissions.js'
import { POLICY_FILE, mergePolicy, parsePolicy, policySummary } from './lib/policy.js'
import {
  failureLine,
  isUnknownCommand,
  metadataPathOf,
  outputText,
  parseAnalyzer,
  parseLimits,
  ranges,
  sampleOutput,
  sanitizeCommand,
  scrubSecrets,
  summarizeDeploy,
  summarizeTests,
  testCandidates,
} from './lib/sf.js'

// ── Settings (filled from userConfig in register) ───────────────────────────
const cfg = {
  prodOrgs: [],
  safeOrgs: [],
  autoOpenFiles: true,
  filesPaneWidth: 72,
  compactRows: true,
  showBand: true,
  coverageTarget: 85,
  allowSecretCommands: false,
  liveTyping: true,
  guardMode: 'ask',
  guardScripts: true,
  guardMcp: true,
  auditLog: true,
  codeAnalyzer: false,
  editorCommand: 'code',
  notify: false,
  rememberFiles: false,
  codingStandards: true,
  namePrefix: '',
  codeChecks: true,
  backupBeforeDeploy: true,
}
let personal = { ...cfg }
let teamPolicy = null
let teamNote = ''
const backups = []
const COVERAGE_MIN = 75
const MIN_CLAUDE = '2.1.287'
let modVersion = '0.11.0' // read from plugin.json at session start; this is the fallback

const PANE = 'sf-guardian'
const FILES_PANE = 'sf-files'
const BAND_REFRESH_MS = 30000
const TICK_MS = 2000
const DRAW_MS = 250 // live typing: at most four redraws a second
const FRESH_MS = 6000 // a change this recent is highlighted
const ORG_CACHE_MS = 10 * 60 * 1000
const AUDIT_MAX = 500
const FULL_TEXT_FILES = 50 // older files keep only their diffs
const MAX_TRACKED_BYTES = 1000000
const MAX_PREVIEW_LINES = 160
const DRAFT_ROWS = 40
const DRAFT_DIFF_MAX_LINES = 2000
const LIST_ROWS = 8
const PREVIEW_CONTEXT = 12
const MAX_TREE_FILES = 50000
const SKIP_DIRS = new Set(['.git', 'node_modules', '.sfdx', '.sf', '.localdevserver', '.husky', '.idea', '.vscode', 'coverage'])
const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|bmp|pdf|zip|jar|gz|tgz|woff2?|ttf|otf|eot|mp3|mp4|mov|resource|class|so|dylib|exe)$/i
const TEST_NAME = /^Test|_?Tests?$/
const READ_ONLY_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'Bash', 'WebFetch', 'WebSearch', 'AskUserQuestion', 'Task', 'Agent', 'TodoWrite'])

// ── Session state (resets when the mod reloads) ─────────────────────────────
let defaultOrg = null
let sfTab = 'apex'
let lastLimits = null
let limitsLoading = false
let running = null
let platform = 'unknown'
let home = ''
let sessionKey = ''
const deployLog = []
const apex = new Map()
const coverage = new Map() // class -> percent
const uncovered = new Map() // class -> uncovered line numbers
const editedThisTurn = new Set()
const changedThisTurn = new Set() // paths, for Code Analyzer
const sfCalls = new Map()
const turnTokens = new Map()

// Orgs
let orgList = [] // slim orgs from the CLI
let orgMap = new Map()
let orgDetection = 'starting' // 'starting', 'on', 'off'
let orgNote = ''
let orgLoadedAt = 0
let orgPromise = null

// Guard
const decisions = [] // the last decisions this session, newest last
let auditCache = null

// Diagnostics
const unparsed = { count: 0, samples: [] }

// Problems: deploy and test failures, analyzer findings
let lastDeployProblems = [] // { file, line, col, problem }
let lastTestProblems = [] // { name, message, cls, line }
let analyzerFindings = [] // { file, line, col, problem, rule, severity }
let analyzerRunning = false
let validating = false
const describeCache = new Map()
let describing = null

// Live typing
const drafts = createDrafts()
let liveDisabled = false
let lastDrawAt = 0

// Live files
const files = new Map() // absolute path (forward slashes) -> entry
const dismissed = new Map() // path -> { mtime, content } when cleared
let selectedFile = null // a path, or 'draft:<id>'
let followLatest = true
let filesView = 'latest' // 'latest', 'all', 'file', 'coverage'
let filesAutoOpened = false
let filesPaneOpen = false
let cwd = ''
const lastTools = []
let watchMode = 'starting' // 'starting', 'git', 'folder', 'off'
let watchNote = ''
let gitRoot = ''
let gitBaseline = null
let folderBaseline = null // Map path -> mtime
let pollPromise = null
let lastPollAt = 0
let lastChangeAt = 0
let lastPollMs = null
let project = null // { root, packageDirs: [abs], sourceApiVersion }

// ── Settings ────────────────────────────────────────────────────────────────
function listOf(v) {
  const s = Array.isArray(v) ? v.join(',') : String(v ?? '')
  return s
    .split(/[,\s]+/)
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean)
}

function applyOptions(options) {
  const o = options || {}
  cfg.prodOrgs = listOf(o.prod_orgs)
  cfg.safeOrgs = listOf(o.safe_orgs)
  const bool = (key, field) => {
    if (typeof o[key] === 'boolean') cfg[field] = o[key]
  }
  bool('auto_open_files', 'autoOpenFiles')
  bool('compact_sf_rows', 'compactRows')
  bool('show_band', 'showBand')
  bool('allow_secret_commands', 'allowSecretCommands')
  bool('live_typing', 'liveTyping')
  bool('guard_scripts', 'guardScripts')
  bool('guard_mcp', 'guardMcp')
  bool('audit_log', 'auditLog')
  bool('code_analyzer', 'codeAnalyzer')
  bool('notify', 'notify')
  bool('remember_files', 'rememberFiles')
  bool('coding_standards', 'codingStandards')
  bool('code_checks', 'codeChecks')
  bool('backup_before_deploy', 'backupBeforeDeploy')
  cfg.namePrefix = normalizePrefix(o.name_prefix)
  const width = Number(o.files_pane_width)
  if (Number.isFinite(width) && width >= 40) cfg.filesPaneWidth = Math.min(160, Math.round(width))
  const target = Number(o.coverage_target)
  if (Number.isFinite(target)) cfg.coverageTarget = Math.max(COVERAGE_MIN, Math.min(100, target))
  if (o.guard_mode === 'block' || o.guard_mode === 'ask') cfg.guardMode = o.guard_mode
  if (typeof o.editor_command === 'string' && o.editor_command.trim()) cfg.editorCommand = o.editor_command.trim()
  personal = { ...cfg }
  applyTeamPolicy()
}

function applyTeamPolicy() {
  Object.assign(cfg, mergePolicy(personal, teamPolicy))
  cfg.namePrefix = normalizePrefix(cfg.namePrefix)
  rebuildOrgMap()
}

async function loadTeamPolicy($, root) {
  const path = root + '/' + POLICY_FILE
  teamPolicy = null
  teamNote = ''
  try {
    if (await $.fs.exists(path)) teamPolicy = parsePolicy(await $.fs.read(path))
  } catch (err) {
    teamNote = POLICY_FILE + ' could not be read: ' + String(err?.message ?? err)
  }
  applyTeamPolicy()
}

function guardSettings() {
  const riskyPermissionFiles = [...files.values()]
    .filter((f) => f.status !== 'deleted' && f.perms?.some((x) => x.risky && x.added))
    .map((f) => ({ rel: projectRel(f.path), member: memberOf(projectRel(f.path)), grants: f.perms.filter((x) => x.risky && x.added).map((x) => x.text) }))
  return { guardMode: cfg.guardMode, guardScripts: cfg.guardScripts, guardMcp: cfg.guardMcp, allowSecretCommands: cfg.allowSecretCommands, riskyPermissionFiles }
}

// ── Paths (forward slashes everywhere, so Windows paths match too) ──────────
const norm = (p) => String(p ?? '').replace(/\\/g, '/')
const isAbs = (p) => /^([A-Za-z]:)?\//.test(p)

function absPath(path) {
  const p = norm(path)
  if (isAbs(p)) return p
  if (p.startsWith('~/') && home) return home + p.slice(1)
  return (cwd ? cwd + '/' : '') + p.replace(/^\.\//, '')
}

function relPath(path) {
  const root = gitRoot || cwd
  return root && path.startsWith(root + '/') ? path.slice(root.length + 1) : path
}

function projectRel(path) {
  const root = project?.root || cwd
  return root && path.startsWith(root + '/') ? path.slice(root.length + 1) : path
}

function splitPath(path) {
  const rel = relPath(path)
  const i = rel.lastIndexOf('/')
  return i < 0 ? { dir: '', base: rel } : { dir: rel.slice(0, i + 1), base: rel.slice(i + 1) }
}

function tildify(p) {
  if (!p) return p
  if (home && (p === home || p.startsWith(home + '/'))) return '~' + p.slice(home.length)
  return p.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~')
}

async function ensureCwd($) {
  if (cwd) return
  try {
    cwd = norm(await $.session.cwd())
  } catch {
    cwd = ''
  }
}

async function ensureHome($) {
  if (home) return home
  let v = null
  try {
    v = await $.env.get('HOME')
  } catch {
    v = null
  }
  if (!v) {
    try {
      v = await $.env.get('USERPROFILE') // Windows
    } catch {
      v = null
    }
  }
  if (v) home = norm(v).replace(/\/$/, '')
  return home
}

// ── Formatting ──────────────────────────────────────────────────────────────
function ago(at) {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (s < 5) return 'now'
  if (s < 60) return s + 's'
  if (s < 3600) return Math.floor(s / 60) + 'm'
  return Math.floor(s / 3600) + 'h'
}

function agoLong(at) {
  const short = ago(at)
  return short === 'now' ? 'just now' : short + ' ago'
}

function duration(ms) {
  const s = Math.round(ms / 1000)
  return s < 60 ? s + 's' : Math.floor(s / 60) + 'm ' + (s % 60) + 's'
}

function tokens(n) {
  return n >= 1000 ? (n / 1000).toFixed(n >= 100000 ? 0 : 1) + 'k' : String(n)
}

function plural(n, word) {
  return n + ' ' + word + (n === 1 ? '' : 's')
}

function deployLine(d, i) {
  return `${i + 1}. ${d.time} · ${d.org} · ${d.kind} · ${d.ok ? '✔ succeeded' : '✘ failed or refused'}`
}

function limitLine(l) {
  const pct = l.max ? Math.round((l.used * 100) / l.max) : 0
  return `${pct >= 80 ? '⚠️' : '  '} ${l.name}: ${l.used.toLocaleString()} / ${l.max.toLocaleString()} (${pct}%)`
}

function limitsText(data) {
  if (data.error) return data.error
  return 'API limits for ' + data.org + ' at ' + data.at + (data.legacy ? ' (old sf CLI: used sf limits api display)' : '') + '\n' + data.rows.map(limitLine).join('\n')
}

function coverageColor(pct) {
  return pct >= cfg.coverageTarget ? 'green' : pct >= COVERAGE_MIN ? 'yellow' : 'red'
}

function coverageBar(pct) {
  const filled = Math.max(0, Math.min(10, Math.round(pct / 10)))
  return '█'.repeat(filled) + '░'.repeat(10 - filled)
}

function versionAtLeast(v, min) {
  const a = String(v).match(/\d+/g)?.map(Number) ?? []
  const b = min.split('.').map(Number)
  for (let i = 0; i < b.length; i++) {
    if ((a[i] ?? 0) > b[i]) return true
    if ((a[i] ?? 0) < b[i]) return false
  }
  return true
}

// ── sf: what a command is, for rows and the spinner ─────────────────────────
function describeSf(command) {
  for (const seg of allSimpleCommands(command)) {
    const sf = sfCommandOf(tokenize(seg))
    if (!sf) continue
    const named = sf.words.find((w, i) => (sf.words[i - 1] === '-o' || sf.words[i - 1] === '--target-org') && w) ?? sf.words.find((w) => w.startsWith('--target-org='))?.slice(13)
    const org = named ?? defaultOrg ?? 'default org'
    const dry = sf.words.includes('--dry-run') || sf.words.includes('--checkonly')
    if (sf.category === 'deploy' || sf.category === 'deploy-quick' || sf.category === 'validate') {
      const verb = dry || sf.category === 'validate' ? 'Validate' : sf.category === 'deploy-quick' ? 'Quick deploy' : 'Deploy'
      const doing = verb === 'Validate' ? 'Validating on ' + org : verb === 'Quick deploy' ? 'Quick deploying to ' + org : 'Deploying to ' + org
      return { type: 'deploy', icon: '🚀', label: verb + ' → ' + org, org, doing, dry: verb === 'Validate' }
    }
    if (/^apex run test|^force:apex:test:run/.test(sf.topic)) {
      const names = testNamesOf(sf.words)
      const shown = names.length > 3 ? names.slice(0, 3).join(', ') + ' +' + (names.length - 3) : names.join(', ')
      return { type: 'test', icon: '🧪', label: 'Apex tests' + (shown ? ' (' + shown + ')' : '') + ' → ' + org, org, doing: 'Running Apex tests on ' + org }
    }
    if (sf.category && sf.category !== 'log') {
      const label = 'sf ' + sf.topic + ' → ' + org
      return { type: 'data', icon: '⚠️', label, org, doing: 'Running ' + label }
    }
  }
  return null
}

function testNamesOf(words) {
  const names = []
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    let val = null
    if (['--class-names', '-n', '--tests', '-t'].includes(w)) val = words[i + 1]
    else {
      const m = w.match(/^--(?:class-names|tests)=(.+)$/)
      if (m) val = m[1]
    }
    if (!val) continue
    for (const raw of val.split(',')) {
      const name = raw.trim().split('.')[0]
      if (name && !names.includes(name)) names.push(name)
    }
  }
  return names
}

function namesTests(command) {
  return /--test-level\b|(?:^|\s)-l[=\s]/.test(command)
}

function waitsForResults(command) {
  return /--wait\b|(?:^|\s)-w[=\s]|--synchronous\b|(?:^|\s)-y\b/.test(command)
}

function markTested(command) {
  if (/RunLocalTests|RunAllTestsInOrg/.test(command)) {
    for (const c of apex.values()) c.tested = true
    return
  }
  for (const seg of allSimpleCommands(command)) {
    for (const testName of testNamesOf(tokenize(seg))) {
      for (const key of [testName, testName.replace(/_?Tests?$/, '')]) {
        const c = apex.get(key)
        if (c) c.tested = true
      }
    }
  }
}

function untestedOf(names) {
  return names.filter((n) => apex.has(n) && !apex.get(n).tested)
}

function noteUnparsed(text) {
  unparsed.count++
  unparsed.samples.push({ at: Date.now(), text: sampleOutput(text) })
  if (unparsed.samples.length > 5) unparsed.samples.shift()
}

// ── Orgs ────────────────────────────────────────────────────────────────────
function rebuildOrgMap() {
  orgMap = classifyOrgs(orgDetection === 'on' ? orgList : [], { prodOrgs: cfg.prodOrgs, safeOrgs: cfg.safeOrgs })
}

function clsOf(org) {
  return orgClass(orgMap, org)
}

async function storeGet($, key) {
  try {
    return await $.store.get(key)
  } catch {
    return undefined
  }
}

async function storeSet($, key, value) {
  try {
    await $.store.set(key, value)
    return true
  } catch {
    return false
  }
}

async function loadOrgsFromCli($) {
  let r = null
  try {
    r = await $.process.run(['sf', 'org', 'list', '--json', '--skip-connection-status'], { timeoutMs: 30000 })
  } catch {
    r = null
  }
  if (!r) {
    orgDetection = 'off'
    orgNote = 'sf not found'
  } else {
    let list = null
    try {
      const j = JSON.parse(r.stdout)
      if (j && j.result) list = slimOrgList(j.result)
    } catch {
      list = null
    }
    if (list) {
      orgList = list
      orgDetection = 'on'
      orgNote = ''
      orgLoadedAt = Date.now()
      void storeSet($, 'orgList', { at: orgLoadedAt, list })
    } else {
      orgDetection = 'off'
      orgNote = 'sf org list failed'
    }
  }
  rebuildOrgMap()
  $.ui.invalidate('ui.render')
}

// Refresh in the background; callers that need the result await the promise
function refreshOrgs($) {
  if (!orgPromise) {
    orgPromise = loadOrgsFromCli($)
      .catch(() => {
        orgDetection = 'off'
        orgNote = 'org detection failed'
        rebuildOrgMap()
      })
      .finally(() => {
        orgPromise = null
      })
  }
  return orgPromise
}

async function startOrgs($) {
  const cached = await storeGet($, 'orgList')
  if (cached && Array.isArray(cached.list) && Date.now() - Number(cached.at) < ORG_CACHE_MS) {
    orgList = cached.list
    orgDetection = 'on'
    orgLoadedAt = Number(cached.at)
    rebuildOrgMap()
  }
  void refreshOrgs($)
}

// The guard waits for the org map when it is still loading
async function orgsForGuard($) {
  if (orgDetection === 'starting') {
    if (!orgPromise) void refreshOrgs($)
    if (orgPromise) await orgPromise
  } else if (orgDetection === 'on' && Date.now() - orgLoadedAt > ORG_CACHE_MS) {
    void refreshOrgs($) // stale: refresh for next time, judge on what we have
  }
  return orgMap
}

async function readDefaultOrg($) {
  try {
    const r = await $.process.run(['sf', 'config', 'get', 'target-org', '--json'], { timeoutMs: 15000 })
    if (r.exitCode !== 0) return null
    return JSON.parse(r.stdout).result?.[0]?.value ?? null
  } catch {
    return null
  }
}

async function fetchLimits($, org) {
  const run = async (args) => {
    const full = [...args, '--json']
    if (org) full.push('--target-org', org)
    return $.process.run(full, { timeoutMs: 60000 })
  }
  try {
    let legacy = false
    let r = await run(['sf', 'org', 'list', 'limits'])
    if (r.exitCode !== 0 && isUnknownCommand(r.stderr + r.stdout)) {
      legacy = true
      r = await run(['sf', 'limits', 'api', 'display'])
    }
    if (r.exitCode !== 0) return { error: 'sf org list limits failed: ' + String(r.stderr || r.stdout || '').trim().slice(0, 200) }
    return { org: org ?? '(default)', at: new Date().toLocaleTimeString(), rows: parseLimits(r.stdout), legacy }
  } catch {
    return { error: 'Could not run sf. Is the Salesforce CLI installed?' }
  }
}

// ── Project (sfdx-project.json) ─────────────────────────────────────────────
async function loadProject($) {
  await ensureCwd($)
  if (!cwd) return null
  let text = null
  let root = cwd
  try {
    text = await $.fs.read(cwd + '/sfdx-project.json')
  } catch {
    text = null
  }
  if (text === null && gitRoot && gitRoot !== cwd) {
    try {
      text = await $.fs.read(gitRoot + '/sfdx-project.json')
      root = gitRoot
    } catch {
      text = null
    }
  }
  await loadTeamPolicy($, root)
  if (text === null) {
    project = { root: cwd, packageDirs: [], sourceApiVersion: null, found: false }
    return project
  }
  try {
    const j = JSON.parse(text)
    const dirs = (j.packageDirectories ?? []).map((d) => norm(d.path ?? '').replace(/^\.\//, '').replace(/\/$/, '')).filter(Boolean)
    project = { root, packageDirs: dirs.map((d) => root + '/' + d), relDirs: dirs, sourceApiVersion: j.sourceApiVersion ?? null, found: true }
  } catch {
    project = { root, packageDirs: [], relDirs: [], sourceApiVersion: null, found: true, broken: true }
  }
  return project
}

// ── Audit log ───────────────────────────────────────────────────────────────
async function auditEntries($) {
  if (auditCache) return auditCache
  const stored = await storeGet($, 'audit')
  auditCache = Array.isArray(stored) ? stored : []
  return auditCache
}

async function audit($, entry) {
  const row = {
    at: new Date().toISOString(),
    session: sessionKey,
    folder: tildify(cwd),
    command: sanitizeCommand(entry.command ?? ''),
    org: entry.org ?? null,
    cls: entry.cls ?? null,
    verdict: entry.verdict,
    answer: entry.answer ?? null,
    outcome: entry.outcome ?? null,
    reason: entry.reason ?? null,
  }
  decisions.push(row)
  if (decisions.length > 50) decisions.shift()
  if (!cfg.auditLog) return row
  try {
    const list = await auditEntries($)
    list.push(row)
    while (list.length > AUDIT_MAX) list.shift()
    await storeSet($, 'audit', list)
  } catch {
    // The log never changes a command's result
  }
  return row
}

function decisionLine(d) {
  const t = new Date(d.at).toLocaleTimeString()
  return `${t} · ${d.verdict}${d.answer ? ' → ' + d.answer : ''}${d.outcome ? ' · ' + d.outcome : ''} · ${d.org ?? '?'} (${d.cls ?? '?'}) · ${d.command}`
}

// ── The guard ───────────────────────────────────────────────────────────────
async function readScripts($, command) {
  const scripts = {}
  if (!cfg.guardScripts) return scripts
  let pkg
  for (const seg of allSimpleCommands(command)) {
    const ref = scriptRefOf(tokenize(seg))
    if (!ref) continue
    const key = ref.kind + ':' + ref.name
    if (key in scripts) continue
    try {
      if (ref.kind === 'npm') {
        if (pkg === undefined) {
          try {
            pkg = JSON.parse(await $.fs.read(absPath('package.json')))
          } catch {
            pkg = null
          }
        }
        const s = pkg?.scripts?.[ref.name]
        if (typeof s === 'string') scripts[key] = s
        else if (pkg) scripts[key] = '' // no such script: npm fails, nothing runs
      } else if (ref.kind === 'make') {
        for (const name of ['Makefile', 'makefile', 'GNUmakefile']) {
          try {
            scripts[key] = await $.fs.read(absPath(name))
            break
          } catch {
            // next name
          }
        }
      } else if (ref.kind === 'file') {
        scripts[key] = await $.fs.read(absPath(ref.name))
      }
    } catch {
      // unreadable: the guard asks
    }
  }
  return scripts
}

async function judge($, command) {
  // A command with no sf part and no script needs no org map: judge it at once
  const quick = decide({ command, orgMap, defaultOrg, settings: { ...guardSettings(), guardScripts: false } })
  const hasScript = cfg.guardScripts && allSimpleCommands(command).some((seg) => scriptRefOf(tokenize(seg)))
  if (quick.parts.length === 0 && !hasScript) return quick
  await orgsForGuard($)
  const scripts = await readScripts($, command)
  return decide({ command, orgMap, defaultOrg, settings: guardSettings(), scripts })
}

async function askPerson($, question, choices) {
  try {
    return await $.ui.ask(question, { options: choices, header: 'SF Guardian' })
  } catch {
    return null // dismissed, or nobody to ask
  }
}

// Ask about reading auth files under ~/.sf and ~/.sfdx
function isAuthPath(p) {
  if (!p || !home) return false
  const a = absPath(p)
  return a.startsWith(home + '/.sf/') || a.startsWith(home + '/.sfdx/') || a === home + '/.sf' || a === home + '/.sfdx'
}

function mentionsAuthDir(cmd) {
  const h = home ? home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '\\0'
  return new RegExp('(?:~|\\$HOME|\\$\\{HOME\\}|%USERPROFILE%|\\$env:USERPROFILE|' + h + ')[/\\\\]\\.sf(?:dx)?(?:[/\\\\\\s"\']|$)').test(cmd)
}

async function guardAuthRead($, what) {
  const answer = await askPerson($, '🔑 Claude wants to read Salesforce auth files: ' + what + '\nThey hold login data for your orgs. Allow?', ['Allow once', 'Cancel'])
  await audit($, { command: what, verdict: 'ask', answer: answer ?? 'no answer', reason: 'auth files', outcome: answer === 'Allow once' ? 'allowed' : 'refused' })
  return answer === 'Allow once'
}

// ── Live files: entries ─────────────────────────────────────────────────────
function isBinary(path, text) {
  return BINARY_EXT.test(path) || (typeof text === 'string' && text.slice(0, 8000).includes('\u0000'))
}

function newEntry(path, status) {
  return {
    path,
    status, // 'created', 'edited', or 'deleted'
    original: null, // content when first seen this session (or at the last commit)
    current: null, // content now
    allDiff: '', // since the session started
    latestDiff: '', // the most recent change
    adds: 0,
    removes: 0,
    focus: null, // [first, last] line of the most recent change
    changes: 0,
    at: 0,
    writing: false,
    seenMtime: null,
    tooLarge: false,
    binary: false,
    isFolder: false,
    noBaseline: false, // existed before and its earlier content is unknown
    slim: false, // full text dropped to save memory
    restored: false, // listed from an earlier session
    cut: false,
  }
}

// Record one change: before -> after (null after = deleted)
function recordChange(f, before, after) {
  f.current = after
  f.changes += 1
  f.at = Date.now()
  lastChangeAt = f.at
  f.writing = false
  f.binary = isBinary(f.path, after) || isBinary(f.path, before)
  const big = (x) => typeof x === 'string' && x.length > MAX_TRACKED_BYTES
  f.tooLarge = big(after) || big(before) || big(f.original)
  f.lint = cfg.codeChecks && !f.binary && !f.tooLarge ? lintSource(f.path, after, { noComments: cfg.codingStandards }) : []
  f.soql = cfg.codeChecks && !f.binary && !f.tooLarge ? soqlFields(f.path, after) : []
  f.perms = isPermissionFile(f.path) && after !== null ? permissionChanges(f.original ?? before ?? '', after) : []
  if (f.binary || f.tooLarge) {
    f.allDiff = ''
    f.latestDiff = ''
    return
  }
  if (f.original !== null) {
    const all = unifiedDiff(f.original, after ?? '')
    f.allDiff = all.text
    f.adds = all.adds
    f.removes = all.removes
    f.cut = all.cut
  }
  if (before !== null) {
    const latest = unifiedDiff(before, after ?? '')
    f.latestDiff = latest.text
    if (f.original === null) {
      f.adds += latest.adds
      f.removes += latest.removes
    }
    f.focus = after === null ? null : latest.first !== null ? [latest.first, latest.last] : f.focus
  }
}

// Keep full text for the most recent files only
function trimMemory() {
  if (files.size <= FULL_TEXT_FILES) return
  const list = [...files.values()].sort((a, b) => b.at - a.at)
  for (const f of list.slice(FULL_TEXT_FILES)) {
    if (f.slim) continue
    f.original = null
    f.current = null
    f.slim = true
  }
}

function select(path) {
  if (followLatest) selectedFile = path
}

// Open the Files pane once, the first time something changes
async function autoOpenFiles($) {
  if (!cfg.autoOpenFiles || filesAutoOpened) return
  filesAutoOpened = true
  try {
    const placed = await $.ui.open({ id: FILES_PANE, title: 'Files', closeOnEscape: true, columns: cfg.filesPaneWidth })
    filesPaneOpen = true
    if (!placed?.isPlaced) $.ui.toast('Files changed. Open the live view with /sffiles')
  } catch {
    // Nothing to draw in, such as a claude -p run
  }
}

// ── Live files: file tools ──────────────────────────────────────────────────
async function trackStart($, path, existed) {
  dismissed.delete(path)
  const f = files.get(path) ?? newEntry(path, existed ? 'edited' : 'created')
  f.writing = true
  f.at = Date.now()
  files.set(path, f)
  select(path)
  $.ui.invalidate('ui.render')
  await autoOpenFiles($)
}

async function trackEnd($, path, before, changed) {
  const f = files.get(path)
  if (!f) return
  f.writing = false
  if (!changed) {
    if (f.changes === 0) files.delete(path) // a refused first write leaves nothing to show
    $.ui.invalidate('ui.render')
    return
  }
  let after = null
  try {
    after = await $.fs.read(path)
  } catch {
    after = null
  }
  if (f.original === null && !f.slim) {
    f.original = before
    f.noBaseline = before === null
  }
  if (f.status === 'deleted') f.status = 'edited'
  recordChange(f, before, after)
  try {
    f.seenMtime = (await $.fs.stat(path)).mtimeMs
  } catch {
    f.seenMtime = null
  }
  trimMemory()
  $.ui.invalidate('ui.render')
}

// ── Live files: rm, del, Remove-Item ────────────────────────────────────────
function rmTargets(command) {
  const out = []
  for (const seg of allSimpleCommands(command)) {
    const words = tokenize(seg)
    let i = 0
    while (i < words.length && /^[A-Za-z_]\w*=/.test(words[i])) i++
    if (words[i] === 'git' && words[i + 1] === 'rm') i++
    const prog = programName(words[i])
    if (!['rm', 'del', 'erase', 'remove-item', 'ri', 'rmdir'].includes(prog)) continue
    const args = words.slice(i + 1)
    for (let k = 0; k < args.length; k++) {
      const tok = args[k]
      if (!tok || /^-/.test(tok) || /^\/[a-z]$/i.test(tok) || /[*?~$]/.test(tok)) {
        if (/^-(Path|LiteralPath)$/i.test(tok) && args[k + 1]) {
          out.push(args[k + 1])
          k++
        }
        continue
      }
      out.push(tok)
    }
  }
  return out
}

async function snapshotRemovals($, targets) {
  await ensureCwd($)
  const snaps = []
  for (const t of targets) {
    const abs = absPath(t)
    try {
      if (!(await $.fs.exists(abs))) continue
      const info = await $.fs.stat(abs)
      const content = info.kind === 'file' ? await $.fs.read(abs) : null
      snaps.push({ abs, content, isFolder: info.kind === 'dir' })
    } catch {
      snaps.push({ abs, content: null, isFolder: false })
    }
  }
  return snaps
}

async function finishRemovals($, snaps) {
  let changed = false
  for (const s of snaps) {
    let gone = false
    try {
      gone = !(await $.fs.exists(s.abs))
    } catch {
      gone = false
    }
    if (!gone) continue
    markDeleted(s.abs, s.content, s.isFolder)
    changed = true
  }
  if (changed) {
    await autoOpenFiles($)
    $.ui.invalidate('ui.render')
  }
}

function markDeleted(abs, content, isFolder) {
  dismissed.delete(abs)
  const f = files.get(abs) ?? newEntry(abs, 'deleted')
  const before = f.current ?? content
  if (f.original === null && !f.slim) f.original = content
  f.status = 'deleted'
  f.isFolder = !!isFolder
  f.seenMtime = null
  recordChange(f, before, null)
  files.set(abs, f)
  select(abs)
}

// ── Live files: watching (git, or the folder itself) ────────────────────────
function parsePorcelain(out) {
  const parts = out.split('\u0000')
  const res = []
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]
    if (p.length < 4) continue
    const x = p[0]
    const y = p[1]
    if (x === 'R' || x === 'C') i++ // the next part is the old name
    res.push({ rel: p.slice(3), untracked: x === '?', deleted: x === 'D' || y === 'D' })
  }
  return res
}

// One look at a time; a caller that comes while one runs waits for it
function watchPoll($) {
  if (watchMode === 'off' && files.size === 0) return Promise.resolve()
  if (!pollPromise) {
    const t0 = Date.now()
    pollPromise = poll($)
      .catch(() => {})
      .finally(() => {
        lastPollMs = Date.now() - t0
        lastPollAt = Date.now()
        pollPromise = null
      })
  }
  return pollPromise
}

// Adaptive: every 2 s right after a change, 5 s for two minutes, then 15 s
function pollInterval() {
  const since = Date.now() - lastChangeAt
  if (since < 30000) return 2000
  if (since < 150000) return 5000
  return 15000
}

async function poll($) {
  await ensureCwd($)
  if (watchMode === 'starting') await startWatch($)
  let changed = false
  if (watchMode === 'git') changed = await gitDiscover($)
  else if (watchMode === 'folder') changed = await folderDiscover($)
  if (await refreshTracked($)) changed = true
  if (changed) {
    trimMemory()
    void ensureDescribes($)
    await autoOpenFiles($)
    $.ui.invalidate('ui.render')
  }
}

async function startWatch($) {
  await ensureHome($)
  let top = null
  try {
    top = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd: cwd || undefined, timeoutMs: 5000 })
  } catch {
    top = null
  }
  if (top && top.exitCode === 0 && top.stdout.trim()) {
    gitRoot = norm(top.stdout.trim())
    watchMode = 'git'
    await loadProject($)
    await gitDiscover($) // the first look is the baseline
    return
  }
  const err = String(top?.stderr ?? '')
  watchNote = !top ? 'git not available' : /not a git repository/i.test(err) ? 'not a git repo' : 'git failed'
  if (!cwd || cwd === '/' || /^[A-Za-z]:\/?$/.test(cwd) || (home && cwd === home)) {
    watchMode = 'off'
    watchNote = 'start claude inside your project folder'
    $.ui.invalidate('ui.render')
    return
  }
  await loadProject($)
  watchMode = 'folder'
  await folderDiscover($) // the first look is the baseline
  $.ui.invalidate('ui.render')
}

// The pathspecs that narrow git status to the package folders
function gitPathspecs() {
  if (!project?.packageDirs?.length || !gitRoot) return []
  const specs = project.packageDirs.map((d) => (d.startsWith(gitRoot + '/') ? d.slice(gitRoot.length + 1) : null)).filter(Boolean)
  return specs.length === project.packageDirs.length ? ['--', ...specs] : []
}

async function gitDiscover($) {
  const st = await $.process.run(['git', '-C', gitRoot, 'status', '--porcelain=v1', '-z', '-uall', ...gitPathspecs()], { timeoutMs: 10000 })
  if (st.exitCode !== 0) return false
  const seen = new Map()
  for (const en of parsePorcelain(st.stdout).slice(0, 2000)) {
    const abs = gitRoot + '/' + en.rel
    let mtime = -1
    if (!en.deleted) {
      try {
        const info = await $.fs.stat(abs)
        if (info.kind !== 'file') continue
        mtime = info.mtimeMs
      } catch {
        continue
      }
    }
    seen.set(abs, { ...en, mtime })
  }
  if (gitBaseline === null) {
    gitBaseline = new Map([...seen].map(([k, v]) => [k, v.mtime]))
    return false
  }
  let changed = false
  for (const [abs, en] of seen) {
    if (files.has(abs)) continue // tracked entries refresh on their own
    if (gitBaseline.get(abs) === en.mtime) continue // already changed before the session
    const gone = dismissed.get(abs)
    if (gone && gone.mtime === en.mtime) continue // cleared, and not changed since
    dismissed.delete(abs)
    if (en.deleted) {
      let content = null
      try {
        const show = await $.process.run(['git', '-C', gitRoot, 'show', 'HEAD:' + en.rel], { timeoutMs: 10000 })
        content = show.exitCode === 0 ? show.stdout : null
      } catch {
        content = null
      }
      markDeleted(abs, content, false)
      changed = true
      continue
    }
    let current
    try {
      current = await $.fs.read(abs)
    } catch {
      continue
    }
    const f = newEntry(abs, en.untracked ? 'created' : 'edited')
    if (en.untracked) f.original = ''
    else {
      try {
        const show = await $.process.run(['git', '-C', gitRoot, 'show', 'HEAD:' + en.rel], { timeoutMs: 10000 })
        f.original = show.exitCode === 0 ? show.stdout : ''
      } catch {
        f.original = ''
      }
    }
    f.seenMtime = en.mtime
    recordChange(f, gone && gone.content !== null ? gone.content : f.original, current)
    files.set(abs, f)
    select(abs)
    changed = true
  }
  return changed
}

// Every file under the roots with its modified time, by $.fs.list alone
async function listTree($, roots) {
  const out = new Map()
  const queue = [...roots]
  while (queue.length && out.size < MAX_TREE_FILES) {
    const dir = queue.shift()
    let entries
    try {
      entries = await $.fs.list(dir)
    } catch {
      continue
    }
    for (const en of entries) {
      const p = dir + '/' + en.name
      if (en.kind === 'dir') {
        if (!SKIP_DIRS.has(en.name)) queue.push(p)
      } else if (en.kind === 'file') out.set(p, en.mtimeMs)
    }
  }
  return out
}

function watchRoots() {
  return project?.packageDirs?.length ? project.packageDirs : [cwd]
}

async function folderDiscover($) {
  const now = await listTree($, watchRoots())
  if (!folderBaseline) {
    folderBaseline = now
    return false
  }
  let changed = false
  let n = 0
  for (const [abs, mtime] of now) {
    if (files.has(abs)) continue // tracked entries refresh on their own
    const was = folderBaseline.get(abs)
    if (was === mtime) continue
    if (++n > 500) break
    const gone = dismissed.get(abs)
    if (gone && gone.mtime === mtime) continue // cleared, and not changed since
    dismissed.delete(abs)
    let current
    try {
      current = await $.fs.read(abs)
    } catch {
      continue
    }
    const existed = was !== undefined
    const f = newEntry(abs, existed ? 'edited' : 'created')
    // A new file started empty; an existing file's earlier content is unknown,
    // unless it was listed before a clear
    const known = gone && gone.content !== null ? gone.content : null
    f.original = known ?? (existed ? current : '')
    f.noBaseline = existed && known === null
    f.seenMtime = mtime
    recordChange(f, known ?? (existed ? null : ''), current)
    files.set(abs, f)
    select(abs)
    changed = true
  }
  return changed
}

// Files already listed: pick up later changes, reverts, deletes and re-creates
async function refreshTracked($) {
  let changed = false
  for (const f of [...files.values()].slice(0, 300)) {
    if (f.writing || f.isFolder) continue
    let info = null
    try {
      info = await $.fs.stat(f.path)
    } catch {
      // Gone, or just not readable right now: only a clear "missing" counts as deleted
      let exists = null
      try {
        exists = await $.fs.exists(f.path)
      } catch {
        exists = null
      }
      if (exists !== false) continue
      info = null
    }
    if (!info || info.kind !== 'file') {
      if (f.status !== 'deleted') {
        markDeleted(f.path, f.current, false)
        changed = true
      }
      continue
    }
    if (f.seenMtime === info.mtimeMs && f.status !== 'deleted') continue
    let current
    try {
      current = await $.fs.read(f.path)
    } catch {
      continue
    }
    f.seenMtime = info.mtimeMs
    if (current === f.current && f.status !== 'deleted') continue
    if (f.restored && f.current === null) {
      // listed from an earlier session: start from what is there now
      f.current = current
      f.original = f.original ?? current
      f.restored = false
      continue
    }
    const before = f.current
    if (f.status === 'deleted') f.status = f.original ? 'edited' : 'created'
    recordChange(f, before, current)
    select(f.path)
    changed = true
  }
  return changed
}

function pollSoon($) {
  void watchPoll($)
}

// ── Remembered file list (paths and counts only) ────────────────────────────
async function saveFileList($) {
  if (!cfg.rememberFiles || !cwd) return
  const rows = [...files.values()].slice(0, 200).map((f) => ({ path: f.path, status: f.status, adds: f.adds, removes: f.removes, at: f.at }))
  await storeSet($, 'files:' + cwd, rows)
}

async function restoreFileList($) {
  if (!cfg.rememberFiles || !cwd) return
  const rows = await storeGet($, 'files:' + cwd)
  if (!Array.isArray(rows)) return
  for (const r of rows) {
    if (!r || typeof r.path !== 'string' || files.has(r.path)) continue
    const f = newEntry(r.path, r.status ?? 'edited')
    f.adds = Number(r.adds) || 0
    f.removes = Number(r.removes) || 0
    f.at = Number(r.at) || 0
    f.restored = true
    f.noBaseline = true
    files.set(r.path, f)
  }
}

// ── Problems: deploy and test failures, analyzer findings ───────────────────
function problemMatches(path, file) {
  if (!file) return false
  const p = norm(file)
  if (isAbs(p)) return p === path
  return path.endsWith('/' + p) || path === p
}

function describeKey(org, object) {
  return String(org).toLowerCase() + '|' + String(object).toLowerCase()
}

function fieldProblems(refs) {
  if (!defaultOrg || !refs?.length) return []
  const out = []
  for (const r of refs) {
    const known = describeCache.get(describeKey(defaultOrg, r.object))
    if (!known) continue
    if (known.missing) out.push({ line: r.line, rule: 'schema', problem: 'Object ' + r.object + ' does not exist in ' + defaultOrg })
    else if (!known.fields.has(r.field.toLowerCase())) out.push({ line: r.line, rule: 'schema', problem: 'Field ' + r.object + '.' + r.field + ' does not exist in ' + defaultOrg })
  }
  return out
}

function codeProblems(f) {
  const file = f.path.split('/').pop()
  const grants = (f.perms ?? []).filter((x) => x.risky && x.added).map((x) => ({ line: null, rule: 'permission', problem: 'Grants ' + x.text + ': a deploy of this file always asks first' }))
  return [...(f.lint ?? []), ...fieldProblems(f.soql), ...grants].map((p) => ({ file, line: p.line, problem: p.problem, rule: p.rule, source: p.rule === 'schema' || p.rule === 'permission' ? p.rule : 'lint' }))
}

async function fetchDescribe($, org, object) {
  try {
    const r = await $.process.run(['sf', 'sobject', 'describe', '--sobject', object, '--json', '-o', org], { timeoutMs: 60000 })
    const j = JSON.parse(r.stdout || '{}')
    if (r.exitCode === 0 && j.result) return j.result
    if (/not found|NOT_FOUND|INVALID_TYPE/i.test(String(j.name ?? '') + String(j.message ?? ''))) return { missing: true }
    return null
  } catch {
    return null
  }
}

async function cacheDescribe($, org, object) {
  const key = describeKey(org, object)
  if (describeCache.has(key)) return describeCache.get(key)
  const d = await fetchDescribe($, org, object)
  if (!d) return null
  const entry = d.missing ? { missing: true } : { fields: new Set((d.fields ?? []).map((x) => String(x.name).toLowerCase())), describe: d }
  describeCache.set(key, entry)
  return entry
}

function ensureDescribes($) {
  if (!cfg.codeChecks || !defaultOrg || describing) return describing
  const wanted = new Set()
  for (const f of files.values()) for (const r of f.soql ?? []) if (!describeCache.has(describeKey(defaultOrg, r.object))) wanted.add(r.object)
  if (wanted.size === 0) return null
  describing = (async () => {
    for (const object of [...wanted].slice(0, 10)) await cacheDescribe($, defaultOrg, object)
    $.ui.invalidate('ui.render')
  })().finally(() => {
    describing = null
  })
  return describing
}

function problemsFor(path) {
  const out = []
  const base = path.split('/').pop()
  const tracked = files.get(path)
  if (tracked) for (const p of codeProblems(tracked)) out.push(p)
  for (const p of lastDeployProblems) if (problemMatches(path, p.file)) out.push({ ...p, source: 'deploy' })
  for (const t of lastTestProblems) if (t.cls && (base === t.cls + '.cls' || base === t.cls + '.trigger')) out.push({ file: base, line: t.line, problem: t.name + ': ' + t.message, source: 'test' })
  for (const a of analyzerFindings) if (problemMatches(path, a.file)) out.push({ ...a, problem: (a.rule ? a.rule + ': ' : '') + a.problem, source: 'analyzer' })
  return out
}

function allProblems() {
  return [
    ...lastDeployProblems.map((p) => ({ ...p, source: 'deploy' })),
    ...lastTestProblems.map((t) => ({ file: t.cls ? t.cls + '.cls' : null, line: t.line, problem: t.name + (t.message ? ': ' + t.message : ''), source: 'test' })),
    ...analyzerFindings.map((a) => ({ ...a, problem: (a.rule ? a.rule + ': ' : '') + a.problem, source: 'analyzer' })),
    ...[...files.values()].filter((f) => f.status !== 'deleted').flatMap(codeProblems),
  ]
}

function pathForProblem(p) {
  if (!p.file) return null
  for (const f of files.values()) if (problemMatches(f.path, p.file) || f.path.split('/').pop() === norm(p.file).split('/').pop()) return f.path
  return null
}

// A short digest Claude can act on: at most 40 lines
function fixDigest() {
  const lines = ['SF Guardian found these problems. Please fix them, then validate again.']
  const last = deployLog[deployLog.length - 1]
  if (lastDeployProblems.length) {
    lines.push('', 'Deploy' + (last ? ' (' + last.kind + ' on ' + last.org + ')' : '') + ' errors:')
    for (const p of lastDeployProblems.slice(0, 12)) lines.push('- ' + (p.file ?? p.name ?? '?') + (p.line ? ':' + p.line + (p.col ? ':' + p.col : '') : '') + '  ' + p.problem)
  }
  if (lastTestProblems.length) {
    lines.push('', 'Failing tests:')
    for (const t of lastTestProblems.slice(0, 10)) lines.push('- ' + t.name + (t.line ? ' (line ' + t.line + ')' : '') + (t.message ? ': ' + t.message : ''))
  }
  const checks = [...files.values()].filter((f) => f.status !== 'deleted').flatMap((f) => codeProblems(f).map((p) => ({ ...p, rel: projectRel(f.path) })))
  if (checks.length) {
    lines.push('', 'Code checks:')
    for (const p of checks.slice(0, 12)) lines.push('- ' + p.rel + ':' + p.line + '  ' + p.problem)
  }
  if (analyzerFindings.length) {
    lines.push('', 'Code Analyzer findings:')
    for (const a of analyzerFindings.slice(0, 10)) lines.push('- ' + (a.file ? projectRel(norm(a.file)) : '?') + (a.line ? ':' + a.line : '') + '  ' + (a.rule ? a.rule + ': ' : '') + a.problem)
  }
  return lines.slice(0, 40).join('\n')
}

async function askClaudeToFix($) {
  if (allProblems().length === 0) {
    $.ui.toast('No problems to fix.')
    return
  }
  try {
    await $.prompt.submit({ text: fixDigest() })
  } catch {
    $.ui.toast('Could not send the prompt. Copy the problems from /sfpanel instead.')
  }
}

// ── Code Analyzer ───────────────────────────────────────────────────────────
async function runAnalyzer($, paths) {
  if (analyzerRunning || paths.length === 0) return
  analyzerRunning = true
  $.ui.invalidate('ui.render')
  const root = project?.root || cwd
  const out = root + '/.sfdx/sf-guardian-analyzer.json'
  try {
    const argv = ['sf', 'code-analyzer', 'run', '--workspace', root, ...paths.flatMap((p) => ['--target', p]), '--output-file', out]
    const r = await $.process.run(argv, { cwd: root, timeoutMs: 600000 })
    let text = null
    try {
      text = await $.fs.read(out)
    } catch {
      text = null
    }
    const parsed = text ? parseAnalyzer(text) : null
    if (parsed) {
      const changed = new Set(paths.map(norm))
      analyzerFindings = parsed.filter((v) => !v.file || changed.has(norm(v.file)) || [...changed].some((c) => problemMatches(c, v.file))).sort((a, b) => a.severity - b.severity)
      if (analyzerFindings.length) $.ui.toast('⚠ Code Analyzer: ' + plural(analyzerFindings.length, 'finding'))
    } else {
      noteUnparsed(text ?? r.stderr ?? r.stdout ?? '')
      if (r.exitCode !== 0) $.ui.toast('Code Analyzer did not run: ' + String(r.stderr || r.stdout || '').trim().split('\n')[0].slice(0, 120))
    }
  } catch {
    // Optional feature: never in the way
  } finally {
    analyzerRunning = false
    $.ui.invalidate('ui.render')
  }
}

// ── Validate the changed files ──────────────────────────────────────────────
async function buildValidation($) {
  if (!project) await loadProject($)
  const org = defaultOrg
  const changed = [...files.values()].filter((f) => f.status !== 'deleted' && !f.isFolder)
  const rels = new Set()
  const apexNames = []
  for (const f of changed) {
    const rel = projectRel(f.path)
    const meta = metadataPathOf(rel, project?.relDirs ?? [])
    if (meta) rels.add(meta)
    const m = f.path.match(/\/([^/]+)\.cls$/)
    if (m && !TEST_NAME.test(m[1])) apexNames.push({ name: m[1], dir: f.path.slice(0, f.path.lastIndexOf('/')) })
    if (m && TEST_NAME.test(m[1])) apexNames.push({ name: m[1], dir: '', isTest: true })
  }
  const tests = new Set()
  for (const a of apexNames) {
    if (a.isTest) {
      tests.add(a.name)
      continue
    }
    for (const cand of testCandidates(a.name)) {
      let ok = false
      try {
        ok = await $.fs.exists(a.dir + '/' + cand + '.cls')
      } catch {
        ok = false
      }
      if (ok) {
        tests.add(cand)
        break
      }
    }
  }
  const hasApex = changed.some((f) => /\.(cls|trigger)$/.test(f.path))
  const argv = ['sf', 'project', 'deploy', 'start', '--dry-run', '--json', '--wait', '9']
  if (org) argv.push('-o', org)
  for (const r of rels) argv.push('--source-dir', r)
  let testNote = ''
  if (tests.size) {
    argv.push('--test-level', 'RunSpecifiedTests')
    for (const t of tests) argv.push('--tests', t)
  } else if (hasApex) {
    argv.push('--test-level', 'RunLocalTests')
    testNote = 'No matching test class found (XTest, X_Test, XTests), so this runs RunLocalTests.'
  }
  return { argv, org, count: rels.size, testNote }
}

function parseJsonSafe(text) {
  try {
    return JSON.parse(String(text ?? ''))
  } catch {
    return null
  }
}

function quoteArg(a) {
  return /[\s"'$]/.test(a) ? JSON.stringify(a) : a
}

async function validateChanged($) {
  if (validating) {
    $.ui.toast('A validation is already running.')
    return
  }
  const v = await buildValidation($)
  if (v.count === 0) {
    $.ui.toast('No changed metadata to validate.')
    return
  }
  if (!v.org) {
    $.ui.toast('No default org. Run: sf config set target-org <alias>')
    return
  }
  const shown = v.argv.map(quoteArg).join(' ')
  const cls = clsOf(v.org)
  const answer = await askPerson($, 'Validate ' + plural(v.count, 'changed component') + ' on ' + v.org + ' (' + cls + ')? A dry run changes nothing.\n' + shown + (v.testNote ? '\n' + v.testNote : ''), ['Validate', 'Cancel'])
  if (answer !== 'Validate') return
  validating = true
  running = 'Validating ' + plural(v.count, 'component') + ' on ' + v.org
  $.ui.invalidate('ui.render')
  await audit($, { command: shown, org: v.org, cls, verdict: 'allow', answer, reason: 'validation from the Files pane', outcome: 'started' })
  void (async () => {
    let ok = false
    try {
      // $.process.run allows ten minutes at most: wait 9 at a time, then follow the job with deploy report
      const runIn = { cwd: project?.root || cwd || undefined, timeoutMs: 600000 }
      let r = await $.process.run(v.argv, runIn)
      for (let round = 0; round < 4; round++) {
        const job = parseJsonSafe(r.stdout)?.result
        const pending = job && job.id && (job.done === false || /^(InProgress|Pending|Canceling)$/.test(String(job.status)))
        if (!pending) break
        r = await $.process.run(['sf', 'project', 'deploy', 'report', '--job-id', job.id, '--wait', '9', '--json', ...(v.org ? ['-o', v.org] : [])], runIn)
      }
      const d = summarizeDeploy(r.stdout || '')
      ok = r.exitCode === 0 && !!d && /^Succeeded$/i.test(d.status)
      if (d) {
        lastDeployProblems = d.failures
        lastTestProblems = d.testFailures
      } else noteUnparsed(r.stdout || r.stderr)
      deployLog.push({ at: Date.now(), time: new Date().toLocaleTimeString(), org: v.org, kind: 'validate', ok })
      const msg = (ok ? '✔ Validation succeeded on ' : '✘ Validation failed on ') + v.org + (d && !ok && d.failures.length ? ' · ' + plural(d.failures.length, 'error') : '')
      $.ui.toast(msg)
      if (cfg.notify) void $.ui.notify(msg, { title: 'SF Guardian' }).catch(() => {})
    } catch {
      $.ui.toast('✘ Could not run the validation. Is sf installed?')
    } finally {
      validating = false
      running = null
      $.ui.invalidate('ui.render')
    }
  })()
}

function stampNow() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
}

function safeName(text) {
  return String(text ?? 'default').replace(/[^\w.@-]/g, '_')
}

async function inGitHistory($, rel, text) {
  const hash = await $.process.run(['git', '-C', gitRoot, 'hash-object', '--stdin'], { stdin: text, timeoutMs: 10000 })
  if (hash.exitCode !== 0) return true
  const log = await $.process.run(['git', '-C', gitRoot, 'log', '--format=', '--raw', '--no-abbrev', '-n', '100', '--', rel], { timeoutMs: 20000 })
  return log.exitCode !== 0 || log.stdout.includes(hash.stdout.trim())
}

async function orgChangesNotInGit($, retrieved) {
  if (!gitRoot) return { checked: false, drift: [] }
  const ls = await $.process.run(['git', '-C', gitRoot, 'ls-files'], { timeoutMs: 20000 })
  if (ls.exitCode !== 0) return { checked: false, drift: [] }
  const byTail = new Map()
  for (const rel of ls.stdout.split('\n').filter(Boolean)) {
    const tail = typeFolderTail(rel)
    if (tail && !byTail.has(tail)) byTail.set(tail, rel)
  }
  const drift = []
  let compared = 0
  for (const path of retrieved.keys()) {
    if (!/\.(cls|trigger|page|component|js|html|css|cmp)$/.test(path)) continue
    const rel = byTail.get(typeFolderTail(path))
    if (!rel || ++compared > 60) continue
    const org = await $.fs.read(path)
    const local = await $.fs.read(gitRoot + '/' + rel).catch(() => null)
    if (local !== null && sameText(org, local)) continue
    if (!(await inGitHistory($, rel, org))) drift.push(rel)
  }
  return { checked: true, drift }
}

async function backupFromOrg($, targets, checkDrift) {
  if (!project) await loadProject($)
  const root = project?.root || cwd
  const made = []
  const drift = []
  for (const t of targets) {
    const dir = root + '/.sfdx/sf-guardian/backups/' + stampNow() + '-' + safeName(t.org)
    const r = await $.process.run(retrieveArgs(t.scope, project?.relDirs?.length ? project.relDirs : ['force-app'], dir, t.org), { cwd: root, timeoutMs: 600000 })
    if (r.exitCode !== 0) return { ok: false, reason: String(parseJsonSafe(r.stdout)?.message ?? r.stderr ?? 'sf failed').split('\n')[0].slice(0, 300), made }
    const retrieved = await listTree($, [dir])
    const manifest = [...retrieved.keys()].filter((f) => f.endsWith('/package.xml')).sort((a, b) => a.length - b.length)[0]
    made.push({ at: new Date().toISOString(), org: t.org ?? defaultOrg, dir: manifest ? manifest.slice(0, -'/package.xml'.length) : dir })
    if (checkDrift) drift.push(...(await orgChangesNotInGit($, retrieved)).drift)
  }
  const stored = await storeGet($, 'backups')
  const list = [...(Array.isArray(stored) ? stored : []), ...made].slice(-20)
  backups.splice(0, backups.length, ...list)
  await storeSet($, 'backups', list)
  return { ok: true, made, drift }
}

function restoreCommand(b) {
  return 'sf project deploy start --metadata-dir ' + quoteArg(b.dir) + ' -o ' + quoteArg(b.org ?? 'default') + ' --test-level RunLocalTests --dry-run'
}

async function backupOrStop($, cmd, deploys) {
  running = 'Backing up what this deploy overwrites'
  $.ui.invalidate('ui.render')
  let b
  try {
    b = await backupFromOrg($, deploys.map((p) => ({ org: p.org, scope: deployScope(sfCommandOf(tokenize(p.segment)).words) })), true)
  } catch (err) {
    b = { ok: false, reason: String(err?.message ?? err), made: [] }
  } finally {
    running = null
    $.ui.invalidate('ui.render')
  }
  const org = deploys[0].org
  if (b.ok && b.drift.length === 0) {
    $.ui.toast('Backup saved: ' + tildify(b.made[0].dir) + ' · /sfguard backups to restore')
    return null
  }
  const question = b.ok
    ? '⚠ ' + plural(b.drift.length, 'file') + ' in ' + org + ' were changed in the org and are not in git. This deploy overwrites them:\n' + b.drift.slice(0, 10).map((x) => '• ' + x).join('\n') + (b.drift.length > 10 ? '\n• …' : '') + '\nBackup saved: ' + tildify(b.made[0].dir)
    : 'The backup before this deploy failed: ' + b.reason + '\nDeploy anyway, without a backup?'
  const choices = b.ok ? ['Deploy anyway', 'Cancel'] : ['Deploy without backup', 'Cancel']
  const answer = await askPerson($, question, choices)
  await audit($, { command: cmd, org, cls: deploys[0].cls, verdict: 'ask', answer: answer ?? 'no answer', reason: b.ok ? 'org changes not in git: ' + b.drift.slice(0, 5).join(', ') : 'backup failed: ' + b.reason, outcome: answer === choices[0] ? 'continued' : 'cancelled' })
  if (answer === choices[0]) return null
  return { deny: b.ok ? 'The user cancelled: this deploy would overwrite changes made in ' + org + ' that are not in git (' + b.drift.slice(0, 5).join(', ') + '). Retrieve them into the project first.' : 'The user cancelled the deploy because the backup failed: ' + b.reason }
}

async function deletedMembers($) {
  const out = new Map()
  for (const f of files.values()) {
    if (f.status !== 'deleted') continue
    const m = memberOf(projectRel(f.path))
    if (!m) continue
    if (m.type === 'LightningComponentBundle' || m.type === 'AuraDefinitionBundle') {
      const folder = f.path.slice(0, f.path.indexOf('/' + m.name + '/') + m.name.length + 1)
      if (await $.fs.exists(folder).catch(() => true)) continue
    }
    out.set(m.type + ':' + m.name, m)
  }
  return [...out.values()]
}

async function deleteFromOrg($) {
  const members = await deletedMembers($)
  if (members.length === 0) {
    $.ui.toast('No deleted metadata to remove from the org.')
    return
  }
  const org = defaultOrg
  if (!org) {
    $.ui.toast('No default org. Run: sf config set target-org <alias>')
    return
  }
  if (!project) await loadProject($)
  const api = project?.sourceApiVersion ?? orgEntry(orgMap, org)?.org?.apiVersion
  if (!api) {
    $.ui.toast('Set sourceApiVersion in sfdx-project.json first.')
    return
  }
  const cls = clsOf(org)
  const root = project?.root || cwd
  const dir = root + '/.sfdx/sf-guardian/destructive/' + stampNow()
  const argv = ['sf', 'project', 'deploy', 'start', '--manifest', dir + '/package.xml', '--post-destructive-changes', dir + '/destructiveChanges.xml', '-o', org, '--wait', '9', '--json']
  if (needsAsk(cls) && members.some((m) => m.type === 'ApexClass' || m.type === 'ApexTrigger')) argv.push('--test-level', 'RunLocalTests')
  const list = members.map((m) => '• ' + m.type + ': ' + m.name).join('\n')
  const blocked = cfg.guardMode === 'block' && needsAsk(cls)
  const choices = blocked ? ['Validate first (dry run)', 'Cancel'] : ['Validate first (dry run)', 'Delete from org', 'Cancel']
  const answer = await askPerson($, 'Delete these from ' + org + ' (' + cls + ')?\n' + list + '\n' + argv.map(quoteArg).join(' '), choices)
  if (answer !== 'Validate first (dry run)' && answer !== 'Delete from org') return
  const dry = answer !== 'Delete from org'
  if (dry) argv.push('--dry-run')
  await $.fs.write(dir + '/package.xml', manifestXml([], api))
  await $.fs.write(dir + '/destructiveChanges.xml', manifestXml(members, api))
  if (!dry && needsAsk(cls) && cfg.backupBeforeDeploy) {
    const b = await backupFromOrg($, [{ org, scope: { sourceDirs: [], metadata: members.map((m) => m.type + ':' + m.name), manifest: null } }], false).catch((err) => ({ ok: false, reason: String(err?.message ?? err) }))
    if (!b.ok) {
      const go = await askPerson($, 'The backup before this delete failed: ' + b.reason + '\nDelete anyway, without a backup?', ['Delete without backup', 'Cancel'])
      if (go !== 'Delete without backup') return
    }
  }
  await audit($, { command: argv.join(' '), org, cls, verdict: 'ask', answer, reason: 'delete ' + plural(members.length, 'component') + ' from the org', outcome: 'started' })
  running = (dry ? 'Validating the delete on ' : 'Deleting from ') + org
  $.ui.invalidate('ui.render')
  try {
    const r = await $.process.run(argv, { cwd: root, timeoutMs: 600000 })
    const d = summarizeDeploy(r.stdout || '')
    const ok = r.exitCode === 0 && !!d && /^Succeeded$/i.test(d.status)
    if (d) lastDeployProblems = d.failures
    deployLog.push({ at: Date.now(), time: new Date().toLocaleTimeString(), org, kind: dry ? 'validate delete' : 'delete', ok })
    $.ui.toast((ok ? '✔ ' : '✘ ') + (dry ? 'Delete validated on ' : 'Deleted from ') + org + (ok ? '' : ': ' + (d?.failures[0]?.problem ?? String(parseJsonSafe(r.stdout)?.message ?? r.stderr ?? 'failed').split('\n')[0])))
  } catch (err) {
    $.ui.toast('✘ Could not run the delete: ' + String(err?.message ?? err))
  } finally {
    running = null
    $.ui.invalidate('ui.render')
  }
}

async function newComponentProblem($, tool, file) {
  if (!cfg.namePrefix || !file || READ_ONLY_TOOLS.has(tool)) return null
  const comp = componentOf(absPath(file))
  if (!comp) return null
  const existing = comp.kind === 'lwc' ? comp.folder : absPath(file).replace(/-meta\.xml$/, '')
  try {
    if (await $.fs.exists(existing)) return null
  } catch {
    return null
  }
  return namingProblem(comp.kind, comp.name, cfg.namePrefix)
}

function generatedNameProblem(command) {
  if (!cfg.namePrefix) return null
  for (const seg of allSimpleCommands(command)) {
    const sf = sfCommandOf(tokenize(seg))
    if (!sf) continue
    const isLwc = sf.topic.startsWith('lightning generate component') && flagValue(sf.words, ['--type']) === 'lwc'
    const kind = sf.topic.startsWith('apex generate class') ? 'class' : sf.topic.startsWith('apex generate trigger') ? 'trigger' : isLwc ? 'lwc' : null
    const problem = kind && namingProblem(kind, flagValue(sf.words, ['--name'], ['-n']), cfg.namePrefix)
    if (problem) return problem
  }
  return null
}

function describeSummary(d, org) {
  const lines = [d.name + ' in ' + org + ' (' + (d.label ?? d.name) + '): ' + plural((d.fields ?? []).length, 'field')]
  for (const f of (d.fields ?? []).slice(0, 400)) {
    const type = f.type === 'reference' ? 'reference → ' + (f.referenceTo ?? []).join('|') + (f.relationshipName ? ' (' + f.relationshipName + ')' : '') : f.type + (f.length ? '(' + f.length + ')' : '')
    const required = f.nillable === false && f.createable && !f.defaultedOnCreate ? '  required' : ''
    const picks = (f.picklistValues ?? []).filter((v) => v.active !== false).map((v) => v.value)
    const values = picks.length ? '  [' + picks.slice(0, 25).join(', ') + (picks.length > 25 ? ', …' : '') + ']' : ''
    lines.push(f.name + '  ' + type + '  "' + f.label + '"' + required + (f.updateable === false && f.createable === false ? '  read only' : '') + values)
  }
  const children = (d.childRelationships ?? []).filter((c) => c.relationshipName).slice(0, 60)
  if (children.length) lines.push('Child relationships: ' + children.map((c) => c.relationshipName + ' → ' + c.childSObject + '.' + c.field).join(', '))
  return lines.join('\n')
}

function stripAttributes(value) {
  if (Array.isArray(value)) return value.map(stripAttributes)
  if (!value || typeof value !== 'object') return value
  const out = {}
  for (const [k, v] of Object.entries(value)) if (k !== 'attributes') out[k] = stripAttributes(v)
  return out
}

function limitQuery(query) {
  const m = query.match(/\blimit\s+(\d+)\s*$/i)
  if (!m) return query + ' LIMIT 50'
  return Number(m[1]) > 200 ? query.slice(0, m.index) + 'LIMIT 200' : query
}

async function describeTool($, e) {
  const object = String(e.object ?? '').trim()
  if (!/^\w+$/.test(object)) return { deny: 'Give an object API name, such as Account or Invoice__c.' }
  const org = String(e.org ?? '').trim() || defaultOrg
  if (!org) return { deny: 'No org given and no default org set. Run: sf config set target-org <alias>' }
  const entry = await cacheDescribe($, org, object)
  if (!entry) return { deny: 'Could not describe ' + object + ' in ' + org + '. Check that sf is installed and the org is logged in (sf org display -o ' + org + ').' }
  if (entry.missing) return { deny: object + ' does not exist in ' + org + '.' }
  return { result: describeSummary(entry.describe, org) }
}

async function soqlTool($, e) {
  const query = String(e.query ?? '').trim().replace(/;+$/, '')
  if (!/^select\s/i.test(query)) return { deny: 'Only SELECT queries are allowed.' }
  const org = String(e.org ?? '').trim() || defaultOrg
  if (!org) return { deny: 'No org given and no default org set. Run: sf config set target-org <alias>' }
  await orgsForGuard($)
  const cls = clsOf(org)
  const limited = limitQuery(query)
  if (needsAsk(cls)) {
    const answer = await askPerson($, 'Claude wants to read records from ' + org + ' (' + cls + '):\n' + limited, ['Run query', 'Cancel'])
    await audit($, { command: 'soql_query ' + limited, org, cls, verdict: 'ask', answer: answer ?? 'no answer', reason: 'reading data from a ' + cls + ' org', outcome: answer === 'Run query' ? 'ran' : 'cancelled' })
    if (answer !== 'Run query') return { deny: 'The user did not allow this query on ' + org + '. Ask before querying it again.' }
  }
  let r
  try {
    r = await $.process.run(['sf', 'data', 'query', '--query', limited, '--json', '-o', org], { timeoutMs: 120000 })
  } catch {
    return { deny: 'Could not run sf. Is the Salesforce CLI installed?' }
  }
  const j = parseJsonSafe(r.stdout)
  if (r.exitCode !== 0 || !j?.result) return { deny: 'Query failed: ' + String(j?.message ?? r.stderr ?? 'unknown error').split('\n')[0] }
  const records = stripAttributes(j.result.records ?? [])
  const text = JSON.stringify({ org, query: limited, totalSize: j.result.totalSize, returned: records.length, records }, null, 1)
  return { result: scrubSecrets(text.length > 50000 ? text.slice(0, 50000) + '\n[cut at 50,000 characters]' : text).text }
}

// ── Open in editor ──────────────────────────────────────────────────────────
async function openInEditor($, path, line) {
  const parts = cfg.editorCommand.split(/\s+/).filter(Boolean)
  const target = path + (line ? ':' + line : '')
  const argv = parts.some((p) => p.includes('{file}'))
    ? parts.map((p) => p.replace('{file}', path).replace('{line}', String(line ?? 1)))
    : [...parts, '-g', target]
  try {
    const r = await $.process.run(argv, { timeoutMs: 10000 })
    if (r.exitCode !== 0) throw new Error(r.stderr)
  } catch {
    $.ui.toast('Could not run "' + parts[0] + '". In VS Code: Command Palette → "Shell Command: Install \'code\' command in PATH", or set the editor in /config.')
  }
}

// ── Drawing: the Files pane ─────────────────────────────────────────────────
const STATUS = {
  created: { glyph: '+', color: 'green', word: 'new file' },
  edited: { glyph: '~', color: 'yellow', word: 'edited' },
  deleted: { glyph: '✕', color: 'red', word: 'deleted' },
}

function watchSummary() {
  const where = cwd ? tildify(cwd) : 'this folder'
  const scope = project?.packageDirs?.length ? ' (' + project.relDirs.join(', ') + ')' : ''
  if (watchMode === 'git') return { ok: true, text: 'watching ' + where + scope + ' via git' }
  if (watchMode === 'folder') return { ok: true, text: 'watching ' + where + scope + (watchNote ? ' (' + watchNote + ')' : '') }
  if (watchMode === 'starting') return { ok: true, text: 'starting the watch…' }
  const last = lastTools.length ? ' · last tools: ' + lastTools.join(', ') : ''
  return { ok: false, text: 'only file tools are tracked: ' + (watchNote || 'watch is off') + last }
}

function draftLabel(d) {
  const p = d.path ?? d.partialPath
  if (!p) return { base: 'drafting…', dir: '' }
  const abs = absPath(p)
  const { dir, base } = splitPath(abs)
  return { base, dir }
}

function draftStatusText(d) {
  if (d.state === 'discarded') return 'not applied'
  if (d.state === 'writing') return 'writing…'
  if (d.kind === 'write') return 'drafting… line ' + Math.max(1, d.text.split('\n').length)
  if (d.kind === 'edit' || d.kind === 'multi-edit') return 'drafting edit' + (d.edits.length > 1 ? ' ' + d.edits.length : '') + '…'
  return 'drafting…'
}

function problemColor(p) {
  return p.source === 'analyzer' || p.source === 'lint' ? 'yellow' : 'red'
}

function draftChecks(d, path, note) {
  if (!cfg.codeChecks || !path) return []
  const text = d.kind === 'write' ? d.text : d.edits.map((e) => e.newText).join('\n')
  const found = [...lintSource(path, text, { noComments: cfg.codingStandards }), ...(d.kind === 'write' ? fieldProblems(soqlFields(path, text)) : [])]
  return found.slice(0, 5).map((p) => note('✘ ' + (d.kind === 'write' ? 'line ' + p.line + '  ' : '') + p.problem, p.rule === 'schema' ? 'red' : 'yellow'))
}

function draftView($, d, Code, note) {
  const out = []
  const path = d.path ? absPath(d.path) : null
  const head = (path ? relPath(path) : '(path not written yet)') + ' · ' + draftStatusText(d)
  if (d.state === 'discarded') {
    out.push(note(head))
    out.push(note('The tool was denied, failed, or the turn stopped. Nothing was written.', 'yellow'))
    return out
  }
  if (d.kind === 'edit' || d.kind === 'multi-edit') {
    out.push(note(head + ' · not on disk yet'))
    for (const [i, e] of d.edits.entries()) {
      const diff = unifiedDiff(e.oldText, e.newText, 2)
      if (d.edits.length > 1) out.push(note('edit ' + (i + 1) + ' of ' + d.edits.length))
      if (diff.text) out.push(Code({ source: diff.text, format: 'diff', path: path ?? undefined, wrap: 'truncate-end' }))
    }
    return [...out, ...draftChecks(d, path, note)]
  }
  if (d.kind === 'write') {
    const base = path ? files.get(path)?.current : null
    const lines = d.text.split('\n').length
    out.push(note(head + ' · ' + plural(lines, 'line') + ' so far' + (d.capped ? ' · live preview stopped at 200 KB' : '')))
    if (typeof base === 'string' && base && splitLines(base).length <= DRAFT_DIFF_MAX_LINES && d.state !== 'drafting') {
      const diff = unifiedDiff(base, d.text, 2)
      if (diff.text) out.push(Code({ source: diff.text, format: 'diff', path: path ?? undefined, wrap: 'truncate-end' }))
      return out
    }
    const t = tailLines(d.text, DRAFT_ROWS)
    const src = t.lines.join('\n') + (d.state === 'drafting' ? '█' : '')
    out.push(Code({ source: src || '█', path: path ?? undefined, startLine: t.first, wrap: 'truncate-end' }))
    return [...out, ...draftChecks(d, path, note)]
  }
  out.push(note(head))
  return out
}

async function askForCoverage($, name, pct, lines) {
  const test = TEST_NAME.test(name) ? name : name + 'Test'
  const text = 'Write or extend Apex tests so ' + name + ' covers lines ' + ranges(lines) + ' (now ' + pct + '%). Read ' + name + ' first and test real behavior with assertions, not just line execution. Put the tests in ' + test + ', then run: sf apex run test --class-names ' + test + ' --code-coverage --json --wait 10'
  try {
    await $.prompt.submit({ text })
  } catch (err) {
    $.ui.toast('Could not send the prompt: ' + String(err?.message ?? err))
  }
}

function coverageView($, sel, Code, Button, note) {
  const out = []
  const m = sel.path.match(/\/([^/]+)\.(cls|trigger)$/)
  if (!m) return [note('Coverage is shown for Apex classes and triggers.')]
  const name = m[1]
  const pct = coverage.get(name)
  const lines = uncovered.get(name)
  if (pct === undefined) return [note('No coverage for ' + name + ' yet. Run its tests with --code-coverage.')]
  if (!lines) return [note(name + ': ' + pct + '% covered. Line detail needs --json output (sf apex run test … --code-coverage --json).')]
  if (lines.length === 0) return [note(name + ': ' + pct + '% covered, every line.', 'green')]
  out.push(note(name + ': ' + pct + '% · ' + plural(lines.length, 'uncovered line') + ': ' + ranges(lines), coverageColor(pct)))
  out.push(Button({ key: 'files-cover', label: 'Ask Claude to cover these lines', hotkey: 't', plain: true, color: 'cyan', onPress: () => askForCoverage($, name, pct, lines) }))
  const src = typeof sel.current === 'string' ? splitLines(sel.current) : null
  if (!src) return out
  // each uncovered range with two lines of context
  const blocks = []
  for (const n of lines) {
    const last = blocks[blocks.length - 1]
    if (last && n <= last.to + 5) last.to = n
    else blocks.push({ from: n, to: n })
  }
  for (const b of blocks.slice(0, 8)) {
    const first = Math.max(1, b.from - 2)
    const end = Math.min(src.length, b.to + 2)
    const marked = src.slice(first - 1, end).map((l, i) => (lines.includes(first + i) ? '✘ ' : '  ') + l)
    out.push(Code({ source: marked.join('\n'), path: sel.path, startLine: first, wrap: 'truncate-end' }))
  }
  if (blocks.length > 8) out.push(note('and ' + (blocks.length - 8) + ' more ranges'))
  return out
}

function renderFilesPane($, e) {
  const { Box, Text, Button, Code } = $.ui.resolve(e)
  const redraw = () => $.ui.invalidate('ui.render')
  const width = Math.max(30, (e.props?.bodyColumns ?? cfg.filesPaneWidth) - 2)
  lastPaneColumns = e.props?.bodyColumns ?? lastPaneColumns
  const draftList = cfg.liveTyping && !liveDisabled ? drafts.list() : []
  const list = [...files.values()].sort((a, b) => b.at - a.at)
  const rowsAll = [...draftList.map((d) => ({ key: 'draft:' + d.id, draft: d })), ...list.map((f) => ({ key: f.path, file: f }))]
  if (!selectedFile || !rowsAll.some((r) => r.key === selectedFile)) selectedFile = rowsAll[0]?.key ?? null
  const selIndex = Math.max(0, rowsAll.findIndex((r) => r.key === selectedFile))
  const selRow = rowsAll[selIndex] ?? null
  const sel = selRow?.file ?? null
  const selDraft = selRow?.draft ?? null

  const choose = (key) => {
    selectedFile = key
    followLatest = false
    redraw()
  }
  const move = (step) => {
    if (rowsAll.length === 0) return
    choose(rowsAll[(selIndex + step + rowsAll.length) % rowsAll.length].key)
  }
  const view = (name) => () => {
    filesView = name
    redraw()
  }

  // Header: title, live state, totals
  const watch = watchSummary()
  const totalAdds = list.reduce((n, f) => n + (f.binary ? 0 : f.adds), 0)
  const totalRemoves = list.reduce((n, f) => n + (f.binary ? 0 : f.removes), 0)
  const live =
    watchMode === 'git' || watchMode === 'folder'
      ? Text({ color: 'green', children: ['● live'] })
      : watchMode === 'starting'
        ? Text({ color: 'yellow', children: ['◐ starting'] })
        : Text({ color: 'yellow', children: ['◐ tools only'] })
  const header = Box({
    flexDirection: 'row',
    columnGap: 2,
    children: [
      Text({ bold: true, children: ['Files'] }),
      live,
      Text({ dimColor: true, children: [plural(list.length, 'file')] }),
      ...(draftList.length ? [Text({ color: 'cyan', children: ['✎ ' + draftList.length] })] : []),
      ...(totalAdds ? [Text({ color: 'green', children: ['+' + totalAdds] })] : []),
      ...(totalRemoves ? [Text({ color: 'red', children: ['−' + totalRemoves] })] : []),
      ...(validating ? [Text({ color: 'yellow', children: ['validating…'] })] : []),
    ],
  })

  const watchLine = Text({ ...(watch.ok ? { dimColor: true } : { color: 'yellow' }), wrap: 'wrap', children: [watch.text] })
  const blank = () => Text({ children: [' '] })
  const problems = allProblems()

  // Controls: plain buttons show their key, so this row is also the key guide
  const controls = Box({
    flexDirection: 'row',
    columnGap: 2,
    flexWrap: 'wrap',
    children: [
      Button({ key: 'files-prev', label: '↑', hotkey: 'k', plain: true, dimColor: true, onPress: () => move(-1) }),
      Button({ key: 'files-next', label: '↓', hotkey: 'j', plain: true, dimColor: true, onPress: () => move(1) }),
      Button({
        key: 'files-follow',
        label: 'Follow ' + (followLatest ? 'on' : 'off'),
        hotkey: 'f',
        plain: true,
        dimColor: !followLatest,
        onPress: () => {
          followLatest = !followLatest
          if (followLatest) selectedFile = rowsAll[0]?.key ?? null
          redraw()
        },
      }),
      Button({
        key: 'files-clear',
        label: 'Clear',
        hotkey: 'x',
        plain: true,
        dimColor: true,
        onPress: () => {
          for (const f of files.values()) dismissed.set(f.path, { mtime: f.seenMtime, content: f.current })
          files.clear()
          selectedFile = null
          followLatest = true
          redraw()
        },
      }),
      Button({ key: 'files-refresh', label: 'Refresh', hotkey: 'r', plain: true, dimColor: true, onPress: () => watchPoll($).then(redraw) }),
      Button({ key: 'files-validate', label: 'Validate', hotkey: 'v', plain: true, dimColor: true, onPress: () => validateChanged($) }),
      ...(sel && sel.status !== 'deleted'
        ? [Button({ key: 'files-open', label: 'Open', hotkey: 'o', plain: true, dimColor: true, onPress: () => openInEditor($, sel.path, problemsFor(sel.path)[0]?.line ?? sel.focus?.[0] ?? null) })]
        : []),
      ...(list.some((f) => f.status === 'deleted' && memberOf(projectRel(f.path)))
        ? [Button({ key: 'files-delete-org', label: 'Delete from org', hotkey: 'd', plain: true, dimColor: true, onPress: () => deleteFromOrg($) })]
        : []),
      ...(problems.length ? [Button({ key: 'files-fix', label: 'Ask Claude to fix', hotkey: 'a', plain: true, color: 'red', onPress: () => askClaudeToFix($) })] : []),
      Text({ dimColor: true, children: ['esc: close'] }),
    ],
  })

  if (rowsAll.length === 0) {
    return Box({
      flexDirection: 'column',
      children: [
        header,
        blank(),
        Text({ children: ['Waiting for changes…'] }),
        Text({ dimColor: true, wrap: 'wrap', children: ['Files Claude creates, edits or deletes show up here as they change' + (cfg.liveTyping ? ', and while Claude writes them.' : '.')] }),
        blank(),
        controls,
        watchLine,
      ],
    })
  }

  // The list, scrolled so the selected row shows
  const start = Math.max(0, Math.min(selIndex - Math.floor(LIST_ROWS / 2), rowsAll.length - LIST_ROWS))
  const shown = rowsAll.slice(start, start + LIST_ROWS)
  const rows = []
  if (start > 0) rows.push(Text({ dimColor: true, children: ['  ↑ ' + start + ' more'] }))
  shown.forEach((r, k) => {
    const i = start + k
    const isSel = r.key === selectedFile
    if (r.draft) {
      const d = r.draft
      const { dir, base } = draftLabel(d)
      rows.push(
        Box({
          flexDirection: 'row',
          columnGap: 1,
          children: [
            Text({ bold: true, ...(isSel ? { color: 'cyan' } : {}), children: [isSel ? '▸' : ' '] }),
            Text({ color: d.state === 'discarded' ? 'gray' : 'cyan', bold: true, children: ['✎'] }),
            Button({ key: 'file-' + i, label: base, plain: true, onPress: () => choose(r.key) }),
            Text({ dimColor: true, wrap: 'truncate-start', children: [dir || ' '] }),
            ...(d.agentId ? [Text({ color: 'magenta', children: ['sub'] })] : []),
            Text({ ...(d.state === 'discarded' ? { dimColor: true } : { color: 'cyan' }), children: [draftStatusText(d)] }),
          ],
        }),
      )
      return
    }
    const f = r.file
    const st = STATUS[f.status] ?? STATUS.edited
    const { dir, base } = splitPath(f.path)
    const fresh = Date.now() - f.at < FRESH_MS
    const stats = []
    const probs = problemsFor(f.path)
    if (f.writing) stats.push(Text({ color: 'yellow', children: ['writing…'] }))
    else {
      if (f.binary) stats.push(Text({ dimColor: true, children: ['binary'] }))
      else {
        if (f.adds) stats.push(Text({ color: 'green', children: ['+' + f.adds] }))
        if (f.removes) stats.push(Text({ color: 'red', children: ['−' + f.removes] }))
      }
      if (probs.length) stats.push(Text({ color: 'red', bold: true, children: ['✘' + probs.length] }))
      stats.push(Text({ ...(fresh ? { color: 'yellow', bold: true } : { dimColor: true }), children: [f.restored ? 'earlier' : ago(f.at)] }))
    }
    rows.push(
      Box({
        flexDirection: 'row',
        columnGap: 1,
        children: [
          Text({ bold: true, ...(isSel ? { color: 'cyan' } : {}), children: [isSel ? '▸' : ' '] }),
          Text({ color: st.color, bold: true, children: [st.glyph] }),
          Button({ key: 'file-' + i, label: base || f.path, plain: true, onPress: () => choose(f.path) }),
          Text({ dimColor: true, wrap: 'truncate-start', children: [dir || ' '] }),
          ...stats,
        ],
      }),
    )
  })
  if (start + LIST_ROWS < rowsAll.length) rows.push(Text({ dimColor: true, children: ['  ↓ ' + (rowsAll.length - start - LIST_ROWS) + ' more'] }))

  // Views
  const tab = (name, label, hotkey) =>
    Button({ key: 'files-view-' + name, label, hotkey, plain: true, dimColor: filesView !== name, onPress: view(name) })
  const tabs = Box({
    flexDirection: 'row',
    columnGap: 3,
    children: [tab('latest', 'Latest change', '1'), tab('all', 'All changes', '2'), tab('file', 'File', '3'), tab('coverage', 'Coverage', '4')],
  })

  const note = (text, color) => Text({ ...(color ? { color } : { dimColor: true }), wrap: 'wrap', children: [text] })
  const detail = []
  if (selDraft) {
    detail.push(...draftView($, selDraft, Code, note))
  } else if (sel) {
    const st = STATUS[sel.status] ?? STATUS.edited
    const facts = [sel.writing ? 'writing…' : st.word, sel.restored ? 'from an earlier session' : agoLong(sel.at)]
    if (sel.focus && sel.status !== 'deleted') facts.push('lines ' + sel.focus[0] + '–' + sel.focus[1])
    detail.push(
      Box({
        flexDirection: 'row',
        columnGap: 1,
        children: [
          Text({ bold: true, wrap: 'truncate-start', children: [relPath(sel.path)] }),
          Text({ color: st.color, children: ['· ' + facts[0]] }),
          Text({ dimColor: true, wrap: 'truncate', children: ['· ' + facts.slice(1).join(' · ')] }),
        ],
      }),
    )
    const code = (source, extra) => Code({ source, path: sel.path, wrap: 'truncate-end', ...extra })

    if (sel.isFolder) detail.push(note('Folder deleted.', 'red'))
    else if (sel.binary) detail.push(note('Binary file: no preview.'))
    else if (sel.tooLarge) detail.push(note('Larger than 1 MB: listed without a preview.'))
    else if (filesView === 'coverage') detail.push(...coverageView($, sel, Code, Button, note))
    else if (filesView === 'latest') {
      if (sel.latestDiff) detail.push(code(sel.latestDiff, { format: 'diff' }))
      else if (sel.writing) detail.push(note('Writing…'))
      else if (sel.restored) detail.push(note('Listed from an earlier session. Changes from now on show here.'))
      else if (sel.noBaseline && sel.changes <= 1) detail.push(note('It changed before it was tracked, so its earlier content is unknown. The next change shows here; press 3 to see the file.'))
      else detail.push(note('No line changes in the latest update.'))
    } else if (filesView === 'all') {
      if (sel.allDiff) {
        detail.push(code(sel.allDiff, { format: 'diff' }))
        if (sel.cut) detail.push(note('Long diff: the first part is shown.'))
        if (sel.noBaseline) detail.push(note('Changes since it was first seen in this session.'))
      } else detail.push(note(sel.noBaseline ? 'No changes since it was first seen.' : 'No changes since the session started.'))
      if (sel.slim) detail.push(note('Older file: its full text was dropped to save memory; the diff above is kept.'))
    } else if (sel.status === 'deleted') {
      detail.push(note('Deleted. Press 1 or 2 to see what it held.', 'red'))
    } else if (sel.current === null) {
      detail.push(note(sel.writing ? 'Writing…' : sel.slim ? 'Older file: full text not kept. Press r to read it again.' : 'Could not read the file.'))
    } else {
      const lines = splitLines(sel.current)
      if (lines.length === 0) detail.push(note('(empty file)'))
      else {
        let first = 1
        let last = Math.min(lines.length, MAX_PREVIEW_LINES)
        const focus = problemsFor(sel.path).find((p) => p.line)?.line
        const at = focus ? [focus, focus] : sel.focus
        if (at) {
          first = Math.max(1, at[0] - PREVIEW_CONTEXT)
          last = Math.min(lines.length, Math.max(at[1] + PREVIEW_CONTEXT, first + 20), first + MAX_PREVIEW_LINES - 1)
        }
        detail.push(note('lines ' + first + '–' + last + ' of ' + lines.length))
        detail.push(code(lines.slice(first - 1, last).join('\n'), { startLine: first }))
      }
    }
    if (sel.perms?.length && sel.status !== 'deleted') {
      detail.push(note('Permission changes since the session started:'))
      for (const x of sel.perms.slice(0, 12)) detail.push(Text({ ...(x.risky ? { color: 'red', bold: true } : x.added ? {} : { dimColor: true }), wrap: 'wrap', children: [(x.added ? '+ grants ' : '− removes ') + x.text + (x.risky ? '  (risky)' : '')] }))
      if (sel.perms.length > 12) detail.push(note('and ' + (sel.perms.length - 12) + ' more'))
    }
    // Problems in this file, under the view
    const probs = problemsFor(sel.path)
    for (const p of probs.slice(0, 6)) detail.push(Text({ color: problemColor(p), wrap: 'wrap', children: ['✘ ' + (p.line ? 'line ' + p.line + (p.col ? ':' + p.col : '') + '  ' : '') + p.problem] }))
    if (probs.length > 6) detail.push(note('and ' + (probs.length - 6) + ' more problems'))
  }

  // Problems elsewhere: press one to select its file
  const other = problems.filter((p) => !sel || !problemsFor(sel.path).some((q) => q.problem === p.problem && q.line === p.line))
  const problemRows = []
  if (other.length) {
    problemRows.push(blank(), Text({ bold: true, color: 'red', children: ['Problems (' + problems.length + ')'] }))
    other.slice(0, 5).forEach((p, i) => {
      const target = pathForProblem(p)
      const label = failureLine({ file: p.file, line: p.line, col: p.col, problem: p.problem })
      problemRows.push(
        target
          ? Button({ key: 'problem-' + i, label: '✘ ' + label, plain: true, color: problemColor(p), onPress: () => choose(target) })
          : Text({ color: problemColor(p), wrap: 'truncate', children: ['✘ ' + label] }),
      )
    })
    if (other.length > 5) problemRows.push(note('and ' + (other.length - 5) + ' more · a: ask Claude to fix'))
  }

  return Box({
    flexDirection: 'column',
    children: [
      header,
      blank(),
      ...rows,
      Text({ dimColor: true, children: ['─'.repeat(Math.min(width, 80))] }),
      ...(selDraft ? [] : [tabs]),
      ...detail,
      ...problemRows,
      blank(),
      controls,
      watchLine,
    ],
  })
}

let lastPaneColumns = null

// ── Drawing: the Salesforce pane ────────────────────────────────────────────
function orgBadgeText(org) {
  const cls = clsOf(org)
  return org + ' · ' + cls
}

function renderSfPane($, e) {
  const { Box, Text, Button } = $.ui.resolve(e)
  const redraw = () => $.ui.invalidate('ui.render')
  const tabButton = (name, label, hotkey) =>
    Button({
      key: 'tab-' + name,
      label,
      hotkey,
      plain: true,
      dimColor: sfTab !== name,
      onPress: () => {
        sfTab = name
        redraw()
      },
    })
  const cls = clsOf(defaultOrg)
  const prod = !!defaultOrg && cls === 'production'
  const header = Text({
    bold: true,
    ...(prod ? { color: 'red' } : {}),
    children: ['Org: ' + (defaultOrg ? orgBadgeText(defaultOrg) : 'not set') + (prod ? '  ⚠️ PRODUCTION' : '') + (orgDetection === 'off' ? '  (org detection off)' : '')],
  })
  let body
  if (sfTab === 'apex') {
    const rows = [...apex.values()]
    if (rows.length === 0) body = [Text({ dimColor: true, children: ['No Apex classes or triggers changed yet.'] })]
    else {
      const open = rows.filter((c) => !c.tested).length
      body = [
        ...rows.map((c) => {
          const pct = coverage.get(c.name)
          return Text({
            color: c.tested ? 'green' : 'yellow',
            children: [(c.tested ? '✔ ' : '○ ') + c.name + '.' + c.kind + (c.isTest ? '  (test)' : '') + (pct !== undefined ? '  ' + pct + '%' : '')],
          })
        }),
        Text({ children: [' '] }),
        Text({ dimColor: true, children: [open + ' not yet covered by a passing test run'] }),
        Button({
          key: 'clear-apex',
          label: 'Clear list (c)',
          hotkey: 'c',
          onPress: () => {
            apex.clear()
            redraw()
          },
        }),
      ]
    }
  } else if (sfTab === 'deploys') {
    body =
      deployLog.length === 0
        ? [Text({ dimColor: true, children: ['No deploys yet in this session.'] })]
        : deployLog.map((d, i) => Text({ color: d.ok ? 'green' : 'red', children: [deployLine(d, i) + ' · ' + agoLong(d.at)] }))
    const probs = allProblems()
    if (probs.length) {
      body.push(Text({ children: [' '] }), Text({ bold: true, color: 'red', children: ['Problems'] }))
      for (const p of probs.slice(0, 10)) body.push(Text({ color: problemColor(p), wrap: 'truncate', children: ['✘ ' + failureLine(p)] }))
      body.push(Button({ key: 'fix-problems', label: 'Ask Claude to fix (a)', hotkey: 'a', onPress: () => askClaudeToFix($) }))
    }
  } else if (sfTab === 'coverage') {
    const rows = [...coverage.entries()].sort((a, b) => a[1] - b[1])
    body =
      rows.length === 0
        ? [Text({ dimColor: true, children: ['No coverage yet. Run tests with --code-coverage.'] })]
        : [
            ...rows.map(([name, pct]) => {
              const un = uncovered.get(name)
              return Text({
                color: coverageColor(pct),
                wrap: 'truncate',
                children: [coverageBar(pct) + ' ' + String(pct).padStart(3) + '%  ' + name + (un && un.length ? '  · uncovered ' + ranges(un) : '')],
              })
            }),
            Text({ children: [' '] }),
            Text({ dimColor: true, children: ['green ≥ ' + cfg.coverageTarget + '% · yellow ≥ ' + COVERAGE_MIN + '% · red below'] }),
          ]
  } else {
    const lines = limitsLoading ? ['Loading…'] : lastLimits ? limitsText(lastLimits).split('\n') : ['Not loaded yet. Press r.']
    body = [
      ...lines.map((line) => Text({ children: [line] })),
      Text({ children: [' '] }),
      Button({
        key: 'refresh-limits',
        label: 'Refresh (r)',
        hotkey: 'r',
        onPress: async () => {
          limitsLoading = true
          redraw()
          lastLimits = await fetchLimits($, defaultOrg)
          limitsLoading = false
          redraw()
        },
      }),
    ]
  }
  return Box({
    flexDirection: 'column',
    children: [
      header,
      Box({
        flexDirection: 'row',
        columnGap: 3,
        children: [tabButton('apex', 'Apex', '1'), tabButton('deploys', 'Deploys', '2'), tabButton('coverage', 'Coverage', '3'), tabButton('limits', 'Limits', '4')],
      }),
      Text({ children: [' '] }),
      ...body,
    ],
  })
}

// ── /sfguard and /sfdoctor ──────────────────────────────────────────────────
function explain(result) {
  if (result.parts.length === 0) return 'allow · nothing here changes an org'
  const out = [result.verdict.toUpperCase()]
  for (const p of result.parts) {
    out.push(
      '  ' + p.verdict.padEnd(6) + ' ' + (CATEGORY_LABEL[p.category] ?? p.category) + ' · ' + (p.org ?? '(no org)') + ' (' + p.cls + (p.usesDefault ? ', default org' : '') + ')' + '\n         ' + (p.inner ? p.inner + '  [inside ' + p.via + ']' : p.segment) + '\n         why: ' + p.reason,
    )
  }
  if (result.verdict === 'ask') out.push('  choices: ' + choicesFor(result).join(' · '))
  return out.join('\n')
}

function orgsReport() {
  const all = uniqueOrgs(orgMap)
  const head =
    orgDetection === 'on'
      ? 'Org detection on (sf org list, ' + agoLong(orgLoadedAt) + ')'
      : orgDetection === 'starting'
        ? 'Org detection starting…'
        : '⚠ Org detection off: ' + (orgNote || 'sf org list failed') + '. Only your settings are used; every other org is unknown and asks.'
  if (all.length === 0) return head + '\nNo orgs known.'
  const lines = all
    .sort((a, b) => a.cls.localeCompare(b.cls))
    .map((o) => {
      const days = o.org?.expirationDate ? daysUntil(o.org.expirationDate) : null
      return '  ' + o.cls.padEnd(10) + ' ' + (o.alias ?? '—').padEnd(16) + ' ' + (o.username ?? '—') + '  [' + o.source + ']' + (o.cls === 'scratch' && days !== null ? '  expires in ' + days + 'd' : '') + (o.username && defaultOrg && [o.alias, o.username].includes(defaultOrg) ? '  ← default' : '')
    })
  return head + '\n' + lines.join('\n') + '\nUnknown orgs (not listed) are treated like production.'
}

async function sfguardCommand($, args) {
  const a = String(args ?? '').trim()
  if (a.startsWith('test')) {
    const cmd = a.slice(4).trim()
    if (!cmd) return 'Usage: /sfguard test <command>   (nothing is run)'
    if (/^mcp__/.test(cmd)) {
      const [tool, org] = cmd.split(/\s+/)
      await orgsForGuard($)
      return explain(decide({ mcp: { tool, input: org ? { usernameOrAlias: org } : {} }, orgMap, defaultOrg, settings: guardSettings() }))
    }
    return explain(await judge($, cmd))
  }
  if (a === 'backups') {
    const stored = await storeGet($, 'backups')
    const list = Array.isArray(stored) ? stored : backups
    if (list.length === 0) return 'No backups yet. SF Guardian saves one before each deploy to a production or unknown org.'
    return 'Backups taken before production deploys, newest first. Validate a restore with its command, then run it without --dry-run:\n' + [...list].reverse().map((b) => '• ' + new Date(b.at).toLocaleString() + ' · ' + b.org + '\n  ' + tildify(b.dir) + '\n  ' + restoreCommand(b)).join('\n') + '\nA restore puts back what the org had; it does not remove components the deploy added.'
  }
  if (a === 'orgs') {
    await orgsForGuard($)
    return orgsReport()
  }
  if (a.startsWith('export')) {
    const target = a.slice(6).trim() || 'sf-guardian-audit-' + new Date().toISOString().slice(0, 10) + '.json'
    const entries = await auditEntries($)
    try {
      await $.fs.write(absPath(target), JSON.stringify(entries, null, 2) + '\n')
      return 'Wrote ' + plural(entries.length, 'entry').replace('entrys', 'entries') + ' to ' + absPath(target) + '. Nothing was sent anywhere.'
    } catch (err) {
      return 'Could not write ' + target + ': ' + String(err?.message ?? err)
    }
  }
  const stored = cfg.auditLog ? await auditEntries($) : decisions
  const recent = stored.slice(-20)
  if (recent.length === 0) return 'No guarded commands yet.' + '\nTry: /sfguard test sf project deploy start -o prod --test-level RunLocalTests\n     /sfguard orgs · /sfguard backups · /sfguard export [file]'
  return 'Last ' + recent.length + ' guard decisions (mode: ' + cfg.guardMode + (cfg.auditLog ? ', audit log on' : ', audit log off') + '):\n' + recent.map(decisionLine).join('\n') + '\n\n/sfguard test <command> · /sfguard orgs · /sfguard backups · /sfguard export [file]'
}

async function runQuiet($, argv, timeoutMs = 8000) {
  try {
    return await $.process.run(argv, { timeoutMs, cwd: cwd || undefined })
  } catch {
    return null
  }
}

async function sfdoctor($, args) {
  const a = String(args ?? '').trim()
  if (a.startsWith('record')) {
    const s = unparsed.samples[unparsed.samples.length - 1]
    if (!s) return 'No unparsed sf output this session.'
    const target = a.slice(6).trim() || 'sf-guardian-unparsed-' + new Date(s.at).toISOString().slice(0, 19).replace(/:/g, '') + '.txt'
    try {
      await $.fs.write(absPath(target), s.text + '\n')
      return 'Saved the last unparsed output (cleaned, first 2 KB) to ' + absPath(target) + '. Read it before attaching it to a bug report.'
    } catch (err) {
      return 'Could not write ' + target + ': ' + String(err?.message ?? err)
    }
  }
  if (a === 'perf') {
    const t0 = Date.now()
    await watchPoll($)
    const ms = Date.now() - t0
    const n = watchMode === 'folder' ? folderBaseline?.size ?? 0 : null
    return 'One poll took ' + ms + ' ms (' + watchMode + (n !== null ? ', ' + n + ' files watched' : '') + '). Budget: 150 ms on a 5,000-file project.\nNext poll in ' + pollInterval() / 1000 + ' s (adaptive).'
  }
  const t0 = Date.now()
  const rows = ['✔ SF Guardian v' + modVersion]
  const ok = (text) => rows.push('✔ ' + text)
  const warn = (text, fix) => rows.push('⚠ ' + text + (fix ? '\n    → ' + fix : ''))
  const bad = (text, fix) => rows.push('✘ ' + text + (fix ? '\n    → ' + fix : ''))
  await ensureCwd($)
  // Claude Code
  try {
    const v = await $.session.version()
    if (versionAtLeast(v.base ?? v.version, MIN_CLAUDE)) ok('Claude Code ' + v.version)
    else bad('Claude Code ' + v.version + ' is older than ' + MIN_CLAUDE, 'Update Claude Code')
  } catch {
    warn('Could not read the Claude Code version')
  }
  // sf, its plugins, git: in parallel
  const [sfv, plugins, gitv] = await Promise.all([runQuiet($, ['sf', '--version']), runQuiet($, ['sf', 'plugins', '--core', '--json'], 15000), runQuiet($, ['git', '--version'])])
  if (sfv && sfv.exitCode === 0) ok('sf ' + sfv.stdout.trim().split(/\s/)[0].replace('@salesforce/cli/', ''))
  else bad('sf is not installed or not on PATH', 'Install the Salesforce CLI: https://developer.salesforce.com/tools/salesforcecli')
  if (plugins && plugins.exitCode === 0) {
    let names = []
    try {
      const j = JSON.parse(plugins.stdout)
      names = (Array.isArray(j) ? j : j.result ?? []).map((p) => p.name)
    } catch {
      names = []
    }
    const need = ['@salesforce/plugin-apex', '@salesforce/plugin-deploy-retrieve', '@salesforce/plugin-org']
    const missing = need.filter((n) => !names.includes(n))
    if (missing.length === 0) ok('apex, deploy-retrieve and org plugins present')
    else bad('missing sf plugins: ' + missing.join(', '), 'sf plugins install ' + missing.join(' '))
    if (cfg.codeAnalyzer) {
      if (names.includes('@salesforce/plugin-code-analyzer')) ok('Code Analyzer plugin present')
      else bad('Code Analyzer is on but its plugin is missing', 'sf plugins install code-analyzer')
      const java = await runQuiet($, ['java', '-version'])
      if (java && java.exitCode === 0) ok('Java found (some analyzer engines need it)')
      else warn('Java not found: the PMD and CPD engines of Code Analyzer need it', 'Install Java 11 or later')
    }
  } else if (sfv && sfv.exitCode === 0) warn('Could not list sf plugins')
  if (gitv && gitv.exitCode === 0) ok(gitv.stdout.trim())
  else warn('git not found: the Files sidebar watches the folder instead', 'Install git')
  // Project
  await loadProject($)
  if (project?.found && !project.broken) ok('sfdx-project.json found' + (project.relDirs?.length ? ' · packages: ' + project.relDirs.join(', ') : '') + (project.sourceApiVersion ? ' · API ' + project.sourceApiVersion : ''))
  else if (project?.broken) bad('sfdx-project.json could not be read as JSON', 'Fix its syntax')
  else warn('No sfdx-project.json in ' + tildify(cwd), 'Start Claude inside your Salesforce project')
  // Orgs
  defaultOrg = await readDefaultOrg($)
  await refreshOrgs($)
  if (defaultOrg) ok('Default org: ' + defaultOrg + ' (' + clsOf(defaultOrg) + ')')
  else warn('No default org', 'sf config set target-org <alias>')
  if (orgDetection === 'on') {
    const counts = { production: 0, sandbox: 0, scratch: 0 }
    for (const o of uniqueOrgs(orgMap)) counts[o.cls] = (counts[o.cls] ?? 0) + 1
    ok('Org detection on: ' + counts.production + ' production, ' + counts.sandbox + ' sandbox, ' + counts.scratch + ' scratch; any other org is unknown and asks')
  } else bad('Org detection off (' + (orgNote || 'sf org list failed') + ')', 'Run sf org list in a terminal; log in again with sf org login web')
  const listed = (n) => orgList.some((o) => [o.alias, o.username].some((k) => k && k.toLowerCase() === n))
  const stray = [...cfg.prodOrgs, ...cfg.safeOrgs].filter((n) => !listed(n))
  if (orgDetection === 'on' && stray.length) warn('In your settings but not logged in: ' + stray.join(', '), 'Check the spelling in /config')
  else if (cfg.prodOrgs.length || cfg.safeOrgs.length) ok('Production and safe org settings match logged-in orgs')
  // Watch
  if (watchMode === 'starting') await watchPoll($)
  const w = watchSummary()
  if (w.ok) ok('Files watch: ' + w.text)
  else warn('Files watch: ' + w.text, 'Start Claude from the project folder')
  // Sidebar width
  if (lastPaneColumns) {
    if (lastPaneColumns >= 60) ok('Sidebar width ' + lastPaneColumns + ' columns')
    else warn('Sidebar is narrow (' + lastPaneColumns + ' columns)', 'Widen the terminal, or raise "Files sidebar width" in /config')
  } else warn('Sidebar width unknown until the sidebar opens', 'A pane opened unasked needs a terminal at least 144 columns wide; /sffiles always opens it')
  // Store
  const probe = 'doctor-' + Date.now()
  if (await storeSet($, 'doctor', probe)) {
    const back = await storeGet($, 'doctor')
    if (back === probe) ok('Store is writable (audit log, org cache)')
    else bad('Store did not read back', 'Check permissions on ~/.claude')
  } else bad('Store is not writable', 'Check permissions on ~/.claude')
  // Unparsed outputs
  if (unparsed.count === 0) ok('No unparsed sf output this session')
  else warn(plural(unparsed.count, 'sf output') + ' could not be summarized this session', '/sfdoctor record saves the last one (cleaned) for a bug report')
  if (teamNote) bad(teamNote, 'Fix the JSON in ' + POLICY_FILE)
  else if (teamPolicy) ok('Team policy (' + POLICY_FILE + '): ' + policySummary(teamPolicy))
  else ok('No team policy file (' + POLICY_FILE + '); your own settings apply')
  ok('Backups before production deploys ' + (cfg.backupBeforeDeploy ? 'on' : 'off'))
  if (cfg.codingStandards) ok('Coding standards on' + (cfg.namePrefix ? ' · new components need the ' + cfg.namePrefix + '_ prefix' : ' · no name prefix set'))
  else warn('Coding standards off', 'Turn them on in /config')
  // Live typing
  if (!cfg.liveTyping) warn('Live typing is off', 'Turn it on in /config')
  else if (liveDisabled) warn('Live typing turned itself off after an error this session', 'Restart Claude Code; report it if it happens again')
  else ok('Live typing on')
  return 'SF Guardian doctor (' + (Date.now() - t0) + ' ms)\n' + rows.join('\n') + '\n\nSafe to paste into an issue: emails and org ids are not shown above, but check your org aliases.'
}

const TOOLS = [
  {
    name: 'describe_object',
    description: 'Describe a Salesforce object in an org: every field with its API name, type, label, whether it is required, lookup targets and picklist values, plus child relationships. Use it before writing Apex, SOQL or LWC that references fields, instead of guessing field API names. Read only. org defaults to the default org.',
    inputSchema: { type: 'object', properties: { object: { type: 'string', description: 'Object API name, such as Account or Invoice__c' }, org: { type: 'string', description: 'Org alias or username (optional)' } }, required: ['object'] },
    isDeferred: false,
  },
  {
    name: 'soql_query',
    description: 'Run a read-only SOQL query in a Salesforce org and get the records as JSON. LIMIT 50 is added when the query has none, and limits above 200 are lowered to 200. On a production or unknown org the user is asked first. org defaults to the default org.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'A SELECT query' }, org: { type: 'string', description: 'Org alias or username (optional)' } }, required: ['query'] },
    isDeferred: false,
  },
]

// ── Hooks ───────────────────────────────────────────────────────────────────
export function register(on, options) {
  applyOptions(options)

  on('session.start', async ($, e, next) => {
    if (typeof e.cwd === 'string' && e.cwd) cwd = norm(e.cwd)
    try {
      const info = await $.session.info()
      platform = info.platform ?? 'unknown'
      sessionKey = String(info.transcriptPath ?? '').replace(/\\/g, '/').split('/').pop().replace(/\.jsonl$/, '')
    } catch {
      // not needed to work
    }
    await ensureHome($)
    try {
      const manifest = JSON.parse(await $.fs.read($.plugin.root + '/.claude-plugin/plugin.json'))
      if (typeof manifest.version === 'string') modVersion = manifest.version
    } catch {
      // keep the fallback
    }
    for (const c of [
      { name: 'sffiles', description: 'Open the live Files sidebar: what Claude creates, edits and deletes' },
      { name: 'sfpanel', description: 'Open the Salesforce pane (Apex · Deploys · Coverage · Limits)' },
      { name: 'sforg', description: 'Show and refresh the default Salesforce org' },
      { name: 'deploys', description: 'List the deploys Claude ran in this session' },
      { name: 'sflimits', description: 'Show org API limits: /sflimits [alias]' },
      { name: 'sfguard', description: 'Guard decisions; /sfguard test <command>, orgs, backups, export [file]' },
      { name: 'sfdoctor', description: 'Check the SF Guardian setup; /sfdoctor record, /sfdoctor perf' },
    ]) {
      try {
        await $.command.register({ ...c, immediate: true })
      } catch {
        // A command that can't register leaves the rest working
      }
    }
    for (const t of TOOLS) {
      try {
        await $.tool.register(t)
      } catch (err) {
        $.ui.toast('SF Guardian could not add the ' + t.name + ' tool: ' + String(err?.message ?? err))
      }
    }
    void startOrgs($)
    defaultOrg = await readDefaultOrg($)
    await restoreFileList($)
    await watchPoll($) // the baseline: what was already changed before this session
    try {
      $.clock.every(BAND_REFRESH_MS, () => $.ui.invalidate('ui.render'))
      $.clock.every(TICK_MS, () => {
        if (!filesPaneOpen) return
        if (Date.now() - lastPollAt >= pollInterval() - 100) void watchPoll($)
        // Keep "now" and ages current
        if ([...files.values()].some((f) => Date.now() - f.at < FRESH_MS + TICK_MS)) $.ui.invalidate('ui.render')
      })
      $.clock.every(DRAW_MS, () => {
        drafts.sweep()
        if (drafts.takeDirty()) {
          lastDrawAt = Date.now()
          $.ui.invalidate('ui.render')
        }
      })
    } catch {
      // No timers here (such as a test): views still update on each change
    }
    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    if (!cfg.codingStandards) return r
    if (!project) await loadProject($)
    if (!project?.found) return r
    return { ...r, sections: [...r.sections, { id: 'sf-guardian:standards', text: standardsText(cfg.namePrefix), scope: 'session' }] }
  })

  on('tool.run', { tool: 'mcp__sf-guardian__describe_object' }, async ($, e) => describeTool($, e))
  on('tool.run', { tool: 'mcp__sf-guardian__soql_query' }, async ($, e) => soqlTool($, e))

  on('session.end', async ($, e, next) => {
    try {
      await saveFileList($)
    } catch {
      // best effort
    }
    return next(e)
  })

  // ── Live typing: watch file tools' arguments stream in; pass every chunk on unchanged ─
  on('turn.step', async function* ($, e, next) {
    const stream = next(e)
    for await (const chunk of stream) {
      if (cfg.liveTyping && !liveDisabled) {
        try {
          const before = drafts.size
          drafts.ingest(chunk, e)
          if (drafts.size > before) {
            const d = [...drafts.list()].pop()
            if (d && followLatest) selectedFile = 'draft:' + d.id
            void autoOpenFiles($)
          }
          if (Date.now() - lastDrawAt >= DRAW_MS && drafts.takeDirty()) {
            lastDrawAt = Date.now()
            $.ui.invalidate('ui.render')
          }
        } catch {
          liveDisabled = true
          drafts.clear()
          try {
            $.ui.toast('SF Guardian: live typing turned off for this session after an error.')
          } catch {
            // never touch the stream
          }
        }
      }
      yield chunk // exactly as received
    }
  })

  // ── Bash: guard, sf summaries, deletes, secrets, and a look for changed files ─
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const cmd = String(e.command ?? '')
    await ensureCwd($)
    await ensureHome($)

    // Auth files under ~/.sf and ~/.sfdx
    if (mentionsAuthDir(cmd) && !(await guardAuthRead($, cmd))) {
      return { deny: 'The user did not allow reading Salesforce auth files (~/.sf, ~/.sfdx). Do not try to read them another way.' }
    }

    const badName = generatedNameProblem(cmd)
    if (badName) return { deny: badName }

    // The guard: every simple command, wrapped ones and scripts included
    const result = await judge($, cmd)
    let command = cmd
    let answer = null
    const first = result.parts.find((p) => p.verdict !== 'allow') ?? result.parts[0]
    if (result.verdict === 'refuse') {
      const p = result.parts.find((x) => x.verdict === 'refuse')
      await audit($, { command: cmd, org: p.org, cls: p.cls, verdict: 'refuse', reason: p.reason, outcome: 'refused' })
      return { deny: p.reason }
    }
    if (result.verdict === 'ask') {
      const choices = choicesFor(result)
      answer = await askPerson($, questionFor(result), choices)
      if (answer === null || answer === 'Cancel' || !choices.includes(answer)) {
        await audit($, { command: cmd, org: first.org, cls: first.cls, verdict: 'ask', answer: answer ?? 'no answer', reason: first.reason, outcome: 'cancelled' })
        const label = first.cls === 'production' ? 'PRODUCTION (' + first.org + ')' : first.cls === 'unknown' ? 'UNKNOWN ORG' + (first.org ? ' (' + first.org + ')' : '') : first.org
        return { deny: 'The user declined this command against ' + label + '. Ask the user before trying another approach.' }
      }
      if (answer.startsWith('Validate')) command = applyDryRun(cmd, result.parts)
      const deploys = answer === 'Run as written' ? result.parts.filter((p) => p.verdict === 'ask' && p.category === 'deploy' && needsAsk(p.cls) && !p.inner) : []
      if (cfg.backupBeforeDeploy && deploys.length) {
        const stop = await backupOrStop($, cmd, deploys)
        if (stop) return stop
      }
    }

    const info = describeSf(command)
    const targets = rmTargets(command)
    let snaps = []
    if (targets.length) {
      try {
        snaps = await snapshotRemovals($, targets)
      } catch {
        snaps = []
      }
    }
    if (info) {
      sfCalls.set(e.tool_use_id, { type: info.type, command, org: info.org })
      if (sfCalls.size > 300) sfCalls.delete(sfCalls.keys().next().value)
      running = info.doing
      $.ui.invalidate('ui.render')
    }

    let r
    try {
      r = await next(command === cmd ? e : { ...e, command })
    } finally {
      if (info) {
        running = null
        $.ui.invalidate('ui.render')
      }
    }

    // Everything below is tracking: it never changes the command's result, except
    // that Salesforce session ids are removed from the output
    try {
      if (result.parts.length) {
        await audit($, { command, org: first.org, cls: first.cls, verdict: result.verdict, answer, reason: first.reason, outcome: r.deny ? 'refused' : r.isError ? 'failed' : 'ran' })
      }
      if (snaps.length) await finishRemovals($, snaps)
      if (info) afterSf($, info, command, r)
      if (changesLogins(command)) {
        void readDefaultOrg($).then((org) => {
          defaultOrg = org
          $.ui.invalidate('ui.render')
        })
        void refreshOrgs($)
      }
    } catch {
      // Tracking never changes the command's result
    }
    pollSoon($)
    return scrubResult(r)
  }).catch(async ($, e, next) => {
    running = null
    // The command already ran: keep its result (tracking fails open). Not yet: refuse (the guard fails closed).
    if (next.called) return next(e)
    return { deny: 'sf-guardian failed (' + next.error.kind + '), so this command was not run.' }
  })

  // ── Every other tool: MCP guard, auth files, live typing, file tracking ───
  on('tool.call', async ($, e, next) => {
    lastTools.push(String(e.tool))
    if (lastTools.length > 4) lastTools.shift()
    await ensureHome($)
    await ensureCwd($)

    // Salesforce MCP tools that change an org
    if (String(e.tool).startsWith('mcp__') && mcpToolOf(e.tool)) {
      await orgsForGuard($)
      const result = decide({ mcp: { tool: e.tool, input: e }, orgMap, defaultOrg, settings: guardSettings() })
      const p = result.parts[0]
      if (p && result.verdict === 'refuse') {
        await audit($, { command: e.tool + ' ' + (p.org ?? ''), org: p.org, cls: p.cls, verdict: 'refuse', reason: p.reason, outcome: 'refused' })
        return { deny: p.reason }
      }
      if (p && result.verdict === 'ask') {
        const choices = choicesFor(result, true)
        const answer = await askPerson($, questionFor(result), choices)
        if (answer !== 'Run as written') {
          await audit($, { command: e.tool + ' ' + (p.org ?? ''), org: p.org, cls: p.cls, verdict: 'ask', answer: answer ?? 'no answer', reason: p.reason, outcome: 'cancelled' })
          return { deny: 'The user declined ' + p.mcpTool + ' on ' + (p.org ?? 'the default org') + ' (' + p.cls + '). Ask the user before trying another approach.' }
        }
        const r = await next(e)
        await audit($, { command: e.tool + ' ' + (p.org ?? ''), org: p.org, cls: p.cls, verdict: 'ask', answer, reason: p.reason, outcome: r.deny ? 'refused' : r.isError ? 'failed' : 'ran' })
        return r
      }
      if (p) await audit($, { command: e.tool + ' ' + (p.org ?? ''), org: p.org, cls: p.cls, verdict: 'allow', reason: p.reason, outcome: 'ran' })
      return next(e)
    }

    const named =
      typeof e.file_path === 'string' ? e.file_path : typeof e.notebook_path === 'string' ? e.notebook_path : typeof e.path === 'string' ? e.path : null

    // Auth files under ~/.sf and ~/.sfdx
    if (named && isAuthPath(named) && !(await guardAuthRead($, e.tool + ' ' + named))) {
      return { deny: 'The user did not allow reading Salesforce auth files (~/.sf, ~/.sfdx). Do not try to read them another way.' }
    }

    const id = e.tool_use_id
    const badName = await newComponentProblem($, e.tool, typeof e.file_path === 'string' ? e.file_path : null)
    if (badName) {
      if (id) drafts.markDiscarded(id)
      return { deny: badName }
    }
    const draft = id ? drafts.markWriting(id) : null
    if (draft) $.ui.invalidate('ui.render')
    const target = typeof e.file_path === 'string' ? e.file_path : typeof e.notebook_path === 'string' ? e.notebook_path : null
    if (!target || READ_ONLY_TOOLS.has(e.tool) || String(e.tool).startsWith('mcp__')) {
      const r = await next(e)
      if (draft) settleDraft($, id, r)
      return r
    }

    const path = absPath(target)
    let before = null
    let existed = true
    try {
      existed = await $.fs.exists(path)
      before = existed ? await $.fs.read(path) : ''
    } catch {
      before = null
    }
    try {
      await trackStart($, path, existed)
      if (draft && followLatest) selectedFile = path
    } catch {
      // Tracking never stops the edit
    }

    const result = await next(e)
    const changed = !result.deny && !result.isError
    try {
      await trackEnd($, path, before, changed)
      if (draft) settleDraft($, id, result)
    } catch {
      // Tracking never changes the tool's result
    }

    if (changed) {
      void ensureDescribes($)
      changedThisTurn.add(path)
      const m = path.match(/([^/]+)\.(cls|trigger)$/)
      if (m) {
        apex.set(m[1], { name: m[1], kind: m[2], isTest: TEST_NAME.test(m[1]), tested: false })
        editedThisTurn.add(m[1])
        $.ui.invalidate('ui.render')
      }
    }
    return result
  }).catch(async ($, e, next) => {
    if (next.called) return next(e) // the tool ran: keep its result
    const target = [e.file_path, e.notebook_path, e.path].find((x) => typeof x === 'string')
    const guarded = (String(e.tool).startsWith('mcp__') && mcpToolOf(e.tool)) || (target && /[\\/]\.sf(?:dx)?[\\/]/.test(target))
    if (guarded) return { deny: 'sf-guardian failed (' + next.error.kind + '), so this call was not run.' }
    return next(e) // tracking fails open
  })

  // ── Turns ─────────────────────────────────────────────────────────────────
  on('turn.start', async ($, e, next) => {
    if (!e.agentId) {
      editedThisTurn.clear()
      changedThisTurn.clear()
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId) return r
    drafts.discardAll() // an aborted turn, or a draft that never became a tool call
    $.ui.invalidate('ui.render')
    if (e.usage) {
      const u = e.usage
      turnTokens.set(e.durationMs, {
        fresh: (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
        cached: u.cache_read_input_tokens ?? 0,
      })
      if (turnTokens.size > 200) turnTokens.delete(turnTokens.keys().next().value)
    }
    void saveFileList($)
    if (e.isAborted) return r
    if (cfg.codeAnalyzer) {
      const targets = [...changedThisTurn].filter((p) => /\.(cls|trigger)$|\/lwc\/.+\.(js|html)$|\/aura\/.+\.(js|cmp)$/.test(p) && files.get(p)?.status !== 'deleted')
      if (targets.length) void runAnalyzer($, targets)
    }
    const untested = untestedOf([...editedThisTurn])
    if (untested.length === 0) return r
    const tests = untested.map((n) => (TEST_NAME.test(n) ? n : n + 'Test'))
    return {
      ...(r ?? {}),
      text: '⚠️ Apex changed without a passing test run: ' + untested.join(', ') + '\n   e.g. sf apex run test --class-names ' + tests.join(',') + ' --code-coverage --wait 10',
    }
  })

  on('prompt.submit', async ($, e, next) => {
    const notes = ['When running Apex tests with sf, add --code-coverage --wait 10.']
    if (defaultOrg) {
      const cls = clsOf(defaultOrg)
      notes.unshift('Salesforce default target org: ' + defaultOrg + ' (' + cls + (cls === 'production' ? ', PRODUCTION, be careful' : '') + ').')
    }
    return next({ ...e, context: [...(e.context ?? []), notes.join(' ')] })
  })

  // ── Commands ──────────────────────────────────────────────────────────────
  on('command.run', { command: 'sffiles' }, async ($) => {
    filesPaneOpen = true
    filesAutoOpened = true
    try {
      await $.ui.open({ id: FILES_PANE, title: 'Files', focus: true, closeOnEscape: true, columns: cfg.filesPaneWidth })
    } catch {
      filesPaneOpen = false
      return { text: 'The Files sidebar needs the Claude Code terminal or the Desktop app.' }
    }
    await watchPoll($)
    $.ui.invalidate('ui.render')
    return {}
  })

  on('command.run', { command: 'sfpanel' }, async ($) => {
    try {
      await $.ui.open({ id: PANE, title: 'Salesforce', focus: true, closeOnEscape: true })
    } catch {
      return { text: 'The Salesforce pane needs the Claude Code terminal or the Desktop app.' }
    }
    return {}
  })

  on('command.run', { command: 'sforg' }, async ($) => {
    defaultOrg = await readDefaultOrg($)
    await refreshOrgs($)
    $.ui.invalidate('ui.render')
    const setup = orgDetection === 'on' ? '' : '\n⚠ Org detection off (' + (orgNote || 'sf org list failed') + '). Set your production orgs in /config.'
    if (!defaultOrg) return { text: 'No default org set. Run: sf config set target-org <alias>' + setup }
    const cls = clsOf(defaultOrg)
    return { text: 'Default org: ' + defaultOrg + ' (' + cls + ')' + (cls === 'production' ? '  ⚠️ PRODUCTION' : '') + setup + '\n/sfguard orgs lists every org.' }
  })

  on('command.run', { command: 'deploys' }, async () => {
    if (deployLog.length === 0) return { text: 'No deploys yet in this session.' }
    const probs = lastDeployProblems.length ? '\n\nLast errors:\n' + lastDeployProblems.slice(0, 5).map((p) => '✘ ' + failureLine(p)).join('\n') : ''
    return { text: deployLog.map(deployLine).join('\n') + probs }
  })

  on('command.run', { command: 'sflimits' }, async ($, e) => {
    const org = String(e.args ?? '').trim() || defaultOrg
    lastLimits = await fetchLimits($, org)
    $.ui.invalidate('ui.render')
    return { text: limitsText(lastLimits) }
  })

  on('command.run', { command: 'sfguard' }, async ($, e) => {
    try {
      return { text: await sfguardCommand($, e.args) }
    } catch (err) {
      return { text: '/sfguard failed: ' + String(err?.message ?? err) }
    }
  })

  on('command.run', { command: 'sfdoctor' }, async ($, e) => {
    try {
      return { text: await sfdoctor($, e.args) }
    } catch (err) {
      return { text: '/sfdoctor failed: ' + String(err?.message ?? err) }
    }
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === FILES_PANE) filesPaneOpen = false
    return next(e)
  })

  // ── Drawing ───────────────────────────────────────────────────────────────
  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId === FILES_PANE) return renderFilesPane($, e)
    if (e.requestId === PANE) return renderSfPane($, e)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!cfg.showBand) return next(e)
    if (e.plugin && e.plugin !== $.plugin.name) return next(e)
    if (e.props?.hasSurvey) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const sep = () => Text({ dimColor: true, children: ['│'] })
    const parts = []
    const cls = clsOf(defaultOrg)
    const entry = orgEntry(orgMap, defaultOrg)
    parts.push(
      !defaultOrg
        ? Text({ dimColor: true, children: ['○ no default org'] })
        : cls === 'production'
          ? Text({ bold: true, color: 'white', backgroundColor: 'red', children: [' PROD · ' + defaultOrg + ' '] })
          : cls === 'unknown'
            ? Text({ bold: true, color: 'yellow', children: ['? ' + defaultOrg + ' · unknown'] })
            : Text({ bold: true, color: 'green', children: ['● ' + defaultOrg + ' · ' + cls] }),
    )
    // Scratch org expiry
    const days = entry?.cls === 'scratch' && entry.org?.expirationDate ? daysUntil(entry.org.expirationDate) : null
    if (days !== null && days <= 3) parts.push(Text({ color: days < 1 ? 'red' : 'yellow', children: [days < 0 ? 'expired' : days < 1 ? 'expires today' : 'expires in ' + days + 'd'] }))
    // API version: the project newer than the org
    if (project?.sourceApiVersion && entry?.org?.apiVersion && compareApi(project.sourceApiVersion, entry.org.apiVersion) > 0) {
      parts.push(Text({ color: 'yellow', children: ['API ' + project.sourceApiVersion + ' > org ' + entry.org.apiVersion] }))
    }
    const open = [...apex.values()].filter((c) => !c.tested).length
    parts.push(sep())
    parts.push(
      apex.size === 0
        ? Text({ dimColor: true, children: ['Apex: no changes'] })
        : open > 0
          ? Text({ color: 'yellow', children: ['Apex: ' + open + ' untested'] })
          : Text({ color: 'green', children: ['Apex: all tested ✔'] }),
    )
    if (files.size > 0) {
      parts.push(sep())
      parts.push(Text({ color: 'cyan', children: ['Files: ' + files.size + (filesPaneOpen ? '' : ' · /sffiles')] }))
    }
    if (analyzerFindings.length || analyzerRunning) {
      parts.push(sep())
      parts.push(Text({ color: 'yellow', children: [analyzerRunning ? 'analyzing…' : '⚠ ' + plural(analyzerFindings.length, 'finding')] }))
    }
    const last = deployLog[deployLog.length - 1]
    parts.push(sep())
    parts.push(
      last
        ? Text({ color: last.ok ? 'green' : 'red', wrap: 'truncate', children: ['Last ' + last.kind + ': ' + (last.ok ? '✔ ' : '✘ ') + last.org + ' ' + agoLong(last.at)] })
        : Text({ dimColor: true, wrap: 'truncate', children: ['No deploys yet'] }),
    )
    parts.push(sep())
    parts.push(Text({ dimColor: true, children: ['SF Guardian v' + modVersion] }))
    if (orgDetection === 'off') {
      parts.push(sep())
      parts.push(Text({ color: 'yellow', wrap: 'truncate', children: ['⚠ org detection off'] }))
    }
    if (orgDetection !== 'on' && cfg.prodOrgs.length === 0) {
      parts.push(sep())
      parts.push(Text({ color: 'yellow', wrap: 'truncate', children: ['⚠ set production orgs in /config'] }))
    }
    return Box({ flexDirection: 'row', columnGap: 1, children: parts })
  })

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const p = e.props
    if (!cfg.compactRows || p.tool !== 'Bash' || p.isExpanded) return next(e)
    const command = typeof p.input?.command === 'string' ? p.input.command : ''
    const info = describeSf(command)
    if (!info) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const cls = clsOf(info.org === 'default org' ? defaultOrg : info.org)
    const prod = cls === 'production'
    const status = p.isRunning
      ? Text({ dimColor: true, children: ['…'] })
      : p.isInterrupted
        ? Text({ dimColor: true, children: ['Interrupted'] })
        : p.isErrored
          ? Text({ color: 'red', children: ['✘'] })
          : Text({ color: 'green', children: ['✔'] })
    return Box({
      flexDirection: 'row',
      columnGap: 2,
      children: [Text({ bold: true, ...(prod ? { color: 'red' } : {}), wrap: 'truncate', children: [info.icon + ' ' + info.label + (prod ? '  [PROD]' : cls === 'unknown' ? '  [unknown org]' : '')] }), status],
    })
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    const p = e.props
    if (!cfg.compactRows || p.tool !== 'Bash' || p.isExpanded) return next(e)
    const call = sfCalls.get(p.tool_use_id)
    if (!call || call.type === 'data') return next(e)
    const text = outputText(p.output)
    const { Box, Text } = $.ui.resolve(e)
    const hint = Text({ dimColor: true, children: ['  ctrl+o for full output'] })
    if (call.type === 'test') {
      const s = summarizeTests(text)
      if (!s) return next(e)
      const rows = [
        Text({ color: s.failed === 0 ? 'green' : 'red', children: ['  🧪 ' + s.passed + ' passed · ' + s.failed + ' failed' + (s.coverage ? ' · coverage ' + s.coverage : '')] }),
        ...s.failures.slice(0, 5).map((f) => Text({ color: 'red', wrap: 'truncate', children: ['     ✘ ' + f.name + (f.line ? ' (line ' + f.line + ')' : '') + (f.message ? '  ' + f.message : '')] })),
      ]
      if (s.failures.length > 5) rows.push(Text({ dimColor: true, children: ['     and ' + (s.failures.length - 5) + ' more'] }))
      return Box({ flexDirection: 'column', children: [...rows, hint] })
    }
    const d = summarizeDeploy(text)
    if (!d) return next(e)
    const good = /^Succeeded$/i.test(d.status)
    const parts = [d.status]
    if (d.components !== null) parts.push(d.components + ' components')
    if (d.tests !== null) parts.push(d.tests + ' tests' + (d.testErrors ? ' (' + d.testErrors + ' failed)' : ''))
    if (d.componentErrors) parts.push(d.componentErrors + ' component errors')
    const rows = [Text({ color: good ? 'green' : 'red', children: ['  🚀 ' + parts.join(' · ')] })]
    for (const f of d.failures.slice(0, 5)) rows.push(Text({ color: 'red', wrap: 'truncate', children: ['     ✘ ' + failureLine(f)] }))
    if (d.failures.length > 5) rows.push(Text({ dimColor: true, children: ['     and ' + (d.failures.length - 5) + ' more'] }))
    for (const t of d.testFailures.slice(0, 3)) rows.push(Text({ color: 'red', wrap: 'truncate', children: ['     ✘ ' + t.name + (t.line ? ' (line ' + t.line + ')' : '') + '  ' + t.message] }))
    return Box({ flexDirection: 'column', children: [...rows, hint] })
  })

  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    if (!running) return next(e)
    return next({ ...e, props: { ...e.props, message: running } })
  })

  on('ui.render', { component: 'TurnDuration' }, async ($, e, next) => {
    const p = e.props
    if (p.isExpanded || p.waitingFor) return next(e)
    const t = turnTokens.get(p.durationMs)
    if (t === undefined) return next(e)
    const { Text } = $.ui.resolve(e)
    return Text({ dimColor: true, children: ['✻ ' + p.word + ' for ' + duration(p.durationMs) + ' · ' + tokens(t.fresh) + ' tokens' + (t.cached ? ' · ' + tokens(t.cached) + ' cached' : '')] })
  })

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    if (e.props.isDraft || e.props.isWorking) return next(e)
    return next({ ...e, props: { ...e.props, tail: ' · /sffiles /sfpanel /sfguard /sfdoctor' } })
  })
}

// ── After an sf command: summaries, problems, toasts ────────────────────────
function afterSf($, info, command, r) {
  const ok = !r.deny && !r.isError
  const text = r.deny ? '' : outputText(r.result) || String(r.text ?? '')
  const isDeploy = info.type === 'deploy'
  if (isDeploy) {
    deployLog.push({ at: Date.now(), time: new Date().toLocaleTimeString(), org: info.org ?? '(unknown)', kind: info.dry ? 'validate' : 'deploy', ok })
    if (!r.deny) {
      const d = summarizeDeploy(text)
      if (d) {
        lastDeployProblems = d.failures
        lastTestProblems = d.testFailures
      } else if (text.trim()) noteUnparsed(text)
      const msg = (ok ? '✔ ' : '✘ ') + info.label + (ok ? ' succeeded' : ' failed') + (d && d.failures.length ? ' · ' + plural(d.failures.length, 'error') : '')
      $.ui.toast(msg)
      if (cfg.notify) void $.ui.notify(msg, { title: 'SF Guardian' }).catch(() => {})
    }
  }
  if (info.type === 'test' && !r.deny) {
    const summary = summarizeTests(text)
    if (summary) {
      for (const c of summary.classCoverage) {
        coverage.set(c.name, c.pct)
        if (c.uncovered) uncovered.set(c.name, c.uncovered)
      }
      lastTestProblems = summary.failures
      const msg = (summary.failed === 0 ? '✔ ' : '✘ ') + summary.passed + ' passed · ' + summary.failed + ' failed' + (summary.coverage ? ' · coverage ' + summary.coverage : '')
      $.ui.toast(msg)
      if (cfg.notify) void $.ui.notify(msg, { title: 'SF Guardian' }).catch(() => {})
    } else if (text.trim()) noteUnparsed(text)
    if (ok && waitsForResults(command) && (!summary || summary.failed === 0)) markTested(command)
  }
  if (isDeploy && ok && namesTests(command)) markTested(command)
  $.ui.invalidate('ui.render')
}

// Remove Salesforce session ids and auth URLs from Bash output before Claude reads it
function scrubResult(r) {
  if (!r || r.deny || r.isError || !r.result || typeof r.result !== 'object') return r
  const out = { ...r.result }
  let count = 0
  for (const k of ['stdout', 'stderr']) {
    if (typeof out[k] !== 'string') continue
    const s = scrubSecrets(out[k])
    out[k] = s.text
    count += s.count
  }
  if (count === 0) return r
  return { result: out, ...(r.context ? { context: r.context } : {}) }
}

// A draft's tool call finished: committed when it ran, discarded when denied or failed
function settleDraft($, id, r) {
  if (!r || r.deny || r.isError) drafts.markDiscarded(id)
  else drafts.markCommitted(id)
  $.ui.invalidate('ui.render')
}
