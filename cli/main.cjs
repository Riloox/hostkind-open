#!/usr/bin/env node
'use strict';

const fs = require('fs');
const crypto = require('crypto');
const readline = require('readline');

const parser = require('./parser.cjs');
const config = require('./config.cjs');
const output = require('./output.cjs');
const help = require('./help.cjs');
const { COMMANDS } = require('./endpoints.cjs');
const { SPECIAL_COMMANDS, runSpecial, buildContext, waitForOperation, packageVersion, timeoutMs } = require('./specials.cjs');

const ALL_COMMANDS = [...SPECIAL_COMMANDS, ...COMMANDS];
const INDEX = parser.buildIndex(ALL_COMMANDS);

const RESERVED_FLAGS = new Set([
  'url', 'token', 'api-key', 'profile', 'server', 'format', 'output', 'data', 'data-file',
  'query', 'header', 'field', 'idempotency-key', 'timeout', 'wait-timeout', 'username',
  'email', 'password', 'password-file', 'preview-token', 'token-file', 'help', 'version',
  'json', 'table', 'quiet', 'verbose', 'yes', 'preview', 'wait', 'no-wait', 'no-color',
  'stdout', 'all', 'follow', 'no-follow', 'stats', 'notifications', 'once', 'raw',
  'insecure', 'show-token', 'password-stdin', 'compact', 'lang', 'content', 'content-file', 'stdin',
  'interval', 'ndjson',
]);

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function truthy(value) {
  return value === true || value === 'true' || value === '1' || value === 1;
}

function requestTimeout(spec, flags) {
  if (flags.timeout) return timeoutMs(flags);
  return spec.long || spec.upload ? 0 : undefined;
}

function getPath(object, dotted) {
  if (!dotted) return undefined;
  let current = object;
  for (const part of String(dotted).split('.')) {
    if (current == null) return undefined;
    current = current[part];
  }
  return current;
}

function substitutePath(template, pathParams) {
  return template.replace(/:([A-Za-z0-9_]+)/g, (match, name) => {
    if (pathParams[name] === undefined) {
      throw Object.assign(new Error(`Missing path argument: ${name}`), { code: 'missing_argument' });
    }
    return encodeURIComponent(String(pathParams[name]));
  });
}

function consumeArg(args, name) {
  if (!args.length) {
    throw Object.assign(new Error(`Missing argument: <${name}>`), { code: 'missing_argument' });
  }
  return args.shift();
}

function addTo(target, key, value) {
  if (Object.prototype.hasOwnProperty.call(target, key)) {
    if (!Array.isArray(target[key])) target[key] = [target[key]];
    target[key].push(value);
  } else {
    target[key] = value;
  }
}

