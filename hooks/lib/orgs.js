// Org classification: pure, no I/O (Appendix A3).
//
// `sf org list --json --skip-connection-status` groups orgs as the CLI sees them:
// sandboxes, scratchOrgs, devHubs, other (plus a deprecated nonScratchOrgs that
// only repeats the rest and is ignored). Alias and username both lead to the
// same entry, in any letter case. Anything not listed is unknown, and the guard
// treats unknown like production.

// Keep only what the mod needs from one org: never tokens or URLs with secrets
export function slimOrg(o, group) {
  return {
    group,
    alias: o.alias ?? null,
    username: o.username ?? null,
    isSandbox: o.isSandbox === true,
    isScratch: o.isScratch === true,
    isDevHub: o.isDevHub === true,
    edition: o.orgEdition ?? null,
    apiVersion: o.instanceApiVersion ?? null,
    expirationDate: o.expirationDate ?? o.trailExpirationDate ?? null,
    isDefault: o.isDefaultUsername === true,
  }
}

// The org list result (its `result`) as a short list of slim orgs
export function slimOrgList(result) {
  const out = []
  for (const group of ['other', 'devHubs', 'sandboxes', 'scratchOrgs']) {
    for (const o of (result && result[group]) ?? []) out.push(slimOrg(o, group))
  }
  return out
}

function classOf(o) {
  if (o.group === 'scratchOrgs' || o.isScratch) return 'scratch'
  if (o.group === 'sandboxes' || o.isSandbox) return 'sandbox'
  return 'production' // `other` and `devHubs`: not a sandbox, not a scratch org
}

// slim list -> Map(lowercased alias or username -> { cls, alias, username, source, org })
export function classifyOrgs(slimList, { prodOrgs = [], safeOrgs = [] } = {}) {
  const map = new Map()
  const rank = { production: 0, sandbox: 1, scratch: 2 }
  for (const o of slimList ?? []) {
    const cls = classOf(o)
    const prev = (o.username && map.get(String(o.username).toLowerCase())) || null
    // the same org can show in two groups (a Dev Hub that is also in `other`): keep the most specific
    if (prev && rank[prev.cls] >= rank[cls]) continue
    const entry = { cls, alias: o.alias ?? prev?.alias ?? null, username: o.username ?? null, source: 'cli', org: o }
    for (const key of [entry.alias, entry.username]) if (key) map.set(String(key).toLowerCase(), entry)
  }
  // the person's own lists win, and apply to the alias and the username of the same org
  const force = (names, cls) => {
    for (const n of names) {
      if (!n) continue
      const hit = map.get(String(n).toLowerCase())
      const entry = hit ? { ...hit, cls, source: 'settings' } : { cls, alias: null, username: String(n), source: 'settings', org: null }
      for (const key of [entry.alias, entry.username, n]) if (key) map.set(String(key).toLowerCase(), entry)
    }
  }
  force(safeOrgs, 'sandbox')
  force(prodOrgs, 'production')
  return map
}

// Unknown means "we cannot tell", and the guard treats it like production
export function orgClass(map, name) {
  if (!name) return 'unknown'
  return map.get(String(name).toLowerCase())?.cls ?? 'unknown'
}

export function orgEntry(map, name) {
  if (!name) return null
  return map.get(String(name).toLowerCase()) ?? null
}

export const needsAsk = (cls) => cls !== 'sandbox' && cls !== 'scratch'

// Unique orgs in a map (each org once, whichever key reached it)
export function uniqueOrgs(map) {
  return [...new Set(map.values())]
}

// Days until a date (negative once past); null when unknown
export function daysUntil(date, now = Date.now()) {
  const t = Date.parse(date)
  if (!Number.isFinite(t)) return null
  return Math.floor((t - now) / 86400000)
}

// Compare API versions such as "62.0" and "61.0": >0 when a is newer
export function compareApi(a, b) {
  const x = Number.parseFloat(a)
  const y = Number.parseFloat(b)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return 0
  return x - y
}
