import { describe, expect, test } from 'claude-code/testing'

const PROD = { options: { prod_orgs: 'prod, admin@acme.com' } }

const BAND = {
  component: 'AbovePrompt' as const,
  props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 5, bodyColumns: 160, scroll: { top: 0, bodyRows: 5 } as any, view: {} as any },
}
const FILES_PANE = {
  component: 'Pane' as const,
  requestId: 'sf-files',
  props: { title: 'Files', isFocused: true, bodyColumns: 72, placement: 'dock', scroll: { top: 0, bodyRows: 40 } as any, view: {} as any } as any,
}
const SF_PANE = { ...FILES_PANE, requestId: 'sf-guardian' }

const HUMAN_TEST_OUTPUT = `=== Test Summary
NAME                 VALUE
Outcome              Failed
Tests Ran            4
Pass Rate            75%
Fail Rate            25%
Test Run Coverage    81%

=== Test Results
TEST NAME                              OUTCOME  MESSAGE
AccountServiceTest.testInsert          Pass
AccountServiceTest.testBadInput        Fail     System.AssertException

=== Apex Code Coverage by Class
CLASSES          PERCENT  UNCOVERED LINES
AccountService   81%      12,13
LeadTrigger      60%      4
`

// $.ui.ask is a tool.call of AskUserQuestion: answer it as a person would
function answerAsk(e: any, label: string) {
  const q = e.questions?.[0]?.question ?? ''
  return { result: { questions: e.questions, answers: { [q]: label } } }
}

// An in-memory disk and project beneath the mod
function project(on: any, disk: Record<string, string>, opts: { cwd?: string; git?: string | null; orgList?: any; defaultOrg?: string; run?: (argv: string, e: any) => any } = {}) {
  const cwd = opts.cwd ?? '/project'
  const mtime: Record<string, number> = {}
  let clock = 1
  const touch = (p: string) => (mtime[p] = ++clock)
  for (const p of Object.keys(disk)) touch(p)
  const state = { porcelain: '', recent: [] as string[], head: {} as Record<string, string>, toasts: [] as string[] }
  on('session.cwd', () => ({ value: cwd }))
  on('env.get', () => ({ value: '/Users/me' }))
  on('fs.exists', ($$: any, e: any) => ({ value: e.path in disk }))
  on('fs.read', ($$: any, e: any) => {
    if (!(e.path in disk)) throw new Error('ENOENT: ' + e.path)
    return { value: disk[e.path] }
  })
  on('fs.list', ($$: any, e: any) => {
    const dir = String(e.path ?? cwd).replace(/\/$/, '')
    const seen = new Map<string, any>()
    for (const p of Object.keys(disk)) {
      if (!p.startsWith(dir + '/')) continue
      const rest = p.slice(dir.length + 1)
      const name = rest.split('/')[0]
      if (rest.includes('/')) seen.set(name, { name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })
      else seen.set(name, { name, kind: 'file', size: disk[p].length, mtimeMs: mtime[p] ?? 0, isLink: false })
    }
    return { value: [...seen.values()] }
  })
  on('fs.write', ($$: any, e: any) => {
    disk[e.path] = e.text
    touch(e.path)
    return { value: undefined }
  })
  on('fs.stat', ($$: any, e: any) => {
    if (!(e.path in disk)) throw new Error('ENOENT: ' + e.path)
    return { value: { kind: 'file', size: disk[e.path].length, mtimeMs: mtime[e.path] ?? 0, isLink: false } }
  })
  on('process.run', ($$: any, e: any) => {
    const argv = e.argv.join(' ')
    const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '' } })
    const own = opts.run?.(argv, e)
    if (own) return own
    if (argv.includes('rev-parse')) {
      return opts.git === null || opts.git === undefined
        ? { value: { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository' } }
        : ok(opts.git + '\n')
    }
    if (argv.includes(' status ')) return ok(state.porcelain)
    const show = argv.match(/ show HEAD:(.+)$/)
    if (show) return show[1] in state.head ? ok(state.head[show[1]]) : { value: { exitCode: 128, stdout: '', stderr: 'no' } }
    if (argv.startsWith('sf config get')) return ok('{"result":[{"value":"' + (opts.defaultOrg ?? 'uat') + '"}]}')
    if (argv.startsWith('sf org list --json')) return opts.orgList ? ok(JSON.stringify({ status: 0, result: opts.orgList })) : { value: { exitCode: 1, stdout: '', stderr: 'no sf' } }
    return { value: { exitCode: 1, stdout: '', stderr: 'not stubbed: ' + argv } }
  })
  on('session.start', ($$: any, e: any) => ({ ...e }))
  on('command.register', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', ($$: any, e: any) => {
    state.toasts.push(String(e.text ?? e))
    return { value: undefined }
  })
  return { mtime, touch, state }
}

async function start($: any, cwd = '/project') {
  await $.session.start({ cwd, surface: 'terminal', isInteractive: true })
}

async function filesPane($: any, surface: 'terminal' | 'desktop' = 'terminal') {
  return $.ui.mount({ plugin: 'sf-guardian', surface, ...FILES_PANE })
}

describe('production guard', () => {
  test('a production deploy without a test level is refused', PROD, async ($, on) => {
    on('tool.call', () => ({ result: { stdout: '', stderr: '' } }))
    const r: any = await $.tool.call({ tool: 'Bash', command: 'sf project deploy start -o prod' })
    expect(String(r.deny ?? r.text)).toMatch(/test level/)
  })

  test('validate-only rewrites the deploy with --dry-run', PROD, async ($, on) => {
    let ran = ''
    on('tool.call', ($$: any, e: any) => {
      if (e.tool === 'AskUserQuestion') return answerAsk(e, 'Validate only (--dry-run)')
      ran = e.command
      return { result: { stdout: '{"result":{"status":"Succeeded","numberComponentsDeployed":3}}', stderr: '' } }
    })
    await $.tool.call({ tool: 'Bash', command: 'sf project deploy start -o prod --test-level RunLocalTests' })
    expect(ran).toMatch(/--dry-run$/)
  })

  test('cancel stops a production data delete', PROD, async ($, on) => {
    let ran = false
    on('tool.call', ($$: any, e: any) => {
      if (e.tool === 'AskUserQuestion') return answerAsk(e, 'Cancel')
      ran = true
      return { result: { stdout: '', stderr: '' } }
    })
    await $.tool.call({ tool: 'Bash', command: 'sf data delete record -s Account -i 001 -o prod' })
    expect(ran).toBe(false)
  })

  test('run as written lets a production command through; usernames match too', PROD, async ($, on) => {
    let ran = false
    on('tool.call', ($$: any, e: any) => {
      if (e.tool === 'AskUserQuestion') return answerAsk(e, 'Run as written')
      ran = true
      return { result: { stdout: '', stderr: '' } }
    })
    await $.tool.call({ tool: 'Bash', command: 'sf data delete record -s Account -i 001 -o Admin@Acme.com' })
    expect(ran).toBe(true)
  })

  test('without production orgs set, the band asks for them', async ($) => {
    const ui = await $.ui.mount({ plugin: 'sf-guardian', surface: 'terminal', ...BAND })
    expect(await ui.find({ type: 'Text', text: /set production orgs in \/config/ })).toBeDefined()
  })

  test('non-Salesforce commands pass untouched', PROD, async ($, on) => {
    let ran = ''
    on('tool.call', ($$: any, e: any) => {
      ran = e.command
      return { result: { stdout: '', stderr: '' } }
    })
    await $.tool.call({ tool: 'Bash', command: 'ls -la' })
    expect(ran).toBe('ls -la')
  })
})

