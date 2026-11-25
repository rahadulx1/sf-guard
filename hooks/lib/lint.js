const DIRECTIVE = /^\s*(eslint|prettier-ignore|istanbul|@ts-|@jest|NOPMD|sfca-)/

export function languageOf(path) {
  if (/\.(cls|trigger)$/.test(path)) return 'apex'
  if (/\/(lwc|aura)\/[^/]+\/[^/]+\.js$/.test(path)) return 'js'
  if (/\/(lwc|aura)\/[^/]+\/[^/]+\.(html|cmp)$/.test(path)) return 'html'
  return null
}

function lineAt(text, index) {
  let line = 1
  for (let i = 0; i < index; i++) if (text[i] === '\n') line++
  return line
}

export function scanSource(text, lang) {
  let code = ''
  const comments = []
  const quotes = lang === 'apex' ? "'" : lang === 'js' ? '\'"`' : ''
  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (lang === 'html') {
      if (text.startsWith('<!--', i)) {
        const end = text.indexOf('-->', i + 4)
        const stop = end < 0 ? text.length : end + 3
        comments.push({ index: i, text: text.slice(i + 4, end < 0 ? stop : end) })
        code += text.slice(i, stop).replace(/[^\n]/g, ' ')
        i = stop
        continue
      }
      code += c
      i++
      continue
    }
    if (c === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i)
      const stop = end < 0 ? text.length : end
      comments.push({ index: i, text: text.slice(i + 2, stop) })
      code += ' '.repeat(stop - i)
      i = stop
      continue
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      const stop = end < 0 ? text.length : end + 2
      comments.push({ index: i, text: text.slice(i + 2, end < 0 ? stop : end).replace(/^\*+/, '') })
      code += text.slice(i, stop).replace(/[^\n]/g, ' ')
      i = stop
      continue
    }
    if (quotes.includes(c)) {
      let j = i + 1
      while (j < text.length && text[j] !== c && (c === '`' || text[j] !== '\n')) j += text[j] === '\\' ? 2 : 1
      const stop = Math.min(text.length, j + 1)
      code += c + text.slice(i + 1, stop - 1).replace(/[^\n]/g, ' ') + (stop - 1 > i ? text[stop - 1] : '')
      i = stop
      continue
    }
    code += c
    i++
  }
  return { code, comments }
}

function matchingBrace(code, open) {
  let depth = 0
  for (let i = open; i < code.length; i++) {
    if (code[i] === '{') depth++
    else if (code[i] === '}' && --depth === 0) return i
  }
  return code.length
}

