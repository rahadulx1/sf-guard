// The guard's decision: pure, no I/O.
//
//   decide({ command | mcp, orgMap, defaultOrg, settings, scripts })
//     -> { verdict, parts: [{ segment, category, org, cls, verdict, reason, rewrite? }], command }
//
// Verdicts: allow, ask, refuse. The hook asks the person once per command line,
// applies the rewrite (`--dry-run` on a deploy) and records the result.

import { allSimpleCommands, commandWords, flagValue, hasFlag, programName, tokenize } from './shell.js'
import { needsAsk, orgClass } from './orgs.js'

// What counts as a change to an org (section 6.2). Longest match wins.
const SF_TABLE = [
  // Deploy
  ['project deploy start', 'deploy'],
  ['project deploy quick', 'deploy-quick'],
  ['project deploy validate', 'validate'],
  ['project deploy resume', 'log'],
  ['project deploy report', 'log'],
  ['project deploy cancel', 'log'],
  // Metadata delete
  ['project delete source', 'metadata-delete'],
  // Data change
  ['data create record', 'data'],
  ['data create file', 'data'],
  ['data update record', 'data'],
  ['data update bulk', 'data'],
  ['data update resume', 'data'],
  ['data upsert bulk', 'data'],
  ['data upsert resume', 'data'],
  ['data delete record', 'data'],
  ['data delete bulk', 'data'],
  ['data delete resume', 'data'],
  ['data import tree', 'data'],
  ['data import bulk', 'data'],
  ['data import resume', 'data'],
  ['data record create', 'data'],
  ['data record update', 'data'],
  ['data record delete', 'data'],
  // Run code
  ['apex run', 'run-code'],
  ['apex run test', null], // read only (tests roll back)
  // Permissions
  ['org assign permset', 'permissions'],
  ['org assign permsetlicense', 'permissions'],
  ['org create user', 'permissions'],
  // Packages
  ['package install', 'packages'],
  ['package uninstall', 'packages'],
  ['package delete', 'packages'],
  ['package version promote', 'packages'],
  ['package version delete', 'packages'],
  // Org lifecycle
  ['org delete sandbox', 'lifecycle'],
  ['org delete scratch', 'lifecycle'],
  ['org refresh sandbox', 'lifecycle'],
  // Secrets
  ['org auth show-access-token', 'secrets'],
  ['org auth show-sfdx-auth-url', 'secrets'],
  ['org auth show-user-password', 'secrets'],
]

// The old sfdx names that still circulate in scripts and docs
const SFDX_TABLE = [
  ['force:source:deploy', 'deploy'],
  ['force:mdapi:deploy', 'deploy'],
  ['force:source:delete', 'metadata-delete'],
  ['force:data:record:create', 'data'],
  ['force:data:record:update', 'data'],
  ['force:data:record:delete', 'data'],
  ['force:data:bulk:upsert', 'data'],
  ['force:data:bulk:delete', 'data'],
  ['force:data:tree:import', 'data'],
  ['force:apex:execute', 'run-code'],
  ['force:user:permset:assign', 'permissions'],
  ['force:user:create', 'permissions'],
  ['force:package:install', 'packages'],
  ['force:package:uninstall', 'packages'],
  ['force:org:delete', 'lifecycle'],
]

// Commands after which the default org or the logins may have changed
const LOGIN_CHANGES = ['config set', 'config unset', 'org login', 'org logout', 'alias set', 'alias unset', 'org create scratch', 'org create sandbox', 'force:config:set', 'force:auth', 'force:alias:set']

export const CATEGORY_LABEL = {
  deploy: 'deploy',
  'deploy-quick': 'quick deploy',
  validate: 'validation',
  log: 'deploy status',
  'metadata-delete': 'metadata delete',
  data: 'data change',
  'run-code': 'anonymous Apex',
  permissions: 'permission change',
  packages: 'package change',
  lifecycle: 'org lifecycle',
  secrets: 'secret',
  script: 'script',
  mcp: 'MCP tool',
}

