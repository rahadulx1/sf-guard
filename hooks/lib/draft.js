// Live typing: read a file tool's arguments while the model is still writing them.
// Pure, no I/O. The `turn.step` hook feeds every chunk to `ingest` and yields the
// chunk on unchanged; the Files pane reads `list()` when it draws.

// ── Read one string field out of a PARTIAL JSON object (Appendix A1) ──
// Never returns half a character: a cut escape or a lone surrogate half waits
// for the next piece.
export function readStringField(partial, key, from = 0) {
  const re = new RegExp('"' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"\\s*:\\s*"', 'g')
  re.lastIndex = from
  const m = re.exec(partial)
  if (!m) return { found: false, text: '', done: false, end: from }
  let out = ''
  let i = m.index + m[0].length
  for (; i < partial.length; i++) {
    const c = partial[i]
    if (c === '"') return { found: true, text: out, done: true, end: i + 1 }
    if (c !== '\\') {
      out += c
      continue
    }
    const n = partial[i + 1]
    if (n === undefined) break // a lone backslash at the end: wait for the next piece
    if (n === 'u') {
      const hex = partial.slice(i + 2, i + 6)
      if (hex.length < 4) break // \uXX cut off: wait
      const code = parseInt(hex, 16)
      i += 5
      // a high surrogate needs its low half; wait for it rather than emit half a character
      if (code >= 0xd800 && code <= 0xdbff) {
        const lo = partial.slice(i + 1, i + 7)
        if (!/^\\u[dD][c-fC-F][0-9a-fA-F]{2}$/.test(lo)) {
          if (lo.length < 6) {
            i -= 5
            break
          }
        } else {
          out += String.fromCharCode(code, parseInt(lo.slice(2), 16))
          i += 6
          continue
        }
      }
      out += String.fromCharCode(code)
      continue
    }
    out += { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/' }[n] ?? n
    i += 1
  }
  // a raw (unescaped) character cut between its two halves: wait for the low half
  const last = out.charCodeAt(out.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1)
  return { found: true, text: out, done: false, end: partial.length }
}

// Every value of a key in order (for `edits[]`: several old_string/new_string pairs)
export function readAllStringFields(partial, key) {
  const out = []
  let from = 0
  for (;;) {
    const r = readStringField(partial, key, from)
    if (!r.found) break
    out.push(r)
    if (!r.done) break
    from = r.end
  }
  return out
}

export const DEFAULT_RAW_CAP = 200 * 1024

// Decode what a block's raw JSON says so far
export function decodeDraft(raw) {
  const path = readStringField(raw, 'file_path')
  const nb = path.found ? path : readStringField(raw, 'notebook_path')
  const content = readStringField(raw, 'content')
  const oldS = readAllStringFields(raw, 'old_string')
  const newS = readAllStringFields(raw, 'new_string')
  const hasEdits = /"edits"\s*:\s*\[/.test(raw)
  let kind = 'unknown'
  if (oldS.length || newS.length) kind = hasEdits ? 'multi-edit' : 'edit'
  else if (content.found) kind = 'write'
  else if (nb.found) kind = 'path-only'
  return {
    path: nb.done ? nb.text : null,
    partialPath: nb.found && !nb.done ? nb.text : null,
    kind,
    text: content.found ? content.text : '',
    textDone: content.done,
    edits: oldS.map((o, i) => ({ oldText: o.text, newText: newS[i]?.text ?? '', done: !!newS[i]?.done })),
  }
}

// The reducer: chunks in, drafts out
export function createDrafts({ cap = DEFAULT_RAW_CAP, now = () => Date.now() } = {}) {
  const blocks = new Map() // step key + index -> tool use id
  const drafts = new Map() // tool use id -> draft
  let dirty = false

  const stepKey = (e) => (e?.agentId ?? 'main') + ':' + (e?.turnId ?? '') + ':' + (e?.index ?? 0)

  function ingest(chunk, stepInput) {
    if (!chunk || typeof chunk !== 'object') return
    const key = stepKey(stepInput)
    if (chunk.kind === 'tool') {
      const name = String(chunk.name ?? '')
      if (name.startsWith('mcp__')) return
      blocks.set(key + ':' + chunk.index, chunk.id)
      drafts.set(chunk.id, {
        id: chunk.id,
        tool: name,
        agentId: stepInput?.agentId ?? null,
        raw: '',
        capped: false,
        path: null,
        kind: 'unknown',
        text: '',
        edits: [],
        startedAt: now(),
        lastDecodeAt: 0,
        decodedLen: -1,
        state: 'drafting',
        endedAt: null,
        streamDone: false,
      })
      dirty = true
      return
    }
    if (chunk.kind === 'input') {
      const id = blocks.get(key + ':' + chunk.index)
      const d = id && drafts.get(id)
      if (!d || d.capped || d.state !== 'drafting') return
      const piece = String(chunk.json ?? '')
      if (d.raw.length + piece.length > cap) {
        d.raw += piece.slice(0, Math.max(0, cap - d.raw.length))
        d.capped = true
      } else d.raw += piece
      dirty = true
      return
    }
    if (chunk.kind === 'stop') {
      for (const [k, id] of blocks) {
        if (!k.startsWith(key + ':')) continue
        const d = drafts.get(id)
        if (d) d.streamDone = true
        blocks.delete(k)
      }
      dirty = true
    }
  }

  // Decode a draft only when it grew since the last decode (called from the draw timer)
  function decode(d) {
    if (d.decodedLen === d.raw.length) return d
    const r = decodeDraft(d.raw)
    d.path = r.path ?? d.path
    d.partialPath = r.partialPath
    d.kind = r.kind
    d.text = r.text
    d.edits = r.edits
    d.decodedLen = d.raw.length
    d.lastDecodeAt = now()
    return d
  }

  // Only drafts that look like file tools: a path, or text, or edits
  function isFileDraft(d) {
    return d.kind !== 'unknown' || !!d.path || /"(file_path|notebook_path)"/.test(d.raw)
  }

  return {
    ingest,
    decode,
    get(id) {
      return drafts.get(id) ?? null
    },
    list() {
      const out = []
      for (const d of drafts.values()) {
        decode(d)
        if (isFileDraft(d)) out.push(d)
      }
      return out
    },
    markWriting(id) {
      const d = drafts.get(id)
      if (d && d.state === 'drafting') {
        d.state = 'writing'
        dirty = true
      }
      return d ?? null
    },
    markCommitted(id) {
      const d = drafts.get(id)
      if (!d) return null
      decode(d)
      d.state = 'committed'
      d.endedAt = now()
      drafts.delete(id)
      dirty = true
      return d
    },
    markDiscarded(id) {
      const d = drafts.get(id)
      if (!d) return null
      decode(d)
      d.state = 'discarded'
      d.endedAt = now()
      d.raw = '' // drafts stay in memory only; drop the text once it is not needed
      d.decodedLen = 0
      dirty = true
      return d
    },
    // At turn end or an interrupt: everything not already applied is discarded
    discardAll() {
      for (const d of drafts.values()) {
        if (d.state === 'drafting' || d.state === 'writing') {
          decode(d)
          d.state = 'discarded'
          d.endedAt = now()
          d.raw = ''
          d.decodedLen = 0
        }
      }
      blocks.clear()
      dirty = true
    },
    // Forget discarded rows after a few seconds
    sweep(keepMs = 4000) {
      const t = now()
      for (const [id, d] of drafts) if (d.state === 'discarded' && t - (d.endedAt ?? t) > keepMs) drafts.delete(id)
    },
    clear() {
      drafts.clear()
      blocks.clear()
      dirty = true
    },
    takeDirty() {
      const was = dirty
      dirty = false
      return was
    },
    get size() {
      return drafts.size
    },
  }
}

// The last line number and the tail of a draft's text, for a tail-following view
export function tailLines(text, rows) {
  const lines = text.split('\n')
  const first = Math.max(0, lines.length - rows)
  return { first: first + 1, lines: lines.slice(first), total: lines.length }
}
