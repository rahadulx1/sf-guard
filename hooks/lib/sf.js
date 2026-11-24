// sf output: parsing, summaries, and cleaning secrets. Pure, no I/O.
//
// JSON field names are from the plugins' own reporters and schemas
// (plugin-apex jsonReporter, plugin-deploy-retrieve project-deploy-start schema,
// plugin-limits, plugin-settings). The human-readable fallbacks are best effort.

export function outputText(output) {
  if (typeof output === 'string') return output
  if (output && typeof output === 'object') return String(output.stdout ?? '') + '\n' + String(output.stderr ?? '')
  return ''
}

export function parseJson(text) {
  const start = text.indexOf('{')
  if (start < 0) return null
  try {
    return JSON.parse(text.slice(start, text.lastIndexOf('}') + 1))
  } catch {
    return null
  }
}

const asArray = (x) => (Array.isArray(x) ? x : x ? [x] : [])

// "Class.AccountService.sync: line 34, column 1" -> { name, line }
function stackLine(stack) {
  const m = String(stack ?? '').match(/Class\.([\w.]+?)\.?\w*: line (\d+)(?:, column (\d+))?/)
  return m ? { cls: m[1].split('.')[0], line: Number(m[2]), col: m[3] ? Number(m[3]) : null } : null
}

// Uncovered line numbers from a coverage record's `lines` map (line -> 1 or 0)
export function uncoveredOf(lines) {
  if (!lines || typeof lines !== 'object') return null
  const out = []
  for (const [k, v] of Object.entries(lines)) if (Number(v) === 0) out.push(Number(k))
  return out.filter(Number.isFinite).sort((a, b) => a - b)
}

// 40,41,42,43,44,71 -> "40–44, 71"
export function ranges(nums) {
  const out = []
  let s = null
  let p = null
  for (const n of nums) {
    if (s === null) s = p = n
    else if (n === p + 1) p = n
    else {
      out.push(s === p ? String(s) : s + '–' + p)
      s = p = n
    }
  }
  if (s !== null) out.push(s === p ? String(s) : s + '–' + p)
  return out.join(', ')
}

export function summarizeTests(text) {
  const j = parseJson(text)
  const s = j?.result?.summary
  if (s && s.testsRan !== undefined) {
    const failures = asArray(j.result.tests)
      .filter((t) => t.Outcome === 'Fail' || t.Outcome === 'CompileFail')
      .map((t) => {
        const at = stackLine(t.StackTrace)
        return { name: t.FullName ?? t.MethodName ?? 'unknown test', message: String(t.Message ?? '').split('\n')[0], cls: at?.cls ?? null, line: at?.line ?? null }
      })
    const classCoverage = asArray(j.result.coverage?.coverage)
      .map((c) => ({
        name: c.name,
        pct: typeof c.coveredPercent === 'number' ? c.coveredPercent : c.totalLines ? Math.round((c.totalCovered * 100) / c.totalLines) : null,
        uncovered: uncoveredOf(c.lines),
      }))
      .filter((c) => c.name && c.pct !== null)
    return {
      ran: Number(s.testsRan),
      passed: Number(s.passing ?? 0),
      failed: Number(s.failing ?? 0),
      coverage: s.testRunCoverage ?? null,
      failedNames: failures.map((f) => f.name),
      failures,
      classCoverage,
    }
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
    for (const m of text.slice(byClass).matchAll(/^\s*([A-Za-z_]\w*)\s+(\d+)%(?:\s+([\d,\s]+))?$/gm)) {
      const uncovered = m[3] ? m[3].split(/[,\s]+/).map(Number).filter((n) => Number.isFinite(n) && n > 0) : null
      classCoverage.push({ name: m[1], pct: Number(m[2]), uncovered: uncovered && uncovered.length ? uncovered : null })
    }
  }
  return { ran: total, passed: total - failed, failed, coverage: cov ? cov[1] : null, failedNames, failures: failedNames.map((name) => ({ name, message: '', cls: null, line: null })), classCoverage }
}

export function summarizeDeploy(text) {
  const r = parseJson(text)?.result
  if (r && r.status) {
    const failures = asArray(r.details?.componentFailures)
      .filter((f) => f && (f.problemType ?? 'Error') !== 'Warning')
      .map((f) => ({
        file: f.fileName ?? null,
        line: f.lineNumber != null ? Number(f.lineNumber) : null,
        col: f.columnNumber != null ? Number(f.columnNumber) : null,
        problem: String(f.problem ?? '').split('\n')[0],
        type: f.componentType ?? null,
        name: f.fullName ?? null,
      }))
    const testFailures = asArray(r.details?.runTestResult?.failures).map((t) => {
      const at = stackLine(t.stackTrace)
      return { name: (t.name ?? '') + (t.methodName ? '.' + t.methodName : ''), message: String(t.message ?? '').split('\n')[0], cls: at?.cls ?? t.name ?? null, line: at?.line ?? null }
    })
    return {
      status: r.status,
      components: r.numberComponentsDeployed ?? null,
      tests: r.numberTestsCompleted ?? null,
      testErrors: r.numberTestErrors ?? 0,
      componentErrors: r.numberComponentErrors ?? 0,
      failures,
      testFailures,
    }
  }
  const m = text.match(/Status:\s*(\w+)/)
  return m ? { status: m[1], components: null, tests: null, testErrors: 0, componentErrors: 0, failures: [], testFailures: [] } : null
}

