const http = require('node:http');
const https = require('node:https');
const tls = require('node:tls');
const { X509Certificate, createHash, timingSafeEqual } = require('node:crypto');

const MAX_BODY = 2 * 1024 * 1024;
const MAX_RESPONSE = 70 * 1024 * 1024;
const ID = '[0-9a-fA-F-]{36}';
const API = new RegExp('^/(?:[A-Za-z0-9_-]+/)*api/(health|vaults(?:/' + ID + '/notes(?:/' + ID + ')?)?)$');
let active = 0;

function privateHost(host) {
  if (/^(?:localhost|\[::1\]|::1)$/i.test(host)) return true;
  // WHATWG URL interprets leading-zero octets as octal; accept canonical decimal only.
  if (!/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(host)) return false;
  const n = host.split('.').map(Number);
  if (n.some(value => value > 255)) return false;
  return n[0] === 127 || n[0] === 10 || n[0] === 192 && n[1] === 168 || n[0] === 172 && n[1] >= 16 && n[1] <= 31;
}

function validate(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || typeof args.url !== 'string' || args.url.length > 4096 || typeof args.method !== 'string')
    throw new Error('Invalid NoteMark sync request.');
  // Check the original path before URL normalization can remove dot segments or decode a host.
  const raw = /^(https?):\/\/([^/?#]+)(\/[^?#]*)$/.exec(args.url);
  if (!raw || /[\s\\%]/.test(raw[2]) || /[@]/.test(raw[2]) || !API.test(raw[3]))
    throw new Error('Use a NoteMark sync API on HTTPS or your local Wi-Fi.');
  let url;
  try { url = new URL(args.url); } catch { throw new Error('Invalid NoteMark sync address.'); }
  const rawHost = raw[2].startsWith('[') ? raw[2].slice(0, raw[2].indexOf(']') + 1) : raw[2].split(':')[0];
  if (url.username || url.password || url.search || url.hash || url.pathname !== raw[3] ||
      url.protocol !== 'https:' && !(url.protocol === 'http:' && privateHost(rawHost) && privateHost(url.hostname)))
    throw new Error('Use a NoteMark sync API on HTTPS or your local Wi-Fi.');
  const method = args.method;
  const allowed = method === 'GET' && (url.pathname.endsWith('/api/health') || url.pathname.endsWith('/notes')) ||
    method === 'POST' && url.pathname.endsWith('/api/vaults') ||
    method === 'PUT' && new RegExp('/notes/' + ID + '$').test(url.pathname);
  if (!allowed) throw new Error('Unsupported NoteMark sync operation.');
  for (const field of ['token', 'body', 'fingerprint'])
    if (args[field] !== undefined && typeof args[field] !== 'string') throw new Error('Invalid NoteMark sync request.');
  const token = args.token || '', body = args.body || '', fingerprint = args.fingerprint || '';
  if (token && !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('Invalid connection token.');
  if (fingerprint && (!/^[0-9a-fA-F]{64}$/.test(fingerprint) || url.protocol !== 'https:' || !privateHost(rawHost) || !privateHost(url.hostname)))
    throw new Error('A phone certificate fingerprint requires local HTTPS.');
  if (body.length > MAX_BODY || Buffer.byteLength(body, 'utf8') > MAX_BODY) throw new Error('This note is too large to sync.');
  const bytes = Buffer.from(body, 'utf8');
  if (method === 'GET' && bytes.length) throw new Error('Invalid sync request.');
  return { url, method, token, bytes, fingerprint };
}

function verifyPinnedCertificate(raw, fingerprint, now = Date.now()) {
  if (!Buffer.isBuffer(raw) || !/^[0-9a-fA-F]{64}$/.test(fingerprint)) throw new Error('The phone certificate could not be verified.');
  const expected = Buffer.from(fingerprint, 'hex'), actual = createHash('sha256').update(raw).digest();
  if (!timingSafeEqual(expected, actual)) throw new Error('The phone certificate changed. Check the private connection code again.');
  const certificate = new X509Certificate(raw);
  if (!(Date.parse(certificate.validFrom) <= now && now <= Date.parse(certificate.validTo)))
    throw new Error('The phone certificate has expired or is not valid yet.');
}

function timeoutError() { return Object.assign(new Error('NoteMark connection timed out.'), { code: 'timeout', name: 'TimeoutError' }); }

function pinnedAgent(fingerprint) {
  // A new agent per request prevents a socket verified for one phone from serving another pin.
  const agent = new https.Agent({ keepAlive: false, maxSockets: 1 });
  agent.createConnection = (options, callback) => {
    // Only this explicitly pinned, validated local request uses a private trust decision.
    // Do not hand the socket to HTTP until verification: no token/body can leave first.
    const socket = tls.connect({ ...options, rejectUnauthorized: false });
    let finished = false;
    const finish = error => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      if (error) { callback(error); socket.destroy(); }
      else { socket.removeListener('error', fail); callback(null, socket); }
    };
    const fail = error => finish(error);
    const timer = setTimeout(() => finish(timeoutError()), 10000);
    socket.once('error', fail);
    socket.once('secureConnect', () => {
      try { verifyPinnedCertificate(socket.getPeerCertificate(true).raw, fingerprint); finish(); }
      catch (error) { finish(error); }
    });
    // Returning a socket here would let Agent assign it before the pin is checked.
  };
  return agent;
}

async function request(args) {
  const options = validate(args);
  if (active >= 24) throw new Error('Please wait for the current connection to finish.');
  active++;
  try { return await send(options); } finally { active--; }
}

function send({ url, method, token, bytes, fingerprint }) {
  return new Promise((resolve, reject) => {
    const agent = fingerprint ? pinnedAgent(fingerprint) : null;
    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    if (method !== 'GET') { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = bytes.length; }
    const transport = url.protocol === 'https:' ? https : http;
    let settled = false, connectTimer;
    const finish = (error, result) => {
      if (settled) return;
      settled = true; clearTimeout(deadline); clearTimeout(connectTimer); agent?.destroy();
      if (error) { req.destroy(); reject(error); } else resolve(result);
    };
    const req = transport.request(url, { method, headers, agent: agent || false }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400) {
        response.destroy(); return finish(new Error('Use the final sync server address; redirects are not accepted.'));
      }
      if (Number(response.headers['content-length']) > MAX_RESPONSE) {
        response.destroy(); return finish(new Error('Sync response is too large.'));
      }
      const chunks = []; let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_RESPONSE) { response.destroy(); finish(new Error('Sync response is too large.')); }
        else chunks.push(chunk);
      });
      response.once('error', error => finish(error));
      response.once('aborted', () => finish(new Error('The sync response was interrupted.')));
      response.once('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
          if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
          finish(null, { status: response.statusCode, data });
        } catch { finish(new Error('This address is not a NoteMark sync server.')); }
      });
    });
    const deadline = setTimeout(() => finish(timeoutError()), 35000);
    req.once('error', error => finish(error));
    req.once('socket', socket => {
      if (socket.connecting) {
        connectTimer = setTimeout(() => finish(timeoutError()), 10000);
        socket.once(url.protocol === 'https:' ? 'secureConnect' : 'connect', () => clearTimeout(connectTimer));
      }
    });
    req.setTimeout(15000, () => finish(timeoutError()));
    req.end(method === 'GET' ? undefined : bytes);
  });
}

module.exports = { request, validate, privateHost, verifyPinnedCertificate, MAX_BODY, MAX_RESPONSE };
