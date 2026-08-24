'use strict';

/*
 * Connectivity guidance (docs/palworld/07-portability-safety.md
 * "Connectivity guidance").
 *
 * Spec contract:
 *   - "Show local address, configured game/query ports, public-address status
 *      when explicitly configured, and a platform-neutral checklist for LAN and
 *      internet access."
 *   - "Hostkind may test local listeners and optionally test a user-requested
 *      public endpoint without claiming that a failed external probe proves
 *      router configuration is wrong."
 *   - "Port forwarding remains documentation, not automatic router mutation."
 *
 * Every item this module emits is tagged with how Hostkind knows it:
 *
 *   observed    - Hostkind measured it on this host, right now;
 *   configured  - it is what the operator or the settings file says;
 *   inferred    - derived from an observation that has other explanations;
 *   instruction - something the operator has to do; Hostkind cannot verify it.
 *
 * Nothing here mutates a router, a firewall, or the server. The UI renders the
 * three fact kinds differently on purpose: an operator who cannot tell a
 * measurement from a guess cannot debug their own network.
 */

const fs = require('fs');
const os = require('os');
const net = require('net');
const dns = require('dns');
const dgram = require('dgram');
const settings = require('./palworld-settings.cjs');

const PROBE_TIMEOUT_MS = 1500;
const PUBLIC_PROBE_TIMEOUT_MS = 4000;

const EVIDENCE = Object.freeze({
  OBSERVED: 'observed',
  CONFIGURED: 'configured',
  INFERRED: 'inferred',
  INSTRUCTION: 'instruction',
});

function localAddresses() {
  const out = [];
  const interfaces = os.networkInterfaces();
  for (const [name, entries] of Object.entries(interfaces || {})) {
    for (const entry of entries || []) {
      if (entry.internal) continue;
      out.push({ interface: name, address: entry.address, family: String(entry.family).replace('IPv', '') === '4' ? 'ipv4' : 'ipv6' });
    }
  }
  return out.sort((a, b) => (a.family === b.family ? a.address.localeCompare(b.address) : a.family === 'ipv4' ? -1 : 1));
}

/*
 * Read the ports the server itself is configured with. The descriptor wins for
 * what Hostkind launches; the settings file is what the game reports to
 * players, and the two disagreeing is a real and confusing failure mode, so we
 * surface both instead of picking one.
 */
function configuredPorts(server) {
  const result = {
    gamePort: Number(server?.port) || null,
    queryPort: Number(server?.queryPort) || null,
    restPort: Number(server?.restPort) || null,
    settingsPublicPort: null,
    settingsPublicIp: null,
    settingsRestPort: null,
    settingsReadable: false,
    mismatch: [],
  };
  try {
    const file = settings.configPath(server.dir);
    if (fs.existsSync(file)) {
      const parsed = settings.parse(fs.readFileSync(file));
      const values = new Map(parsed.members.map((member) => [member.key, settings.decode(member.rawValue)]));
      result.settingsReadable = parsed.errors.length === 0;
      const publicPort = Number(values.get('PublicPort'));
      const restPort = Number(values.get('RESTAPIPort'));
      const publicIp = String(values.get('PublicIP') || '').trim();
      result.settingsPublicPort = Number.isInteger(publicPort) && publicPort > 0 ? publicPort : null;
      result.settingsRestPort = Number.isInteger(restPort) && restPort > 0 ? restPort : null;
      result.settingsPublicIp = publicIp || null;
    }
  } catch { /* an unreadable settings file is reported as "not readable", not as zero */ }
  if (result.gamePort && result.settingsPublicPort && result.gamePort !== result.settingsPublicPort) {
    result.mismatch.push({ field: 'gamePort', descriptor: result.gamePort, settings: result.settingsPublicPort });
  }
  if (result.restPort && result.settingsRestPort && result.restPort !== result.settingsRestPort) {
    result.mismatch.push({ field: 'restPort', descriptor: result.restPort, settings: result.settingsRestPort });
  }
  return result;
}

/*
 * TCP listener probe: a successful connect proves something is accepting
 * connections on this host. A refusal proves nothing is - on loopback, and only
 * right now.
 */
function probeTcp(port, { host = '127.0.0.1', timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      resolve({ port, protocol: 'tcp', state: 'unknown', evidence: EVIDENCE.OBSERVED, detail: 'invalid_port' });
      return;
    }
    const addressFamily = net.isIP(host);
    if (!addressFamily) {
      resolve({ port, protocol: 'tcp', host, state: 'unknown', evidence: EVIDENCE.OBSERVED, detail: 'invalid_host' });
      return;
    }
    const socket = new net.Socket();
    let settled = false;
    const done = (state, detail) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ port, protocol: 'tcp', host, state, evidence: EVIDENCE.OBSERVED, detail: detail || null });
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done('listening'));
    socket.once('timeout', () => done('unknown', 'timeout'));
    socket.once('error', (error) => done(error.code === 'ECONNREFUSED' ? 'closed' : 'unknown', error.code || 'error'));
    socket.connect({ port, host, family: addressFamily });
  });
}