// The sf words that name the command: `sf project deploy start …` -> ['project','deploy','start']
function sfTopic(words) {
  const topic = []
  for (const w of words.slice(1)) {
    if (w.startsWith('-')) break
    for (const part of w.split(':')) if (part) topic.push(part)
    if (topic.length >= 4) break
  }
  return topic
}

// One simple command's words -> { prog, topic, category } or null when it is not sf
export function sfCommandOf(words) {
  const cw = commandWords(words)
  if (cw.length === 0) return null
  const prog = programName(cw[0])
  if (prog !== 'sf' && prog !== 'sfdx') return null
  const first = cw[1] ?? ''
  if (first.startsWith('force:')) {
    const hit = SFDX_TABLE.filter(([name]) => first === name || first.startsWith(name + ':')).sort((a, b) => b[0].length - a[0].length)[0]
    const verbose = first === 'force:org:display' && cw.includes('--verbose')
    return { prog, words: cw, topic: first, category: verbose ? 'secrets' : hit ? hit[1] : null }
  }
  const topic = sfTopic(cw)
  const joined = topic.join(' ')
  let best = null
  for (const [name, cat] of SF_TABLE) {
    if (joined === name || joined.startsWith(name + ' ')) {
      if (!best || name.length > best[0].length) best = [name, cat]
    }
  }
  return { prog, words: cw, topic: joined, category: best ? best[1] : null }
}

// Does this line change the default org or the logins?
export function changesLogins(line) {
  for (const seg of allSimpleCommands(line)) {
    const sf = sfCommandOf(tokenize(seg))
    if (!sf) continue
    if (LOGIN_CHANGES.some((n) => sf.topic === n || sf.topic.startsWith(n + ' ') || sf.topic.startsWith(n + ':'))) return true
    if (hasFlag(sf.words, ['--set-default', '--set-default-dev-hub'], ['-s', '-d'])) {
      if (/^(org (login|create)|force:auth)/.test(sf.topic)) return true
    }
  }
  return false
}

// The org a sf command names, or null for the default org
export function orgOf(sf) {
  if (/^package version|^package delete/.test(sf.topic)) {
    return flagValue(sf.words, ['--target-dev-hub', '--targetdevhubusername'], ['-v'])
  }
  return flagValue(sf.words, ['--target-org', '--targetusername'], ['-o', '-u'])
}

const namesTests = (w) => hasFlag(w, ['--test-level', '--testlevel'], ['-l'])
const isDryRun = (sf) => hasFlag(sf.words, ['--dry-run', '--checkonly']) || (sf.prog === 'sfdx' && hasFlag(sf.words, [], ['-c']))

