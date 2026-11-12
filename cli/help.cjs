'use strict';

const { bold, dim, green, yellow } = require('./output.cjs');

const GLOBAL_OPTIONS = [
  ['-u, --url <url>', 'Panel URL (default: local config or http://127.0.0.1:2121)'],
  ['-p, --profile <name>', 'Credential profile to use'],
  ['--token <jwt>', 'Bearer session token (or set HOSTKIND_TOKEN)'],
  ['--api-key <key>', 'API key (or set HOSTKIND_API_KEY)'],
  ['-s, --server <id|name>', 'Target server (or set HOSTKIND_SERVER)'],
  ['--json', 'JSON output (the default when stdout is not a terminal)'],
  ['--table', 'Render list results as a table (the default on a terminal)'],
  ['--format <mode>', 'json, table, or raw'],
  ['-q, --quiet', 'Print identifiers only'],
  ['-y, --yes', 'Confirm destructive actions without a prompt'],
  ['--preview', 'Run only the preview step, when the command has one'],
  ['--preview-token <t>', 'Reuse a preview token'],
  ['--wait', 'Follow an operationId until it finishes'],
  ['--wait-timeout <s>', 'Bound --wait in seconds (default: no bound)'],
  ['--timeout <seconds>', 'HTTP timeout; 0 disables it (default 30)'],
  ['-v, --verbose', 'Log each HTTP request to stderr'],
  ['--no-color', 'Disable colors (or set NO_COLOR)'],
  ['--data <json|@file>', 'Merge a JSON body into the request'],
  ['--query <key=value>', 'Add a query parameter (repeatable)'],
  ['--header <name: value>', 'Add an HTTP header (repeatable)'],
  ['-f, --file <path>', 'Upload a file (repeatable where supported)'],
  ['-o, --output <path|->', 'Download destination, or - for stdout'],
  ['--idempotency-key <key>', 'Override the generated idempotency key'],
  ['-h, --help', 'Show help'],
  ['-V, --version', 'Show the CLI version'],
];

function argList(spec) {
  const names = [...new Set([...(spec.args || []), ...(spec.bodyArgs || []), ...(spec.queryArgs || [])])];
  const args = names.map((arg, i) => (spec.joinRest && i === names.length - 1 ? `<${arg}...>` : `<${arg}>`));
  for (const key of spec.bodyArrayArgs || []) args.push(`<${key}...>`);
  return args.join(' ');
}

function usage(spec) {
  const args = argList(spec);
  return `hostkind ${spec.name}${args ? ` ${args}` : ''} [options]`;
}

const GROUP_SUMMARIES = {
  auth: 'Sign-in state, current user, modules, and foundation diagnostics',
  panel: 'Panel settings, folder browser, host snapshot, and metrics',
  servers: 'Register, edit, select, create, clone, and control servers',
  console: 'Run console commands, read history, and follow live output',
  players: 'Player actions, whitelist, ops, bans, and player lists',
  worlds: 'Import, clone, archive, download, delete, and pregenerate worlds',
  backups: 'Create, inspect, verify, restore, and download backups',
  trash: 'Restore or purge recoverable deletions',
  files: 'Browse, read, write, rename, upload, and download server files',
  configs: 'Edit config files and restore their snapshots',
  addons: 'Upload, enable, disable, and delete plugins and mods',
  tasks: 'Scheduled commands and restarts',
  templates: 'Create, export, import, and instantiate server templates',
  minecraft: 'Content, modpacks, map plugins, and server adoption',
  palworld: 'REST status, settings, players, map, updates, mods, and profiles',
  terraria: 'Players, config, worlds, tModLoader mods, and TShock',
  valheim: 'Updates, worlds, imports, renames, and downloads',
  updates: 'Managed content update scans, plans, apply, and rollback',
  'application-update': 'Check, download, and install Hostkind releases',
  audit: 'Audit log, export, and retention',
  crashes: 'Crash groups and acknowledgements',
  health: 'Health findings, samples, and thresholds',
  operations: 'Durable operations: list, read, cancel, resume, rollback',
  notifications: 'Read, mark read, and clear notifications',
  users: 'Accounts and their grants',
  apikeys: 'API key lifecycle and grants',
  me: 'Current profile, password, language, and terms',
  product: 'Manifests, lifecycle, BYOC, pairing, and restore drills',
  'bug-reports': 'Create and read bug reports, and configure reporting',
  profile: 'Saved connection profiles',
  api: 'Call any panel endpoint directly',
};

