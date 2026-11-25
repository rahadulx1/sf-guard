export const POLICY_FILE = '.sfguard.json'

const list = (value) =>
  (Array.isArray(value) ? value : String(value ?? '').split(','))
    .map((x) => String(x).trim().toLowerCase())
    .filter(Boolean)

export function parsePolicy(text) {
  const j = JSON.parse(text)
  if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error(POLICY_FILE + ' must hold a JSON object')
  return j
}

export function mergePolicy(personal, team) {
  if (!team) return { ...personal }
  const out = { ...personal }
  out.prodOrgs = [...new Set([...personal.prodOrgs, ...list(team.prod_orgs)])]
  if (team.guard_mode === 'block') out.guardMode = 'block'
  if (team.guard_scripts === true) out.guardScripts = true
  if (team.guard_mcp === true) out.guardMcp = true
  if (team.allow_secret_commands === false) out.allowSecretCommands = false
  if (team.coding_standards === true) out.codingStandards = true
  if (team.code_checks === true) out.codeChecks = true
  if (team.backup_before_deploy === true) out.backupBeforeDeploy = true
  if (team.audit_log === true) out.auditLog = true
  if (typeof team.name_prefix === 'string' && team.name_prefix.trim()) out.namePrefix = team.name_prefix
  return out
}

export function policySummary(team) {
  if (!team) return 'none'
  const parts = []
  if (list(team.prod_orgs).length) parts.push('production orgs ' + list(team.prod_orgs).join(', '))
  if (team.guard_mode === 'block') parts.push('guard mode block')
  if (typeof team.name_prefix === 'string' && team.name_prefix.trim()) parts.push('name prefix ' + team.name_prefix.trim())
  for (const key of ['guard_scripts', 'guard_mcp', 'coding_standards', 'code_checks', 'backup_before_deploy', 'audit_log']) if (team[key] === true) parts.push(key)
  if (team.allow_secret_commands === false) parts.push('no secret commands')
  return parts.join(' · ') || 'nothing that changes your settings'
}