// Script runners: the mod cannot always see inside them
export function scriptRefOf(words) {
  const cw = commandWords(words)
  if (cw.length === 0) return null
  const prog = programName(cw[0])
  if ((prog === 'npm' || prog === 'pnpm') && (cw[1] === 'run' || cw[1] === 'run-script') && cw[2]) return { kind: 'npm', name: cw[2] }
  if ((prog === 'npm' || prog === 'pnpm') && (cw[1] === 'test' || cw[1] === 't' || cw[1] === 'start')) return { kind: 'npm', name: cw[1] === 't' ? 'test' : cw[1] }
  if (prog === 'yarn' && cw[1] && !cw[1].startsWith('-') && !['add', 'install', 'remove', 'upgrade', 'init'].includes(cw[1])) return { kind: 'npm', name: cw[1] === 'run' ? cw[2] : cw[1] }
  if (prog === 'make') return { kind: 'make', name: cw.slice(1).filter((w) => !w.startsWith('-')).join(' ') || '(default)' }
  if ((prog === 'bash' || prog === 'sh' || prog === 'zsh') && cw[1] && !cw[1].startsWith('-')) return { kind: 'file', name: cw[1] }
  if (/^\.{0,2}\//.test(cw[0]) && /\.(sh|bash|zsh|ps1)$|^\.\//.test(cw[0])) return { kind: 'file', name: cw[0] }
  return null
}

function judgeSf(sf, segment, ctx) {
  const { orgMap, defaultOrg, settings } = ctx
  const cat = sf.category
  if (!cat) return null
  const named = orgOf(sf)
  const org = named ?? defaultOrg ?? null
  const cls = orgClass(orgMap, org)
  const risky = needsAsk(cls)
  const block = settings.guardMode === 'block'
  const who = org ? org + ' (' + cls + ')' : 'the default org (none set)'
  const part = { segment, category: cat, org, cls, verdict: 'allow', reason: '', usesDefault: !named }

  if (cat === 'secrets') {
    if (settings.allowSecretCommands) return { ...part, reason: 'secret commands are allowed in settings' }
    return { ...part, verdict: 'refuse', reason: 'This command prints a Salesforce secret (access token, auth URL or password) into the conversation. SF Guardian refuses it; the person can allow it with the "Allow secret commands" setting.' }
  }
  if (cat === 'log' || cat === 'validate') return { ...part, reason: 'does not change the org' }
  if (cat === 'deploy' && isDryRun(sf)) return { ...part, reason: 'a dry run does not change the org' }
  if (cat === 'lifecycle') {
    if (block && risky) return { ...part, verdict: 'refuse', reason: 'guard mode is block: no lifecycle changes to ' + who }
    return { ...part, verdict: 'ask', reason: 'org lifecycle commands always ask' }
  }
  if (!risky) return { ...part, reason: who + ' is not production' }
  if (cat === 'deploy' && !namesTests(sf.words)) {
    return { ...part, verdict: 'refuse', reason: 'Production deploys must name a test level. Re-run with --test-level RunLocalTests, or --test-level RunSpecifiedTests --tests <TestClass>.' }
  }
  if (block) {
    const tip = cat === 'deploy' ? ' Validate instead with --dry-run.' : ''
    return { ...part, verdict: 'refuse', reason: 'guard mode is block: no changes to ' + who + '.' + tip }
  }
  const p = { ...part, verdict: 'ask', reason: CATEGORY_LABEL[cat] + ' on ' + who }
  if (cat === 'deploy') p.rewrite = '--dry-run'
  return p
}

// sf commands inside a script's text, judged on the default org unless they name one
function judgeScriptText(text, segment, ref, ctx, depth) {
  const parts = []
  for (const line of String(text).split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    for (const p of decideLine(t, ctx, depth + 1).parts) {
      if (p.verdict !== 'allow') parts.push({ ...p, segment, via: ref.kind + ' ' + ref.name, inner: p.segment, rewrite: undefined })
    }
  }
  return parts
}

function decideLine(line, ctx, depth = 0) {
  const parts = []
  for (const segment of allSimpleCommands(line)) {
    const words = tokenize(segment)
    const sf = sfCommandOf(words)
    if (sf) {
      const p = judgeSf(sf, segment, ctx)
      if (p) parts.push(p)
      continue
    }
    if (depth > 0 || !ctx.settings.guardScripts) continue
    const ref = scriptRefOf(words)
    if (!ref) continue
    const key = ref.kind + ':' + ref.name
    const text = ctx.scripts?.[key]
    if (typeof text === 'string') {
      // We could read it: judge what is inside
      if (/\bsf(?:dx)?\b/.test(text)) parts.push(...judgeScriptText(text, segment, ref, ctx, depth))
      continue
    }
    // Could not read it: ask once while the default org is production or unknown
    const cls = orgClass(ctx.orgMap, ctx.defaultOrg)
    if (!needsAsk(cls)) continue
    const who = (ctx.defaultOrg ?? 'no default org') + ' (' + cls + ')'
    parts.push({ segment, category: 'script', org: ctx.defaultOrg, cls, verdict: 'ask', reason: 'a script the mod cannot read, while the default org is ' + who, usesDefault: true })
  }
  return { parts }
}

const MCP_TOOLS = {
  deploy_metadata: 'deploy',
  assign_permission_set: 'permissions',
  delete_org: 'lifecycle',
  resume_tool_operation: 'deploy',
}

// The Salesforce MCP tools that change an org, matched by the end of the name
export function mcpToolOf(name) {
  const m = String(name ?? '').match(/^mcp__.+__([a-z_]+)$/)
  if (!m || !(m[1] in MCP_TOOLS)) return null
  return { tool: m[1], category: MCP_TOOLS[m[1]] }
}

function decideMcp(mcp, ctx) {
  const t = mcpToolOf(mcp.tool)
  if (!t || !ctx.settings.guardMcp) return []
  const named = typeof mcp.input?.usernameOrAlias === 'string' && mcp.input.usernameOrAlias ? mcp.input.usernameOrAlias : null
  const org = named ?? ctx.defaultOrg ?? null
  const cls = orgClass(ctx.orgMap, org)
  const who = (org ?? 'the default org') + ' (' + cls + ')'
  const segment = t.tool + (named ? ' → ' + named : ' → default org')
  const base = { segment, category: 'mcp', mcpTool: t.tool, org, cls, usesDefault: !named }
  if (t.category === 'lifecycle') {
    if (ctx.settings.guardMode === 'block' && needsAsk(cls)) return [{ ...base, verdict: 'refuse', reason: 'guard mode is block: no lifecycle changes to ' + who }]
    return [{ ...base, verdict: 'ask', reason: 'deleting an org always asks' }]
  }
  if (!needsAsk(cls)) return [{ ...base, verdict: 'allow', reason: who + ' is not production' }]
  if (ctx.settings.guardMode === 'block') return [{ ...base, verdict: 'refuse', reason: 'guard mode is block: no changes to ' + who }]
  return [{ ...base, verdict: 'ask', reason: CATEGORY_LABEL[t.category] + ' through MCP on ' + who }]
}

export const DEFAULT_SETTINGS = { guardMode: 'ask', guardScripts: true, guardMcp: true, allowSecretCommands: false }

// The one entry point
export function decide({ command, mcp, orgMap = new Map(), defaultOrg = null, settings = {}, scripts = {} }) {
  const ctx = { orgMap, defaultOrg, settings: { ...DEFAULT_SETTINGS, ...settings }, scripts }
  const parts = mcp ? decideMcp(mcp, ctx) : decideLine(String(command ?? ''), ctx).parts
  const verdict = parts.some((p) => p.verdict === 'refuse') ? 'refuse' : parts.some((p) => p.verdict === 'ask') ? 'ask' : 'allow'
  return { verdict, parts, command: command ?? null }
}

// Insert `--dry-run` into the deploy parts of the original line, right to left
export function applyDryRun(line, parts) {
  let out = line
  const targets = parts.filter((p) => p.rewrite === '--dry-run')
  const spots = []
  let from = 0
  for (const p of targets) {
    const at = out.indexOf(p.segment, from)
    if (at < 0) continue
    spots.push(at + p.segment.length)
    from = at + p.segment.length
  }
  for (const end of spots.sort((a, b) => b - a)) out = out.slice(0, end) + ' --dry-run' + out.slice(end)
  return out
}

// The choices to offer for an `ask`
export function choicesFor(result, isMcp = false) {
  const canValidate = !isMcp && result.parts.some((p) => p.verdict === 'ask' && p.rewrite === '--dry-run')
  return canValidate ? ['Validate only (--dry-run)', 'Run as written', 'Cancel'] : ['Run as written', 'Cancel']
}

// One question listing every risky part
export function questionFor(result) {
  const risky = result.parts.filter((p) => p.verdict === 'ask')
  const orgs = [...new Set(risky.map((p) => (p.org ?? 'default org') + (p.cls === 'production' ? ' · PRODUCTION' : ' · ' + p.cls.toUpperCase())))]
  const lines = risky.map((p) => '• ' + (CATEGORY_LABEL[p.category] ?? p.category) + ': ' + (p.inner ? p.inner + '  (inside ' + p.via + ')' : p.segment))
  return '⚠️ ' + orgs.join(', ') + '\n' + lines.join('\n') + '\nRun this?'
}
