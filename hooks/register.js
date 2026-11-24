// SF Guardian v0.5 — a Claude Code mod for Salesforce developers
//
// Settings live in /config (or `claude plugin configure sf-guardian@my-mods`),
// so updating the mod never touches them.
//
// Safety     Production guard: deploys and data changes aimed at a production or
//            unknown org ask first (validate only, run, cancel). Production
//            deploys without --test-level are refused.
// Awareness  Band above the prompt: org badge, untested Apex, changed files, last deploy.
//            Claude is told the default org with each prompt.
// Live files Sidebar listing every file Claude creates, edits or deletes, with the
//            latest change, all changes this session, or the file itself. Changes
//            made any way (file tools, shell commands, sf retrieve) are picked up.
// Readability Compact sf rows, test and deploy summaries, a spinner that says what
//            sf is doing, tokens on the turn line, toasts when deploys and tests end.
// Tracking   Apex Claude edits is marked tested when a passing run covers it.
// Commands   /sffiles  /sfpanel  /sforg  /deploys  /sflimits [alias]

// ── Settings (filled from userConfig in register) ───────────────────────────
const cfg = {
  prodOrgs: [],
  autoOpenFiles: true,
  filesPaneWidth: 72,
  compactRows: true,
  showBand: true,
  coverageTarget: 85,
}
const COVERAGE_MIN = 75

const KEY_LIMITS = ['DailyApiRequests', 'DailyAsyncApexExecutions', 'DailyBulkV2QueryJobs', 'DataStorageMB', 'FileStorageMB', 'SingleEmail']

const PANE = 'sf-guardian'
const FILES_PANE = 'sf-files'
const BAND_REFRESH_MS = 30000
const WATCH_MS = 2000
const FRESH_MS = 6000 // a change this recent is highlighted
const MAX_TRACKED_BYTES = 1000000
const MAX_DIFF_CHARS = 40000
const MAX_PREVIEW_LINES = 160
const LIST_ROWS = 8
const PREVIEW_CONTEXT = 12
const SKIP_DIRS = ['.git', 'node_modules', '.sfdx', '.sf', '.localdevserver', '.husky', '.idea', 'coverage']
const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|bmp|pdf|zip|jar|gz|tgz|woff2?|ttf|otf|eot|mp3|mp4|mov|resource|class|so|dylib|exe)$/i

const DEPLOY = /\bsf\s+project\s+deploy\s+(start|quick)\b|\bsfdx\s+force:source:deploy\b/
const DESTRUCTIVE = /\bsf\s+data\s+(delete|update|upsert|import)\b|\bsf\s+apex\s+run(?!\s+test)\b|\bsf\s+org\s+delete\b/
const APEX_TEST = /\bsf\s+apex\s+run\s+test\b|\bsfdx\s+force:apex:test:run\b/
const TEST_NAME = /^Test|_?Tests?$/
const READ_ONLY_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'Bash', 'WebFetch', 'WebSearch', 'AskUserQuestion', 'Task', 'Agent', 'TodoWrite'])

// ── Session state (resets when the mod reloads) ─────────────────────────────
let defaultOrg = null
let sfTab = 'apex'
let lastLimits = null
let limitsLoading = false
let running = null
const deployLog = []
const apex = new Map()
const coverage = new Map()
const editedThisTurn = new Set()
const sfCalls = new Map()
const turnTokens = new Map()

// Live files
const files = new Map() // absolute path -> entry
const dismissed = new Map() // path -> mtime when cleared; shows again once it changes
let selectedFile = null
let followLatest = true
let filesView = 'latest' // 'latest', 'all', or 'file'
let filesAutoOpened = false
let filesPaneOpen = false
let cwd = ''
let toolsSeen = 0
let fileToolsSeen = 0
const lastTools = []
let watchMode = 'starting' // 'starting', 'git', 'folder', 'off'
let watchNote = ''
let gitRoot = ''
let gitBaseline = null
let folderMarker = ''
let folderBaseline = null
let pollPromise = null

// ── Settings ────────────────────────────────────────────────────────────────
function applyOptions(options) {
  const o = options || {}
  const list = Array.isArray(o.prod_orgs) ? o.prod_orgs.join(',') : String(o.prod_orgs ?? '')
  cfg.prodOrgs = list.split(/[,\s]+/).map((x) => x.trim().toLowerCase()).filter(Boolean)
  if (typeof o.auto_open_files === 'boolean') cfg.autoOpenFiles = o.auto_open_files
  const width = Number(o.files_pane_width)
  if (Number.isFinite(width) && width >= 40) cfg.filesPaneWidth = Math.min(160, Math.round(width))
  if (typeof o.compact_sf_rows === 'boolean') cfg.compactRows = o.compact_sf_rows
  if (typeof o.show_band === 'boolean') cfg.showBand = o.show_band
  const target = Number(o.coverage_target)
  if (Number.isFinite(target)) cfg.coverageTarget = Math.max(COVERAGE_MIN, Math.min(100, target))
}

