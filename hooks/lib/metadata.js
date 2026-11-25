import { flagValue } from './shell.js'

const FOLDER_TYPES = [
  [/\/classes\/([^/]+)\.cls(-meta\.xml)?$/, 'ApexClass'],
  [/\/triggers\/([^/]+)\.trigger(-meta\.xml)?$/, 'ApexTrigger'],
  [/\/pages\/([^/]+)\.page(-meta\.xml)?$/, 'ApexPage'],
  [/\/components\/([^/]+)\.component(-meta\.xml)?$/, 'ApexComponent'],
  [/\/lwc\/([^/]+)\//, 'LightningComponentBundle'],
  [/\/aura\/([^/]+)\//, 'AuraDefinitionBundle'],
  [/\/permissionsets\/([^/]+)\.permissionset-meta\.xml$/, 'PermissionSet'],
  [/\/profiles\/([^/]+)\.profile-meta\.xml$/, 'Profile'],
  [/\/flows\/([^/]+)\.flow-meta\.xml$/, 'Flow'],
  [/\/layouts\/([^/]+)\.layout-meta\.xml$/, 'Layout'],
  [/\/tabs\/([^/]+)\.tab-meta\.xml$/, 'CustomTab'],
  [/\/staticresources\/([^/.]+)\./, 'StaticResource'],
]

export function memberOf(path) {
  const p = '/' + String(path).replace(/\\/g, '/').replace(/^\/+/, '')
  const field = p.match(/\/objects\/([^/]+)\/fields\/([^/]+)\.field-meta\.xml$/)
  if (field) return { type: 'CustomField', name: field[1] + '.' + field[2] }
  const object = p.match(/\/objects\/([^/]+)\/\1\.object-meta\.xml$/)
  if (object) return { type: 'CustomObject', name: object[1] }
  for (const [re, type] of FOLDER_TYPES) {
    const m = p.match(re)
    if (m) return { type, name: m[1] }
  }
  return null
}

function escapeXml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function manifestXml(members, apiVersion) {
  const byType = new Map()
  for (const m of members) byType.set(m.type, [...(byType.get(m.type) ?? []), m.name])
  const types = [...byType]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([type, names]) => '    <types>\n' + [...new Set(names)].sort().map((n) => '        <members>' + escapeXml(n) + '</members>\n').join('') + '        <name>' + type + '</name>\n    </types>\n')
    .join('')
  return '<?xml version="1.0" encoding="UTF-8"?>\n<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n' + types + '    <version>' + apiVersion + '</version>\n</Package>\n'
}

export function deployScope(words) {
  const all = (longs, shorts) => {
    const out = []
    for (let i = 0; i < words.length; i++) {
      const w = words[i]
      if (longs.includes(w) || shorts.includes(w)) {
        for (let j = i + 1; j < words.length && !words[j].startsWith('-'); j++) out.push(words[j])
      } else {
        const long = longs.find((l) => w.startsWith(l + '='))
        if (long) out.push(w.slice(long.length + 1))
      }
    }
    return out
  }
  return {
    sourceDirs: all(['--source-dir'], ['-d']),
    metadata: all(['--metadata'], ['-m']),
    manifest: flagValue(words, ['--manifest'], ['-x']),
  }
}

export function scopeCovers(scope, rel, member) {
  if (!scope.sourceDirs.length && !scope.metadata.length && !scope.manifest) return true
  if (scope.manifest) return true
  const p = rel.replace(/\\/g, '/')
  if (scope.sourceDirs.some((d) => p === d.replace(/^\.\//, '').replace(/\/$/, '') || p.startsWith(d.replace(/^\.\//, '').replace(/\/$/, '') + '/'))) return true
  return !!member && scope.metadata.some((m) => m === member.type || m === member.type + ':' + member.name || m === member.type + ':*')
}

export function retrieveArgs(scope, packageDirs, outDir, org) {
  const argv = ['sf', 'project', 'retrieve', 'start', '--target-metadata-dir', outDir, '--unzip', '--wait', '9', '--json']
  if (org) argv.push('-o', org)
  if (scope.manifest) return [...argv, '--manifest', scope.manifest]
  if (scope.metadata.length) return [...argv, ...scope.metadata.flatMap((m) => ['--metadata', m])]
  return [...argv, ...(scope.sourceDirs.length ? scope.sourceDirs : packageDirs).flatMap((d) => ['--source-dir', d])]
}

export function typeFolderTail(path) {
  const p = String(path).replace(/\\/g, '/')
  const m = p.match(/(?:^|\/)((?:classes|triggers|pages|components|lwc|aura|permissionsets|profiles|flows|layouts|tabs|objects|staticresources)\/.+)$/)
  return m ? m[1] : null
}

export function sameText(a, b) {
  const clean = (t) => String(t ?? '').replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trimEnd()
  return clean(a) === clean(b)
}