function buildRequest(spec, ctx) {
  const args = [...ctx.args];
  const flags = ctx.flags;
  const placeholders = [...String(spec.path || '').matchAll(/:([A-Za-z0-9_]+)/g)].map((match) => match[1]);
  const pathParams = {};
  for (const name of placeholders) {
    if (spec.defaultPathParams && Object.prototype.hasOwnProperty.call(spec.defaultPathParams, name)) {
      pathParams[name] = spec.defaultPathParams[name];
    } else {
      pathParams[name] = consumeArg(args, name);
    }
  }
  const body = spec.body && typeof spec.body === 'object' ? JSON.parse(JSON.stringify(spec.body)) : {};
  const query = {};
  if (spec.query && typeof spec.query === 'object') Object.assign(query, spec.query);

  const bodyArgs = spec.bodyArgs || [];
  bodyArgs.forEach((key, position) => {
    // `console run say hello` sends "say hello": the last argument of a
    // joinRest command takes every remaining word.
    const rest = spec.joinRest && position === bodyArgs.length - 1;
    body[key] = rest && args.length > 1 ? args.splice(0).join(' ') : consumeArg(args, key);
  });
  for (const key of spec.queryArgs || []) {
    query[key] = consumeArg(args, key);
  }
  for (const key of spec.bodyArrayArgs || []) {
    if (!args.length) throw Object.assign(new Error(`Missing argument(s): <${key}>`), { code: 'missing_argument' });
    body[key] = args.splice(0);
  }

  const customArgs = !!spec.bodyFromFlags || !!spec.queryFromFlags;
  if (args.length && !customArgs) {
    throw Object.assign(new Error(`Too many arguments: ${args.join(' ')}`), { code: 'too_many_arguments' });
  }

  const isRead = spec.method === 'GET' || spec.method === 'HEAD';
  const isUpload = !!spec.upload;
  const queryFlags = !!spec.queryFlags;
  const genericEntries = Object.entries(flags)
    .filter(([key]) => !RESERVED_FLAGS.has(key));
  const formFields = {};
  for (const [key, value] of genericEntries) {
    const name = parser.camelKey(key);
    if (isUpload) {
      if ((spec.upload.query || []).includes(key) || (spec.upload.query || []).includes(name)) {
        addTo(query, key, value);
      } else {
        formFields[name] = value;
      }
      continue;
    }
    if (isRead || queryFlags) addTo(query, name, value);
    else if (WRITE_METHODS.has(spec.method)) addTo(body, name, value);
    else addTo(query, name, value);
  }
  for (const key of spec.queryFromFlags || []) {
    if (flags[key] !== undefined) query[key] = flags[key];
  }
  // `--file` is the upload flag, but a few write endpoints also use a field
  // named "file" (Terraria raw config, for example). Only map it when the
  // command is not multipart.
  if (!isUpload && flags.file !== undefined) addTo(body, 'file', flags.file);

  if (spec.bodyFromFlags) {
    Object.assign(body, spec.bodyFromFlags(flags, { ...ctx, args: [...ctx.args] }) || {});
  }
  if (spec.queryFromFlags && typeof spec.queryFromFlags === 'function') {
    Object.assign(query, spec.queryFromFlags(flags, ctx) || {});
  }

  const data = parseDataFlag(flags);
  if (data !== undefined) {
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      throw Object.assign(new Error('--data must be a JSON object.'), { code: 'invalid_data' });
    }
    if (isRead) Object.assign(query, data);
    else Object.assign(body, data);
  }
  Object.assign(query, parser.parseQuery(flags.query));

  let files = [];
  if (isUpload) {
    const raw = flags.file === undefined ? [] : (Array.isArray(flags.file) ? flags.file : [flags.file]);
    files = raw.map((file) => ({ path: file, field: spec.upload.field }));
    const tokenField = spec.preview && (spec.preview.tokenField || 'token');
    const hasToken = (tokenField && flags['preview-token'] !== undefined)
      || flags['token-file'] !== undefined
      || (tokenField && data && typeof data === 'object' && data[tokenField] !== undefined);
    if (!files.length && !hasToken) {
      throw Object.assign(new Error(`This command needs a file. Pass --file <path>.`), { code: 'missing_file' });
    }
    if (!spec.upload.multiple && files.length > 1) {
      throw Object.assign(new Error('This command accepts one file. Pass a single --file.'), { code: 'too_many_files' });
    }
    if (files.length) {
      Object.assign(formFields, parser.parseFields(flags.field));
    }
    if (data !== undefined) {
      for (const [key, value] of Object.entries(data)) formFields[key] = value;
    }
  }

  const headers = parser.parseHeaders(flags.header);
  if (WRITE_METHODS.has(spec.method)) {
    headers['Idempotency-Key'] = String(flags['idempotency-key'] || crypto.randomUUID());
  }
  if (flags['idempotency-key']) headers['Idempotency-Key'] = String(flags['idempotency-key']);

  return {
    method: spec.method,
    path: substitutePath(spec.path, pathParams),
    pathParams,
    body,
    query,
    headers,
    files,
    formFields,
    data,
  };
}

function parseDataFlag(flags) {
  if (flags.data !== undefined) return parser.parseData(flags.data);
  if (flags['data-file']) return parser.parseData(`@${flags['data-file']}`);
  return undefined;
}

async function buildForm(ctx, built) {
  if (!built.files.length) return undefined;
  return ctx.client.multipart(built.files, built.formFields);
}

