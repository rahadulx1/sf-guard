// Shell lines as the guard reads them: pure, no I/O.
//
// A line is split into simple commands (quote-aware), each simple command into
// words, and the words before the real command (VAR=value, env, sudo, npx …)
// are skipped, so `cd x && sf …`, `FOO=1 sf …` and `bash -c "sf …"` are all
// judged, while `echo "sf project deploy start"` is only text.

// Split a shell line into simple commands, aware of quotes (Appendix A2)
export function splitCommands(line) {
  const out = []
  let cur = ''
  let q = null
  const push = () => {
    if (cur.trim()) out.push(cur.trim())
    cur = ''
  }
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (q) {
      cur += c
      if (c === '\\' && q === '"') cur += line[++i] ?? ''
      else if (c === q) q = null
      continue
    }
    if (c === '\\') {
      cur += c + (line[++i] ?? '')
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      q = c
      cur += c
      continue
    }
    if (c === '\n' || c === ';') {
      push()
      continue
    }
    if (c === '&' || c === '|') {
      if (line[i + 1] === c) i++
      push()
      continue
    }
    cur += c
  }
  push()
  return out
}

// The text inside bash -c "…", sh -c '…', $(…) and `…`, so a wrapped command is not missed
export function innerScripts(cmd) {
  const found = []
  for (const m of cmd.matchAll(/\b(?:bash|sh|zsh|pwsh|powershell)(?:\.exe)?\s+(?:-l\s+)?-(?:l?c|Command)\s+("(?:[^"\\]|\\.)*"|'[^']*')/g)) {
    const body = m[1].slice(1, -1)
    found.push(m[1][0] === '"' ? body.replace(/\\(["\\$`])/g, '$1') : body)
  }
  for (const m of cmd.matchAll(/\$\(([^()]*)\)/g)) found.push(m[1])
  for (const m of cmd.matchAll(/`([^`]*)`/g)) found.push(m[1])
  return found
}

// Every simple command in a line, wrapped ones included (depth-limited)
export function allSimpleCommands(line, depth = 0) {
  const out = []
  for (const seg of splitCommands(line)) {
    out.push(seg)
    if (depth < 3) for (const inner of innerScripts(seg)) out.push(...allSimpleCommands(inner, depth + 1))
  }
  return out
}

// Words of one simple command, quotes removed. Redirections are dropped.
export function tokenize(simple) {
  const words = []
  let cur = ''
  let has = false
  let q = null
  for (let i = 0; i < simple.length; i++) {
    const c = simple[i]
    if (q) {
      if (c === q) q = null
      else if (c === '\\' && q === '"' && /["\\$`]/.test(simple[i + 1] ?? '')) cur += simple[++i]
      else cur += c
      continue
    }
    if (c === "'" || c === '"') {
      q = c
      has = true
      continue
    }
    if (c === '\\') {
      cur += simple[++i] ?? ''
      has = true
      continue
    }
    if (/\s/.test(c)) {
      if (has) words.push(cur)
      cur = ''
      has = false
      continue
    }
    cur += c
    has = true
  }
  if (has) words.push(cur)
  // drop redirections such as `> out.json`, `2>&1`
  const out = []
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    if (/^\d*>>?&?\d*$|^<$/.test(w)) {
      if (!/&\d$/.test(w)) i++
      continue
    }
    if (/^\d*>>?&?\S+$/.test(w) && !w.startsWith('-')) continue
    out.push(w)
  }
  return out
}

const PREFIXES = new Set(['sudo', 'env', 'time', 'nohup', 'command', 'exec', 'nice', 'npx', 'xargs', 'builtin', 'noglob'])

// The words from the real command on: skips VAR=value, env, sudo, npx and their flags
export function commandWords(words) {
  let i = 0
  while (i < words.length) {
    const w = words[i]
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) {
      i++
      continue
    }
    if (PREFIXES.has(w)) {
      i++
      while (i < words.length && words[i].startsWith('-')) i++
      continue
    }
    break
  }
  return words.slice(i)
}

// The program's base name: /usr/local/bin/sf, sf.cmd, C:\…\sf.exe -> sf
export function programName(word) {
  return String(word ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    .replace(/\.(cmd|exe|bat|ps1)$/i, '')
    .toLowerCase()
}

// The value of a flag in a word list: --target-org x, --target-org=x, -o x, -ox
export function flagValue(words, longs, shorts = []) {
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    for (const l of longs) {
      if (w === l) return words[i + 1] ?? null
      if (w.startsWith(l + '=')) return w.slice(l.length + 1)
    }
    for (const s of shorts) {
      if (w === s) return words[i + 1] ?? null
      if (w.startsWith(s + '=')) return w.slice(s.length + 1)
    }
  }
  return null
}

export function hasFlag(words, longs, shorts = []) {
  return words.some((w) => longs.some((l) => w === l || w.startsWith(l + '=')) || shorts.some((s) => w === s || w.startsWith(s + '=')))
}
