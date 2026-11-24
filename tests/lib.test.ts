// Pure functions: decoder, splitter, classifier, guard decision, parsers.
import { describe, expect, test } from 'claude-code/testing'
import { createDrafts, decodeDraft, readStringField } from '../hooks/lib/draft.js'
import { allSimpleCommands, innerScripts, splitCommands, tokenize } from '../hooks/lib/shell.js'
import { classifyOrgs, daysUntil, needsAsk, orgClass, slimOrgList } from '../hooks/lib/orgs.js'
import { applyDryRun, changesLogins, choicesFor, decide, questionFor } from '../hooks/lib/guard.js'
import { metadataPathOf, parseAnalyzer, parseLimits, ranges, sampleOutput, sanitizeCommand, scrubSecrets, summarizeDeploy, summarizeTests } from '../hooks/lib/sf.js'
import { unifiedDiff } from '../hooks/lib/diff.js'
import { ANALYZER, APEX_FAIL, APEX_PASS, DEPLOY_FAIL, DEPLOY_OK, HUMAN_DEPLOY, LIMITS, ORG_LIST } from './fixtures/sf-output.js'

// A deterministic random source, so a failure reproduces
function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

describe('readStringField (live typing decoder)', () => {
  test('partial JSON decodes to a prefix of the real text; the whole decodes exactly', async () => {
    const rand = rng(42)
    const alphabet = ['a', 'Z', ' ', '\n', '\t', '"', '\\', '/', 'é', '日本', '😀', '{"x":1}', '\\u0041', '}', ']', ',', ':']
    let checks = 0
    for (let n = 0; n < 400; n++) {
      let content = ''
      const len = Math.floor(rand() * 40)
      for (let i = 0; i < len; i++) content += alphabet[Math.floor(rand() * alphabet.length)]
      const json = JSON.stringify({ file_path: '/p/A.cls', content })
      let cut = 0
      while (cut < json.length) {
        cut = Math.min(json.length, cut + 1 + Math.floor(rand() * 6))
        const r = readStringField(json.slice(0, cut), 'content')
        if (r.found) {
          expect(content.startsWith(r.text)).toBe(true)
          // never half a surrogate pair
          const last = r.text.charCodeAt(r.text.length - 1)
          if (!r.done && r.text.length) expect(last >= 0xd800 && last <= 0xdbff).toBe(false)
          checks++
        }
      }
      const whole = readStringField(json, 'content')
      expect(whole.done).toBe(true)
      expect(whole.text).toBe(content)
    }
    expect(checks).toBeGreaterThan(1000)
  })

  test('keys in either order, escaped look-alikes are not keys', async () => {
    expect(readStringField('{"content":"x\\"file_path\\": \\"no","file_path":"/a/B.cls"}', 'file_path').text).toBe('/a/B.cls')
    expect(decodeDraft('{"content":"hello\\nworld').kind).toBe('write')
    expect(decodeDraft('{"content":"hello\\nworld').path).toBe(null)
    const edit = decodeDraft('{"file_path":"/x.cls","old_string":"a","new_string":"b')
    expect(edit.kind).toBe('edit')
    expect(edit.edits[0]).toEqual({ oldText: 'a', newText: 'b', done: false })
    const multi = decodeDraft('{"file_path":"/x.cls","edits":[{"old_string":"a","new_string":"b"},{"old_string":"c","new_string":"d"}]}')
    expect(multi.kind).toBe('multi-edit')
    expect(multi.edits.length).toBe(2)
  })
})