// ── sf command helpers ──────────────────────────────────────────────────────
function targetOrgOf(command) {
  const m = command.match(/(?:^|\s)(?:--target-org|-o)[=\s]+("[^"]+"|'[^']+'|\S+)/)
  return m ? m[1].replace(/^["']|["']$/g, '') : defaultOrg
}

function isProd(org) {
  return !!org && cfg.prodOrgs.includes(org.toLowerCase())
}

function namesTests(command) {
  return /--test-level\b|(?:^|\s)-l[=\s]/.test(command)
}

function waitsForResults(command) {
  return /--wait\b|(?:^|\s)-w[=\s]|--synchronous\b|(?:^|\s)-y\b/.test(command)
}

function testNamesOf(command) {
  const names = []
  for (const m of command.matchAll(/(?:^|\s)(?:--class-names|-n|--tests|-t)[=\s]+("[^"]+"|'[^']+'|\S+)/g)) {
    for (const raw of m[1].replace(/^["']|["']$/g, '').split(',')) {
      const name = raw.trim().split('.')[0]
      if (name && !names.includes(name)) names.push(name)
    }
  }
  return names
}

function describeSf(command) {
  const org = targetOrgOf(command) ?? 'default org'
  if (DEPLOY.test(command)) {
    const verb = /--dry-run\b/.test(command) ? 'Validate' : /deploy\s+quick\b/.test(command) ? 'Quick deploy' : 'Deploy'
    const doing = verb === 'Validate' ? 'Validating on ' + org : verb === 'Quick deploy' ? 'Quick deploying to ' + org : 'Deploying to ' + org
    return { type: 'deploy', icon: '🚀', label: verb + ' → ' + org, org, doing }
  }
  if (APEX_TEST.test(command)) {
    const names = testNamesOf(command)
    const shown = names.length > 3 ? names.slice(0, 3).join(', ') + ' +' + (names.length - 3) : names.join(', ')
    return { type: 'test', icon: '🧪', label: 'Apex tests' + (shown ? ' (' + shown + ')' : '') + ' → ' + org, org, doing: 'Running Apex tests on ' + org }
  }
  if (DESTRUCTIVE.test(command)) {
    const m = command.match(/\bsf\s+(data\s+\w+|apex\s+run|org\s+delete)/)
    const label = 'sf ' + (m ? m[1] : 'command') + ' → ' + org
    return { type: 'data', icon: '⚠️', label, org, doing: 'Running ' + label }
  }
  return null
}

function markTested(command) {
  if (/RunLocalTests|RunAllTestsInOrg/.test(command)) {
    for (const c of apex.values()) c.tested = true
    return
  }
  for (const testName of testNamesOf(command)) {
    for (const key of [testName, testName.replace(/_?Tests?$/, '')]) {
      const c = apex.get(key)
      if (c) c.tested = true
    }
  }
}

function untestedOf(names) {
  return names.filter((n) => apex.has(n) && !apex.get(n).tested)
}

// ── Output parsing ──────────────────────────────────────────────────────────
function outputText(output) {
  if (typeof output === 'string') return output
  if (output && typeof output === 'object') return String(output.stdout ?? '') + '\n' + String(output.stderr ?? '')
  return ''
}

function parseJson(text) {
  const start = text.indexOf('{')
  if (start < 0) return null
  try {
    return JSON.parse(text.slice(start, text.lastIndexOf('}') + 1))
  } catch {
    return null
  }
}

function summarizeTests(text) {
  const j = parseJson(text)
  const s = j?.result?.summary
  if (s && s.testsRan !== undefined) {
    const failedNames = (j.result.tests ?? []).filter((t) => t.Outcome === 'Fail').map((t) => t.FullName ?? t.MethodName ?? 'unknown test')
    const classCoverage = (j.result.coverage?.coverage ?? [])
      .map((c) => ({
        name: c.name,
        pct: typeof c.coveredPercent === 'number' ? c.coveredPercent : c.totalLines ? Math.round((c.totalCovered * 100) / c.totalLines) : null,
      }))
      .filter((c) => c.name && c.pct !== null)
    return { ran: Number(s.testsRan), passed: Number(s.passing ?? 0), failed: Number(s.failing ?? 0), coverage: s.testRunCoverage ?? null, failedNames, classCoverage }
  }
  const ran = text.match(/Tests Ran\s+(\d+)/i)
  if (!ran) return null
  const total = Number(ran[1])
  const failRate = text.match(/Fail Rate\s+(\d+)%/i)
  const failingCount = text.match(/Failing\s+(\d+)/i)
  const failed = failingCount ? Number(failingCount[1]) : failRate ? Math.round((total * Number(failRate[1])) / 100) : 0
  const cov = text.match(/Test Run Coverage\s+(\d+%)/i)
  const failedNames = [...text.matchAll(/^\s*(\S+\.\S+)\s+Fail\b/gm)].map((m) => m[1])
  const classCoverage = []
  const byClass = text.search(/Coverage by Class|Code Coverage for Classes/i)
  if (byClass >= 0) {
    for (const m of text.slice(byClass).matchAll(/^\s*([A-Za-z_]\w*)\s+(\d+)%/gm)) classCoverage.push({ name: m[1], pct: Number(m[2]) })
  }
  return { ran: total, passed: total - failed, failed, coverage: cov ? cov[1] : null, failedNames, classCoverage }
}

function summarizeDeploy(text) {
  const r = parseJson(text)?.result
  if (r && r.status) {
    return {
      status: r.status,
      components: r.numberComponentsDeployed ?? null,
      tests: r.numberTestsCompleted ?? null,
      testErrors: r.numberTestErrors ?? 0,
      componentErrors: r.numberComponentErrors ?? 0,
    }
  }
  const m = text.match(/Status:\s*(\w+)/)
  return m ? { status: m[1], components: null, tests: null, testErrors: 0, componentErrors: 0 } : null
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
  return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n)
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
  return 'API limits for ' + data.org + ' at ' + data.at + '\n' + data.rows.map(limitLine).join('\n')
}

function coverageColor(pct) {
  return pct >= cfg.coverageTarget ? 'green' : pct >= COVERAGE_MIN ? 'yellow' : 'red'
}

function coverageBar(pct) {
  const filled = Math.max(0, Math.min(10, Math.round(pct / 10)))
  return '█'.repeat(filled) + '░'.repeat(10 - filled)
}

function plural(n, word) {
  return n + ' ' + word + (n === 1 ? '' : 's')
}

// ── sf CLI calls ────────────────────────────────────────────────────────────
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
  const args = ['sf', 'limits', 'api', 'display', '--json']
  if (org) args.push('--target-org', org)
  try {
    const r = await $.process.run(args, { timeoutMs: 60000 })
    if (r.exitCode !== 0) return { error: 'sf limits failed: ' + String(r.stderr || r.stdout || '').trim().slice(0, 200) }
    const all = JSON.parse(r.stdout).result ?? []
    return {
      org: org ?? '(default)',
      at: new Date().toLocaleTimeString(),
      rows: all.filter((l) => KEY_LIMITS.includes(l.name)).map((l) => ({ name: l.name, max: l.max, used: l.max - l.remaining })),
    }
  } catch {
    return { error: 'Could not run sf. Is the Salesforce CLI installed?' }
  }
}

// ── Live files: diffing ─────────────────────────────────────────────────────
function splitLines(text) {
  if (!text) return []
  const lines = text.split(/\r?\n/)
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

// Line diff: trim the common head and tail, then an LCS over what is left
function diffLines(a, b) {
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const midA = a.slice(start, endA)
  const midB = b.slice(start, endB)
  const mid = []
  if (midA.length * midB.length > 2000000) {
    for (const l of midA) mid.push(['-', l])
    for (const l of midB) mid.push(['+', l])
  } else {
    const n = midA.length
    const m = midB.length
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = midA[i] === midB[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
      }
    }
    let i = 0
    let j = 0
    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        mid.push([' ', midA[i]])
        i++
        j++
      } else if (dp[i + 1][j] >= dp[i][j + 1]) mid.push(['-', midA[i++]])
      else mid.push(['+', midB[j++]])
    }
    while (i < n) mid.push(['-', midA[i++]])
    while (j < m) mid.push(['+', midB[j++]])
  }
  const out = []
  for (const l of a.slice(0, start)) out.push([' ', l])
  for (const r of mid) out.push(r)
  for (const l of a.slice(endA)) out.push([' ', l])
  return out
}

// Unified-diff hunks, counts, and the changed line range in the new text
function unifiedDiff(before, after, context = 3) {
  const rows = []
  let aNo = 1
  let bNo = 1
  for (const [t, line] of diffLines(splitLines(before), splitLines(after))) {
    rows.push({ t, line, a: aNo, b: bNo })
    if (t !== '+') aNo++
    if (t !== '-') bNo++
  }
  const changed = []
  rows.forEach((r, i) => {
    if (r.t !== ' ') changed.push(i)
  })
  if (changed.length === 0) return { text: '', adds: 0, removes: 0, first: null, last: null, cut: false }
  const hunks = []
  let cur = null
  for (const i of changed) {
    const s = Math.max(0, i - context)
    const e = Math.min(rows.length - 1, i + context)
    if (cur && s <= cur.e + 1) cur.e = e
    else hunks.push((cur = { s, e }))
  }
  let text = ''
  let cut = false
  for (const h of hunks) {
    const slice = rows.slice(h.s, h.e + 1)
    const aRows = slice.filter((r) => r.t !== '+')
    const bRows = slice.filter((r) => r.t !== '-')
    const aStart = aRows.length ? aRows[0].a : Math.max(0, slice[0].a - 1)
    const bStart = bRows.length ? bRows[0].b : Math.max(0, slice[0].b - 1)
    const hunk = `@@ -${aStart},${aRows.length} +${bStart},${bRows.length} @@\n` + slice.map((r) => r.t + r.line).join('\n') + '\n'
    // Cut only at a hunk boundary: a diff cut mid-hunk does not draw
    if (text.length + hunk.length > MAX_DIFF_CHARS) {
      cut = true
      break
    }
    text += hunk
  }
  let adds = 0
  let removes = 0
  for (const r of rows) {
    if (r.t === '+') adds++
    else if (r.t === '-') removes++
  }
  const newLines = changed.map((i) => rows[i].b)
  return { text, adds, removes, first: Math.max(1, Math.min(...newLines)), last: Math.max(1, Math.max(...newLines)), cut }
}

function isBinary(path, text) {
  return BINARY_EXT.test(path) || (typeof text === 'string' && text.slice(0, 8000).includes('\u0000'))
}

// ── Live files: entries ─────────────────────────────────────────────────────
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
    cut: false,
  }
}

