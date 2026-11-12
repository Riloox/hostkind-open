'use strict';

/*
 * The complete Hostkind command catalog.
 *
 * Every action is a thin description of one panel endpoint: method, path, the
 * positionals it consumes, and the safety metadata the dispatcher needs
 * (server scope, confirmation, preview token, upload field, download).
 *
 * Endpoints that take a body accept arbitrary `--flags` (kebab-case is mapped
 * to camelCase) and `--data '<json>'` for nested payloads. That keeps this file
 * declarative without freezing every route's body schema.
 */

function cmd(group, action, method, path, summary, extra = {}) {
  return { group, action, method, path, summary, ...extra };
}

const COMMANDS = [
  /* ---------------------------------------------------------------- auth */
  cmd('auth', 'mode', 'GET', '/api/auth-mode', 'Show whether sign-in is required and the panel branding', { public: true, serverScoped: false }),
  cmd('auth', 'whoami', 'GET', '/api/me', 'Show the signed-in principal and permissions', { aliases: ['whoami'], serverScoped: false }),
  cmd('auth', 'modules', 'GET', '/api/modules', 'List supported game modules and capabilities', { aliases: ['modules'], serverScoped: false }),
  cmd('auth', 'foundation', 'GET', '/api/foundation/status', 'Diagnose the database foundation (admin)', { serverScoped: false }),

  /* --------------------------------------------------------------- panel */
  cmd('panel', 'config', 'GET', '/api/config', 'Read panel configuration without secrets', { serverScoped: false }),
  cmd('panel', 'set-backups', 'PUT', '/api/config/backups', 'Update backup retention settings', { serverScoped: false }),
  cmd('panel', 'set-auth', 'PUT', '/api/config/auth', 'Turn password sign-in on or off', { serverScoped: false }),
  cmd('panel', 'set-watchdog', 'PUT', '/api/config/watchdog', 'Update crash-loop watchdog settings', { serverScoped: false }),
  cmd('panel', 'set-accents', 'PUT', '/api/config/game-accents', 'Update per-game accent colors', { serverScoped: false }),
  cmd('panel', 'fs', 'GET', '/api/fs', 'Browse host folders for server registration', { serverScoped: false }),
  cmd('panel', 'pick-folder', 'GET', '/api/pick-folder', 'Open the native OS folder picker', { serverScoped: false }),
  cmd('panel', 'system', 'GET', '/api/system', 'Point-in-time host and process snapshot', { serverScoped: false }),
  cmd('panel', 'metrics', 'GET', '/api/metrics', 'Bounded metric history for one server', { serverScoped: false }),

  /* --------------------------------------------------- application update */
  cmd('application-update', 'status', 'GET', '/api/application-update/status', 'Read Hostkind update status', { serverScoped: false }),
  cmd('application-update', 'check', 'POST', '/api/application-update/check', 'Check for a new Hostkind release', { serverScoped: false }),
  cmd('application-update', 'download', 'POST', '/api/application-update/download', 'Download and stage a Hostkind release', { serverScoped: false, long: true }),
  cmd('application-update', 'install', 'POST', '/api/application-update/install', 'Install the staged Hostkind release', { serverScoped: false, confirm: true, body: { approved: true } }),

  /* -------------------------------------------------------- bug reports */
  cmd('bug-reports', 'create', 'POST', '/api/bug-reports', 'Create a bug report', { serverScoped: false }),
  cmd('bug-reports', 'get', 'GET', '/api/bug-reports/:id', 'Read one bug report', { args: ['id'], serverScoped: false }),
  cmd('bug-reports', 'config', 'PUT', '/api/config/bug-reports', 'Update bug-report settings', { serverScoped: false }),

  /* ---------------------------------------------------------------- me */
  cmd('me', 'get', 'GET', '/api/me', 'Show the current profile', { serverScoped: false }),
  cmd('me', 'update', 'PUT', '/api/me', 'Edit the current profile', { serverScoped: false }),
  cmd('me', 'password', 'PUT', '/api/me/password', 'Change the current password', { serverScoped: false, confirm: true }),
  cmd('me', 'language', 'PUT', '/api/me/language', 'Set the account language', { serverScoped: false }),
  cmd('me', 'terms', 'PUT', '/api/me/terms', 'Accept a Terms of Use version', { serverScoped: false }),

  /* ------------------------------------------------------------- servers */
  cmd('servers', 'list', 'GET', '/api/servers', 'List registered servers', { aliases: ['servers'], serverScoped: false }),
  cmd('servers', 'add', 'POST', '/api/servers', 'Register a server', { serverScoped: false }),
  cmd('servers', 'update', 'PUT', '/api/servers/:id', 'Edit a registered server', { args: ['id'], serverScoped: false }),
  cmd('servers', 'map', 'PUT', '/api/servers/:id/map', 'Update only a server map URL', { args: ['id'], serverScoped: false }),
  cmd('servers', 'remove', 'DELETE', '/api/servers/:id', 'Remove a server (optionally trash its files)', { args: ['id'], serverScoped: false, queryFlags: true, confirm: true }),
  cmd('servers', 'select', 'POST', '/api/active', 'Switch the panel-wide active server', { args: ['serverId'], serverScoped: false, bodyArgs: ['serverId'] }),
  cmd('servers', 'status', 'GET', '/api/status', 'Read active-server status', { serverScoped: false }),
  cmd('servers', 'start', 'POST', '/api/servers/:id/start', 'Start one server', { args: ['id'], serverScoped: false }),
  cmd('servers', 'stop', 'POST', '/api/servers/:id/stop', 'Stop one server', { args: ['id'], serverScoped: false }),
  cmd('servers', 'restart', 'POST', '/api/servers/:id/restart', 'Restart one server', { args: ['id'], serverScoped: false }),
  cmd('servers', 'command', 'POST', '/api/command', 'Run one console line on the selected server', { aliases: ['rcon'], bodyArgs: ['cmd'], joinRest: true }),
  cmd('servers', 'active-start', 'POST', '/api/server/start', 'Start the active server', { serverScoped: false }),
  cmd('servers', 'active-stop', 'POST', '/api/server/stop', 'Stop the active server', { serverScoped: false }),
  cmd('servers', 'active-restart', 'POST', '/api/server/restart', 'Restart the active server', { serverScoped: false }),
  cmd('servers', 'versions', 'GET', '/api/create/versions', 'List installable versions for a server type', { serverScoped: false, long: true }),
  cmd('servers', 'defaults', 'GET', '/api/create/defaults', 'Show the default server parent folder', { serverScoped: false }),
  cmd('servers', 'create', 'POST', '/api/create', 'Create and install a server (NDJSON progress)', { serverScoped: false, ndjson: true, confirm: true, bodyFromFlags: minecraftCreateBody }),
  cmd('servers', 'clone-preview', 'POST', '/api/servers/:id/clone-preview', 'Preview cloning a server', { args: ['id'], serverScoped: false }),
  cmd('servers', 'clone', 'POST', '/api/servers/:id/clone', 'Clone a server into a new folder', { args: ['id'], serverScoped: false, confirm: true, wait: true }),

  /* ------------------------------------------------------------- console */
  cmd('console', 'run', 'POST', '/api/command', 'Run one console command', { bodyArgs: ['cmd'], joinRest: true, aliases: ['command'], examples: ['hostkind console run say Restarting in 5 minutes --server survival'] }),

  /* ------------------------------------------------------------- players */
  cmd('players', 'online', 'GET', '/api/players', 'List online Minecraft players'),
  cmd('players', 'lookup', 'GET', '/api/players/lookup', 'Resolve a Minecraft name through Mojang', { args: ['name'], queryArgs: ['name'] }),
  cmd('players', 'lists', 'GET', '/api/playerlists', 'Show whitelist, ops, bans, and recent players'),
  cmd('players', 'action', 'POST', '/api/players/:action', 'Run a raw Minecraft player console action', { args: ['action'], bodyArgs: ['name'] }),
  cmd('players', 'kick', 'POST', '/api/players/kick', 'Kick an online player', { bodyArgs: ['name'] }),
  cmd('players', 'ban', 'POST', '/api/playerlists/ban/add', 'Ban a player (online or offline)', { bodyArgs: ['name'], confirm: true }),
  cmd('players', 'pardon', 'POST', '/api/playerlists/ban/remove', 'Pardon a banned player', { bodyArgs: ['name'] }),
  cmd('players', 'op', 'POST', '/api/playerlists/op/add', 'Grant operator status', { bodyArgs: ['name'], confirm: true }),
  cmd('players', 'deop', 'POST', '/api/playerlists/op/remove', 'Remove operator status', { bodyArgs: ['name'], confirm: true }),
  cmd('players', 'whitelist-add', 'POST', '/api/playerlists/whitelist/add', 'Add a player to the whitelist', { bodyArgs: ['name'] }),
  cmd('players', 'whitelist-remove', 'POST', '/api/playerlists/whitelist/remove', 'Remove a player from the whitelist', { bodyArgs: ['name'] }),
  cmd('players', 'list-edit', 'POST', '/api/playerlists/:kind/:op', 'Add or remove a whitelist, op, or ban entry', { args: ['kind', 'op'], bodyArgs: ['name'] }),
  cmd('players', 'whitelist', 'POST', '/api/whitelist/toggle', 'Turn the whitelist on or off', { args: ['state'], bodyFromFlags: (flags, ctx) => ({ enabled: String(ctx.args[0] || '').toLowerCase() === 'on' || flags.enabled === true }) }),

  /* --------------------------------------------------------------- worlds */
  cmd('worlds', 'list', 'GET', '/api/worlds', 'List worlds and recent world operations'),
  cmd('worlds', 'import-preview', 'POST', '/api/worlds/import/preview', 'Preview importing a world archive', { upload: { field: 'file', multiple: false } }),
  cmd('worlds', 'import', 'POST', '/api/worlds/import', 'Import a world archive', { upload: { field: 'file', multiple: false }, confirm: true, wait: true, preview: { path: '/api/worlds/import/preview', tokenPath: 'preview.token' } }),
  cmd('worlds', 'clone', 'POST', '/api/worlds/:id/clone', 'Clone a world', { args: ['id'], confirm: true, wait: true, preview: { path: '/api/worlds/:id/clone', body: { preview: true }, tokenPath: 'preview.token' } }),
  cmd('worlds', 'archive', 'POST', '/api/worlds/:id/archive', 'Archive and remove a world', { args: ['id'], confirm: true, wait: true, preview: { path: '/api/worlds/:id/archive', body: { preview: true }, noToken: true } }),
  cmd('worlds', 'download', 'GET', '/api/worlds/:id/download', 'Download a world as a zip', { args: ['id'], download: true }),
  cmd('worlds', 'delete-preview', 'POST', '/api/worlds/:id/delete/preview', 'Preview deleting a world', { args: ['id'] }),
  cmd('worlds', 'delete', 'DELETE', '/api/worlds/:id', 'Delete a world', { examples: ['hostkind worlds delete world --preview', 'hostkind worlds delete world --yes --wait'], args: ['id'], confirm: true, wait: true, preview: { path: '/api/worlds/:id/delete/preview', tokenPath: 'preview.token' } }),
  cmd('worlds', 'pregenerate-preview', 'POST', '/api/worlds/:id/pregenerate/preview', 'Preview Chunky world pre-generation', { args: ['id'] }),
  cmd('worlds', 'pregenerate', 'POST', '/api/worlds/:id/pregenerate', 'Pre-generate a world with Chunky', { args: ['id'], confirm: true, wait: true, body: { consent: true }, preview: { path: '/api/worlds/:id/pregenerate/preview', tokenPath: 'preview.token' } }),

  /* -------------------------------------------------------------- backups */
  cmd('backups', 'list', 'GET', '/api/backups', 'List backups for the selected server'),
  cmd('backups', 'create', 'POST', '/api/backups', 'Create a backup', { examples: ['hostkind backups create --server survival --wait'] }),
  cmd('backups', 'options', 'PUT', '/api/backups/options', 'Update backup options (Terraria includeMods)'),
  cmd('backups', 'delete', 'DELETE', '/api/backups/:name', 'Move a backup to trash', { args: ['name'], confirm: true }),
  cmd('backups', 'download', 'GET', '/api/backups/:name/download', 'Download a backup archive', { args: ['name'], download: true }),
  cmd('backups', 'contents', 'GET', '/api/backups/:name/contents', 'Inspect a backup manifest', { args: ['name'] }),
  cmd('backups', 'verify', 'POST', '/api/backups/:name/verify', 'Verify a backup', { args: ['name'] }),
  cmd('backups', 'impact', 'POST', '/api/backups/:name/impact', 'Preview a restore and get a token', { args: ['name'] }),
  cmd('backups', 'restore', 'POST', '/api/backups/:name/restore', 'Restore a verified backup', { args: ['name'], confirm: true, wait: true, preview: { path: '/api/backups/:name/impact', tokenPath: 'impact.token' } }),

  /* ---------------------------------------------------------------- trash */
  cmd('trash', 'list', 'GET', '/api/trash', 'List trashed files and retention', { serverScoped: false }),
  cmd('trash', 'restore', 'POST', '/api/trash/:id/restore', 'Restore a trashed file', { args: ['id'], serverScoped: false, confirm: true }),
  cmd('trash', 'purge', 'DELETE', '/api/trash/:id', 'Permanently purge a trash entry', { args: ['id'], serverScoped: false, confirm: true }),

  /* ---------------------------------------------------------------- files */
  cmd('files', 'list', 'GET', '/api/files', 'List a server folder', { queryArgs: ['path'] }),
  cmd('files', 'read', 'GET', '/api/files/read', 'Read a text file', { args: ['path'], queryArgs: ['path'] }),
  cmd('files', 'write', 'PUT', '/api/files/write', 'Write a text file', { examples: ['hostkind files write server.properties --content-file ./server.properties', 'cat motd.txt | hostkind files write motd.txt --stdin'], args: ['path'], bodyFromFlags: (flags, ctx) => ({ path: ctx.args[0], content: readContent(flags) }) }),
  cmd('files', 'mkdir', 'POST', '/api/files/mkdir', 'Create a folder', { args: ['path'], bodyFromFlags: (flags, ctx) => splitPathBody(ctx.args[0], 'name') }),
  cmd('files', 'rename', 'POST', '/api/files/rename', 'Rename a file or folder', { args: ['path', 'name'], bodyFromFlags: (_flags, ctx) => ({ path: ctx.args[0], name: ctx.args[1] }) }),
  cmd('files', 'delete', 'DELETE', '/api/files', 'Delete a file or folder', { args: ['path'], queryArgs: ['path'], queryFlags: true, confirm: true }),
  cmd('files', 'download', 'GET', '/api/files/download', 'Download a file', { args: ['path'], queryArgs: ['path'], download: true }),
  cmd('files', 'upload', 'POST', '/api/files/upload', 'Upload files into a folder', { examples: ['hostkind files upload --file ./MyPlugin.jar --path plugins'], upload: { field: 'files', multiple: true, query: ['path'] } }),

  /* -------------------------------------------------------------- configs */
  cmd('configs', 'list', 'GET', '/api/configs', 'List editable server config files'),
  cmd('configs', 'read', 'GET', '/api/configs/:name', 'Read a config file', { args: ['name'] }),
  cmd('configs', 'write', 'PUT', '/api/configs/:name', 'Write a config file', { args: ['name'], bodyFromFlags: (flags) => ({ content: readContent(flags) }) }),
  cmd('configs', 'history', 'GET', '/api/configs/:name/backups', 'List config snapshots', { args: ['name'] }),
  cmd('configs', 'restore', 'POST', '/api/configs/:name/restore', 'Restore a config snapshot', { args: ['name'], bodyArgs: ['backup'], confirm: true }),

  /* --------------------------------------------------------------- addons */
  cmd('addons', 'list', 'GET', '/api/addons', 'List plugins or mods'),
  cmd('addons', 'upload', 'POST', '/api/addons/upload', 'Upload a plugin or mod jar', { upload: { field: 'addon', multiple: false, query: ['kind'] } }),
  cmd('addons', 'enable', 'POST', '/api/addons/enabled', 'Enable plugins or mods', { bodyArrayArgs: ['names'], body: { enabled: true } }),
  cmd('addons', 'disable', 'POST', '/api/addons/enabled', 'Disable plugins or mods', { bodyArrayArgs: ['names'], body: { enabled: false } }),
  cmd('addons', 'delete', 'DELETE', '/api/addons/:name', 'Delete a plugin or mod jar', { args: ['name'], confirm: true }),

  /* ---------------------------------------------------------------- tasks */
  cmd('tasks', 'list', 'GET', '/api/tasks', 'List scheduled tasks'),
  cmd('tasks', 'preview', 'POST', '/api/tasks/preview', 'Validate a task and preview its trigger'),
  cmd('tasks', 'create', 'POST', '/api/tasks', 'Create a scheduled task'),
  cmd('tasks', 'update', 'PUT', '/api/tasks/:id', 'Update a scheduled task', { args: ['id'] }),
  cmd('tasks', 'delete', 'DELETE', '/api/tasks/:id', 'Delete a scheduled task', { args: ['id'], confirm: true }),
  cmd('tasks', 'run', 'POST', '/api/tasks/:id/run', 'Run a scheduled task now', { args: ['id'] }),

  /* ---------------------------------------------------------------- audit */
  cmd('audit', 'list', 'GET', '/api/audit', 'Read the audit log', { serverScoped: false }),
  cmd('audit', 'export', 'GET', '/api/audit/export', 'Export the audit log (csv or json)', { serverScoped: false, download: true, queryFromFlags: ['format'] }),
  cmd('audit', 'retention-preview', 'POST', '/api/audit/retention/preview', 'Preview audit-retention deletion', { serverScoped: false }),
  cmd('audit', 'retention-apply', 'POST', '/api/audit/retention/apply', 'Delete audit rows older than a previewed cutoff', { serverScoped: false, confirm: true, preview: { path: '/api/audit/retention/preview', tokenPath: 'previewToken', tokenField: 'previewToken' } }),
  cmd('audit', 'tour-event', 'POST', '/api/audit/tour-event', 'Accept a legacy onboarding-tour event', { serverScoped: false }),

  /* -------------------------------------------------------------- crashes */
  cmd('crashes', 'list', 'GET', '/api/crashes', 'List crash groups'),
  cmd('crashes', 'get', 'GET', '/api/crashes/:id', 'Read one crash group', { args: ['id'] }),
  cmd('crashes', 'acknowledge', 'POST', '/api/crashes/groups/:id/acknowledge', 'Acknowledge a crash group', { args: ['id'] }),
  cmd('crashes', 'unacknowledge', 'POST', '/api/crashes/groups/:id/unacknowledge', 'Clear a crash acknowledgement', { args: ['id'] }),

  /* --------------------------------------------------------------- health */
  cmd('health', 'get', 'GET', '/api/health', 'Read health findings for the selected server'),
  cmd('health', 'samples', 'GET', '/api/health/samples', 'Read bounded health samples'),
  cmd('health', 'settings', 'PUT', '/api/health/settings', 'Update health thresholds'),

  /* -------------------------------------------------------- notifications */
  cmd('notifications', 'list', 'GET', '/api/notifications', 'List notifications', { serverScoped: false }),
  cmd('notifications', 'read-all', 'POST', '/api/notifications/read-all', 'Mark all visible notifications read', { serverScoped: false }),
  cmd('notifications', 'clear', 'POST', '/api/notifications/clear', 'Delete all visible notifications', { serverScoped: false, confirm: true }),
  cmd('notifications', 'read', 'POST', '/api/notifications/:id/read', 'Mark one notification read', { args: ['id'], serverScoped: false }),
  cmd('notifications', 'delete', 'DELETE', '/api/notifications/:id', 'Delete one notification', { args: ['id'], serverScoped: false, confirm: true }),

  /* ------------------------------------------------------------ operations */
  cmd('operations', 'list', 'GET', '/api/operations', 'List durable operations', { serverScoped: false }),
  cmd('operations', 'get', 'GET', '/api/operations/:id', 'Read one operation', { args: ['id'], serverScoped: false }),
  cmd('operations', 'cancel', 'POST', '/api/operations/:id/cancel', 'Cancel an operation', { args: ['id'], serverScoped: false, confirm: true }),
  cmd('operations', 'resume', 'POST', '/api/operations/:id/resume', 'Resume an operation', { args: ['id'], serverScoped: false }),
  cmd('operations', 'rollback', 'POST', '/api/operations/:id/rollback', 'Roll back an operation', { args: ['id'], serverScoped: false, confirm: true }),

  /* --------------------------------------------------------------- updates */
  cmd('updates', 'scan', 'POST', '/api/updates/scan', 'Scan managed content for available updates', { long: true }),
  cmd('updates', 'summary', 'GET', '/api/updates/summary', 'Summarize available content updates'),
  cmd('updates', 'plan', 'POST', '/api/updates/plan', 'Create an update plan for selected artifacts'),
  cmd('updates', 'plan-get', 'GET', '/api/updates/plans/:id', 'Read an update plan', { args: ['id'] }),
  cmd('updates', 'apply', 'POST', '/api/updates/plans/:id/apply', 'Apply an update plan', { args: ['id'], confirm: true, wait: true, long: true }),
  cmd('updates', 'rollback', 'POST', '/api/updates/plans/:id/rollback', 'Roll back an update plan', { args: ['id'], confirm: true }),

  /* ------------------------------------------------------------- templates */
  cmd('templates', 'list', 'GET', '/api/templates', 'List server templates'),
  cmd('templates', 'preview', 'GET', '/api/templates/:id/preview', 'Inspect a stored template', { args: ['id'] }),
  cmd('templates', 'build-preview', 'POST', '/api/templates/preview', 'Preview a template manifest from a server'),
  cmd('templates', 'create', 'POST', '/api/templates', 'Create a template from a server', { confirm: true }),
  cmd('templates', 'export', 'GET', '/api/templates/:id/export', 'Download a template archive', { args: ['id'], download: true }),
  cmd('templates', 'import-preview', 'POST', '/api/templates/import/preview', 'Preview importing a template archive', { upload: { field: 'file', multiple: false } }),
  cmd('templates', 'import', 'POST', '/api/templates/import', 'Import a previewed template archive', { confirm: true, preview: { path: '/api/templates/import/preview', tokenPath: 'token', tokenField: 'token' }, upload: { field: 'file', multiple: false } }),
  cmd('templates', 'instantiate', 'POST', '/api/templates/:id/instantiate', 'Create a server from a template', { args: ['id'], confirm: true, wait: true }),
  cmd('templates', 'recover', 'POST', '/api/templates/operations/:id/recover', 'Register or discard a stalled template instantiation', { args: ['id'], confirm: true }),
  cmd('templates', 'delete', 'DELETE', '/api/templates/:id', 'Delete a template', { args: ['id'], confirm: true }),

  /* ------------------------------------------------------------ minecraft */
  cmd('minecraft', 'providers', 'GET', '/api/minecraft/content/providers', 'List Minecraft content providers', { serverScoped: false }),
  cmd('minecraft', 'search', 'GET', '/api/minecraft/content/search', 'Search the content catalog'),
  cmd('minecraft', 'versions', 'GET', '/api/minecraft/content/projects/:provider/:projectId/versions', 'List versions for a content project', { args: ['projectId'], defaultPathParams: { provider: 'modrinth' } }),
  cmd('minecraft', 'modrinth-search', 'GET', '/api/modrinth/search', 'Loader-aware Modrinth search'),
  cmd('minecraft', 'modrinth-versions', 'GET', '/api/modrinth/versions/:projectId', 'Loader-aware Modrinth versions', { args: ['projectId'] }),
  cmd('minecraft', 'install', 'POST', '/api/modrinth/install', 'Install one Modrinth version', { confirm: true, long: true }),
  cmd('minecraft', 'install-batch', 'POST', '/api/modrinth/install-batch', 'Install several Modrinth projects', { confirm: true, long: true }),
  cmd('minecraft', 'map-plugins', 'GET', '/api/minecraft/content/map-plugins', 'Read web-map plugin status'),
  cmd('minecraft', 'map-plugin-install', 'POST', '/api/minecraft/content/map-plugins/:key/install', 'Install a web-map plugin', { args: ['key'], confirm: true }),
  cmd('minecraft', 'bluemap-accept-download', 'POST', '/api/minecraft/content/map-plugins/bluemap/accept-download', 'Accept the BlueMap download notice'),
  cmd('minecraft', 'installed', 'GET', '/api/minecraft/content/installed', 'Read content provenance and modpack history'),
  cmd('minecraft', 'preview', 'POST', '/api/minecraft/content/previews', 'Prepare a catalog or FTB content install', { wait: true }),
  cmd('minecraft', 'upload-preview', 'POST', '/api/minecraft/content/upload-previews', 'Inspect an uploaded zip, jar, or installer', { upload: { field: 'file', multiple: false }, wait: true }),
  cmd('minecraft', 'preview-apply', 'POST', '/api/minecraft/content/previews/:previewId/apply', 'Apply a prepared content preview', { args: ['previewId'], confirm: true, wait: true }),
  cmd('minecraft', 'upload-apply', 'POST', '/api/minecraft/content/uploads/:operationId/apply', 'Apply an inspected uploaded content package', { args: ['operationId'], confirm: true, wait: true }),
  cmd('minecraft', 'modpacks versions', 'GET', '/api/modrinth/modpack/versions/:projectId', 'List modpack versions', { args: ['projectId'] }),
  cmd('minecraft', 'modpacks preview', 'GET', '/api/modrinth/modpack/preview/:versionId', 'Preview an mrpack manifest', { args: ['versionId'] }),
  cmd('minecraft', 'modpacks install', 'POST', '/api/modrinth/modpack/install', 'Install a modpack (existing or new server)', { confirm: true, wait: true, long: true }),
  cmd('minecraft', 'import-preview', 'POST', '/api/modpacks/import/preview', 'Preview a managed modpack import'),
  cmd('minecraft', 'import', 'POST', '/api/modpacks/import', 'Apply a managed modpack import', { confirm: true, wait: true, preview: { path: '/api/modpacks/import/preview', tokenPath: 'previewId', tokenField: 'previewId' }, long: true }),
  cmd('minecraft', 'modpacks installed', 'GET', '/api/modpacks/installed', 'Read the managed modpack and history'),
  cmd('minecraft', 'modpacks update-preview', 'POST', '/api/modpacks/update/preview', 'Preview a managed modpack update'),
  cmd('minecraft', 'modpacks update', 'POST', '/api/modpacks/update', 'Apply a managed modpack update', { confirm: true, wait: true, preview: { path: '/api/modpacks/update/preview', tokenPath: 'previewId', tokenField: 'previewId' }, long: true }),
  cmd('minecraft', 'modpacks clone', 'POST', '/api/modpacks/clone', 'Clone a server without operator data', { confirm: true }),
  cmd('minecraft', 'modpacks rollback', 'POST', '/api/modpacks/history/:id/rollback', 'Roll back a modpack history entry', { args: ['id'], confirm: true, wait: true }),
  cmd('minecraft', 'adopt preview', 'POST', '/api/portability/minecraft/adopt/preview', 'Detect an existing Minecraft server folder', { serverScoped: false }),

  /* ------------------------------------------------------------- palworld */
  cmd('palworld', 'status', 'GET', '/api/palworld/status', 'Read live Palworld REST status'),
  cmd('palworld', 'settings', 'GET', '/api/palworld/settings', 'Read the Palworld settings editor'),
  cmd('palworld', 'settings preview', 'POST', '/api/palworld/settings/preview', 'Validate a Palworld settings patch'),
  cmd('palworld', 'settings apply', 'PUT', '/api/palworld/settings', 'Apply a previewed Palworld settings patch', { confirm: true, preview: { path: '/api/palworld/settings/preview', tokenPath: 'previewToken', tokenField: 'previewToken', prepare: { method: 'GET', path: '/api/palworld/settings', merge: (data) => ({ revision: data.revision }) }, applyFromPreview: (preview) => ({ revision: preview.revision }) } }),
  cmd('palworld', 'settings history', 'GET', '/api/palworld/settings/history', 'Read Palworld settings history'),
  cmd('palworld', 'settings restore', 'POST', '/api/palworld/settings/history/:id/restore', 'Restore a Palworld settings snapshot', { args: ['id'], confirm: true }),
  cmd('palworld', 'updates', 'GET', '/api/palworld/updates', 'Read Palworld update status'),
  cmd('palworld', 'updates check', 'POST', '/api/palworld/updates/check', 'Refresh Steam metadata and Palworld update status', { long: true }),
  cmd('palworld', 'updates preview', 'POST', '/api/palworld/updates/preview', 'Plan a Palworld update'),
  cmd('palworld', 'updates apply', 'POST', '/api/palworld/updates/apply', 'Apply a planned Palworld update', { confirm: true, wait: true, preview: { path: '/api/palworld/updates/preview', tokenPath: 'plan', tokenField: 'plan', applyFromPreview: (preview) => ({ plan: preview.plan, revision: preview.plan && preview.plan.revision }) } }),
  cmd('palworld', 'updates policy', 'GET', '/api/palworld/updates/policy', 'Read the Palworld automatic-update policy'),
  cmd('palworld', 'updates policy-set', 'PUT', '/api/palworld/updates/policy', 'Write the Palworld automatic-update policy'),
  cmd('palworld', 'players', 'GET', '/api/palworld/players', 'List live Palworld players'),
  cmd('palworld', 'players kick', 'POST', '/api/palworld/players/:userId/kick', 'Kick a Palworld player', { args: ['userId'], confirm: true }),
  cmd('palworld', 'players ban', 'POST', '/api/palworld/players/:userId/ban', 'Ban a Palworld player', { args: ['userId'], confirm: true }),
  cmd('palworld', 'players unban', 'POST', '/api/palworld/players/unban', 'Unban a Palworld player'),
  cmd('palworld', 'action', 'POST', '/api/palworld/:action', 'Run a legacy Palworld action shim', { args: ['action'] }),
  cmd('palworld', 'announce', 'POST', '/api/palworld/announcements', 'Broadcast a Palworld announcement', { bodyArgs: ['message'] }),
  cmd('palworld', 'save', 'POST', '/api/palworld/save', 'Trigger a Palworld world save'),
  cmd('palworld', 'map', 'GET', '/api/palworld/map', 'Read Palworld map state'),
  cmd('palworld', 'map-asset', 'GET', '/api/palworld/map/asset', 'Download the Palworld map image', { download: true }),
  cmd('palworld', 'map-calibration', 'PUT', '/api/palworld/map/calibration', 'Preview, apply, reset, or restore map calibration', { confirm: true }),
  cmd('palworld', 'mods', 'GET', '/api/palworld/mods', 'List installed Palworld mods'),
  cmd('palworld', 'mods catalog', 'GET', '/api/palworld/mods/catalog', 'Search the Palworld Workshop catalog'),
  cmd('palworld', 'mods catalog-download', 'POST', '/api/palworld/mods/catalog/download', 'Download Workshop items into the cache'),
  cmd('palworld', 'mods catalog-get', 'GET', '/api/palworld/mods/catalog/:workshopId', 'Read one Workshop item', { args: ['workshopId'] }),
  cmd('palworld', 'mods sources', 'GET', '/api/palworld/mods/sources', 'Read Workshop source configuration'),
  cmd('palworld', 'mods sources-set', 'PUT', '/api/palworld/mods/sources', 'Save Workshop source configuration'),
  cmd('palworld', 'mods official', 'GET', '/api/palworld/mods/official', 'Check official Palworld package updates'),
  cmd('palworld', 'mods preview', 'POST', '/api/palworld/mods/preview', 'Preview a Palworld mod package', { upload: { field: 'package', multiple: false } }),
  cmd('palworld', 'mods install', 'POST', '/api/palworld/mods/install', 'Install a previewed Palworld mod package', { confirm: true, wait: true, preview: { path: '/api/palworld/mods/preview', tokenPath: 'previewToken', tokenField: 'previewToken', applyFromPreview: (preview) => ({ revision: preview.revision }) } }),
  cmd('palworld', 'mods import', 'POST', '/api/palworld/mods/import', 'Apply a previewed legacy mod import', { confirm: true, wait: true, preview: { path: '/api/palworld/mods/preview', tokenPath: 'previewToken', tokenField: 'previewToken', applyFromPreview: (preview) => ({ revision: preview.revision }) } }),
  cmd('palworld', 'mods enabled-batch', 'POST', '/api/palworld/mods/enabled-batch', 'Enable or disable a batch of Palworld mods'),
  cmd('palworld', 'mods enabled', 'POST', '/api/palworld/mods/:id/enabled', 'Enable or disable one Palworld mod', { args: ['id'] }),
  cmd('palworld', 'mods remove', 'DELETE', '/api/palworld/mods/:id', 'Move a Palworld mod to trash', { args: ['id'], confirm: true }),
  cmd('palworld', 'mods restore', 'POST', '/api/palworld/mods/trash/:id/restore', 'Restore a trashed Palworld mod', { args: ['id'] }),
  cmd('palworld', 'mods adopt', 'POST', '/api/palworld/mods/adopt', 'Adopt an unmanaged Palworld mod folder'),
  cmd('palworld', 'mods updates-check', 'POST', '/api/palworld/mods/updates/check', 'Check for Palworld mod updates'),
  cmd('palworld', 'platform', 'GET', '/api/palworld/platform', 'Read Palworld Wine/runtime compatibility'),
  cmd('palworld', 'platform wine', 'PUT', '/api/palworld/platform/wine', 'Save Palworld Wine settings'),
  cmd('palworld', 'profile preview', 'GET', '/api/palworld/profile/preview', 'Preview a portable Palworld profile'),
  cmd('palworld', 'profile export', 'POST', '/api/palworld/profile/export', 'Export a portable Palworld profile'),
  cmd('palworld', 'profile download', 'GET', '/api/palworld/profile/export/:id/download', 'Download an exported Palworld profile', { args: ['id'], download: true }),
  cmd('palworld', 'connectivity', 'GET', '/api/palworld/connectivity', 'Read Palworld connectivity diagnostics'),
  cmd('palworld', 'connectivity test', 'POST', '/api/palworld/connectivity/test', 'Test a Palworld endpoint'),
  cmd('palworld', 'adopt preview', 'POST', '/api/portability/palworld/adopt/preview', 'Preview adopting an existing Palworld install', { serverScoped: false }),
  cmd('palworld', 'adopt', 'POST', '/api/portability/palworld/adopt', 'Adopt an existing Palworld install', { serverScoped: false, confirm: true }),
  cmd('palworld', 'import preview', 'POST', '/api/portability/palworld/import/preview', 'Preview importing a Palworld profile', { serverScoped: false, upload: { field: 'profile', multiple: false } }),
  cmd('palworld', 'import', 'POST', '/api/portability/palworld/import', 'Import a previewed Palworld profile', { serverScoped: false, confirm: true, upload: { field: 'profile', multiple: false }, preview: { path: '/api/portability/palworld/import/preview', tokenPath: 'token', tokenField: 'token' } }),

  /* ------------------------------------------------------------- terraria */
  cmd('terraria', 'versions', 'GET', '/api/terraria/versions', 'List installable Terraria builds', { long: true }),
  cmd('terraria', 'players', 'GET', '/api/terraria/players', 'List Terraria players'),
  cmd('terraria', 'player-action', 'POST', '/api/terraria/players/:action', 'Run a Terraria player action', { args: ['action'], bodyArgs: ['target'] }),
  cmd('terraria', 'config', 'GET', '/api/terraria/config', 'Read serverconfig.txt'),
  cmd('terraria', 'config-preview', 'POST', '/api/terraria/config/preview', 'Validate Terraria config edits'),
  cmd('terraria', 'config-apply', 'PUT', '/api/terraria/config', 'Apply previewed Terraria config edits', { confirm: true, preview: { path: '/api/terraria/config/preview', tokenPath: 'previewToken', tokenField: 'previewToken', prepare: { method: 'GET', path: '/api/terraria/config', merge: (data) => ({ revision: data.revision }) }, applyFromPreview: (preview) => ({ revision: preview.revision }) } }),
  cmd('terraria', 'config-raw', 'GET', '/api/terraria/config/raw', 'Read a raw Terraria config file'),
  cmd('terraria', 'config-raw-set', 'PUT', '/api/terraria/config/raw', 'Write a raw Terraria config file', { confirm: true }),
  cmd('terraria', 'config-history', 'GET', '/api/terraria/config/history', 'Read Terraria config history'),
  cmd('terraria', 'config-restore', 'POST', '/api/terraria/config/history/:id/restore', 'Restore a Terraria config revision', { args: ['id'], confirm: true }),
  cmd('terraria', 'import-preview', 'POST', '/api/terraria/import/preview', 'Preview adopting an existing Terraria install', { serverScoped: false }),
  cmd('terraria', 'import', 'POST', '/api/terraria/import', 'Adopt an existing Terraria install', { serverScoped: false, confirm: true, preview: { path: '/api/terraria/import/preview', tokenPath: 'token', tokenField: 'token' } }),

  cmd('terraria', 'worlds', 'GET', '/api/terraria/worlds', 'List Terraria worlds', { aliases: ['terraria worlds list'] }),
  cmd('terraria', 'worlds select-preview', 'POST', '/api/terraria/worlds/select/preview', 'Preview selecting a Terraria world'),
  cmd('terraria', 'worlds select', 'POST', '/api/terraria/worlds/select', 'Select a Terraria world', { confirm: true, wait: true, preview: { path: '/api/terraria/worlds/select/preview', tokenPath: 'preview.token' } }),
  cmd('terraria', 'worlds import-preview', 'POST', '/api/terraria/worlds/import/preview', 'Preview importing Terraria world files', { upload: { field: 'files', multiple: true } }),
  cmd('terraria', 'worlds import', 'POST', '/api/terraria/worlds/import', 'Import Terraria world files', { upload: { field: 'files', multiple: true }, confirm: true, wait: true, preview: { path: '/api/terraria/worlds/import/preview', tokenPath: 'preview.token' } }),
  cmd('terraria', 'worlds generate-preview', 'POST', '/api/terraria/worlds/generate/preview', 'Preview generating a Terraria world'),
  cmd('terraria', 'worlds generate', 'POST', '/api/terraria/worlds/generate', 'Generate a Terraria world', { confirm: true, wait: true, preview: { path: '/api/terraria/worlds/generate/preview', tokenPath: 'preview.token' } }),
  cmd('terraria', 'worlds download', 'GET', '/api/terraria/worlds/:file/download', 'Download a Terraria world bundle', { args: ['file'], download: true }),
  cmd('terraria', 'worlds delete-preview', 'POST', '/api/terraria/worlds/:file/delete/preview', 'Preview deleting a Terraria world', { args: ['file'] }),
  cmd('terraria', 'worlds delete', 'DELETE', '/api/terraria/worlds/:file', 'Delete a Terraria world', { args: ['file'], confirm: true, wait: true, preview: { path: '/api/terraria/worlds/:file/delete/preview', tokenPath: 'preview.token' } }),

  cmd('terraria', 'mods', 'GET', '/api/terraria/mods', 'List Terraria mods'),
  cmd('terraria', 'mods diagnostics', 'GET', '/api/terraria/mods/diagnostics', 'Read Terraria mod diagnostics'),
  cmd('terraria', 'mods import-preview', 'POST', '/api/terraria/mods/import/preview', 'Preview a tModLoader mod import', { upload: { field: 'file', multiple: false } }),
  cmd('terraria', 'mods import', 'POST', '/api/terraria/mods/import', 'Apply a previewed tModLoader mod import', { confirm: true, wait: true, preview: { path: '/api/terraria/mods/import/preview', tokenPath: 'token', tokenField: 'token' } }),
  cmd('terraria', 'mods resolve', 'POST', '/api/terraria/mods/workshop/resolve', 'Resolve a Workshop URL or id'),
  cmd('terraria', 'mods catalog', 'GET', '/api/terraria/mods/workshop/catalog', 'Search the tModLoader Workshop catalog'),
  cmd('terraria', 'mods install-batch', 'POST', '/api/terraria/mods/workshop/install-batch', 'Install several Workshop mods', { confirm: true }),
  cmd('terraria', 'mods install', 'POST', '/api/terraria/mods/workshop/install', 'Install one Workshop mod', { confirm: true }),
  cmd('terraria', 'mods updates', 'GET', '/api/terraria/mods/updates', 'Check tModLoader mod updates'),
  cmd('terraria', 'modpacks list', 'GET', '/api/terraria/mods/modpacks', 'List Terraria modpacks'),
  cmd('terraria', 'modpacks create', 'POST', '/api/terraria/mods/modpacks', 'Capture a Terraria modpack'),
  cmd('terraria', 'modpacks export', 'GET', '/api/terraria/mods/modpacks/:id/export', 'Download a Terraria modpack', { args: ['id'], download: true }),
  cmd('terraria', 'modpacks apply-preview', 'POST', '/api/terraria/mods/modpacks/:id/apply/preview', 'Preview applying a Terraria modpack', { args: ['id'] }),
  cmd('terraria', 'modpacks apply', 'POST', '/api/terraria/mods/modpacks/:id/apply', 'Apply a Terraria modpack', { args: ['id'], confirm: true, wait: true, preview: { path: '/api/terraria/mods/modpacks/:id/apply/preview', tokenPath: 'token', tokenField: 'token' } }),
  cmd('terraria', 'modpacks delete', 'DELETE', '/api/terraria/mods/modpacks/:id', 'Delete a Terraria modpack', { args: ['id'], confirm: true }),
  cmd('terraria', 'mods enabled-batch', 'POST', '/api/terraria/mods/batch/enable', 'Enable a batch of Terraria mods', { body: { enabled: true }, preview: { path: '/api/terraria/mods/batch/enable', tokenPath: 'preview.token', tokenField: 'token' } }),
  cmd('terraria', 'mods disabled-batch', 'POST', '/api/terraria/mods/batch/disable', 'Disable a batch of Terraria mods', { body: { enabled: false }, preview: { path: '/api/terraria/mods/batch/disable', tokenPath: 'preview.token', tokenField: 'token' } }),
  cmd('terraria', 'mods enable', 'POST', '/api/terraria/mods/:name/enable', 'Enable one Terraria mod', { args: ['name'], preview: { path: '/api/terraria/mods/:name/enable', tokenPath: 'preview.token', tokenField: 'token' } }),
  cmd('terraria', 'mods disable', 'POST', '/api/terraria/mods/:name/disable', 'Disable one Terraria mod', { args: ['name'], preview: { path: '/api/terraria/mods/:name/disable', tokenPath: 'preview.token', tokenField: 'token' } }),
  cmd('terraria', 'mods delete', 'DELETE', '/api/terraria/mods/:name', 'Delete a Terraria mod', { args: ['name'], confirm: true, preview: { method: 'DELETE', path: '/api/terraria/mods/:name', tokenPath: 'preview.token', tokenField: 'token' } }),
  cmd('terraria', 'mods restore', 'POST', '/api/terraria/mods/trash/:id/restore', 'Restore a trashed Terraria mod', { args: ['id'] }),

  cmd('terraria', 'tshock status', 'GET', '/api/terraria/tshock/status', 'Read TShock REST status'),
  cmd('terraria', 'tshock players', 'GET', '/api/terraria/tshock/players', 'List TShock players'),
  cmd('terraria', 'tshock player-action', 'POST', '/api/terraria/tshock/players/:action', 'Run a TShock player action', { args: ['action'], bodyArgs: ['target'] }),
  cmd('terraria', 'tshock accounts', 'GET', '/api/terraria/tshock/accounts', 'List TShock accounts'),
  cmd('terraria', 'tshock account-create', 'POST', '/api/terraria/tshock/accounts', 'Create or edit a TShock account'),
  cmd('terraria', 'tshock account-delete', 'DELETE', '/api/terraria/tshock/accounts/:name', 'Delete a TShock account', { args: ['name'], confirm: true }),
  cmd('terraria', 'tshock groups', 'GET', '/api/terraria/tshock/groups', 'List TShock groups'),
  cmd('terraria', 'tshock group-preview', 'POST', '/api/terraria/tshock/groups/preview', 'Preview a TShock group change'),
  cmd('terraria', 'tshock group-set', 'POST', '/api/terraria/tshock/groups', 'Save a TShock group', { confirm: true }),
  cmd('terraria', 'tshock group-delete', 'DELETE', '/api/terraria/tshock/groups/:name', 'Delete a TShock group', { args: ['name'], confirm: true }),
  cmd('terraria', 'tshock permissions', 'GET', '/api/terraria/tshock/permissions', 'List TShock permissions'),
  cmd('terraria', 'tshock bans', 'GET', '/api/terraria/tshock/bans', 'List TShock bans'),
  cmd('terraria', 'tshock ban-create', 'POST', '/api/terraria/tshock/bans', 'Create a TShock ban', { confirm: true }),
  cmd('terraria', 'tshock ban-delete', 'DELETE', '/api/terraria/tshock/bans/:id', 'Delete a TShock ban', { args: ['id'], confirm: true }),

  /* -------------------------------------------------------------- valheim */
  cmd('valheim', 'updates', 'GET', '/api/valheim/updates', 'Read Valheim update status'),
  cmd('valheim', 'updates check', 'POST', '/api/valheim/updates/check', 'Refresh Valheim update status', { long: true }),
  cmd('valheim', 'updates preview', 'POST', '/api/valheim/updates/preview', 'Plan a Valheim update'),
  cmd('valheim', 'updates apply', 'POST', '/api/valheim/updates/apply', 'Apply a previewed Valheim update', { confirm: true, wait: true, preview: { path: '/api/valheim/updates/preview', tokenPath: 'previewToken', tokenField: 'previewToken' } }),
  cmd('valheim', 'updates rollback', 'POST', '/api/valheim/updates/:operationId/rollback', 'Roll back a Valheim update', { args: ['operationId'], confirm: true, wait: true }),
  cmd('valheim', 'updates policy', 'GET', '/api/valheim/updates/policy', 'Read the Valheim update policy'),
  cmd('valheim', 'updates policy-set', 'PUT', '/api/valheim/updates/policy', 'Write the Valheim update policy'),
  cmd('valheim', 'worlds', 'GET', '/api/valheim/worlds', 'List Valheim worlds', { aliases: ['valheim worlds list'] }),
  cmd('valheim', 'worlds select-preview', 'POST', '/api/valheim/worlds/select/preview', 'Preview selecting a Valheim world'),
  cmd('valheim', 'worlds select', 'POST', '/api/valheim/worlds/select', 'Select a Valheim world', { confirm: true, wait: true, preview: { path: '/api/valheim/worlds/select/preview', tokenPath: 'preview.token' } }),
  cmd('valheim', 'worlds import-preview', 'POST', '/api/valheim/worlds/import/preview', 'Preview importing a Valheim world pair', { upload: { field: 'files', multiple: true } }),
  cmd('valheim', 'worlds import', 'POST', '/api/valheim/worlds/import', 'Import a Valheim world pair', { upload: { field: 'files', multiple: true }, confirm: true, wait: true, preview: { path: '/api/valheim/worlds/import/preview', tokenPath: 'preview.token' } }),
  cmd('valheim', 'worlds rename-preview', 'POST', '/api/valheim/worlds/rename/preview', 'Preview renaming a Valheim world'),
  cmd('valheim', 'worlds rename', 'POST', '/api/valheim/worlds/rename', 'Rename a Valheim world', { confirm: true, wait: true, preview: { path: '/api/valheim/worlds/rename/preview', tokenPath: 'preview.token' } }),
  cmd('valheim', 'worlds download', 'GET', '/api/valheim/worlds/:name/download', 'Download a Valheim world bundle', { args: ['name'], download: true }),
  cmd('valheim', 'worlds delete-preview', 'POST', '/api/valheim/worlds/:name/delete/preview', 'Preview deleting a Valheim world', { args: ['name'] }),
  cmd('valheim', 'worlds delete', 'DELETE', '/api/valheim/worlds/:name', 'Delete a Valheim world', { args: ['name'], confirm: true, wait: true, preview: { path: '/api/valheim/worlds/:name/delete/preview', tokenPath: 'preview.token' } }),

  /* --------------------------------------------------------------- users */
  cmd('users', 'list', 'GET', '/api/users', 'List users', { serverScoped: false }),
  cmd('users', 'permissions', 'GET', '/api/users/:id/permissions', 'Read one user grants', { args: ['id'], serverScoped: false }),
  cmd('users', 'set-permissions', 'PUT', '/api/users/:id/permissions', 'Replace one user grants', { args: ['id'], serverScoped: false }),
  cmd('users', 'create', 'POST', '/api/users', 'Create a user', { serverScoped: false }),
  cmd('users', 'update', 'PUT', '/api/users/:id', 'Edit a user', { args: ['id'], serverScoped: false }),
  cmd('users', 'delete', 'DELETE', '/api/users/:id', 'Delete a user', { args: ['id'], serverScoped: false, confirm: true }),

  /* ------------------------------------------------------------- api keys */
  cmd('apikeys', 'list', 'GET', '/api/api-keys', 'List API keys', { serverScoped: false }),
  cmd('apikeys', 'create', 'POST', '/api/api-keys', 'Mint an API key', { serverScoped: false }),
  cmd('apikeys', 'permissions', 'GET', '/api/api-keys/:id/permissions', 'Read one API key grants', { args: ['id'], serverScoped: false }),
  cmd('apikeys', 'set-permissions', 'PUT', '/api/api-keys/:id/permissions', 'Replace one API key grants', { args: ['id'], serverScoped: false }),
  cmd('apikeys', 'revoke', 'DELETE', '/api/api-keys/:id', 'Revoke an API key', { args: ['id'], serverScoped: false, confirm: true }),

  /* -------------------------------------------------------------- product */
  cmd('product', 'manifest', 'GET', '/api/product/manifest/:serverId', 'Export a server manifest', { args: ['serverId'], serverScoped: false }),
  cmd('product', 'validate-manifest', 'POST', '/api/product/manifest/validate', 'Validate a server manifest', { serverScoped: false }),
  cmd('product', 'lifecycle', 'GET', '/api/product/lifecycle', 'Read lifecycle scorecards', { serverScoped: false }),
  cmd('product', 'byoc-targets', 'GET', '/api/product/byoc/targets', 'List BYOC targets', { serverScoped: false }),
  cmd('product', 'byoc-create', 'POST', '/api/product/byoc/targets', 'Create a BYOC target', { serverScoped: false }),
  cmd('product', 'byoc-update', 'PATCH', '/api/product/byoc/targets/:id', 'Update a BYOC target status', { args: ['id'], serverScoped: false }),
  cmd('product', 'pairing-create', 'POST', '/api/product/pairing/challenges', 'Create a pairing challenge', { serverScoped: false }),
  cmd('product', 'pairing-consume', 'POST', '/api/product/pairing/consume', 'Consume a pairing challenge', { serverScoped: false }),
  cmd('product', 'restore-drill-create', 'POST', '/api/product/restore-drills', 'Record a restore drill', { serverScoped: false }),
  cmd('product', 'restore-drill-latest', 'GET', '/api/product/restore-drills/latest', 'Read the latest restore drill', { serverScoped: false }),
  cmd('product', 'event', 'POST', '/api/product/events', 'Record a product event', { serverScoped: false }),
  cmd('product', 'summary', 'GET', '/api/product/summary', 'Read the product event summary', { serverScoped: false }),
];