describe('draft reducer', () => {
  const step = { turnId: 't1', index: 0, model: 'm', messageCount: 1 }
  test('a write grows, keys in either order, and commits', async () => {
    const d = createDrafts()
    d.ingest({ kind: 'tool', index: 1, id: 'tu1', name: 'Write' }, step)
    d.ingest({ kind: 'input', index: 1, json: '{"content":"line 1\\nli' }, step)
    expect(d.list()[0].path).toBe(null)
    d.ingest({ kind: 'input', index: 1, json: 'ne 2","file_path":"/p/A.cls"}' }, step)
    const [w] = d.list()
    expect(w.path).toBe('/p/A.cls')
    expect(w.text).toBe('line 1\nline 2')
    d.ingest({ kind: 'stop', stopReason: 'tool_use', usage: null }, step)
    d.markWriting('tu1')
    expect(d.get('tu1')?.state).toBe('writing')
    d.markCommitted('tu1')
    expect(d.list().length).toBe(0)
  })

  test('two parallel blocks, a subagent, an unknown tool, an MCP tool, broken JSON', async () => {
    const d = createDrafts()
    const sub = { ...step, agentId: 'a1' }
    d.ingest({ kind: 'tool', index: 0, id: 'x1', name: 'Write' }, step)
    d.ingest({ kind: 'tool', index: 1, id: 'x2', name: 'Edit' }, step)
    d.ingest({ kind: 'tool', index: 0, id: 'x3', name: 'Write' }, sub)
    d.ingest({ kind: 'tool', index: 2, id: 'x4', name: 'Bash' }, step)
    d.ingest({ kind: 'tool', index: 3, id: 'x5', name: 'mcp__sf__deploy_metadata' }, step)
    d.ingest({ kind: 'input', index: 0, json: '{"file_path":"/a","content":"A' }, step)
    d.ingest({ kind: 'input', index: 1, json: '{"file_path":"/b","old_string":"o","new_string":"n"}' }, step)
    d.ingest({ kind: 'input', index: 0, json: '{"file_path":"/c","content":"C"}' }, sub)
    d.ingest({ kind: 'input', index: 2, json: '{"command":"ls"}' }, step)
    const list = d.list()
    expect(list.map((x: any) => x.path).sort()).toEqual(['/a', '/b', '/c'])
    expect(list.find((x: any) => x.path === '/c').agentId).toBe('a1')
    expect(list.find((x: any) => x.path === '/a').text).toBe('A') // never closed: still shown
    d.discardAll()
    expect(d.list().every((x: any) => x.state === 'discarded')).toBe(true)
  })

  test('raw is capped', async () => {
    const d = createDrafts({ cap: 100 })
    d.ingest({ kind: 'tool', index: 0, id: 'c', name: 'Write' }, step)
    d.ingest({ kind: 'input', index: 0, json: '{"file_path":"/a","content":"' + 'x'.repeat(500) }, step)
    const [w] = d.list()
    expect(w.capped).toBe(true)
    expect(w.raw.length).toBe(100)
  })
})

describe('shell splitting', () => {
  const cases: [string, string[]][] = [
    ['a && b', ['a', 'b']],
    ['a || b; c', ['a', 'b', 'c']],
    ['a | b & c', ['a', 'b', 'c']],
    ['a\nb', ['a', 'b']],
    ['echo "x && y"; z', ['echo "x && y"', 'z']],
    ["echo 'a;b' | c", ["echo 'a;b'", 'c']],
    ['echo a\\;b', ['echo a\\;b']],
    ['git commit -m "sf data delete; x"', ['git commit -m "sf data delete; x"']],
  ]
  for (const [line, want] of cases) test('split: ' + line.replace(/\n/g, '\\n'), async () => expect(splitCommands(line)).toEqual(want))

  test('wrapped commands are found', async () => {
    expect(innerScripts('bash -c "sf data delete record -o p"')).toEqual(['sf data delete record -o p'])
    expect(innerScripts("sh -c 'a && b'")).toEqual(['a && b'])
    expect(innerScripts('echo $(sf apex run -o p)')).toEqual(['sf apex run -o p'])
    expect(allSimpleCommands('x && bash -lc "a; b"')).toEqual(['x', 'bash -lc "a; b"', 'a', 'b'])
  })

  test('tokenize removes quotes and redirections', async () => {
    expect(tokenize('sf data query -q "SELECT Id FROM A" -o \'my org\' > out.json 2>&1')).toEqual(['sf', 'data', 'query', '-q', 'SELECT Id FROM A', '-o', 'my org'])
  })
})