describe('sf readability', () => {
  test('test results draw as a compact summary', PROD, async ($, on) => {
    on('tool.call', () => ({ result: { stdout: HUMAN_TEST_OUTPUT, stderr: '' } }))
    await $.tool.call({ tool: 'Bash', command: 'sf apex run test -n AccountServiceTest -o uat --wait 10', tool_use_id: 'tu1' } as any)
    const ui = await $.ui.mount({
      plugin: 'sf-guardian',
      surface: 'terminal',
      component: 'ToolResult',
      requestId: 'tu1',
      props: { tool_use_id: 'tu1', tool: 'Bash', output: { stdout: HUMAN_TEST_OUTPUT, stderr: '' }, isErrored: false } as any,
    })
    expect(await ui.find({ type: 'Text', text: /3 passed · 1 failed · coverage 81%/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /testBadInput/ })).toBeDefined()
  })

  test('sf rows draw compactly and flag production', PROD, async ($) => {
    const ui = await $.ui.mount({
      plugin: 'sf-guardian',
      surface: 'terminal',
      component: 'ToolUse',
      props: { tool_use_id: 'x', tool: 'Bash', input: { command: 'sf project deploy start -o prod --test-level RunLocalTests' }, isRunning: false, isErrored: false, isInterrupted: false } as any,
    })
    expect(await ui.find({ type: 'Text', text: /Deploy → prod.*PROD/ })).toBeDefined()
  })

  test('compact rows can be turned off in settings', { options: { compact_sf_rows: false } }, async ($, on) => {
    let seen = false
    on('ui.render', { component: 'ToolUse' }, ($$: any, e: any, next: any) => {
      seen = true
      return next(e)
    })
    await $.ui.mount({
      plugin: 'sf-guardian',
      surface: 'terminal',
      component: 'ToolUse',
      props: { tool_use_id: 'x', tool: 'Bash', input: { command: 'sf project deploy start -o uat' }, isRunning: false, isErrored: false, isInterrupted: false } as any,
    })
    expect(seen).toBe(true)
  })

  test('band tracks untested Apex and clears after a passing run', PROD, async ($, on) => {
    on('tool.call', ($$: any, e: any) => {
      if (e.tool === 'Bash') return { result: { stdout: 'Tests Ran 2\nPass Rate 100%\nFail Rate 0%', stderr: '' } }
      return { result: { type: 'create', filePath: e.file_path, content: '', structuredPatch: [] } }
    })
    await $.tool.call({ tool: 'Write', file_path: '/p/classes/AccountService.cls', content: 'x' } as any)
    let ui = await $.ui.mount({ plugin: 'sf-guardian', surface: 'terminal', ...BAND })
    expect(await ui.find({ type: 'Text', text: /1 untested/ })).toBeDefined()
    await ui.unmount()
    await $.tool.call({ tool: 'Bash', command: 'sf apex run test -n AccountServiceTest -o uat --wait 10' })
    ui = await $.ui.mount({ plugin: 'sf-guardian', surface: 'terminal', ...BAND })
    expect(await ui.find({ type: 'Text', text: /all tested/ })).toBeDefined()
  })

  test('the Salesforce pane shows coverage and draws on the desktop', PROD, async ($, on) => {
    on('tool.call', () => ({ result: { stdout: HUMAN_TEST_OUTPUT, stderr: '' } }))
    await $.tool.call({ tool: 'Bash', command: 'sf apex run test -n AccountServiceTest -o uat --wait 10' })
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'sf-guardian', surface, ...SF_PANE })
      await ui.press({ key: 'tab-coverage' })
      expect(await ui.find({ type: 'Text', text: /60%  LeadTrigger/ })).toBeDefined()
      await ui.unmount()
    }
  })

  test('hint line lists the commands', async ($, on) => {
    let tail = ''
    on('ui.render', { component: 'PromptHint' }, ($$: any, e: any, next: any) => {
      tail = e.props.tail ?? ''
      return next(e)
    })
    await $.ui.mount({ plugin: 'sf-guardian', surface: 'terminal', component: 'PromptHint', props: { isDraft: false, isWorking: false, hint: '? for shortcuts' } as any })
    expect(tail).toMatch(/sffiles/)
  })
})

