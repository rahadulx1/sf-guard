export const RISKY_USER_PERMISSIONS = new Set([
  'ModifyAllData',
  'ViewAllData',
  'ModifyMetadata',
  'ManageUsers',
  'ManageInternalUsers',
  'ManageProfilesPermissionsets',
  'AssignPermissionSets',
  'ManageRoles',
  'ManageSharing',
  'ResetPasswords',
  'AuthorApex',
  'CustomizeApplication',
  'ViewAllUsers',
  'ManageAuthProviders',
  'ManageEncryptionKeys',
  'ManageDataIntegrations',
])

const OBJECT_FLAGS = [
  ['allowRead', 'Read'],
  ['allowCreate', 'Create'],
  ['allowEdit', 'Edit'],
  ['allowDelete', 'Delete'],
  ['viewAllRecords', 'View All'],
  ['modifyAllRecords', 'Modify All'],
]

export function isPermissionFile(path) {
  return /\.(profile|permissionset)-meta\.xml$/.test(path)
}

function blocks(xml, tag) {
  return [...String(xml ?? '').matchAll(new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>', 'g'))].map((m) => m[1])
}

function value(block, tag) {
  return (block.match(new RegExp('<' + tag + '>([^<]*)</' + tag + '>')) ?? [])[1] ?? null
}

export function parsePermissions(xml) {
  const grants = new Set()
  for (const b of blocks(xml, 'userPermissions')) if (value(b, 'enabled') === 'true') grants.add('user:' + value(b, 'name'))
  for (const b of blocks(xml, 'objectPermissions')) {
    for (const [flag, label] of OBJECT_FLAGS) if (value(b, flag) === 'true') grants.add('object:' + value(b, 'object') + ':' + label)
  }
  for (const b of blocks(xml, 'fieldPermissions')) {
    if (value(b, 'readable') === 'true') grants.add('field:' + value(b, 'field') + ':Read')
    if (value(b, 'editable') === 'true') grants.add('field:' + value(b, 'field') + ':Edit')
  }
  return grants
}

function describe(grant) {
  const [kind, name, level] = grant.split(':')
  if (kind === 'user') return { text: name, risky: RISKY_USER_PERMISSIONS.has(name) }
  if (kind === 'object') return { text: level + ' on ' + name, risky: level === 'View All' || level === 'Modify All' }
  return { text: level + ' on field ' + name, risky: false }
}

export function permissionChanges(before, after) {
  const was = parsePermissions(before)
  const now = parsePermissions(after)
  const out = []
  for (const g of now) if (!was.has(g)) out.push({ ...describe(g), added: true })
  for (const g of was) if (!now.has(g)) out.push({ ...describe(g), risky: false, added: false })
  return out
}