function visibleCommands(commands) {
  return commands.filter((command) => !command.hidden).sort((a, b) => a.name.localeCompare(b.name));
}

// One-word commands (login, doctor, api, ...) read as verbs, not groups.
const TOP_LEVEL_ALIASES = new Set(['whoami']);

function topLevelCommands(index) {
  const groups = new Set(commandGroups(index));
  return [...index.byKey]
    .filter(([key, spec]) => !key.includes(' ') && !spec.hidden && !groups.has(key)
      && (spec.name === key || TOP_LEVEL_ALIASES.has(key)))
    .map(([name, spec]) => ({ name, summary: spec.summary }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function commandGroups(index) {
  return [...index.groups.keys()]
    .filter((group) => index.groups.get(group).some((command) => command.name.includes(' ') && !command.hidden))
    .sort();
}

function twoColumns(lines, rows, flags, paintName = (text) => green(flags, text)) {
  const width = Math.max(...rows.map(([name]) => name.length));
  for (const [name, description] of rows) {
    lines.push(`  ${paintName(name.padEnd(width))}  ${description}`);
  }
}

function renderRoot(index, flags) {
  const lines = [];
  lines.push(`${bold(flags, 'hostkind')} controls a Hostkind panel from the terminal.`);
  lines.push('');
  lines.push(bold(flags, 'Usage'));
  lines.push('  hostkind <command> [args] [options]');
  lines.push('  hostkind <group> <action> [args] [options]');
  lines.push('');
  lines.push(bold(flags, 'Commands'));
  twoColumns(lines, topLevelCommands(index).map((item) => [item.name, item.summary]), flags);
  lines.push('');
  lines.push(bold(flags, 'Groups'));
  twoColumns(lines, commandGroups(index).map((group) => [group, dim(flags, GROUP_SUMMARIES[group] || '')]), flags);
  lines.push('');
  lines.push(bold(flags, 'Examples'));
  lines.push('  hostkind login --url http://127.0.0.1:2121');
  lines.push('  hostkind servers list');
  lines.push('  hostkind console tail --server survival');
  lines.push('  hostkind backups create --server survival --wait');
  lines.push('  hostkind worlds delete world --preview');
  lines.push('  hostkind api GET /api/servers --json');
  lines.push('');
  lines.push(bold(flags, 'Global options'));
  twoColumns(lines, GLOBAL_OPTIONS, flags, (text) => text);
  lines.push('');
  lines.push(dim(flags, 'Run `hostkind help <group>` or `hostkind <command> --help` for details.'));
  lines.push(dim(flags, `Config: ${require('./config.cjs').configPath()}`));
  return lines.join('\n');
}

function commandTags(command, flags) {
  const tags = [];
  if (command.confirm) tags.push(yellow(flags, '[confirm]'));
  if (command.preview) tags.push(dim(flags, '[preview]'));
  return tags.length ? ` ${tags.join(' ')}` : '';
}

function renderGroup(index, group, flags) {
  const commands = visibleCommands(index.groups.get(group) || []);
  if (!commands.length) return null;
  const lines = [];
  lines.push(`${bold(flags, `hostkind ${group}`)}${GROUP_SUMMARIES[group] ? `  ${dim(flags, GROUP_SUMMARIES[group])}` : ''}`);
  lines.push('');
  const rows = commands.map((command) => {
    const args = argList(command);
    return [`${command.name}${args ? ` ${args}` : ''}`, `${command.summary}${commandTags(command, flags)}`];
  });
  twoColumns(lines, rows, flags);
  lines.push('');
  lines.push(dim(flags, '[confirm] asks before running; pass --yes in scripts. [preview] supports --preview.'));
  lines.push(dim(flags, 'Run `hostkind <command> --help` for arguments and options.'));
  return lines.join('\n');
}

function commandOptions(spec) {
  const rows = [];
  const write = spec.method && spec.method !== 'GET' && spec.method !== 'HEAD';
  if (spec.serverScoped !== false && !spec.special) rows.push(['--server <id|name>', 'Target server (default: the panel\'s active server)']);
  if (spec.upload) rows.push(['--file <path>', spec.upload.multiple ? 'File to upload (repeatable)' : 'File to upload']);
  if (spec.upload) rows.push(['--field <key=value>', 'Extra multipart form field (repeatable)']);
  if (spec.download) rows.push(['--output <path|->', 'Where to save it; a folder, a file name, or - for stdout']);
  if (spec.preview) {
    rows.push(['--preview', 'Show what would change and exit']);
    rows.push(['--preview-token <token>', 'Apply a preview you already reviewed']);
  }
  if (spec.confirm) rows.push(['-y, --yes', 'Skip the confirmation prompt']);
  if (spec.wait) {
    rows.push(['--wait', 'Follow the returned operation until it finishes']);
    rows.push(['--wait-timeout <seconds>', 'Give up waiting after this long']);
  }
  if (spec.path && write) rows.push(['--<field> <value>', 'Set a body field (--max-players 10 sends maxPlayers)']);
  if (spec.path && !write) rows.push(['--<param> <value>', 'Add a query parameter']);
  if (spec.path) rows.push(['--data <json|@file>', write ? 'Merge a JSON object into the body' : 'Merge a JSON object into the query']);
  for (const [name, meta] of Object.entries(spec.options || {})) {
    rows.push([name.startsWith('-') ? name : `--${name}`, (meta && meta.description) || '']);
  }
  return rows;
}

function renderCommand(spec, flags, index) {
  const lines = [];
  lines.push(`${bold(flags, `hostkind ${spec.name}`)}  ${spec.summary || ''}`);
  lines.push('');
  lines.push(bold(flags, 'Usage'));
  lines.push(`  ${usage(spec)}`);
  if (spec.aliases && spec.aliases.length) {
    lines.push(`  ${dim(flags, `alias: ${spec.aliases.map((alias) => `hostkind ${alias}`).join(', ')}`)}`);
  }
  if (spec.argsHint) lines.push(`  ${spec.argsHint}`);

  const children = index
    ? visibleCommands(index.commands.filter((command) => command.name.startsWith(`${spec.name} `)))
    : [];
  if (children.length) {
    lines.push('');
    lines.push(bold(flags, 'Subcommands'));
    twoColumns(lines, children.map((command) => {
      const args = argList(command);
      return [`${command.name}${args ? ` ${args}` : ''}`, `${command.summary}${commandTags(command, flags)}`];
    }), flags);
  }

  const options = commandOptions(spec);
  if (options.length) {
    lines.push('');
    lines.push(bold(flags, 'Options'));
    twoColumns(lines, options, flags, (text) => text);
  }

  const notes = [];
  if (spec.preview) {
    notes.push(`Runs a preview first (${spec.preview.method || 'POST'} ${spec.preview.path}) and applies the token it returns.`);
  }
  if (spec.confirm) notes.push(yellow(flags, 'Changes or removes data. Asks for confirmation on a terminal; scripts must pass --yes.'));
  if (notes.length) {
    lines.push('');
    for (const note of notes) lines.push(note);
  }
  if (spec.examples && spec.examples.length) {
    lines.push('');
    lines.push(bold(flags, 'Examples'));
    for (const example of spec.examples) lines.push(`  ${example}`);
  }
  if (spec.method) {
    lines.push('');
    lines.push(dim(flags, `Endpoint: ${spec.method} ${spec.path}`));
  }
  lines.push(dim(flags, 'Global options (--json, --table, --quiet, --profile, --url, ...): hostkind --help'));
  return lines.join('\n');
}

function renderCommands(index, filter, flags) {
  const commands = index.commands
    .filter((command) => !command.hidden)
    .filter((command) => !filter || command.group === filter || command.group.startsWith(`${filter} `) || command.name.startsWith(`${filter} `))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (flags.json) return JSON.stringify({
    commands: commands.map((command) => ({
      name: command.name,
      group: command.group,
      method: command.method || null,
      path: command.path || null,
      summary: command.summary,
      args: command.args || [],
      aliases: command.aliases || [],
      destructive: !!command.confirm,
      preview: command.preview ? { method: command.preview.method || 'POST', path: command.preview.path } : null,
      special: command.special || null,
    })),
  }, null, 2);
  const groups = new Map();
  for (const command of commands) {
    if (!groups.has(command.group)) groups.set(command.group, []);
    groups.get(command.group).push(command);
  }
  const lines = [];
  for (const [group, items] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(bold(flags, group));
    const width = Math.max(...items.map((item) => item.name.length));
    for (const item of items) {
      lines.push(`  ${item.name.padEnd(width)}  ${dim(flags, item.summary)}`);
    }
  }
  lines.push('');
  lines.push(dim(flags, `${commands.length} commands`));
  return lines.join('\n');
}

module.exports = {
  GLOBAL_OPTIONS,
  usage,
  renderRoot,
  renderGroup,
  renderCommand,
  renderCommands,
  visibleCommands,
  topLevelCommands,
  commandGroups,
};