describe('live files', () => {
  test('an edit shows in the list with its latest change, all changes and the file', async ($, on) => {
    const path = '/project/force-app/main/default/classes/AccountService.cls'
    const disk: Record<string, string> = { [path]: 'public class AccountService {\n  void a() {}\n  void b() {}\n}\n' }
    project(on, disk)
    on('tool.call', ($$: any, e: any) => {
      disk[e.file_path] = disk[e.file_path].replace(e.old_string, e.new_string)
      return { result: { type: 'update', filePath: e.file_path, content: '', structuredPatch: [] } }
    })
    await $.tool.call({ tool: 'Edit', file_path: path, old_string: '  void b() {}', new_string: '  void c() {}\n  void d() {}' } as any)

    const ui = await filesPane($)
    expect(await ui.find({ type: 'Text', text: '1 file' })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: 'AccountService.cls' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /force-app\/main\/default\/classes\// })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '+2' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '−1' })).toBeDefined()
    expect(await ui.find({ type: 'Code', text: /\+  void d\(\) \{\}/ })).toBeDefined()

    await ui.press({ key: 'files-view-all' })
    expect(await ui.find({ type: 'Code', text: /-  void b\(\) \{\}/ })).toBeDefined()

    await ui.press({ key: 'files-view-file' })
    expect(await ui.find({ type: 'Text', text: /lines 1–5 of 5/ })).toBeDefined()
    expect(await ui.find({ type: 'Code', text: /void c\(\)/ })).toBeDefined()
  })

  test('a second edit shows only itself under Latest, both under All', async ($, on) => {
    const path = '/project/a.txt'
    const disk: Record<string, string> = { [path]: 'one\ntwo\nthree\n' }
    project(on, disk)
    on('tool.call', ($$: any, e: any) => {
      disk[e.file_path] = disk[e.file_path].replace(e.old_string, e.new_string)
      return { result: 'ok' }
    })
    await $.tool.call({ tool: 'Edit', file_path: path, old_string: 'one', new_string: 'ONE' } as any)
    await $.tool.call({ tool: 'Edit', file_path: path, old_string: 'three', new_string: 'THREE' } as any)
    const ui = await filesPane($)
    const latest = await ui.find({ type: 'Code' })
    expect(latest?.text).toMatch(/\+THREE/)
    expect(latest?.text).not.toMatch(/\+ONE/)
    await ui.press({ key: 'files-view-all' })
    const all = await ui.find({ type: 'Code' })
    expect(all?.text).toMatch(/\+ONE/)
    expect(all?.text).toMatch(/\+THREE/)
    expect(await ui.find({ type: 'Text', text: '+2' })).toBeDefined()
  })

  test('a new file is marked created', async ($, on) => {
    const disk: Record<string, string> = {}
    project(on, disk)
    on('tool.call', ($$: any, e: any) => {
      disk[e.file_path] = e.content
      return { result: { type: 'create', filePath: e.file_path, content: e.content, structuredPatch: [] } }
    })
    await $.tool.call({ tool: 'Write', file_path: '/project/classes/NewHelper.cls', content: 'public class NewHelper {\n}\n' } as any)
    const ui = await filesPane($)
    expect(await ui.find({ type: 'Text', text: '+' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /· new file/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '+2' })).toBeDefined()
  })

  test('rm marks a file deleted and keeps what it held', async ($, on) => {
    const disk: Record<string, string> = { '/project/scripts/old.apex': 'line one\nline two\nline three\n' }
    project(on, disk)
    on('tool.call', () => {
      delete disk['/project/scripts/old.apex']
      return { result: { stdout: '', stderr: '' } }
    })
    await $.tool.call({ tool: 'Bash', command: 'rm -f scripts/old.apex' })
    const ui = await filesPane($)
    expect(await ui.find({ type: 'Text', text: /· deleted/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '−3' })).toBeDefined()
    expect(await ui.find({ type: 'Code', text: /-line two/ })).toBeDefined()
  })

  test('a refused edit leaves no row', async ($, on) => {
    project(on, { '/project/x.cls': 'a\n' })
    on('tool.call', () => ({ deny: 'no' }))
    await $.tool.call({ tool: 'Edit', file_path: '/project/x.cls', old_string: 'a', new_string: 'b' } as any)
    const ui = await filesPane($)
    expect(await ui.find({ type: 'Text', text: /Waiting for changes/ })).toBeDefined()
  })

  test('any tool that writes a named file is tracked, whatever its name', async ($, on) => {
    const path = '/project/lwc/card/card.js'
    const disk: Record<string, string> = { [path]: 'export default 1\n' }
    project(on, disk)
    on('tool.call', ($$: any, e: any) => {
      disk[e.file_path] = 'export default 2\nexport const x = 3\n'
      return { result: 'ok' }
    })
    await $.tool.call({ tool: 'Update', file_path: path, changes: 'whatever' } as any)
    const ui = await filesPane($)
    expect(await ui.find({ type: 'Button', text: 'card.js' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '+2' })).toBeDefined()
  })

  test('git watch: a file changed by a shell command shows; files changed before the session do not', async ($, on) => {
    const disk: Record<string, string> = { '/project/classes/Old.cls': 'old dirty\n', '/project/classes/Svc.cls': 'class Svc {\n  a\n}\n' }
    const p = project(on, disk, { git: '/project' })
    p.state.porcelain = ' M classes/Old.cls\u0000'
    p.state.head['classes/Svc.cls'] = 'class Svc {\n  a\n}\n'
    on('tool.call', () => {
      disk['/project/classes/Svc.cls'] = 'class Svc {\n  a\n  b\n}\n'
      p.touch('/project/classes/Svc.cls')
      p.state.porcelain = ' M classes/Old.cls\u0000 M classes/Svc.cls\u0000'
      return { result: { stdout: '', stderr: '' } }
    })
    await start($)
    await $.tool.call({ tool: 'Bash', command: "sed -i '' 's/a/a\\n  b/' classes/Svc.cls" })
    await $.command.run({ command: 'sffiles', args: '' } as any)
    const ui = await filesPane($)
    expect(await ui.find({ type: 'Button', text: 'Svc.cls' })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: 'Old.cls' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: '● live' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /via git/ })).toBeDefined()
    expect(await ui.find({ type: 'Code', text: /\+  b/ })).toBeDefined()
  })

  test('folder watch (no git): a shell-created file shows, then its next change diffs', async ($, on) => {
    const disk: Record<string, string> = { '/Users/me/proj/README.md': 'hello\n' }
    const p = project(on, disk, { cwd: '/Users/me/proj' })
    let step = 0
    on('tool.call', () => {
      step++
      if (step === 1) disk['/Users/me/proj/notes.txt'] = 'one\ntwo\n'
      else disk['/Users/me/proj/notes.txt'] += 'three\n'
      p.touch('/Users/me/proj/notes.txt')
      p.state.recent = ['/Users/me/proj/notes.txt']
      return { result: { stdout: '', stderr: '' } }
    })
    await start($, '/Users/me/proj')
    await $.tool.call({ tool: 'Bash', command: "printf 'one\\ntwo\\n' > notes.txt" })
    await $.command.run({ command: 'sffiles', args: '' } as any)
    let ui = await filesPane($)
    expect(await ui.find({ type: 'Button', text: 'notes.txt' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '+2' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /not a git repo/ })).toBeDefined()
    await ui.unmount()

    await $.tool.call({ tool: 'Bash', command: "echo three >> notes.txt" })
    await $.command.run({ command: 'sffiles', args: '' } as any)
    ui = await filesPane($)
    expect(await ui.find({ type: 'Text', text: '+3' })).toBeDefined()
    expect((await ui.find({ type: 'Code' }))?.text).toMatch(/\+three/)
  })

  test('in the home folder the watch is off and says why', async ($, on) => {
    project(on, {}, { cwd: '/Users/me' })
    await start($, '/Users/me')
    await $.command.run({ command: 'sffiles', args: '' } as any)
    const ui = await filesPane($)
    expect(await ui.find({ type: 'Text', text: /start claude inside your project folder/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '◐ tools only' })).toBeDefined()
  })

  test('clear hides files until they change again, then diffs from what was cleared', async ($, on) => {
    const path = '/project/a.txt'
    const disk: Record<string, string> = { [path]: 'one\n' }
    const p = project(on, disk, { git: '/project' })
    p.state.head['a.txt'] = 'one\n'
    on('tool.call', ($$: any, e: any) => {
      if (e.tool === 'Edit') {
        disk[path] = disk[path].replace(e.old_string, e.new_string)
        p.touch(path)
        p.state.porcelain = ' M a.txt\u0000'
        return { result: 'ok' }
      }
      disk[path] += 'three\n'
      p.touch(path)
      return { result: { stdout: '', stderr: '' } }
    })
    await start($)
    await $.tool.call({ tool: 'Edit', file_path: path, old_string: 'one', new_string: 'one\ntwo' } as any)
    let ui = await filesPane($)
    await ui.press({ key: 'files-clear' })
    await ui.unmount()

    await $.command.run({ command: 'sffiles', args: '' } as any)
    ui = await filesPane($)
    expect(await ui.find({ type: 'Text', text: /Waiting for changes/ })).toBeDefined()
    await ui.unmount()

    await $.tool.call({ tool: 'Bash', command: 'echo three >> a.txt' })
    await $.command.run({ command: 'sffiles', args: '' } as any)
    ui = await filesPane($)
    expect(await ui.find({ type: 'Button', text: 'a.txt' })).toBeDefined()
    const code = (await ui.find({ type: 'Code' }))?.text ?? ''
    expect(code).toMatch(/\+three/)
    expect(code).not.toMatch(/\+two/)
  })

  test('a listed file changed outside Claude, then deleted, keeps up', async ($, on) => {
    const path = '/project/a.txt'
    const disk: Record<string, string> = { [path]: 'one\n' }
    const p = project(on, disk, { git: '/project' })
    on('tool.call', ($$: any, e: any) => {
      disk[path] = 'one\ntwo\n'
      p.touch(path)
      return { result: 'ok' }
    })
    await start($)
    await $.tool.call({ tool: 'Edit', file_path: path, old_string: 'one', new_string: 'one\ntwo' } as any)
    disk[path] = 'one\ntwo\nmine\n'
    p.touch(path)
    await $.command.run({ command: 'sffiles', args: '' } as any)
    let ui = await filesPane($)
    expect((await ui.find({ type: 'Code' }))?.text).toMatch(/\+mine/)
    await ui.unmount()

    delete disk[path]
    await $.command.run({ command: 'sffiles', args: '' } as any)
    ui = await filesPane($)
    expect(await ui.find({ type: 'Text', text: /· deleted/ })).toBeDefined()
  })

  test('binary files are listed without a preview', async ($, on) => {
    const disk: Record<string, string> = {}
    project(on, disk)
    on('tool.call', ($$: any, e: any) => {
      disk[e.file_path] = 'PNG\u0000\u0001data'
      return { result: 'ok' }
    })
    await $.tool.call({ tool: 'Write', file_path: '/project/staticresources/logo.png', content: 'x' } as any)
    const ui = await filesPane($)
    expect(await ui.find({ type: 'Text', text: 'binary' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Binary file: no preview/ })).toBeDefined()
    expect(await ui.find({ type: 'Code' })).toBeUndefined()
  })

  test('a long list scrolls with the selection', async ($, on) => {
    const disk: Record<string, string> = {}
    project(on, disk)
    on('tool.call', ($$: any, e: any) => {
      disk[e.file_path] = 'x\n'
      return { result: 'ok' }
    })
    for (let i = 1; i <= 12; i++) await $.tool.call({ tool: 'Write', file_path: '/project/f' + i + '.txt', content: 'x' } as any)
    const ui = await filesPane($)
    expect(await ui.find({ type: 'Text', text: /↓ 4 more/ })).toBeDefined()
    for (let i = 0; i < 9; i++) await ui.press({ key: 'files-next' })
    expect(await ui.find({ type: 'Text', text: /↑ \d+ more/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: /Follow off/ })).toBeDefined()
  })

  test('the Files pane draws in VS Code, narrow, and above the prompt', async ($, on) => {
    const disk: Record<string, string> = { '/project/force-app/main/default/classes/AVeryLongClassNameForTesting.cls': 'a\n' }
    project(on, disk)
    on('tool.call', ($$: any, e: any) => {
      disk[e.file_path] = 'b\n'
      return { result: 'ok' }
    })
    await $.tool.call({ tool: 'Edit', file_path: '/project/force-app/main/default/classes/AVeryLongClassNameForTesting.cls', old_string: 'a', new_string: 'b' } as any)
    const vscode = await $.ui.mount({ plugin: 'sf-guardian', surface: 'vscode', ...FILES_PANE })
    expect(await vscode.find({ type: 'Button', text: 'AVeryLongClassNameForTesting.cls' })).toBeDefined()
    const narrow = await $.ui.mount({
      plugin: 'sf-guardian',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'sf-files',
      props: { title: 'Files', isFocused: false, bodyColumns: 34, placement: 'inline', scroll: { top: 0, bodyRows: 12 } as any, view: {} as any } as any,
    })
    expect(await narrow.find({ type: 'Code' })).toBeDefined()
  })

  test('the Files pane draws on the desktop app too', async ($, on) => {
    const disk: Record<string, string> = { '/project/a.txt': 'a\n' }
    project(on, disk)
    on('tool.call', ($$: any, e: any) => {
      disk[e.file_path] = 'b\n'
      return { result: 'ok' }
    })
    await $.tool.call({ tool: 'Edit', file_path: '/project/a.txt', old_string: 'a', new_string: 'b' } as any)
    const ui = await filesPane($, 'desktop')
    expect(await ui.find({ type: 'Button', text: 'a.txt' })).toBeDefined()
    await ui.press({ key: 'files-view-file' })
    expect(await ui.find({ type: 'Code', text: /b/ })).toBeDefined()
  })
})