describe('org classification', () => {
  const list = slimOrgList(ORG_LIST.result)
  test('groups from sf org list; alias and username alike in any case', async () => {
    const m = classifyOrgs(list)
    expect(orgClass(m, 'prod')).toBe('production')
    expect(orgClass(m, 'RELEASE@ACME.COM')).toBe('production')
    expect(orgClass(m, 'uat')).toBe('sandbox')
    expect(orgClass(m, 'dev@acme.com.dev')).toBe('sandbox')
    expect(orgClass(m, 'hub')).toBe('production')
    expect(orgClass(m, 'so')).toBe('scratch')
    expect(orgClass(m, 'trial')).toBe('production')
    expect(orgClass(m, 'nobody')).toBe('unknown')
    expect(orgClass(m, null)).toBe('unknown')
  })
  test('settings win: safe_orgs and prod_orgs, for alias and username of one org', async () => {
    const m = classifyOrgs(list, { safeOrgs: ['trial'], prodOrgs: ['release@acme.com.uat'] })
    expect(orgClass(m, 'trial@acme.com')).toBe('sandbox')
    expect(orgClass(m, 'uat')).toBe('production')
    expect(m.get('uat').source).toBe('settings')
  })
  test('no sf at all: only the lists', async () => {
    const m = classifyOrgs([], { prodOrgs: ['prod'] })
    expect(orgClass(m, 'prod')).toBe('production')
    expect(orgClass(m, 'uat')).toBe('unknown')
    expect(needsAsk('unknown')).toBe(true)
  })
  test('never keeps tokens', async () => {
    expect(JSON.stringify(list)).not.toMatch(/accessToken|REDACTED/)
  })
  test('scratch expiry in days', async () => {
    expect(daysUntil('2026-01-04', Date.parse('2026-01-01'))).toBe(3)
  })
})