/*
 * UDP cannot be probed by connecting - the game port is UDP, so the only local
 * signal available is whether the port can still be bound. "Bind refused"
 * means something holds it, which is an inference, not a measurement of the
 * Palworld server itself: another process could hold the same port.
 */
function probeUdp(port, { host = '0.0.0.0' } = {}) {
  return new Promise((resolve) => {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      resolve({ port, protocol: 'udp', state: 'unknown', evidence: EVIDENCE.INFERRED, detail: 'invalid_port' });
      return;
    }
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: false });
    let settled = false;
    const done = (state, detail) => {
      if (settled) return;
      settled = true;
      try { socket.close(); } catch { /* already closed */ }
      resolve({ port, protocol: 'udp', host, state, evidence: EVIDENCE.INFERRED, detail: detail || null });
    };
    socket.once('error', (error) => done(error.code === 'EADDRINUSE' ? 'in_use' : 'unknown', error.code || 'error'));
    socket.once('listening', () => done('free'));
    try { socket.bind(port, host); } catch (error) { done('unknown', error.code || 'error'); }
  });
}

/*
 * The platform-neutral checklist. It never names a router model, never tells
 * the operator their configuration is wrong, and never claims Hostkind can
 * change any of it.
 */
function checklist({ ports, online }) {
  const items = [
    {
      id: 'server_running',
      state: online ? 'ok' : 'attention',
      evidence: EVIDENCE.OBSERVED,
      message: online ? 'The server process is running.' : 'The server is offline. Players cannot connect until it is started.',
    },
    {
      id: 'lan_address',
      state: 'info',
      evidence: EVIDENCE.OBSERVED,
      message: 'Players on this network connect using a local address of this machine and the game port.',
    },
    {
      id: 'firewall',
      state: 'info',
      evidence: EVIDENCE.INSTRUCTION,
      message: 'Allow inbound UDP on the game port through this machine\'s firewall. Hostkind cannot verify host firewall rules.',
    },
    {
      id: 'port_forward',
      state: 'info',
      evidence: EVIDENCE.INSTRUCTION,
      message: 'For internet play, forward the game port (UDP) on the router to this machine. Hostkind documents this; it never changes router configuration.',
    },
    {
      id: 'public_ip',
      state: ports.settingsPublicIp ? 'ok' : 'info',
      evidence: ports.settingsPublicIp ? EVIDENCE.CONFIGURED : EVIDENCE.INSTRUCTION,
      message: ports.settingsPublicIp
        ? 'A public address is configured in the server settings.'
        : 'No public address is configured. Set one only if players connect from the internet and the address is stable.',
    },
    {
      id: 'rest_loopback',
      state: 'ok',
      evidence: EVIDENCE.CONFIGURED,
      message: 'The Palworld REST API is used through loopback only and must never be forwarded or exposed.',
    },
  ];
  if (ports.mismatch.length) {
    items.push({
      id: 'port_mismatch',
      state: 'attention',
      evidence: EVIDENCE.OBSERVED,
      message: 'The ports Hostkind launches with and the ports in the settings file disagree. Players will use the settings value.',
    });
  }
  if (!ports.settingsReadable) {
    items.push({
      id: 'settings_unreadable',
      state: 'attention',
      evidence: EVIDENCE.OBSERVED,
      message: 'PalWorldSettings.ini could not be read, so the configured public port could not be confirmed.',
    });
  }
  return items;
}

async function report({ server, online = false, probe = true, probeTcpImpl = probeTcp, probeUdpImpl = probeUdp } = {}) {
  const ports = configuredPorts(server);
  const listeners = [];
  if (probe) {
    const gamePort = ports.settingsPublicPort || ports.gamePort;
    if (gamePort) listeners.push(await probeUdpImpl(gamePort));
    if (ports.queryPort && ports.queryPort !== gamePort) listeners.push(await probeUdpImpl(ports.queryPort));
    const restPort = ports.restPort || ports.settingsRestPort;
    if (restPort) listeners.push(await probeTcpImpl(restPort, { host: '127.0.0.1' }));
  }
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    hostname: os.hostname(),
    addresses: localAddresses(),
    ports: {
      game: {
        value: ports.settingsPublicPort || ports.gamePort,
        source: ports.settingsPublicPort ? 'settings' : 'registration',
        evidence: EVIDENCE.CONFIGURED,
        protocol: 'udp',
      },
      query: { value: ports.queryPort, source: 'registration', evidence: EVIDENCE.CONFIGURED, protocol: 'udp' },
      rest: {
        value: ports.restPort || ports.settingsRestPort,
        source: ports.restPort ? 'registration' : 'settings',
        evidence: EVIDENCE.CONFIGURED,
        protocol: 'tcp',
        loopbackOnly: true,
      },
    },
    publicAddress: {
      value: ports.settingsPublicIp,
      state: ports.settingsPublicIp ? 'configured' : 'not_configured',
      evidence: EVIDENCE.CONFIGURED,
    },
    settingsReadable: ports.settingsReadable,
    mismatch: ports.mismatch,
    listeners,
    checklist: checklist({ ports, online }),
  };
}