async function runPreview(spec, ctx, built) {
  const preview = spec.preview;
  if (!preview || !preview.path) return null;
  const previewBody = { ...built.body };
  if (preview.body && typeof preview.body === 'object') Object.assign(previewBody, preview.body);
  if (preview.prepare) {
    const preparePath = substitutePath(preview.prepare.path, built.pathParams);
    const prepared = await ctx.client.request(preview.prepare.method || 'GET', preparePath, {
      noServer: spec.serverScoped === false,
      timeout: requestTimeout(spec, ctx.flags),
    });
    const merged = typeof preview.prepare.merge === 'function'
      ? preview.prepare.merge(prepared, ctx)
      : prepared;
    if (merged && typeof merged === 'object') Object.assign(previewBody, merged);
  }
  const form = await buildForm(ctx, built);
  const result = await ctx.client.request(preview.method || 'POST', substitutePath(preview.path, built.pathParams), {
    query: built.query,
    json: form ? undefined : previewBody,
    form,
    headers: built.headers,
    timeout: requestTimeout(spec, ctx.flags),
  });
  if (result && result.ok === false) {
    const issues = result.issues || result.error || 'The preview rejected the request.';
    throw Object.assign(new Error(typeof issues === 'string' ? issues : JSON.stringify(issues)), {
      code: 'preview_rejected',
      details: result,
    });
  }
  return { result, body: previewBody };
}

function previewTokenFrom(result, preview) {
  const token = getPath(result, preview.tokenPath || 'token');
  if (token !== undefined && token !== null) return token;
  // A few endpoints return the token directly instead of under a nested key.
  if (result && typeof result === 'object') {
    if (result.token !== undefined) return result.token;
    if (result.previewToken !== undefined) return result.previewToken;
    if (result.previewId !== undefined) return result.previewId;
  }
  return undefined;
}

async function confirmAction(spec, ctx) {
  if (!spec.confirm) return true;
  if (truthy(ctx.flags.yes)) return true;
  if (ctx.flags['preview-token'] !== undefined) return true;
  if (!process.stdin.isTTY) {
    throw Object.assign(new Error(`\`hostkind ${spec.name}\` changes or removes data and needs confirmation.`), {
      code: 'confirmation_required',
      hint: 'Re-run with --yes. Add --preview first to see what would change.',
    });
  }
  const target = ctx.args.length ? ` ${ctx.args.join(' ')}` : '';
  const server = ctx.server && spec.serverScoped !== false ? ` on server "${ctx.server}"` : '';
  const answer = await promptLine(`${spec.summary}${target ? `:${target}` : ''}${server}. Continue? [y/N] `);
  return /^y(es)?$/i.test(answer.trim());
}

// Prompts go to stderr so `hostkind ... > out.json` captures only the result.
function promptLine(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question(question, (answer) => { resolve(answer); rl.close(); });
    rl.on('close', () => resolve(''));
  });
}

function printDownload(result, flags) {
  if (result.stdout) return output.EXIT.OK;
  if (output.isHuman(flags)) {
    process.stdout.write(`Saved ${result.filename} (${output.formatBytes(result.bytes)})\n`);
  } else {
    output.printResult({ ok: true, file: result.filename, bytes: result.bytes }, flags);
  }
  return output.EXIT.OK;
}

async function runNdjson(spec, ctx, built) {
  const form = await buildForm(ctx, built);
  let doneEvent = null;
  let errorEvent = null;
  const progress = {};
  const result = await ctx.client.requestNdjson(built.method, built.path, {
    query: built.query,
    json: form ? undefined : built.body,
    form,
    headers: built.headers,
    timeout: ctx.flags.timeout ? timeoutMs(ctx.flags) : 0,
    onEvent: (event) => {
      if (event && event.type === 'done') doneEvent = event;
      else if (event && event.type === 'error') errorEvent = event;
      if (ctx.flags.json) output.printNdjsonEvent(event, ctx.flags, process.stdout, progress);
      else if (!doneEvent && !errorEvent) output.printNdjsonEvent(event, ctx.flags, process.stderr, progress);
    },
  });
  if (progress.open) process.stderr.write('\n');
  if (errorEvent) {
    throw Object.assign(new Error(errorEvent.error || 'The operation failed.'), { code: 'operation_failed', details: errorEvent });
  }
  if (doneEvent) {
    if (!ctx.flags.json) output.printResult(doneEvent.server, ctx.flags);
    return doneEvent.server;
  }
  if (!ctx.flags.json) output.printResult(result.last, ctx.flags);
  return result.last;
}