describe('guard decision (Appendix B and more)', () => {
  const orgMap = classifyOrgs(slimOrgList(ORG_LIST.result), { safeOrgs: ['trial'] })
  // [command, defaultOrg, verdict, settings?]
  const cases: [string, string | null, string, any?][] = [
    ['sf project deploy start -o prod --test-level RunLocalTests', null, 'ask'],
    ['sf project deploy start -o prod', null, 'refuse'],
    ['sf project deploy start -o uat', null, 'allow'],
    ['sf project deploy start', 'prod', 'refuse'],
    ['sf project deploy start -l RunLocalTests', 'prod', 'ask'],
    ['sf project deploy start -l RunLocalTests', 'uat', 'allow'],
    ['sf data delete record -s Account -i 001 -o release@acme.com', null, 'ask'],
    ['sf data delete record -s Account -i 001 -o Release@Acme.com', null, 'ask'],
    ['cd force-app && sf project deploy start -o prod --test-level RunLocalTests', null, 'ask'],
    ['sf project deploy start -o prod --test-level RunLocalTests && sf data update record -s A -i 1 -v "x=1" -o prod', null, 'ask'],
    ['bash -c "sf project deploy start -o prod --test-level RunLocalTests"', null, 'ask'],
    ["sh -c 'sf data delete bulk -s A --file x.csv -o prod'", null, 'ask'],
    ['echo $(sf data delete record -s A -i 1 -o prod)', null, 'ask'],
    ['echo "sf project deploy start -o prod"', null, 'allow'],
    ['git commit -m "sf data delete record -o prod"', null, 'allow'],
    ['grep -r "sf project deploy start" docs/', null, 'allow'],
    ['sf data query -q "SELECT Id FROM Account" -o prod', null, 'allow'],
    ['sf apex run test -n AccountServiceTest -o prod --wait 10', null, 'allow'],
    ['sf apex run -f script.apex -o prod', null, 'ask'],
    ['sf apex run -f script.apex -o uat', null, 'allow'],
    ['sf org assign permset -n Admin_Access -o prod', null, 'ask'],
    ['sf org assign permsetlicense -n X -o prod', null, 'ask'],
    ['sf org create user -o prod', null, 'ask'],
    ['sf package install -p 04t -o prod', null, 'ask'],
    ['sf package uninstall -p 04t -o prod', null, 'ask'],
    ['sf package delete -p 0Ho -v hub', null, 'ask'],
    ['sf package version promote -p 04t -v hub', null, 'ask'],
    ['sf org delete sandbox -o uat', null, 'ask'],
    ['sf org delete scratch -o so', null, 'ask'],
    ['sf org refresh sandbox --name uat -o prod', null, 'ask'],
    ['sf org auth show-access-token -o uat', null, 'refuse'],
    ['sf org auth show-sfdx-auth-url -o uat', null, 'refuse'],
    ['sf org auth show-user-password -o so', null, 'refuse'],
    ['sf org auth show-access-token -o uat', null, 'allow', { allowSecretCommands: true }],
    ['sf org display -o prod', null, 'allow'],
    ['sf org list', null, 'allow'],
    ['sf org list limits -o prod', null, 'allow'],
    ['sf project retrieve start -o prod', null, 'allow'],
    ['sf code-analyzer run --workspace .', 'prod', 'allow'],
    ['sf project deploy resume --job-id 0Af', 'prod', 'allow'],
    ['sf project deploy report --job-id 0Af', 'prod', 'allow'],
    ['sf project deploy cancel --job-id 0Af', 'prod', 'allow'],
    ['sf project deploy validate -o prod -l RunLocalTests', null, 'allow'],
    ['sf project deploy start -o prod --dry-run', null, 'allow'],
    ['sf project deploy quick --job-id 0Af -o prod', null, 'ask'],
    ['sf project delete source -m ApexClass:X -o prod', null, 'ask'],
    ['sf data create record -s Account -v "Name=x" -o prod', null, 'ask'],
    ['sf data create file --file x.pdf -o prod', null, 'ask'],
    ['sf data upsert bulk -s A --file x.csv -i Id -o prod', null, 'ask'],
    ['sf data import tree --files x.json -o prod', null, 'ask'],
    ['sf data create record -s Account -v "Name=x" -o trial', null, 'allow'],
    ['sf project deploy start -o somewhere --test-level RunLocalTests', null, 'ask'],
    ['sf project deploy start -o hub -l RunLocalTests', null, 'ask'],
    ['FOO=1 /usr/local/bin/sf data delete bulk -s A --file x.csv -o dev@acme.com.dev', null, 'allow'],
    ['sudo sf data delete record -s A -i 1 -o prod', null, 'ask'],
    ['npx sf data delete record -s A -i 1 -o prod', null, 'ask'],
    ['sf project:deploy:start -o prod -l RunLocalTests', null, 'ask'],
    ['sfdx force:source:deploy -u prod -l RunLocalTests', null, 'ask'],
    ['sfdx force:source:deploy -u prod -c -l RunLocalTests', null, 'allow'],
    ['sfdx force:org:display -u prod --verbose', null, 'refuse'],
    ['sf data delete record -o so -s A -i 1 2>&1 | tee out.txt', null, 'allow'],
    ['sf data delete record -s A -i 1 --target-org=prod', null, 'ask'],
    ['sf project deploy start -o prod -l RunLocalTests', null, 'refuse', { guardMode: 'block' }],
    ['sf project deploy start -o uat', null, 'allow', { guardMode: 'block' }],
    ['sf data query -q "SELECT Id FROM A" -o prod', null, 'allow', { guardMode: 'block' }],
    ['sf org delete sandbox -o uat', null, 'ask', { guardMode: 'block' }],
    ['npm run deploy', 'prod', 'ask'],
    ['npm run deploy', 'uat', 'allow'],
    ['npm run deploy', 'prod', 'allow', { guardScripts: false }],
    ['make deploy', 'prod', 'ask'],
    ['./scripts/deploy.sh', 'prod', 'ask'],
    ['npm test', 'prod', 'ask'],
  ]
  for (const [command, defaultOrg, want, settings] of cases) {
    test(want + ': ' + command + (defaultOrg ? ' [default ' + defaultOrg + ']' : '') + (settings ? ' ' + JSON.stringify(settings) : ''), async () => {
      expect(decide({ command, orgMap, defaultOrg, settings }).verdict).toBe(want)
    })
  }

  test('scripts the mod can read are judged by what is inside', async () => {
    expect(decide({ command: 'npm run lint', orgMap, defaultOrg: 'prod', scripts: { 'npm:lint': 'eslint .' } }).verdict).toBe('allow')
    const r = decide({ command: 'npm run deploy', orgMap, defaultOrg: 'prod', scripts: { 'npm:deploy': 'sf project deploy start -l RunLocalTests' } })
    expect(r.verdict).toBe('ask')
    expect(questionFor(r)).toMatch(/inside npm deploy/)
    expect(decide({ command: 'npm run x', orgMap, defaultOrg: 'uat', scripts: { 'npm:x': 'sf data delete record -o prod -s A -i 1' } }).verdict).toBe('ask')
  })

  test('validate-only puts --dry-run on the deploy part only', async () => {
    const line = 'cd force-app && sf project deploy start -o prod --test-level RunLocalTests && echo ok'
    expect(applyDryRun(line, decide({ command: line, orgMap }).parts)).toBe('cd force-app && sf project deploy start -o prod --test-level RunLocalTests --dry-run && echo ok')
    const wrapped = 'bash -c "sf project deploy start -o prod -l RunLocalTests"'
    expect(applyDryRun(wrapped, decide({ command: wrapped, orgMap }).parts)).toBe('bash -c "sf project deploy start -o prod -l RunLocalTests --dry-run"')
  })

  test('one question lists every risky part; choices fit', async () => {
    const r = decide({ command: 'sf project deploy start -o prod -l RunLocalTests && sf data update record -s A -i 1 -o prod', orgMap })
    const q = questionFor(r)
    expect(q).toMatch(/deploy: sf project deploy start/)
    expect(q).toMatch(/data change: sf data update record/)
    expect(choicesFor(r)).toEqual(['Validate only (--dry-run)', 'Run as written', 'Cancel'])
    expect(choicesFor(decide({ command: 'sf apex run -o prod', orgMap }))).toEqual(['Run as written', 'Cancel'])
  })

  test('MCP tools: org given, org missing, read-only tools, turned off', async () => {
    expect(decide({ mcp: { tool: 'mcp__salesforce__deploy_metadata', input: { usernameOrAlias: 'prod' } }, orgMap }).verdict).toBe('ask')
    expect(decide({ mcp: { tool: 'mcp__x__deploy_metadata', input: {} }, orgMap, defaultOrg: 'uat' }).verdict).toBe('allow')
    expect(decide({ mcp: { tool: 'mcp__x__deploy_metadata', input: {} }, orgMap, defaultOrg: 'prod' }).verdict).toBe('ask')
    expect(decide({ mcp: { tool: 'mcp__x__assign_permission_set', input: { usernameOrAlias: 'release@acme.com' } }, orgMap }).verdict).toBe('ask')
    expect(decide({ mcp: { tool: 'mcp__x__delete_org', input: { usernameOrAlias: 'so' } }, orgMap }).verdict).toBe('ask')
    expect(decide({ mcp: { tool: 'mcp__x__run_soql_query', input: { usernameOrAlias: 'prod' } }, orgMap }).verdict).toBe('allow')
    expect(decide({ mcp: { tool: 'mcp__x__deploy_metadata', input: { usernameOrAlias: 'prod' } }, orgMap, settings: { guardMcp: false } }).verdict).toBe('allow')
    expect(decide({ mcp: { tool: 'mcp__x__deploy_metadata', input: { usernameOrAlias: 'prod' } }, orgMap, settings: { guardMode: 'block' } }).verdict).toBe('refuse')
    expect(choicesFor(decide({ mcp: { tool: 'mcp__x__deploy_metadata', input: { usernameOrAlias: 'prod' } }, orgMap }), true)).toEqual(['Run as written', 'Cancel'])
  })

  test('commands that change the default org or logins', async () => {
    expect(changesLogins('sf config set target-org uat')).toBe(true)
    expect(changesLogins('sf org login web -a prod')).toBe(true)
    expect(changesLogins('sf org logout -o x')).toBe(true)
    expect(changesLogins('sf alias set x=y')).toBe(true)
    expect(changesLogins('sf org create scratch -f a.json -d')).toBe(true)
    expect(changesLogins('sf org display')).toBe(false)
  })
})

