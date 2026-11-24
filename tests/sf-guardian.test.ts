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
function project(on: any, disk: Record<string, string>, opts: { cwd?: string; git?: string | null } = {}) {
  const cwd = opts.cwd ?? '/project'
  const mtime: Record<string, number> = {}
  let clock = 1
  const touch = (p: string) => (mtime[p] = ++clock)
  for (const p of Object.keys(disk)) touch(p)
  const state = { porcelain: '', recent: [] as string[], head: {} as Record<string, string> }
  on('session.cwd', () => ({ value: cwd }))
  on('env.get', () => ({ value: '/Users/me' }))
  on('fs.exists', ($$: any, e: any) => ({ value: e.path in disk }))
  on('fs.read', ($$: any, e: any) => {
    if (!(e.path in disk)) throw new Error('ENOENT: ' + e.path)
    return { value: disk[e.path] }
  })
  on('fs.stat', ($$: any, e: any) => {
    if (!(e.path in disk)) throw new Error('ENOENT: ' + e.path)
    return { value: { kind: 'file', size: disk[e.path].length, mtimeMs: mtime[e.path] ?? 0, isLink: false } }
  })
  on('process.run', ($$: any, e: any) => {
    const argv = e.argv.join(' ')
    const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '' } })
    if (argv.includes('rev-parse')) {
      return opts.git === null || opts.git === undefined
        ? { value: { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository' } }
        : ok(opts.git + '\n')
    }
    if (argv.includes(' status ')) return ok(state.porcelain)
    const show = argv.match(/ show HEAD:(.+)$/)
    if (show) return show[1] in state.head ? ok(state.head[show[1]]) : { value: { exitCode: 128, stdout: '', stderr: 'no' } }
    if (argv.startsWith('touch')) return ok('')
    if (argv.startsWith('find') && argv.includes('-newer')) return ok(state.recent.join('\n'))
    if (argv.startsWith('find')) return ok(Object.keys(disk).join('\n'))
    if (argv.startsWith('sf config get')) return ok('{"result":[{"value":"uat"}]}')
    return { value: { exitCode: 1, stdout: '', stderr: 'not stubbed: ' + argv } }
  })
  on('session.start', ($$: any, e: any) => ({ ...e }))
  on('command.register', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
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