// Record one change: before -> after (null after = deleted)
function recordChange(f, before, after) {
  f.current = after
  f.changes += 1
  f.at = Date.now()
  f.writing = false
  f.binary = isBinary(f.path, after) || isBinary(f.path, before)
  const big = (x) => typeof x === 'string' && x.length > MAX_TRACKED_BYTES
  f.tooLarge = big(after) || big(before) || big(f.original)
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
    f.focus = after === null ? null : latest.first !== null ? [latest.first, latest.last] : f.focus
  }
}

function relPath(path) {
  const root = gitRoot || cwd
  return root && path.startsWith(root + '/') ? path.slice(root.length + 1) : path
}

function splitPath(path) {
  const rel = relPath(path)
  const i = rel.lastIndexOf('/')
  return i < 0 ? { dir: '', base: rel } : { dir: rel.slice(0, i + 1), base: rel.slice(i + 1) }
}

function absPath(path) {
  return path.startsWith('/') ? path : (cwd ? cwd + '/' : '') + path.replace(/^\.\//, '')
}

async function ensureCwd($) {
  if (cwd) return
  try {
    cwd = await $.session.cwd()
  } catch {
    cwd = ''
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
  if (f.original === null) {
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
  $.ui.invalidate('ui.render')
}

// ── Live files: rm ──────────────────────────────────────────────────────────
function rmTargets(command) {
  const out = []
  for (const m of command.matchAll(/(?:^|[;&|(]\s*)(?:git\s+)?rm\s+([^;&|)\n]+)/g)) {
    for (const tok of m[1].trim().split(/\s+/)) {
      if (!tok || tok.startsWith('-') || /[*?~$]/.test(tok)) continue
      out.push(tok.replace(/^["']|["']$/g, ''))
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
  if (f.original === null) f.original = content
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
  if (watchMode === 'off') return Promise.resolve()
  if (!pollPromise) {
    pollPromise = poll($)
      .catch(() => {})
      .finally(() => {
        pollPromise = null
      })
  }
  return pollPromise
}

async function poll($) {
  await ensureCwd($)
  if (watchMode === 'starting') await startWatch($)
  let changed = false
  if (watchMode === 'git') changed = await gitDiscover($)
  else if (watchMode === 'folder') changed = await folderDiscover($)
  if (await refreshTracked($)) changed = true
  if (changed) {
    await autoOpenFiles($)
    $.ui.invalidate('ui.render')
  }
}

async function startWatch($) {
  let top = null
  try {
    top = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd: cwd || undefined, timeoutMs: 5000 })
  } catch {
    top = null
  }
  if (top && top.exitCode === 0 && top.stdout.trim()) {
    gitRoot = top.stdout.trim()
    watchMode = 'git'
    await gitDiscover($) // the first look is the baseline
    return
  }
  const err = String(top?.stderr ?? '')
  watchNote = !top ? 'git not available' : /not a git repository/i.test(err) ? 'not a git repo' : 'git failed'
  let home = ''
  try {
    home = (await $.env.get('HOME')) ?? ''
  } catch {
    home = ''
  }
  if (!cwd || cwd === '/' || (home && cwd === home)) {
    watchMode = 'off'
    watchNote = 'start claude inside your project folder'
    $.ui.invalidate('ui.render')
    return
  }
  watchMode = 'folder'
  await folderDiscover($) // the first look is the baseline
  $.ui.invalidate('ui.render')
}

async function gitDiscover($) {
  const st = await $.process.run(['git', '-C', gitRoot, 'status', '--porcelain=v1', '-z', '-uall'], { timeoutMs: 10000 })
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

async function findFiles($, newer) {
  const args = ['find', cwd, '-type', 'f']
  if (newer) args.push('-newer', newer)
  for (const d of SKIP_DIRS) args.push('-not', '-path', '*/' + d + '/*')
  const r = await $.process.run(args, { timeoutMs: 15000 })
  if (r.exitCode !== 0 && !r.stdout) return null
  return r.stdout.split('\n').filter(Boolean).slice(0, 50000)
}

async function folderDiscover($) {
  if (!folderMarker) {
    const marker = '/tmp/sf-guardian-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)
    const t = await $.process.run(['touch', marker], { timeoutMs: 5000 })
    if (t.exitCode !== 0) {
      watchMode = 'off'
      watchNote = 'could not start the folder watch'
      return false
    }
    folderBaseline = new Set((await findFiles($, null)) ?? [])
    folderMarker = marker
    return false
  }
  const recent = await findFiles($, folderMarker)
  if (!recent) return false
  let changed = false
  for (const abs of recent.slice(0, 500)) {
    if (files.has(abs)) continue // tracked entries refresh on their own
    let mtime
    try {
      mtime = (await $.fs.stat(abs)).mtimeMs
    } catch {
      continue
    }
    const gone = dismissed.get(abs)
    if (gone && gone.mtime === mtime) continue // cleared, and not changed since
    dismissed.delete(abs)
    let current
    try {
      current = await $.fs.read(abs)
    } catch {
      continue
    }
    const existed = !!folderBaseline && folderBaseline.has(abs)
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
    const before = f.current
    if (f.status === 'deleted') f.status = f.original ? 'edited' : 'created'
    recordChange(f, before, current)
    select(f.path)
    changed = true
  }
  return changed
}

function pollSoon($) {
  watchPoll($)
}

// ── Drawing: the Files pane ─────────────────────────────────────────────────
const STATUS = {
  created: { glyph: '+', color: 'green', word: 'new file' },
  edited: { glyph: '~', color: 'yellow', word: 'edited' },
  deleted: { glyph: '✕', color: 'red', word: 'deleted' },
}

function watchSummary() {
  const where = cwd ? cwd.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~') : 'this folder'
  if (watchMode === 'git') return { ok: true, text: 'watching ' + where + ' via git' }
  if (watchMode === 'folder') return { ok: true, text: 'watching ' + where + (watchNote ? ' (' + watchNote + ')' : '') }
  if (watchMode === 'starting') return { ok: true, text: 'starting the watch…' }
  const last = lastTools.length ? ' · last tools: ' + lastTools.join(', ') : ''
  return { ok: false, text: 'only file tools are tracked: ' + (watchNote || 'watch is off') + last }
}

function renderFilesPane($, e) {
  const { Box, Text, Button, Code } = $.ui.resolve(e)
  const redraw = () => $.ui.invalidate('ui.render')
  const width = Math.max(30, (e.props?.bodyColumns ?? cfg.filesPaneWidth) - 2)
  const list = [...files.values()].sort((a, b) => b.at - a.at)
  if (!selectedFile || !files.has(selectedFile)) selectedFile = list[0]?.path ?? null
  const selIndex = Math.max(0, list.findIndex((f) => f.path === selectedFile))
  const sel = selectedFile ? files.get(selectedFile) : null

  const choose = (path) => {
    selectedFile = path
    followLatest = false
    redraw()
  }
  const move = (step) => {
    if (list.length === 0) return
    choose(list[(selIndex + step + list.length) % list.length].path)
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
      ...(totalAdds ? [Text({ color: 'green', children: ['+' + totalAdds] })] : []),
      ...(totalRemoves ? [Text({ color: 'red', children: ['−' + totalRemoves] })] : []),
    ],
  })

  const watchLine = Text({ ...(watch.ok ? { dimColor: true } : { color: 'yellow' }), wrap: 'wrap', children: [watch.text] })
  const blank = () => Text({ children: [' '] })

  // Controls: plain buttons show their key, so this row is also the key guide
  const controls = Box({
    flexDirection: 'row',
    columnGap: 2,
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
          if (followLatest) selectedFile = list[0]?.path ?? null
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
      Text({ dimColor: true, children: ['esc: close'] }),
    ],
  })

  if (list.length === 0) {
    return Box({
      flexDirection: 'column',
      children: [
        header,
        blank(),
        Text({ children: ['Waiting for changes…'] }),
        Text({ dimColor: true, wrap: 'wrap', children: ['Files Claude creates, edits or deletes show up here as they change.'] }),
        blank(),
        controls,
        watchLine,
      ],
    })
  }

  // The list, scrolled so the selected row shows
  const start = Math.max(0, Math.min(selIndex - Math.floor(LIST_ROWS / 2), list.length - LIST_ROWS))
  const shown = list.slice(start, start + LIST_ROWS)
  const rows = []
  if (start > 0) rows.push(Text({ dimColor: true, children: ['  ↑ ' + start + ' more'] }))
  shown.forEach((f, k) => {
    const i = start + k
    const st = STATUS[f.status] ?? STATUS.edited
    const { dir, base } = splitPath(f.path)
    const isSel = f.path === selectedFile
    const fresh = Date.now() - f.at < FRESH_MS
    const stats = []
    if (f.writing) stats.push(Text({ color: 'yellow', children: ['writing…'] }))
    else {
      if (f.binary) stats.push(Text({ dimColor: true, children: ['binary'] }))
      else {
        if (f.adds) stats.push(Text({ color: 'green', children: ['+' + f.adds] }))
        if (f.removes) stats.push(Text({ color: 'red', children: ['−' + f.removes] }))
      }
      stats.push(Text({ ...(fresh ? { color: 'yellow', bold: true } : { dimColor: true }), children: [ago(f.at)] }))
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
  if (start + LIST_ROWS < list.length) rows.push(Text({ dimColor: true, children: ['  ↓ ' + (list.length - start - LIST_ROWS) + ' more'] }))

  // Views
  const tab = (name, label, hotkey) =>
    Button({ key: 'files-view-' + name, label, hotkey, plain: true, dimColor: filesView !== name, onPress: view(name) })
  const tabs = Box({
    flexDirection: 'row',
    columnGap: 3,
    children: [tab('latest', 'Latest change', '1'), tab('all', 'All changes', '2'), tab('file', 'File', '3')],
  })

  const detail = []
  if (sel) {
    const st = STATUS[sel.status] ?? STATUS.edited
    const facts = [sel.writing ? 'writing…' : st.word, agoLong(sel.at)]
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
    const note = (text, color) => Text({ ...(color ? { color } : { dimColor: true }), wrap: 'wrap', children: [text] })
    const code = (source, extra) => Code({ source, path: sel.path, wrap: 'truncate-end', ...extra })

    if (sel.isFolder) detail.push(note('Folder deleted.', 'red'))
    else if (sel.binary) detail.push(note('Binary file: no preview.'))
    else if (sel.tooLarge) detail.push(note('Larger than 1 MB: listed without a preview.'))
    else if (filesView === 'latest') {
      if (sel.latestDiff) detail.push(code(sel.latestDiff, { format: 'diff' }))
      else if (sel.writing) detail.push(note('Writing…'))
      else if (sel.noBaseline && sel.changes <= 1) detail.push(note('It changed before it was tracked, so its earlier content is unknown. The next change shows here; press 3 to see the file.'))
      else detail.push(note('No line changes in the latest update.'))
    } else if (filesView === 'all') {
      if (sel.allDiff) {
        detail.push(code(sel.allDiff, { format: 'diff' }))
        if (sel.cut) detail.push(note('Long diff: the first part is shown.'))
        if (sel.noBaseline) detail.push(note('Changes since it was first seen in this session.'))
      } else detail.push(note(sel.noBaseline ? 'No changes since it was first seen.' : 'No changes since the session started.'))
    } else if (sel.status === 'deleted') {
      detail.push(note('Deleted. Press 1 or 2 to see what it held.', 'red'))
    } else if (sel.current === null) {
      detail.push(note(sel.writing ? 'Writing…' : 'Could not read the file.'))
    } else {
      const lines = splitLines(sel.current)
      if (lines.length === 0) detail.push(note('(empty file)'))
      else {
        let first = 1
        let last = Math.min(lines.length, MAX_PREVIEW_LINES)
        if (sel.focus) {
          first = Math.max(1, sel.focus[0] - PREVIEW_CONTEXT)
          last = Math.min(lines.length, Math.max(sel.focus[1] + PREVIEW_CONTEXT, first + 20), first + MAX_PREVIEW_LINES - 1)
        }
        detail.push(note('lines ' + first + '–' + last + ' of ' + lines.length))
        detail.push(code(lines.slice(first - 1, last).join('\n'), { startLine: first }))
      }
    }
  }

  return Box({
    flexDirection: 'column',
    children: [
      header,
      blank(),
      ...rows,
      Text({ dimColor: true, children: ['─'.repeat(Math.min(width, 80))] }),
      tabs,
      ...detail,
      blank(),
      controls,
      watchLine,
    ],
  })
}

// ── Drawing: the Salesforce pane ────────────────────────────────────────────
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
  const prod = isProd(defaultOrg)
  const header = Text({
    bold: true,
    ...(prod ? { color: 'red' } : {}),
    children: ['Org: ' + (defaultOrg ?? 'not set') + (prod ? '  ⚠️ PRODUCTION' : '')],
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
  } else if (sfTab === 'coverage') {
    const rows = [...coverage.entries()].sort((a, b) => a[1] - b[1])
    body =
      rows.length === 0
        ? [Text({ dimColor: true, children: ['No coverage yet. Run tests with --code-coverage.'] })]
        : [
            ...rows.map(([name, pct]) =>
              Text({ color: coverageColor(pct), wrap: 'truncate', children: [coverageBar(pct) + ' ' + String(pct).padStart(3) + '%  ' + name] }),
            ),
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

// ── Hooks ───────────────────────────────────────────────────────────────────
export function register(on, options) {
  applyOptions(options)

  on('session.start', async ($, e, next) => {
    if (typeof e.cwd === 'string' && e.cwd) cwd = e.cwd
    for (const c of [
      { name: 'sffiles', description: 'Open the live Files sidebar: what Claude creates, edits and deletes' },
      { name: 'sfpanel', description: 'Open the Salesforce pane (Apex · Deploys · Coverage · Limits)' },
      { name: 'sforg', description: 'Show and refresh the default Salesforce org' },
      { name: 'deploys', description: 'List the deploys Claude ran in this session' },
      { name: 'sflimits', description: 'Show org API limits: /sflimits [alias]' },
    ]) {
      try {
        await $.command.register({ ...c, immediate: true })
      } catch {
        // A command that can't register leaves the rest working
      }
    }
    defaultOrg = await readDefaultOrg($)
    await watchPoll($) // the baseline: what was already changed before this session
    try {
      $.clock.every(BAND_REFRESH_MS, () => $.ui.invalidate('ui.render'))
      $.clock.every(WATCH_MS, () => {
        if (!filesPaneOpen) return
        watchPoll($)
        // Keep "now" and ages current
        if ([...files.values()].some((f) => Date.now() - f.at < FRESH_MS + WATCH_MS)) $.ui.invalidate('ui.render')
      })
    } catch {
      // No timers here (such as a test): views still update on each change
    }
    return next(e)
  })

  // ── Bash: production guard, sf summaries, deletes, and a look for changed files ─
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const cmd = String(e.command ?? '')
    const info = describeSf(cmd)

    if (!info) {
      const targets = rmTargets(cmd)
      let snaps = []
      if (targets.length) {
        try {
          snaps = await snapshotRemovals($, targets)
        } catch {
          snaps = []
        }
      }
      const r = await next(e)
      try {
        if (snaps.length) await finishRemovals($, snaps)
      } catch {
        // Tracking never changes the command's result
      }
      pollSoon($) // a shell command can write files: look right away
      return r
    }

    const org = targetOrgOf(cmd)
    const isDeploy = info.type === 'deploy'
    let command = cmd

    if (info.type !== 'test') {
      const unknown = org === null
      const risky = unknown || isProd(org)
      if (isProd(org) && isDeploy && !namesTests(cmd) && !/deploy\s+quick\b/.test(cmd)) {
        return {
          deny: 'Production deploys must name a test level. Re-run with --test-level RunLocalTests, or --test-level RunSpecifiedTests --tests <TestClass>.',
        }
      }
      if (risky) {
        const label = unknown ? 'UNKNOWN ORG' : 'PRODUCTION (' + org + ')'
        const choices = isDeploy ? ['Validate only (--dry-run)', 'Run as written', 'Cancel'] : ['Run as written', 'Cancel']
        let answer = 'Cancel'
        try {
          answer = await $.ui.ask('⚠️ ' + label + ': ' + cmd + '  Run this command?', choices)
        } catch {
          // Dismissed, or nobody to ask
        }
        if (answer === 'Cancel' || !choices.includes(answer)) {
          return { deny: 'The user declined this command against ' + label + '. Ask the user before trying another approach.' }
        }
        if (answer.startsWith('Validate') && !/--dry-run\b/.test(cmd)) command = cmd + ' --dry-run'
      }
    }

    const final = describeSf(command)
    sfCalls.set(e.tool_use_id, { type: final.type, command, org: final.org })
    if (sfCalls.size > 300) sfCalls.delete(sfCalls.keys().next().value)
    running = final.doing
    $.ui.invalidate('ui.render')

    let result
    try {
      result = await next({ ...e, command })
    } finally {
      running = null
      $.ui.invalidate('ui.render')
    }

    try {
      const ok = !result.deny && !result.isError
      const text = result.deny ? '' : outputText(result.result) || String(result.text ?? '')
      if (isDeploy) {
        deployLog.push({ at: Date.now(), time: new Date().toLocaleTimeString(), org: org ?? '(unknown)', kind: /--dry-run\b/.test(command) ? 'validate' : 'deploy', ok })
        if (!result.deny) $.ui.toast((ok ? '✔ ' : '✘ ') + final.label + (ok ? ' succeeded' : ' failed'))
      }
      if (final.type === 'test' && !result.deny) {
        const summary = summarizeTests(text)
        if (summary) {
          for (const c of summary.classCoverage) coverage.set(c.name, c.pct)
          $.ui.toast((summary.failed === 0 ? '✔ ' : '✘ ') + summary.passed + ' passed · ' + summary.failed + ' failed' + (summary.coverage ? ' · coverage ' + summary.coverage : ''))
        }
        if (ok && waitsForResults(command) && (!summary || summary.failed === 0)) markTested(command)
      }
      if (isDeploy && ok && namesTests(command)) markTested(command)
      $.ui.invalidate('ui.render')
    } catch {
      // Tracking never changes the command's result
    }
    pollSoon($)
    return result
  }).catch(async ($, e, next) => {
    running = null
    if (next.called) return { deny: 'sf-guardian failed after the command ran (' + next.error.kind + '); check the result yourself.' }
    return { deny: 'sf-guardian failed (' + next.error.kind + '), so this command was not run.' }
  })

  // ── Every other tool: any tool that writes a named file is tracked ────────
  on('tool.call', async ($, e, next) => {
    toolsSeen += 1
    lastTools.push(String(e.tool))
    if (lastTools.length > 4) lastTools.shift()
    const named =
      typeof e.file_path === 'string' ? e.file_path : typeof e.notebook_path === 'string' ? e.notebook_path : null
    if (!named || READ_ONLY_TOOLS.has(e.tool) || String(e.tool).startsWith('mcp__')) return next(e)

    fileToolsSeen += 1
    await ensureCwd($)
    const path = absPath(named)
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
    } catch {
      // Tracking never stops the edit
    }

    const result = await next(e)
    const changed = !result.deny && !result.isError
    try {
      await trackEnd($, path, before, changed)
    } catch {
      // Tracking never changes the tool's result
    }

    const m = changed && path.match(/([^/\\]+)\.(cls|trigger)$/)
    if (m) {
      apex.set(m[1], { name: m[1], kind: m[2], isTest: TEST_NAME.test(m[1]), tested: false })
      editedThisTurn.add(m[1])
      $.ui.invalidate('ui.render')
    }
    return result
  })

  // ── Turns ─────────────────────────────────────────────────────────────────
  on('turn.start', async ($, e, next) => {
    if (!e.agentId) editedThisTurn.clear()
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId) return r
    if (e.usage) {
      const u = e.usage
      turnTokens.set(e.durationMs, (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0))
      if (turnTokens.size > 200) turnTokens.delete(turnTokens.keys().next().value)
      $.ui.invalidate('ui.render')
    }
    if (e.isAborted) return r
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
    if (defaultOrg) notes.unshift('Salesforce default target org: ' + defaultOrg + (isProd(defaultOrg) ? ' (PRODUCTION, be careful).' : '.'))
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
    $.ui.invalidate('ui.render')
    const setup = cfg.prodOrgs.length ? '' : '\nTip: set your production orgs in /config (SF Guardian: Production orgs).'
    if (!defaultOrg) return { text: 'No default org set. Run: sf config set target-org <alias>' + setup }
    return { text: 'Default org: ' + defaultOrg + (isProd(defaultOrg) ? '  ⚠️ PRODUCTION' : '') + setup }
  })

  on('command.run', { command: 'deploys' }, async () => {
    if (deployLog.length === 0) return { text: 'No deploys yet in this session.' }
    return { text: deployLog.map(deployLine).join('\n') }
  })

  on('command.run', { command: 'sflimits' }, async ($, e) => {
    const org = String(e.args ?? '').trim() || defaultOrg
    lastLimits = await fetchLimits($, org)
    $.ui.invalidate('ui.render')
    return { text: limitsText(lastLimits) }
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
    parts.push(
      !defaultOrg
        ? Text({ dimColor: true, children: ['○ no default org'] })
        : isProd(defaultOrg)
          ? Text({ bold: true, color: 'white', backgroundColor: 'red', children: [' PROD · ' + defaultOrg + ' '] })
          : Text({ bold: true, color: 'green', children: ['● ' + defaultOrg] }),
    )
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
    const last = deployLog[deployLog.length - 1]
    parts.push(sep())
    parts.push(
      last
        ? Text({ color: last.ok ? 'green' : 'red', wrap: 'truncate', children: ['Last ' + last.kind + ': ' + (last.ok ? '✔ ' : '✘ ') + last.org + ' ' + agoLong(last.at)] })
        : Text({ dimColor: true, wrap: 'truncate', children: ['No deploys yet'] }),
    )
    if (cfg.prodOrgs.length === 0) {
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
    const prod = isProd(targetOrgOf(command))
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
      children: [Text({ bold: true, ...(prod ? { color: 'red' } : {}), wrap: 'truncate', children: [info.icon + ' ' + info.label + (prod ? '  [PROD]' : '')] }), status],
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
        ...s.failedNames.slice(0, 5).map((n) => Text({ color: 'red', children: ['     ✘ ' + n] })),
      ]
      if (s.failedNames.length > 5) rows.push(Text({ dimColor: true, children: ['     and ' + (s.failedNames.length - 5) + ' more'] }))
      return Box({ flexDirection: 'column', children: [...rows, hint] })
    }
    const d = summarizeDeploy(text)
    if (!d) return next(e)
    const good = /^Succeeded$/i.test(d.status)
    const parts = [d.status]
    if (d.components !== null) parts.push(d.components + ' components')
    if (d.tests !== null) parts.push(d.tests + ' tests' + (d.testErrors ? ' (' + d.testErrors + ' failed)' : ''))
    if (d.componentErrors) parts.push(d.componentErrors + ' component errors')
    return Box({ flexDirection: 'column', children: [Text({ color: good ? 'green' : 'red', children: ['  🚀 ' + parts.join(' · ')] }), hint] })
  })

  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    if (!running) return next(e)
    return next({ ...e, props: { ...e.props, message: running } })
  })

  on('ui.render', { component: 'TurnDuration' }, async ($, e, next) => {
    const p = e.props
    if (p.isExpanded || p.waitingFor) return next(e)
    const total = turnTokens.get(p.durationMs)
    if (total === undefined) return next(e)
    const { Text } = $.ui.resolve(e)
    return Text({ dimColor: true, children: ['✻ ' + p.word + ' for ' + duration(p.durationMs) + ' · ' + tokens(total) + ' tokens'] })
  })

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    if (e.props.isDraft || e.props.isWorking) return next(e)
    return next({ ...e, props: { ...e.props, tail: ' · /sffiles /sfpanel /sflimits' } })
  })
}
