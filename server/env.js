// Tiny .env loader and startup configuration. Values are never printed or logged.
import fs from 'node:fs';
import os from 'node:os';

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function unquote(raw) {
  const value = raw.trim();
  const quote = value[0];
  if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
    const inner = value.slice(1, -1);
    return quote === '"' ? inner.replace(/\\n/g, '\n').replace(/\\"/g, '"') : inner;
  }
  const hash = value.search(/\s#/); // unquoted values may carry a trailing comment
  return hash === -1 ? value : value.slice(0, hash).trim();
}

// Parses KEY=VALUE lines. Ignores blank lines, comments and malformed lines.
export function parseEnv(text) {
  const out = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^export\s+/, '');
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (KEY_RE.test(key)) out[key] = unquote(line.slice(eq + 1));
  }
  return out;
}

// Applies a .env file to env without overriding variables that are already set.
// Returns the names (never the values) of the variables it applied.
export function loadEnvFile(file, env = process.env) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw new ConfigError(`Could not read the env file (${err && err.code ? err.code : 'error'})`);
  }
  const applied = [];
  for (const [key, value] of Object.entries(parseEnv(text))) {
    if (env[key] === undefined || env[key] === '') {
      env[key] = value;
      applied.push(key);
    }
  }
  return applied;
}

const MODES = ['live', 'replay', 'auto'];

// Validates the environment. The API key itself is not part of the result.
export function resolveConfig(env = process.env) {
  const portRaw = env.PORT === undefined || env.PORT === '' ? '3000' : String(env.PORT);
  const port = Number(portRaw);
  if (!/^\d+$/.test(portRaw) || port > 65535) {
    throw new ConfigError('PORT must be an integer between 0 and 65535');
  }
  const requestedMode = (env.SARVAM_MODE || 'auto').trim().toLowerCase();
  if (!MODES.includes(requestedMode)) {
    throw new ConfigError('SARVAM_MODE must be one of: live, replay, auto');
  }
  const apiKeyPresent = typeof env.SARVAM_API_KEY === 'string' && env.SARVAM_API_KEY.trim() !== '';
  const certFile = env.CERT_FILE || '';
  const keyFile = env.KEY_FILE || '';
  if (Boolean(certFile) !== Boolean(keyFile)) {
    throw new ConfigError('Set both CERT_FILE and KEY_FILE for HTTPS, or neither for HTTP');
  }
  const mode = requestedMode === 'auto' ? (apiKeyPresent ? 'live' : 'replay') : requestedMode;
  return { port, requestedMode, mode, apiKeyPresent, certFile, keyFile, https: Boolean(certFile) };
}

export function readTls({ certFile, keyFile }) {
  try {
    return { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) };
  } catch (err) {
    throw new ConfigError(`Could not read CERT_FILE or KEY_FILE (${err && err.code ? err.code : 'error'})`);
  }
}

// Non-internal IPv4 addresses a phone on the same network can reach.
export function lanAddresses(interfaces = os.networkInterfaces()) {
  return Object.values(interfaces)
    .flatMap((list) => list || [])
    .filter((a) => (a.family === 'IPv4' || a.family === 4) && !a.internal)
    .map((a) => a.address);
}

export function bannerLines({ https = false, port, addresses = [], mode, requestedMode, apiKeyPresent }) {
  const scheme = https ? 'https' : 'http';
  const lines = [
    'malayalam-notch: Malayalam voice notes translated in the MacBook notch',
    `Sarvam mode: ${mode === 'live' ? 'LIVE' : 'REPLAY'} (SARVAM_MODE=${requestedMode}, SARVAM_API_KEY ${apiKeyPresent ? 'set' : 'not set'})`,
    `Laptop:    ${scheme}://localhost:${port}/dashboard`,
  ];
  if (addresses.length === 0) lines.push('Phone:     no LAN address found; connect the laptop to a network');
  for (const address of addresses) lines.push(`Phone:     ${scheme}://${address}:${port}/phone`);
  if (requestedMode === 'live' && !apiKeyPresent) {
    lines.push('Warning: SARVAM_MODE=live but SARVAM_API_KEY is not set; live calls will fail');
  }
  if (!https) {
    lines.push('Note: phone microphone in a browser usually needs HTTPS (set CERT_FILE and KEY_FILE); without it the phone page may not be able to record');
  }
  return lines;
}