// ── 0.5.1 to 0.9.0 ──────────────────────────────────────────────────────────
import { APEX_FAIL, APEX_PASS, DEPLOY_FAIL, LIMITS, ORG_LIST } from './fixtures/sf-output.js'

// A store beneath the mod, so the audit log and caches can be read back
function store(on: any) {
  const data: Record<string, any> = {}
  on('store.get', ($$: any, e: any) => ({ value: data[e.key] === undefined ? undefined : JSON.parse(JSON.stringify(data[e.key])) }))
  on('store.set', ($$: any, e: any) => {
    data[e.key] = JSON.parse(JSON.stringify(e.value))
    return { value: undefined }
  })
  return data
}

// Answer every question with `label`, run everything else with `run`
function bash(on: any, label: string, run: (e: any) => any = () => ({ result: { stdout: '', stderr: '' } })) {
  const seen = { asked: [] as string[], ran: [] as string[] }
  on('tool.call', ($$: any, e: any) => {
    if (e.tool === 'AskUserQuestion') {
      seen.asked.push(e.questions?.[0]?.question ?? '')
      return answerAsk(e, label)
    }
    seen.ran.push(e.command ?? e.tool)
    return run(e)
  })
  return seen
}

describe('guard v2: orgs from sf org list', () => {
  test('the username of a production org asks, like its alias; a sandbox never asks', async ($, on) => {
    project(on, {}, { orgList: ORG_LIST.result, defaultOrg: 'uat' })
    store(on)
    const seen = bash(on, 'Cancel')
    await start($)
    await $.tool.call({ tool: 'Bash', command: 'sf data delete record -s Account -i 001 -o RELEASE@acme.com' })
    await $.tool.call({ tool: 'Bash', command: 'sf data delete record -s Account -i 001 -o prod' })
    expect(seen.asked.length).toBe(2)
    expect(seen.ran.length).toBe(0)
    await $.tool.call({ tool: 'Bash', command: 'sf project deploy start -o uat' })
    await $.tool.call({ tool: 'Bash', command: 'sf data delete record -s A -i 1 -o release@acme.com.uat' })
    expect(seen.asked.length).toBe(2)
    expect(seen.ran.length).toBe(2)
  })

  test('chains and bash -c are judged; validate-only rewrites only the deploy part', async ($, on) => {
    project(on, {}, { orgList: ORG_LIST.result })
    store(on)
    const seen = bash(on, 'Validate only (--dry-run)')
    await start($)
    await $.tool.call({ tool: 'Bash', command: 'cd force-app && sf project deploy start -o prod --test-level RunLocalTests && echo ok' })
    await $.tool.call({ tool: 'Bash', command: 'bash -c "sf project deploy start -o prod --test-level RunLocalTests"' })
    expect(seen.asked.length).toBe(2)
    expect(seen.ran[0]).toBe('cd force-app && sf project deploy start -o prod --test-level RunLocalTests --dry-run && echo ok')
    expect(seen.ran[1]).toBe('bash -c "sf project deploy start -o prod --test-level RunLocalTests --dry-run"')
  })

  test('words only inside quotes raise no alarm', async ($, on) => {
    project(on, {}, { orgList: ORG_LIST.result })
    store(on)
    const seen = bash(on, 'Cancel')
    await start($)
    await $.tool.call({ tool: 'Bash', command: 'git commit -m "sf project deploy start -o prod"' })
    await $.tool.call({ tool: 'Bash', command: 'echo "sf data delete record -o prod"' })
    expect(seen.asked.length).toBe(0)
    expect(seen.ran.length).toBe(2)
  })

  test('an org that is not listed is unknown and asks', async ($, on) => {
    project(on, {}, { orgList: ORG_LIST.result })
    store(on)
    const seen = bash(on, 'Cancel')
    await start($)
    const r: any = await $.tool.call({ tool: 'Bash', command: 'sf apex run -f x.apex -o somewhere' })
    expect(seen.asked[0]).toMatch(/somewhere · UNKNOWN/)
    expect(String(r.deny ?? r.text)).toMatch(/declined/)
  })

  test('secret commands are refused, and allowed by the setting', async ($, on) => {
    project(on, {}, { orgList: ORG_LIST.result })
    store(on)
    const seen = bash(on, 'Cancel')
    await start($)
    const r: any = await $.tool.call({ tool: 'Bash', command: 'sf org auth show-access-token -o uat' })
    expect(String(r.deny ?? r.text)).toMatch(/secret/)
    await $.tool.call({ tool: 'Bash', command: 'sf org display -o uat' })
    expect(seen.ran).toEqual(['sf org display -o uat'])
  })

  test('secret commands run when allowed in settings', { options: { allow_secret_commands: true } }, async ($, on) => {
    project(on, {}, { orgList: ORG_LIST.result })
    store(on)
    const seen = bash(on, 'Cancel')
    await start($)
    await $.tool.call({ tool: 'Bash', command: 'sf org auth show-access-token -o uat' })
    expect(seen.ran.length).toBe(1)
  })

  test('block mode refuses production changes and lets reads through', { options: { guard_mode: 'block' } }, async ($, on) => {
    project(on, {}, { orgList: ORG_LIST.result })
    store(on)
    const seen = bash(on, 'Run as written')
    await start($)
    const r: any = await $.tool.call({ tool: 'Bash', command: 'sf data delete record -s A -i 1 -o prod' })
    expect(String(r.deny ?? r.text)).toMatch(/block/)
    await $.tool.call({ tool: 'Bash', command: 'sf data query -q "SELECT Id FROM A" -o prod' })
    expect(seen.asked.length).toBe(0)
    expect(seen.ran.length).toBe(1)
  })

  test('with sf missing, the guard uses the lists and the band says detection is off', PROD, async ($, on) => {
    project(on, {})
    store(on)
    const seen = bash(on, 'Cancel')
    await start($)
    await $.tool.call({ tool: 'Bash', command: 'sf data delete record -s A -i 1 -o prod' })
    expect(seen.asked[0]).toMatch(/PRODUCTION/)
    const ui = await $.ui.mount({ plugin: 'sf-guardian', surface: 'terminal', ...BAND })
    expect(await ui.find({ type: 'Text', text: /org detection off/ })).toBeDefined()
  })

  test('npm scripts: a script with sf inside asks, a plain one does not', async ($, on) => {
    project(on, { '/project/package.json': JSON.stringify({ scripts: { lint: 'eslint .', deploy: 'sf project deploy start -l RunLocalTests' } }) }, { orgList: ORG_LIST.result, defaultOrg: 'prod' })
    store(on)
    const seen = bash(on, 'Cancel')
    await start($)
    await $.tool.call({ tool: 'Bash', command: 'npm run lint' })
    expect(seen.asked.length).toBe(0)
    await $.tool.call({ tool: 'Bash', command: 'npm run deploy' })
    expect(seen.asked[0]).toMatch(/inside npm deploy/)
  })

  test('the Salesforce MCP deploy asks on production, with the org given or by default', async ($, on) => {
    project(on, {}, { orgList: ORG_LIST.result, defaultOrg: 'prod' })
    store(on)
    const seen = bash(on, 'Cancel')
    await start($)
    const r: any = await $.tool.call({ tool: 'mcp__salesforce__deploy_metadata', usernameOrAlias: 'prod', sourceDir: ['force-app'] } as any)
    expect(String(r.deny ?? r.text)).toMatch(/declined deploy_metadata/)
    await $.tool.call({ tool: 'mcp__salesforce__deploy_metadata', sourceDir: ['force-app'] } as any)
    expect(seen.asked.length).toBe(2)
    await $.tool.call({ tool: 'mcp__salesforce__deploy_metadata', usernameOrAlias: 'uat', sourceDir: ['force-app'] } as any)
    await $.tool.call({ tool: 'mcp__salesforce__run_soql_query', usernameOrAlias: 'prod', query: 'SELECT Id FROM A' } as any)
    expect(seen.asked.length).toBe(2)
    expect(seen.ran.length).toBe(2)
  })

  test('reading ~/.sfdx asks first', async ($, on) => {
    project(on, {}, { orgList: ORG_LIST.result })
    store(on)
    const seen = bash(on, 'Cancel')
    await start($)
    const r: any = await $.tool.call({ tool: 'Read', file_path: '/Users/me/.sfdx/release@acme.com.json' } as any)
    expect(String(r.deny ?? r.text)).toMatch(/auth files/)
    await $.tool.call({ tool: 'Bash', command: 'cat ~/.sf/config.json' })
    expect(seen.asked.length).toBe(2)
    expect(seen.ran.length).toBe(0)
    await $.tool.call({ tool: 'Read', file_path: '/project/.sfdx/sfdx-config.json' } as any)
    expect(seen.ran.length).toBe(1)
  })

  test('session ids are removed from Bash output', async ($, on) => {
    project(on, {}, { orgList: ORG_LIST.result })
    store(on)
    bash(on, 'Cancel', () => ({ result: { stdout: 'Access Token 00D5g000004ABCDE!AQ4AQFakeTokenValue.abcdefghijklmnop_1234\n', stderr: '' } }))
    await start($)
    const r: any = await $.tool.call({ tool: 'Bash', command: 'curl https://example.com' })
    expect(JSON.stringify(r)).not.toMatch(/AQ4AQ/)
    expect(JSON.stringify(r)).toMatch(/session id removed/)
  })

  test('the default org refreshes after sf config set', async ($, on) => {
    let org = 'uat'
    project(on, {}, {
      orgList: ORG_LIST.result,
      run: (argv) => (argv.startsWith('sf config get') ? { value: { exitCode: 0, stdout: JSON.stringify({ result: [{ value: org }] }), stderr: '' } } : undefined),
    })
    store(on)
    bash(on, 'Cancel', () => {
      org = 'prod'
      return { result: { stdout: '', stderr: '' } }
    })
    await start($)
    await $.tool.call({ tool: 'Bash', command: 'sf config set target-org prod' })
    const r: any = await $.command.run({ command: 'sforg', args: '' } as any)
    expect(r.text).toMatch(/Default org: prod \(production\)/)
  })
})