// `fileName` in a deploy failure is relative to the project, sometimes with a
// leading package folder already; show "AccountService.cls:34:12  problem"
export function failureLine(f) {
  const base = String(f.file ?? f.name ?? '?').replace(/\\/g, '/').split('/').pop()
  return base + (f.line ? ':' + f.line + (f.col ? ':' + f.col : '') : '') + '  ' + f.problem
}

export const KEY_LIMITS = ['DailyApiRequests', 'DailyAsyncApexExecutions', 'DailyBulkV2QueryJobs', 'DataStorageMB', 'FileStorageMB', 'SingleEmail']

export function parseLimits(stdout) {
  const all = JSON.parse(stdout).result ?? []
  return all.filter((l) => KEY_LIMITS.includes(l.name)).map((l) => ({ name: l.name, max: l.max, used: l.max - l.remaining }))
}

export function isUnknownCommand(text) {
  return /is not a sf command|command .* not found|not a .*command|Unknown command|CommandNotFound/i.test(String(text ?? ''))
}

// Code Analyzer v5 JSON (`violations[]` with `locations[]` and `primaryLocationIndex`).
// ⚠ Shape taken from the plugin's docs, not a captured run: parse defensively.
export function parseAnalyzer(text) {
  const j = typeof text === 'string' ? parseJson(text) : text
  if (!j || typeof j !== 'object') return null
  const list = Array.isArray(j.violations) ? j.violations : Array.isArray(j.result?.violations) ? j.result.violations : null
  if (!list) return null
  return list.map((v) => {
    const loc = asArray(v.locations)[v.primaryLocationIndex ?? 0] ?? asArray(v.locations)[0] ?? {}
    return {
      file: loc.file ?? null,
      line: loc.startLine ?? null,
      col: loc.startColumn ?? null,
      rule: v.rule ?? null,
      engine: v.engine ?? null,
      severity: Number(v.severity ?? 3),
      problem: String(v.message ?? '').split('\n')[0],
    }
  })
}

// ── Secrets ──
// A Salesforce session id: an org id, "!", a long token
export const SESSION_ID = /\b00D[A-Za-z0-9]{12,15}![A-Za-z0-9._\-]{20,}/g
// An sfdx auth URL: force://<clientId>:<secret>:<refreshToken>@<host>
export const AUTH_URL = /force:\/\/[^\s"'@]*@[^\s"']+/g

export function scrubSecrets(text) {
  if (typeof text !== 'string' || !text) return { text, count: 0 }
  let count = 0
  const out = text
    .replace(SESSION_ID, () => {
      count++
      return '[session id removed by SF Guardian]'
    })
    .replace(AUTH_URL, () => {
      count++
      return 'force://[auth URL removed by SF Guardian]'
    })
  return { text: out, count }
}

// Clean a command line before it is stored: values of secret flags, session ids, auth URLs
export function sanitizeCommand(cmd) {
  return scrubSecrets(
    String(cmd ?? '').replace(/(--(?:password|client-secret|clientsecret|secret|token|private-key|jwt-key-file|sfdx-url|consumer-secret)(?:=|\s+))("[^"]*"|'[^']*'|\S+)/gi, '$1***'),
  ).text
}

// The first 2 KB of an output the mod could not summarize, cleaned
export function sampleOutput(text) {
  return sanitizeCommand(String(text ?? '').slice(0, 2048))
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, 'user@example.com')
    .replace(/\b00[DO][A-Za-z0-9]{12,15}\b/g, '00DXXXXXXXXXXXXXXX')
    .replace(/https:\/\/[A-Za-z0-9.-]+\.(?:salesforce|force|lightning\.force)\.com/g, 'https://example.my.salesforce.com')
}

// ── Metadata paths for a validation of the changed files ──
// path (relative, forward slashes) -> what to pass to --source-dir, or null
export function metadataPathOf(rel, packageDirs) {
  const p = rel.replace(/\\/g, '/')
  if (packageDirs && packageDirs.length && !packageDirs.some((d) => p === d || p.startsWith(d.replace(/\/$/, '') + '/'))) return null
  if (/(^|\/)(README[^/]*|\.eslintrc[^/]*|jsconfig\.json|\.forceignore)$/i.test(p)) return null
  if (/(^|\/)(__tests__|tests?)\//.test(p)) return null
  const bundle = p.match(/^(.*\/(?:lwc|aura)\/[^/]+)\//)
  if (bundle) return bundle[1]
  if (p.endsWith('-meta.xml')) {
    const comp = p.replace(/-meta\.xml$/, '')
    return /\.(cls|trigger|page|component|resource|email)$/.test(comp) ? comp : p
  }
  return p
}

// Test classes for a changed Apex class: X -> XTest, X_Test, XTests (the ones that exist)
export function testCandidates(name) {
  return [name + 'Test', name + '_Test', name + 'Tests']
}