async function runEndpoint(spec, ctx) {
  const built = buildRequest(spec, ctx);
  const flags = ctx.flags;

  if (flags.preview === true) {
    if (!spec.preview) {
      throw Object.assign(new Error(`\`${spec.name}\` does not have a preview step.`), { code: 'no_preview' });
    }
    const preview = await runPreview(spec, ctx, built);
    output.printResult(preview.result, flags);
    return output.EXIT.OK;
  }

  let token = flags['preview-token'];
  if (token === undefined && flags['token-file']) token = fs.readFileSync(String(flags['token-file']), 'utf8').trim();
  const tokenField = spec.preview && (spec.preview.tokenField || 'token');
  if (token !== undefined && tokenField) built.body[tokenField] = token;
  if (token === undefined && tokenField && built.body[tokenField] !== undefined) {
    token = built.body[tokenField];
  }

  // At a terminal, show the preview before asking, so the answer is informed.
  let previewed = null;
  const willPrompt = spec.confirm && !truthy(flags.yes) && token === undefined && process.stdin.isTTY;
  if (willPrompt && spec.preview) {
    previewed = await runPreview(spec, ctx, built);
    process.stderr.write(`${output.bold(flags, 'Preview')}\n${output.stringify(previewed.result, flags)}\n\n`);
  }

  const confirmed = await confirmAction(spec, ctx);
  if (!confirmed) {
    throw Object.assign(new Error('Cancelled.'), { code: 'cancelled' });
  }

  if (spec.preview && token === undefined) {
    const preview = previewed || await runPreview(spec, ctx, built);
    token = spec.preview.noToken ? undefined : previewTokenFrom(preview.result, spec.preview);
    if (token === undefined && !spec.preview.noToken) {
      throw Object.assign(new Error('The preview did not return a token.'), { code: 'preview_missing_token', details: preview.result });
    }
    if (tokenField && token !== undefined) built.body[tokenField] = token;
    if (spec.preview.applyFromPreview) {
      Object.assign(built.body, spec.preview.applyFromPreview(preview.result, ctx) || {});
    }
    // The preview and the action are different requests; reusing the same
    // Idempotency-Key would let the server treat the action as a replay.
    if (!flags['idempotency-key'] && WRITE_METHODS.has(spec.method)) {
      built.headers['Idempotency-Key'] = crypto.randomUUID();
    }
    if (flags.verbose) process.stderr.write(`preview token: ${token}\n`);
  }

  if (spec.download) {
    const result = await ctx.client.download(built.method, built.path, {
      query: built.query,
      json: Object.keys(built.body).length ? built.body : undefined,
      headers: built.headers,
      output: flags.output,
      timeout: flags.timeout ? timeoutMs(flags) : 0,
    });
    return printDownload(result, flags);
  }

  if (spec.ndjson) {
    await runNdjson(spec, ctx, built);
    return output.EXIT.OK;
  }

  // Preview-token flows upload the file once, in the preview request. The
  // apply request is JSON and carries the token from that preview.
  const form = spec.preview ? undefined : await buildForm(ctx, built);
  let result = await ctx.client.request(built.method, built.path, {
    query: built.query,
    json: form ? undefined : (Object.keys(built.body).length ? built.body : undefined),
    form,
    headers: built.headers,
    timeout: requestTimeout(spec, flags),
  });

  if (spec.name === 'me password' && result && result.token) {
    config.setProfile(ctx.cfg, ctx.profileName, { token: result.token });
    config.saveConfig(ctx.cfg);
  }

  if (flags.wait && result && result.operationId) {
    const seconds = Number(flags['wait-timeout'] || 0);
    const interval = Number(flags.interval || 1);
    result = await waitForOperation(ctx, result.operationId, {
      timeoutSeconds: seconds,
      intervalSeconds: interval,
      flags,
    });
  }

  output.printResult(result, flags);
  if (!flags.wait && result && result.operationId && output.isHuman(flags, process.stderr)) {
    process.stderr.write(output.dim(flags, `Started operation ${result.operationId}. Follow it with \`hostkind wait ${result.operationId}\`, or pass --wait next time.\n`));
  }
  if (result && ['failed', 'cancelled', 'recovery_required'].includes(result.state)) return output.EXIT.ERROR;
  return output.EXIT.OK;
}