describe('/sfguard and the audit log', () => {
  test('decisions are logged, cleaned, and listed; /sfguard test runs nothing', async ($, on) => {
    project(on, {}, { orgList: ORG_LIST.result })
    const data = store(on)
    const seen = bash(on, 'Cancel')
    await start($)
    await $.tool.call({ tool: 'Bash', command: 'sf data delete record -s A -i 1 -o prod --password hunter2' })
    expect(data.audit.length).toBe(1)
    expect(data.audit[0]).toMatchObject({ verdict: 'ask', answer: 'Cancel', outcome: 'cancelled', org: 'prod', cls: 'production' })
    expect(data.audit[0].command).not.toMatch(/hunter2/)
    const list: any = await $.command.run({ command: 'sfguard', args: '' } as any)
    expect(list.text).toMatch(/ask → Cancel · cancelled · prod \(production\)/)
    const t: any = await $.command.run({ command: 'sfguard', args: 'test cd x && sf project deploy start -o release@acme.com -l RunLocalTests' } as any)
    expect(t.text).toMatch(/^ASK/)
    expect(t.text).toMatch(/Validate only/)
    expect(seen.ran.length).toBe(0)
    const o: any = await $.command.run({ command: 'sfguard', args: 'orgs' } as any)
    expect(o.text).toMatch(/production\s+prod\s+release@acme\.com/)
    expect(o.text).toMatch(/scratch\s+so/)
  })

  test('the audit log is a ring buffer of 500', async ($, on) => {
    project(on, {}, { orgList: ORG_LIST.result })
    const data = store(on)
    data.audit = Array.from({ length: 500 }, (_, i) => ({ at: '2026-01-01T00:00:00Z', command: 'old ' + i, verdict: 'allow' }))
    bash(on, 'Cancel')
    await start($)
    await $.tool.call({ tool: 'Bash', command: 'sf apex run -o prod' })
    expect(data.audit.length).toBe(500)
    expect(data.audit[0].command).toBe('old 1')
  })

  test('/sfguard export writes the entries to a file', async ($, on) => {
    const disk: Record<string, string> = {}
    project(on, disk, { orgList: ORG_LIST.result })
    store(on)
    bash(on, 'Cancel')
    await start($)
    await $.tool.call({ tool: 'Bash', command: 'sf apex run -o prod' })
    const r: any = await $.command.run({ command: 'sfguard', args: 'export audit.json' } as any)
    expect(r.text).toMatch(/Wrote 1 entry/)
    expect(JSON.parse(disk['/project/audit.json'])[0].org).toBe('prod')
  })

  test('the audit log can be turned off', { options: { audit_log: false } }, async ($, on) => {
    project(on, {}, { orgList: ORG_LIST.result })
    const data = store(on)
    bash(on, 'Cancel')
    await start($)
    await $.tool.call({ tool: 'Bash', command: 'sf apex run -o prod' })
    expect(data.audit).toBeUndefined()
  })
})