describe('parsers (schema-shaped fixtures)', () => {
  test('passing Apex run with line coverage', async () => {
    const s: any = summarizeTests(JSON.stringify(APEX_PASS))
    expect([s.ran, s.passed, s.failed, s.coverage]).toEqual([2, 2, 0, '88%'])
    expect(s.classCoverage[0]).toEqual({ name: 'AccountService', pct: 88, uncovered: [40, 41, 42, 43, 44, 71] })
    expect(ranges(s.classCoverage[0].uncovered)).toBe('40–44, 71')
  })
  test('failing Apex run names the class and line', async () => {
    const s: any = summarizeTests('Warning: something\n' + JSON.stringify(APEX_FAIL))
    expect(s.failed).toBe(1)
    expect(s.failures[0]).toEqual({ name: 'LeadHandlerTest.convertsLead', message: 'System.AssertException: Assertion Failed: Expected: 1, Actual: 0', cls: 'LeadHandler', line: 34 })
  })
  test('successful deploy', async () => {
    const d: any = summarizeDeploy(JSON.stringify(DEPLOY_OK))
    expect([d.status, d.components, d.tests, d.failures.length]).toEqual(['Succeeded', 4, 2, 0])
  })
  test('failed deploy: file, line, column, problem; warnings left out; one test failure as an object', async () => {
    const d: any = summarizeDeploy(JSON.stringify(DEPLOY_FAIL))
    expect(d.failures.length).toBe(2)
    expect(d.failures[0]).toEqual({ file: 'force-app/main/default/classes/AccountService.cls', line: 34, col: 12, problem: 'Variable does not exist: foo', type: 'ApexClass', name: 'AccountService' })
    expect(d.testFailures[0]).toEqual({ name: 'AccountServiceTest.testInsert', message: 'System.NullPointerException', cls: 'AccountService', line: 20 })
  })
  test('human-readable deploy status', async () => {
    expect(summarizeDeploy(HUMAN_DEPLOY)?.status).toBe('Succeeded')
  })
  test('limits', async () => {
    expect(parseLimits(JSON.stringify(LIMITS))).toEqual([
      { name: 'DailyApiRequests', max: 15000, used: 1000 },
      { name: 'DataStorageMB', max: 1000, used: 900 },
    ])
  })
  test('Code Analyzer findings', async () => {
    expect(parseAnalyzer(JSON.stringify(ANALYZER))?.[0]).toEqual({ file: '/project/force-app/main/default/classes/AccountService.cls', line: 12, col: 5, rule: 'ApexCRUDViolation', engine: 'pmd', severity: 2, problem: 'Validate CRUD permission before SOQL/DML operation' })
    expect(parseAnalyzer('not json')).toBe(null)
  })
})