function renderHelpFor(match, ctx, flags) {
  if (!match) return `${help.renderRoot(INDEX, flags)}\n`;
  if (match.kind === 'command') return `${help.renderCommand(match.spec, flags, INDEX)}\n`;
  if (match.kind === 'group') return `${help.renderGroup(INDEX, match.group, flags)}\n`;
  return `${help.renderRoot(INDEX, flags)}\n`;
}

async function resolveHelp(argv) {
  const rest = argv.filter((token) => token !== '--help' && token !== '-h');
  if (!rest.length) return { kind: 'root' };
  if (rest.length === 1 && INDEX.groups.has(rest[0])) return { kind: 'group', group: rest[0] };
  for (let length = rest.length; length >= 1; length -= 1) {
    const key = rest.slice(0, length).join(' ');
    const spec = INDEX.byKey.get(key);
    if (spec) return { kind: 'command', spec };
  }
  const group = rest[0];
  if (INDEX.groups.has(group)) return { kind: 'group', group };
  const groupMatch = [...INDEX.groups.keys()].find((name) => name.startsWith(`${group} `));
  if (groupMatch) return { kind: 'group', group: groupMatch };
  return { kind: 'root' };
}

async function main(argv) {
  // `hostkind <group> --help` is group help, not help for the first action.
  if (argv.length === 2 && (argv[1] === '--help' || argv[1] === '-h') && INDEX.groups.has(argv[0])) {
    process.stdout.write(`${help.renderGroup(INDEX, argv[0], {})}\n`);
    return output.EXIT.OK;
  }
  const match = parser.matchCommand(argv, INDEX);
  if (match.kind === 'version') {
    process.stdout.write(`${output.stringify({ name: 'hostkind', version: packageVersion() }, {})}\n`);
    return output.EXIT.OK;
  }
  if (match.kind === 'help') {
    const helpMatch = await resolveHelp(match.rest);
    process.stdout.write(renderHelpFor(helpMatch, null, {}));
    return output.EXIT.OK;
  }
  if (match.kind === 'root') {
    process.stdout.write(`${help.renderRoot(INDEX, {})}\n`);
    return output.EXIT.OK;
  }
  if (match.kind === 'group') {
    process.stdout.write(`${help.renderGroup(INDEX, match.group, {})}\n`);
    return output.EXIT.OK;
  }
  if (match.kind === 'error') {
    throw Object.assign(new Error(match.message), { code: 'unknown_command', hint: match.hint });
  }

  const parsed = parser.parseOptions(match.rest, match.spec);
  const flags = parsed.flags;
  const args = parsed.positionals;
  if (flags.help) {
    process.stdout.write(`${help.renderCommand(match.spec, flags, INDEX)}\n`);
    return output.EXIT.OK;
  }
  if (flags.version && match.spec.group === 'version') {
    process.stdout.write(`${output.stringify({ name: 'hostkind', version: packageVersion() }, flags)}\n`);
    return output.EXIT.OK;
  }

  const cfg = config.loadConfig();
  const profileName = config.selectedProfileName(cfg, flags);
  const ctx = buildContext({ flags, args, cfg, profileName, index: INDEX });
  if (match.spec.special) return runSpecial(match.spec, ctx);
  return runEndpoint(match.spec, ctx);
}

async function run() {
  const argv = process.argv.slice(2);
  try {
    const code = await main(argv);
    process.exitCode = typeof code === 'number' ? code : output.EXIT.OK;
  } catch (err) {
    output.printError(err, parseFlagsForErrors(argv));
    process.exitCode = output.exitCodeFor(err);
  }
}

function parseFlagsForErrors(argv) {
  try {
    const match = parser.matchCommand(argv, INDEX);
    if (match.kind === 'command') return parser.parseOptions(match.rest, match.spec).flags;
    // No command matched; still honor --json and --no-color for the error.
    return parser.parseOptions(argv).flags;
  } catch (_) { /* ignore */ }
  return {};
}

if (require.main === module) run();

module.exports = { main, run, buildRequest, runPreview, INDEX };