function validEndpointHost(value) {
  const host = String(value || '').trim();
  if (!host || host.length > 253) return null;
  if (/^[a-z0-9.-]+$/i.test(host) || net.isIP(host)) return host;
  return null;
}

/*
 * A requested public probe is an SSRF surface: the operator's host input must
 * never reach internal services. `validEndpointHost` only checks the shape;
 * this rejects addresses and names that name a private, loopback, link-local,
 * or otherwise reserved target before any socket is opened (CodeQL
 * js/request-forgery). A hostname that is not an IP literal is accepted when
 * its name cannot be internal; the probe still only observes the connect
 * result and never assumes the router is misconfigured.
 */
function isPublicProbeTarget(host) {
  const value = String(host || '').trim().toLowerCase();
  if (!value) return false;
  if (net.isIP(value)) {
    if (net.isIPv4(value)) {
      const parts = value.split('.').map(Number);
      const [a, b] = parts;
      if (a === 0 || a === 10 || a === 127) return false; // 0.0.0.0/8, 10.0.0.0/8, loopback
      if (a === 169 && b === 254) return false; // link-local
      if (a === 172 && b >= 16 && b <= 31) return false; // 172.16.0.0/12
      if (a === 192 && b === 168) return false; // 192.168.0.0/16
      if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT 100.64.0.0/10
      if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
      if (a >= 224) return false; // multicast and reserved
      return true;
    }
    if (value === '::' || value === '::1' || value.startsWith('fe80:') || value.startsWith('fc') || value.startsWith('fd') || value.startsWith('ff')) return false;
    if (value.startsWith('::ffff:')) {
      const mapped = value.slice('::ffff:'.length);
      return net.isIPv4(mapped) ? isPublicProbeTarget(mapped) : false;
    }
    return true;
  }
  if (value === 'localhost' || value.endsWith('.local') || value.endsWith('.internal')
    || value.endsWith('.home.arpa') || value.endsWith('.localhost')) return false;
  return true;
}

function invalidEndpointHost() {
  return Object.assign(new Error('Only public addresses can be probed.'), { status: 400, code: 'invalid_host' });
}

async function lookupAll(host) {
  return dns.promises.lookup(host, { all: true, verbatim: true });
}

/*
 * Resolve the requested name before opening the socket. Checking only the
 * spelling of a hostname is not enough: DNS can point a public-looking name at
 * loopback or a private network. The socket receives the validated address, not
 * the original hostname, so a later DNS answer cannot redirect the connection.
 */
async function resolvePublicProbeAddress(host, lookupImpl = lookupAll) {
  let records;
  try {
    records = await lookupImpl(host);
  } catch {
    throw invalidEndpointHost();
  }
  const addresses = Array.isArray(records) ? records : [records];
  if (!addresses.length || addresses.some((record) => !record || !net.isIP(record.address) || !isPublicProbeTarget(record.address))) {
    throw invalidEndpointHost();
  }
  return { address: String(addresses[0].address), family: net.isIP(addresses[0].address) };
}

/*
 * An explicitly requested external probe. The result deliberately carries its
 * own interpretation: a refused or timed-out connection has many causes (the
 * probe leaves from inside the same network, UDP is not probeable at all, an
 * ISP may filter), so the response says what was tried and what it does not
 * prove.
 */
async function testEndpoint({ host, port, timeoutMs = PUBLIC_PROBE_TIMEOUT_MS, probeTcpImpl = probeTcp, lookupImpl = lookupAll } = {}) {
  const target = validEndpointHost(host);
  if (!target) throw Object.assign(new Error('Enter a host name or IP address to test.'), { status: 400, code: 'invalid_host' });
  if (!isPublicProbeTarget(target)) {
    throw invalidEndpointHost();
  }
  const number = Number(port);
  if (!Number.isInteger(number) || number < 1 || number > 65535) {
    throw Object.assign(new Error('Enter a port between 1 and 65535.'), { status: 400, code: 'invalid_port' });
  }
  const resolved = await resolvePublicProbeAddress(target, lookupImpl);
  const result = await probeTcpImpl(number, { host: resolved.address, family: resolved.family, timeoutMs });
  return {
    ok: true,
    requested: { host: target, port: number, protocol: 'tcp' },
    result: result.state,
    detail: result.detail,
    evidence: EVIDENCE.OBSERVED,
    interpretation: result.state === 'listening'
      ? 'Something accepted a TCP connection at that address and port from this machine.'
      : 'No TCP connection was accepted from this machine. This does not prove the router is misconfigured: the game port is UDP, probes from inside the network often fail, and networks may filter the attempt.',
  };
}

module.exports = {
  EVIDENCE,
  localAddresses,
  configuredPorts,
  probeTcp,
  probeUdp,
  checklist,
  report,
  testEndpoint,
};