describe('secrets and cleaning', () => {
  const sid = '00D5g000004ABCDE!AQ4AQFakeTokenValue.abcdefghijklmnop_1234'
  test('session ids and auth URLs are removed', async () => {
    const r = scrubSecrets('token: ' + sid + '\nurl: force://PlatformCLI::5Aep861abc@acme.my.salesforce.com')
    expect(r.count).toBe(2)
    expect(r.text).not.toMatch(/AQ4AQ|5Aep861/)
  })
  test('commands are cleaned before they are stored', async () => {
    expect(sanitizeCommand('sf org login jwt --client-secret abc123 --password "p w" -o x')).toBe('sf org login jwt --client-secret *** --password *** -o x')
    expect(sanitizeCommand('curl -H "Authorization: Bearer ' + sid + '"')).not.toMatch(/AQ4AQ/)
  })
  test('unparsed samples hide emails, org ids and hosts, and stop at 2 KB', async () => {
    const s = sampleOutput('user a.b@acme.com org 00D5g000004ABCDE at https://acme.my.salesforce.com ' + 'x'.repeat(5000))
    expect(s).toMatch(/user@example\.com/)
    expect(s).toMatch(/00DXXXXXXXXXXXXXXX/)
    expect(s).toMatch(/example\.my\.salesforce\.com/)
    expect(s.length).toBeLessThan(2100)
  })
})

describe('validation paths', () => {
  const dirs = ['force-app']
  const cases: [string, string | null][] = [
    ['force-app/main/default/classes/A.cls', 'force-app/main/default/classes/A.cls'],
    ['force-app/main/default/classes/A.cls-meta.xml', 'force-app/main/default/classes/A.cls'],
    ['force-app/main/default/lwc/card/card.js', 'force-app/main/default/lwc/card'],
    ['force-app/main/default/lwc/card/__tests__/card.test.js', null],
    ['force-app/main/default/aura/Box/BoxController.js', 'force-app/main/default/aura/Box'],
    ['README.md', null],
    ['scripts/apex/hello.apex', null],
    ['force-app/main/default/objects/Account/fields/X__c.field-meta.xml', 'force-app/main/default/objects/Account/fields/X__c.field-meta.xml'],
  ]
  for (const [rel, want] of cases) test(rel + ' -> ' + want, async () => expect(metadataPathOf(rel, dirs)).toBe(want))
})

describe('diff', () => {
  test('counts and focus', async () => {
    const d = unifiedDiff('a\nb\nc\n', 'a\nB\nc\nd\n')
    expect([d.adds, d.removes, d.first, d.last]).toEqual([2, 1, 2, 4])
  })
})