function minecraftCreateBody(flags) {
  const body = {};
  if (flags.version !== undefined) body.mcVersion = flags.version;
  if (flags['mc-version'] !== undefined) body.mcVersion = flags['mc-version'];
  if (flags['accept-eula'] !== undefined || flags.acceptEula !== undefined) {
    body.eula = flags['accept-eula'] !== false && flags.acceptEula !== false;
  }
  return body;
}

function readContent(flags) {
  const fs = require('fs');
  const file = flags['content-file'];
  if (file) return fs.readFileSync(String(file), 'utf8');
  if (flags.content !== undefined) return String(flags.content);
  if (flags.stdin === true) {
    try { return fs.readFileSync(0, 'utf8'); } catch (_) { /* fall through */ }
  }
  throw Object.assign(new Error('No content supplied. Use --content, --content-file, or --stdin.'), { code: 'missing_content' });
}

function splitPathBody(value, leafKey) {
  if (!value) throw Object.assign(new Error('A path is required.'), { code: 'missing_argument' });
  const raw = String(value).replace(/[\\/]+$/, '');
  const normalized = raw.replace(/\\/g, '/');
  const index = normalized.lastIndexOf('/');
  if (index < 0) return { path: '', [leafKey]: normalized };
  return { path: normalized.slice(0, index), [leafKey]: normalized.slice(index + 1) };
}

module.exports = { COMMANDS, readContent };
