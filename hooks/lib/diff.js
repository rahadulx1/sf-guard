// Line diffs for the Files pane: pure, no I/O.

export const MAX_DIFF_CHARS = 40000

export function splitLines(text) {
  if (!text) return []
  const lines = text.split(/\r?\n/)
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

// Line diff: trim the common head and tail, then an LCS over what is left
export function diffLines(a, b) {
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
export function unifiedDiff(before, after, context = 3) {
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