function loopBodies(code) {
  const bodies = []
  for (const m of code.matchAll(/\b(for|while)\s*\(/g)) {
    let depth = 0
    let i = m.index + m[0].length - 1
    for (; i < code.length; i++) {
      if (code[i] === '(') depth++
      else if (code[i] === ')' && --depth === 0) break
    }
    const rest = code.slice(i + 1)
    const lead = rest.match(/^\s*/)[0].length
    if (rest[lead] === ';') continue
    const start = i + 1 + lead
    bodies.push([start, code[start] === '{' ? matchingBrace(code, start) : code.indexOf(';', start)])
  }
  for (const m of code.matchAll(/\bdo\s*\{/g)) {
    const start = m.index + m[0].length - 1
    bodies.push([start, matchingBrace(code, start)])
  }
  return bodies
}

const SOQL = /\[\s*select\b|\bDatabase\.(query|queryWithBinds|getQueryLocator)\s*\(/gi
const DML = /\b(insert|update|upsert|delete|undelete|merge)\s+(?!=)[A-Za-z_(\[]|\bDatabase\.(insert|update|upsert|delete|undelete|merge)\s*\(/gi
const RECORD_ID = /'([0a][0-9A-Za-z]{4}0{3,}[0-9A-Za-z]+)'/g

export function lintSource(path, text, { noComments = false } = {}) {
  const lang = languageOf(path)
  if (!lang || typeof text !== 'string') return []
  const { code, comments } = scanSource(text, lang)
  const out = []
  const add = (index, rule, problem) => out.push({ line: lineAt(text, index), rule, problem })
  if (noComments) {
    for (const c of comments) if (!DIRECTIVE.test(c.text)) add(c.index, 'no-comments', 'Comment in code: your coding standards allow none')
  }
  if (lang !== 'apex') return out
  const bodies = loopBodies(code)
  const inLoop = (index) => bodies.some(([s, e]) => index >= s && index < e)
  for (const m of code.matchAll(SOQL)) if (inLoop(m.index)) add(m.index, 'soql-in-loop', 'SOQL inside a loop: query once before the loop')
  for (const m of code.matchAll(DML)) if (inLoop(m.index)) add(m.index, 'dml-in-loop', 'DML inside a loop: collect records and run one DML after the loop')
  for (const m of text.matchAll(RECORD_ID)) if (m[1].length === 15 || m[1].length === 18) add(m.index, 'hardcoded-id', 'Hard-coded record id ' + m[1])
  const isTest = /@\s*isTest\b/i.test(code)
  const declaration = code.match(/^[ \t]*(?:(?:public|global|private)\s+)?(?:(?:virtual|abstract|with sharing|without sharing|inherited sharing)\s+)*class\s+\w+/im)
  if (declaration && !isTest && path.endsWith('.cls') && !/sharing/i.test(declaration[0])) {
    add(declaration.index, 'sharing', 'Class without a sharing keyword: add with sharing, inherited sharing or without sharing')
  }
  if (!isTest) for (const m of code.matchAll(/\bSystem\.debug\s*\(/g)) add(m.index, 'debug', 'System.debug left in code')
  return out.sort((a, b) => a.line - b.line)
}

function splitTopLevel(list) {
  const parts = []
  let depth = 0
  let cur = ''
  for (const c of list) {
    if (c === '(') depth++
    if (c === ')') depth--
    if (c === ',' && depth === 0) {
      parts.push(cur)
      cur = ''
    } else cur += c
  }
  parts.push(cur)
  return parts
}

function selectList(code, from) {
  let depth = 0
  for (let i = from; i < code.length; i++) {
    if (code[i] === '(') depth++
    else if (code[i] === ')') depth--
    else if (code[i] === ']' && depth === 0) return null
    else if (depth === 0 && /\s/.test(code[i - 1]) && /^from\s+(\w+)/i.test(code.slice(i, i + 80))) {
      return { list: code.slice(from, i), object: code.slice(i).match(/^from\s+(\w+)/i)[1] }
    }
  }
  return null
}

export function soqlFields(path, text) {
  if (languageOf(path) !== 'apex' || typeof text !== 'string') return []
  const { code } = scanSource(text, 'apex')
  const out = []
  for (const m of code.matchAll(/\[\s*select\s+/gi)) {
    const listStart = m.index + m[0].length
    const query = selectList(code, listStart)
    if (!query) continue
    let offset = 0
    for (const part of splitTopLevel(query.list)) {
      const name = part.trim()
      const at = listStart + offset + part.indexOf(name)
      offset += part.length + 1
      if (/^\w+$/.test(name)) out.push({ object: query.object, field: name, line: lineAt(text, at) })
    }
  }
  return out
}

export function componentOf(path) {
  const p = path.replace(/\\/g, '/')
  const apex = p.match(/\/classes\/([^/]+)\.cls(?:-meta\.xml)?$/)
  if (apex) return { kind: 'class', name: apex[1] }
  const trigger = p.match(/\/triggers\/([^/]+)\.trigger(?:-meta\.xml)?$/)
  if (trigger) return { kind: 'trigger', name: trigger[1] }
  const lwc = p.match(/^(.*\/lwc\/([^/]+))\//)
  if (lwc) return { kind: 'lwc', name: lwc[2], folder: lwc[1] }
  return null
}

export function namingProblem(kind, name, prefix) {
  if (!prefix || !name) return null
  const label = kind === 'class' ? 'Apex classes' : kind === 'trigger' ? 'Apex triggers' : 'Lightning Web Components'
  const lead = kind === 'lwc' ? prefix.toLowerCase() + '_' : prefix + '_'
  const rest = name.startsWith(lead) ? name.slice(lead.length) : name.replace(/^[A-Za-z0-9]+_(?=.)/, (p) => (p.toLowerCase() === lead.toLowerCase() ? '' : p))
  const fixed = lead + (kind === 'lwc' ? rest.charAt(0).toLowerCase() : rest.charAt(0).toUpperCase()) + rest.slice(1)
  const shape = kind === 'lwc' ? /^[a-z]/ : /^[A-Z]/
  if (name.startsWith(lead) && shape.test(rest) && !name.includes('__') && !name.endsWith('_')) return null
  const example = fixed.replace(/_{2,}/g, '_').replace(/_$/, '')
  return 'New ' + label + ' must be named with the ' + lead + ' prefix, without double or trailing underscores. Rename ' + name + ' to ' + example + '.'
}