describe('live typing', () => {
  const STEP = { turnId: 't1', index: 0, model: 'claude', messageCount: 1 }

  test('a Write shows while it streams, chunks pass through unchanged, then it becomes a normal row', async ($, on) => {
    const disk: Record<string, string> = {}
    project(on, disk)
    on('tool.call', ($$: any, e: any) => {
      disk[e.file_path] = e.content
      return { result: 'ok' }
    })
    const chunks: any[] = [
      { kind: 'text', index: 0, text: 'Writing the class.' },
      { kind: 'tool', index: 1, id: 'tu-w', name: 'Write' },
      { kind: 'input', index: 1, json: '{"file_path":"/project/force-app/main/default/classes/Acc' },
      { kind: 'input', index: 1, json: 'ountService.cls","content":"public class AccountService {\\n  public static void sync() {' },
      { kind: 'input', index: 1, json: '}\\n}\\n"}' },
      { kind: 'stop', stopReason: 'tool_use', usage: null },
    ]
    on('turn.step', async function* () {
      for (const c of chunks) yield c
      return { turnId: 't1', index: 0, answer: 'Writing the class.', toolUses: [], stopReason: 'tool_use', usage: null }
    })
    const out: any[] = []
    let ui: any = null
    for await (const c of $.turn.step(STEP as any)) {
      out.push(c)
      if (out.length === 4) {
        ui = await filesPane($)
        expect(await ui.find({ type: 'Button', text: 'AccountService.cls' })).toBeDefined()
        expect(await ui.find({ type: 'Text', text: /drafting… line 2/ })).toBeDefined()
        expect((await ui.find({ type: 'Code' }))?.text).toMatch(/public static void sync\(\) \{█/)
        await ui.unmount()
      }
    }
    expect(out).toEqual(chunks)
    await $.tool.call({ tool: 'Write', tool_use_id: 'tu-w', file_path: '/project/force-app/main/default/classes/AccountService.cls', content: 'public class AccountService {\n  public static void sync() {}\n}\n' } as any)
    ui = await filesPane($)
    expect(await ui.find({ type: 'Text', text: /drafting/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /· new file/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '+3' })).toBeDefined()
  })

  test('an Edit draft shows old and new text; a denied tool leaves "not applied" and no file', async ($, on) => {
    const disk: Record<string, string> = { '/project/a.cls': 'one\n' }
    project(on, disk)
    on('tool.call', () => ({ deny: 'no' }))
    on('turn.step', async function* () {
      yield { kind: 'tool', index: 0, id: 'tu-e', name: 'Edit' }
      yield { kind: 'input', index: 0, json: '{"file_path":"/project/a.cls","old_string":"one","new_string":"two"}' }
      yield { kind: 'stop', stopReason: 'tool_use', usage: null }
      return { turnId: 't1', index: 0, answer: '', toolUses: [], stopReason: 'tool_use', usage: null }
    })
    for await (const _ of $.turn.step(STEP as any)) {
      // drain
    }
    let ui = await filesPane($)
    const code = (await ui.find({ type: 'Code' }))?.text ?? ''
    expect(code).toMatch(/-one/)
    expect(code).toMatch(/\+two/)
    await ui.unmount()
    await $.tool.call({ tool: 'Edit', tool_use_id: 'tu-e', file_path: '/project/a.cls', old_string: 'one', new_string: 'two' } as any)
    ui = await filesPane($)
    expect(await ui.find({ type: 'Text', text: 'not applied' })).toBeDefined()
    expect(disk['/project/a.cls']).toBe('one\n')
  })

  test('an aborted turn discards its drafts', async ($, on) => {
    project(on, {})
    on('turn.complete', () => ({ text: '' }))
    on('turn.step', async function* () {
      yield { kind: 'tool', index: 0, id: 'tu-x', name: 'Write' }
      yield { kind: 'input', index: 0, json: '{"file_path":"/project/x.txt","content":"hel' }
      return { turnId: 't1', index: 0, answer: '', toolUses: [], stopReason: null, usage: null }
    })
    for await (const _ of $.turn.step(STEP as any)) {
      // drain
    }
    await $.turn.complete({ turnId: 't1', durationMs: 10, isAborted: true, answer: '' } as any)
    const ui = await filesPane($)
    expect(await ui.find({ type: 'Text', text: 'not applied' })).toBeDefined()
  })

  test('live typing can be turned off', { options: { live_typing: false } }, async ($, on) => {
    project(on, {})
    on('turn.step', async function* () {
      yield { kind: 'tool', index: 0, id: 'tu-o', name: 'Write' }
      yield { kind: 'input', index: 0, json: '{"file_path":"/project/x.txt","content":"hello"}' }
      return { turnId: 't1', index: 0, answer: '', toolUses: [], stopReason: 'tool_use', usage: null }
    })
    for await (const _ of $.turn.step(STEP as any)) {
      // drain
    }
    const ui = await filesPane($)
    expect(await ui.find({ type: 'Text', text: /Waiting for changes/ })).toBeDefined()
  })
})

describe('Salesforce workflow', () => {
  test('a failed deploy shows file and line in its row and in the sidebar', async ($, on) => {
    const path = '/project/force-app/main/default/classes/AccountService.cls'
    const disk: Record<string, string> = { [path]: 'a\n' }
    project(on, disk, { orgList: ORG_LIST.result })
    store(on)
    const out = JSON.stringify(DEPLOY_FAIL)
    on('tool.call', ($$: any, e: any) => {
      if (e.tool === 'Edit') {
        disk[path] = 'b\n'
        return { result: 'ok' }
      }
      return { isError: true, result: { stdout: out, stderr: '' }, text: out }
    })
    await start($)
    await $.tool.call({ tool: 'Edit', file_path: path, old_string: 'a', new_string: 'b' } as any)
    await $.tool.call({ tool: 'Bash', command: 'sf project deploy start -o uat --json', tool_use_id: 'd1' } as any)
    const row = await $.ui.mount({
      plugin: 'sf-guardian',
      surface: 'terminal',
      component: 'ToolResult',
      requestId: 'd1',
      props: { tool_use_id: 'd1', tool: 'Bash', output: { stdout: out, stderr: '' }, isErrored: true } as any,
    })
    expect(await row.find({ type: 'Text', text: /AccountService\.cls:34:12  Variable does not exist: foo/ })).toBeDefined()
    const ui = await filesPane($)
    expect(await ui.find({ type: 'Text', text: '✘2' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /line 34:12  Variable does not exist/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: /card\.js:3:1/ })).toBeUndefined() // card.js is not a listed file
  })

  test('ask Claude to fix sends a short digest', async ($, on) => {
    project(on, {}, { orgList: ORG_LIST.result })
    store(on)
    const out = JSON.stringify(DEPLOY_FAIL)
    let sent = ''
    on('prompt.submit', ($$: any, e: any) => {
      sent = e.text
      return { text: e.text }
    })
    on('tool.call', () => ({ isError: true, result: { stdout: out, stderr: '' }, text: out }))
    await start($)
    await $.tool.call({ tool: 'Bash', command: 'sf project deploy start -o uat --json' })
    const ui = await $.ui.mount({ plugin: 'sf-guardian', surface: 'terminal', ...SF_PANE })
    await ui.press({ key: 'tab-deploys' })
    await ui.press({ key: 'fix-problems' })
    expect(sent).toMatch(/AccountService\.cls:34:12  Variable does not exist: foo/)
    expect(sent.split('\n').length).toBeLessThanOrEqual(40)
  })

  test('uncovered lines show in the Coverage view', async ($, on) => {
    const path = '/project/force-app/main/default/classes/AccountService.cls'
    const lines = Array.from({ length: 80 }, (_, i) => 'line ' + (i + 1)).join('\n') + '\n'
    const disk: Record<string, string> = { [path]: lines }
    project(on, disk)
    const out = JSON.stringify(APEX_PASS)
    on('tool.call', ($$: any, e: any) => {
      if (e.tool === 'Edit') {
        disk[path] = disk[path].replace('line 1\n', 'LINE 1\n')
        return { result: 'ok' }
      }
      return { result: { stdout: out, stderr: '' } }
    })
    await $.tool.call({ tool: 'Edit', file_path: path, old_string: 'line 1', new_string: 'LINE 1' } as any)
    await $.tool.call({ tool: 'Bash', command: 'sf apex run test -n AccountServiceTest -o uat --code-coverage --json --wait 10' })
    const ui = await filesPane($)
    await ui.press({ key: 'files-view-coverage' })
    expect(await ui.find({ type: 'Text', text: /AccountService: 88% · 6 uncovered lines: 40–44, 71/ })).toBeDefined()
    expect((await ui.find({ type: 'Code' }))?.text).toMatch(/✘ line 40/)
  })

  test('a failing test names its class and line', async ($, on) => {
    on('tool.call', () => ({ result: { stdout: JSON.stringify(APEX_FAIL), stderr: '' } }))
    await $.tool.call({ tool: 'Bash', command: 'sf apex run test -n LeadHandlerTest -o uat --json --wait 10', tool_use_id: 't9' } as any)
    const ui = await $.ui.mount({
      plugin: 'sf-guardian',
      surface: 'terminal',
      component: 'ToolResult',
      requestId: 't9',
      props: { tool_use_id: 't9', tool: 'Bash', output: { stdout: JSON.stringify(APEX_FAIL), stderr: '' }, isErrored: false } as any,
    })
    expect(await ui.find({ type: 'Text', text: /LeadHandlerTest\.convertsLead \(line 34\)/ })).toBeDefined()
  })

  test('v validates only the changed files, with their tests, after a confirmation', async ($, on) => {
    const disk: Record<string, string> = {
      '/project/sfdx-project.json': JSON.stringify({ packageDirectories: [{ path: 'force-app', default: true }], sourceApiVersion: '62.0' }),
      '/project/force-app/main/default/classes/AccountService.cls': 'a\n',
      '/project/force-app/main/default/classes/AccountServiceTest.cls': 't\n',
      '/project/force-app/main/default/lwc/card/card.js': 'x\n',
      '/project/README.md': 'r\n',
    }
    let p: any
    let validated: string[] = []
    let asked = ''
    p = project(on, disk, {
      orgList: ORG_LIST.result,
      run: (argv, e) => {
        if (!argv.startsWith('sf project deploy start')) return undefined
        validated = e.argv
        return { value: { exitCode: 0, stdout: JSON.stringify({ status: 0, result: { status: 'Succeeded', numberComponentsDeployed: 2 } }), stderr: '' } }
      },
    })
    store(on)
    on('tool.call', ($$: any, e: any) => {
      if (e.tool === 'AskUserQuestion') {
        asked = e.questions?.[0]?.question ?? ''
        return answerAsk(e, 'Validate')
      }
      disk[e.file_path] = 'changed\n'
      return { result: 'ok' }
    })
    await start($)
    for (const p of ['/project/force-app/main/default/classes/AccountService.cls', '/project/force-app/main/default/lwc/card/card.js', '/project/README.md']) {
      await $.tool.call({ tool: 'Edit', file_path: p, old_string: 'x', new_string: 'y' } as any)
    }
    const ui = await filesPane($)
    await ui.press({ key: 'files-validate' })
    expect(p.state.toasts).toEqual(['✔ Validation succeeded on uat'])
    expect(asked).toMatch(/Validate 2 changed components on uat \(sandbox\)/)
    expect(validated).toEqual([
      'sf', 'project', 'deploy', 'start', '--dry-run', '--json', '--wait', '9', '-o', 'uat',
      '--source-dir', 'force-app/main/default/classes/AccountService.cls',
      '--source-dir', 'force-app/main/default/lwc/card',
      '--test-level', 'RunSpecifiedTests', '--tests', 'AccountServiceTest',
    ])
  })

  test('the band shows the org class, scratch expiry and a newer project API', async ($, on) => {
    const soon = new Date(Date.now() + 2 * 86400000 + 3600000).toISOString()
    const list = { ...ORG_LIST.result, scratchOrgs: [{ alias: 'so', username: 's@x.com', isScratch: true, expirationDate: soon, instanceApiVersion: '61.0' }] }
    project(on, { '/project/sfdx-project.json': JSON.stringify({ packageDirectories: [{ path: 'force-app' }], sourceApiVersion: '62.0' }) }, { orgList: list, defaultOrg: 'so', git: '/project' })
    store(on)
    await start($)
    await $.command.run({ command: 'sforg', args: '' } as any)
    const ui = await $.ui.mount({ plugin: 'sf-guardian', surface: 'terminal', ...BAND })
    expect(await ui.find({ type: 'Text', text: '● so · scratch' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /expires in 2d/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'API 62.0 > org 61.0' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^SF Guardian v\d+\.\d+\.\d+$/ })).toBeDefined()
  })
})

describe('0.5.1 fixes', () => {
  test('limits use sf org list limits, and fall back on an old CLI', async ($, on) => {
    const calls: string[] = []
    let old = false
    on('process.run', ($$: any, e: any) => {
      const argv = e.argv.join(' ')
      calls.push(argv)
      if (argv.startsWith('sf org list limits') && old) return { value: { exitCode: 127, stdout: '', stderr: 'Warning: org list limits is not a sf command.' } }
      return { value: { exitCode: 0, stdout: JSON.stringify(LIMITS), stderr: '' } }
    })
    let r: any = await $.command.run({ command: 'sflimits', args: 'uat' } as any)
    expect(calls[0]).toBe('sf org list limits --json --target-org uat')
    expect(r.text).toMatch(/DataStorageMB: 900 \/ 1,000 \(90%\)/)
    old = true
    r = await $.command.run({ command: 'sflimits', args: 'uat' } as any)
    expect(calls.slice(-1)[0]).toBe('sf limits api display --json --target-org uat')
    expect(r.text).toMatch(/old sf CLI/)
  })

  test('the turn line shows new and cached tokens apart', async ($, on) => {
    on('turn.complete', () => ({ text: '' }))
    await $.turn.complete({ turnId: 't', durationMs: 4321, answer: '', usage: { input_tokens: 100, output_tokens: 3000, cache_creation_input_tokens: 0, cache_read_input_tokens: 142000 } } as any)
    const ui = await $.ui.mount({ plugin: 'sf-guardian', surface: 'terminal', component: 'TurnDuration', props: { durationMs: 4321, word: 'Worked', isExpanded: false } as any })
    expect(await ui.find({ type: 'Text', text: /3\.1k tokens · 142k cached/ })).toBeDefined()
  })
})

describe('/sfdoctor', () => {
  test('checks the setup and prints a line per check', async ($, on) => {
    project(on, { '/project/sfdx-project.json': JSON.stringify({ packageDirectories: [{ path: 'force-app' }], sourceApiVersion: '62.0' }) }, {
      orgList: ORG_LIST.result,
      git: '/project',
      run: (argv) => {
        if (argv === 'sf --version') return { value: { exitCode: 0, stdout: '@salesforce/cli/2.159.7 darwin-arm64 node-v22\n', stderr: '' } }
        if (argv.startsWith('sf plugins')) return { value: { exitCode: 0, stdout: JSON.stringify([{ name: '@salesforce/plugin-apex' }, { name: '@salesforce/plugin-deploy-retrieve' }, { name: '@salesforce/plugin-org' }]), stderr: '' } }
        if (argv === 'git --version') return { value: { exitCode: 0, stdout: 'git version 2.50.0\n', stderr: '' } }
        return undefined
      },
    })
    store(on)
    on('session.version', () => ({ value: { version: '2.1.331', base: '2.1.331' } }))
    await start($)
    const r: any = await $.command.run({ command: 'sfdoctor', args: '' } as any)
    expect(r.text).toMatch(/✔ Claude Code 2\.1\.331/)
    expect(r.text).toMatch(/✔ sf 2\.159\.7/)
    expect(r.text).toMatch(/✔ apex, deploy-retrieve and org plugins present/)
    expect(r.text).toMatch(/✔ sfdx-project\.json found · packages: force-app · API 62\.0/)
    expect(r.text).toMatch(/✔ Default org: uat \(sandbox\)/)
    expect(r.text).toMatch(/✔ Org detection on: 3 production, 2 sandbox, 1 scratch/)
    expect(r.text).toMatch(/✔ Store is writable/)
    expect(r.text).not.toMatch(/release@acme\.com/)
  })

  test('record saves the last unparsed output, cleaned', async ($, on) => {
    const disk: Record<string, string> = {}
    project(on, disk)
    on('tool.call', () => ({ result: { stdout: 'Something new from sf for admin@acme.com', stderr: '' } }))
    await $.tool.call({ tool: 'Bash', command: 'sf apex run test -n X -o uat --wait 10' })
    const r: any = await $.command.run({ command: 'sfdoctor', args: 'record out.txt' } as any)
    expect(r.text).toMatch(/Saved/)
    expect(disk['/project/out.txt']).toMatch(/user@example\.com/)
  })
})

describe('0.9.0: Windows paths, memory, open in editor', () => {
  test('Windows paths: backslashes match, home from USERPROFILE', async ($, on) => {
    const disk: Record<string, string> = { 'C:/proj/force-app/main/default/classes/A.cls': 'a\n' }
    project(on, disk, { cwd: 'C:\\proj' })
    on('tool.call', ($$: any, e: any) => {
      disk['C:/proj/force-app/main/default/classes/A.cls'] = 'b\n'
      return { result: 'ok' }
    })
    await $.tool.call({ tool: 'Edit', file_path: 'C:\\proj\\force-app\\main\\default\\classes\\A.cls', old_string: 'a', new_string: 'b' } as any)
    const ui = await filesPane($)
    expect(await ui.find({ type: 'Button', text: 'A.cls' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /force-app\/main\/default\/classes\// })).toBeDefined()
  })

  test('del and Remove-Item count as deletes', async ($, on) => {
    const disk: Record<string, string> = { '/project/a.txt': 'x\n', '/project/b.txt': 'y\n' }
    project(on, disk)
    on('tool.call', ($$: any, e: any) => {
      if (/del /.test(e.command)) delete disk['/project/a.txt']
      if (/Remove-Item/.test(e.command)) delete disk['/project/b.txt']
      return { result: { stdout: '', stderr: '' } }
    })
    await $.tool.call({ tool: 'Bash', command: 'del a.txt' })
    await $.tool.call({ tool: 'Bash', command: 'Remove-Item -Path b.txt -Force' })
    const ui = await filesPane($)
    expect(await ui.find({ type: 'Text', text: '2 files' })).toBeDefined()
  })

  test('older files keep only their diff', async ($, on) => {
    const disk: Record<string, string> = {}
    project(on, disk)
    on('tool.call', ($$: any, e: any) => {
      disk[e.file_path] = 'x\n'
      return { result: 'ok' }
    })
    for (let i = 1; i <= 55; i++) await $.tool.call({ tool: 'Write', file_path: '/project/f' + i + '.txt', content: 'x' } as any)
    const ui = await filesPane($)
    expect(await ui.find({ type: 'Text', text: '55 files' })).toBeDefined()
  })

  test('o opens the selected file in the editor at its line', { options: { editor_command: 'code' } }, async ($, on) => {
    const disk: Record<string, string> = { '/project/my dir/a.cls': 'a\nb\n' }
    let argv: string[] = []
    project(on, disk, {
      run: (line, e) => {
        if (e.argv[0] !== 'code') return undefined
        argv = e.argv
        return { value: { exitCode: 0, stdout: '', stderr: '' } }
      },
    })
    on('tool.call', () => {
      disk['/project/my dir/a.cls'] = 'a\nB\n'
      return { result: 'ok' }
    })
    await $.tool.call({ tool: 'Edit', file_path: '/project/my dir/a.cls', old_string: 'b', new_string: 'B' } as any)
    const ui = await filesPane($)
    await ui.press({ key: 'files-open' })
    expect(argv).toEqual(['code', '-g', '/project/my dir/a.cls:2'])
  })
})
