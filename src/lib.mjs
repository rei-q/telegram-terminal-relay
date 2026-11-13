// Shared parts of Telegram Terminal Relay: paths, config, Telegram calls, the pending and done stores, and the
// signed control channel to the listener.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { APP, resolveDataDir } from './paths.mjs';
import { readToken, helperEnv } from './secret.mjs';

export { APP };
export const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));

export const DATA_DIR = resolveDataDir();
export const PORT = Number(process.env.TTR_PORT || 47901);
const API = process.env.TTR_API || 'https://api.telegram.org';
export const PENDING = path.join(DATA_DIR, 'pending');
export const DONE = path.join(DATA_DIR, 'done');
export const LOGS = path.join(DATA_DIR, 'logs');
const CONFIG = path.join(DATA_DIR, 'config.json');
export const OFFSET = path.join(DATA_DIR, 'offset.json');   // the last Telegram update handled, kept across restarts
export const INBOX = path.join(DATA_DIR, 'inbox');         // packages from agents on another machine; never the owner's word
export const ACKS = path.join(DATA_DIR, 'acks');           // delivery receipts for packages sent from this machine
export const MSGS = path.join(DATA_DIR, 'msgs');           // owner messages from Telegram, signed by the listener
export const CLOSABLE = path.join(DATA_DIR, 'closable');   // sessions the owner may end from Telegram
export const SENT = path.join(DATA_DIR, 'sent');           // which session sent which Telegram message, so a reply finds it
export const THREADS = path.join(DATA_DIR, 'threads');     // one record per conversation; the id is shared across machines
export const FILES = path.join(DATA_DIR, 'files');         // attachments received from the owner, one folder per message
export const SESSIONS = path.join(DATA_DIR, 'sessions');   // one record per terminal label: its topic and its message ids
export const MAIL = path.join(DATA_DIR, 'mail');           // owner messages queued per terminal
export const LISTENING = path.join(DATA_DIR, 'listening'); // heartbeat files of terminals waiting for a message
// Security: the data folder is private to this OS user on macOS and Linux (mode 0700).
fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
for (const d of [PENDING, DONE, LOGS, INBOX, ACKS, MSGS, SENT, THREADS, FILES, CLOSABLE, SESSIONS, MAIL, LISTENING]) fs.mkdirSync(d, { recursive: true });

// A terminal is identified by its label ("terminal 4"); the key is its file-safe form.
export const keyOf = (label) => String(label || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'default';
export const getSession = (key) => readJson(path.join(SESSIONS, `${key}.json`));
export function listSessions() {
  return fs.readdirSync(SESSIONS).filter((f) => f.endsWith('.json')).map((f) => readJson(path.join(SESSIONS, f))).filter(Boolean);
}
export function noteSession(key, patch, ids = []) {
  const s = getSession(key) || { key, msgIds: [] };
  Object.assign(s, patch);
  s.msgIds = [...(s.msgIds || []), ...ids].slice(-300);
  s.ts = Date.now();
  writeJson(path.join(SESSIONS, `${key}.json`), s);
  return s;
}
export function mailDir(key, sub = '') {
  const d = path.join(MAIL, key, sub);
  fs.mkdirSync(d, { recursive: true });
  return d;
}
export function listMail(key) {
  const d = mailDir(key);
  return fs.readdirSync(d).filter((f) => f.endsWith('.json')).sort().map((f) => ({ ...readJson(path.join(d, f), {}), file: path.join(d, f) })).filter((m) => m.id);
}
export function findMail(id) {
  if (!validId(id)) return null;
  for (const k of fs.readdirSync(MAIL)) {
    for (const sub of ['', 'taken', 'read']) {
      const d = path.join(MAIL, k, sub);
      if (!fs.existsSync(d)) continue;
      const f = fs.readdirSync(d).find((n) => n.endsWith(`-${id}.json`));
      if (f) return readJson(path.join(d, f));
    }
  }
  return null;
}

// Machine to machine messages travel as posts in a private channel where both bots are admins (optional).
export const PEER_MAX = 20 * 1024 * 1024; // the Bot API lets a bot download at most 20 MB
export const DEFAULT_NAME = 'machine';
export const peerName = (c) => String(c.pcName || DEFAULT_NAME).replace(/\s+/g, '-');
export const validThread = (t) => /^\d{1,12}$/.test(String(t || ''));
export const peerHead = ({ from, to, id, kind, ref, thread }) => `#peer v1 from=${from} to=${to} id=${id} kind=${kind}${ref ? ` ref=${ref}` : ''}${validThread(thread) ? ` thread=${thread}` : ''}`;
export function parsePeer(text) {
  const m = /^#peer v1 from=(\S+) to=(\S+) id=([a-f0-9]{8}) kind=(ping|ack|note)(?: ref=([a-f0-9]{8}))?[^\n]*(?:\n([\s\S]*))?$/.exec(String(text || ''));
  if (!m) return null;
  // The thread number is an optional field on the head line; a listener that does not know it ignores it.
  const t = / thread=(\d{1,12})(?= |$)/.exec(String(text).split('\n')[0]);
  return { from: m[1], to: m[2], id: m[3], kind: m[4], ref: m[5] || null, thread: t ? t[1] : null, note: (m[6] || '').trim() };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export const validId = (id) => /^[a-f0-9]{8}$/.test(String(id || ''));

// Security: every tag, code and mac comparison runs in constant time. Both sides are hashed first, so strings of
// different lengths compare without leaking the length either.
export function safeEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const h = (s) => crypto.createHash('sha256').update(s).digest();
  return crypto.timingSafeEqual(h(a), h(b));
}

// A one-time pairing code: 10 characters of base32 (50 bits), easy to read and valid in a t.me start link.
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const pairCode = () => [...crypto.randomBytes(10)].map((x) => B32[x & 31]).join('');

// Security: file names that usually hold secrets are refused on every outgoing --file.
const SECRET_NAMES = [/^\.env/i, /\.pem$/i, /\.key$/i, /^\.npmrc$/i, /^id_(rsa|dsa|ecdsa|ed25519)/i, /\.p12$/i, /\.pfx$/i, /\.ppk$/i,
  /^[._]netrc$/i, /^\.git-credentials$/i, /^credentials/i, /token/i, /\.kdbx$/i, /auth\.json$/i, /cookies/i];
export const secretLooking = (file) => SECRET_NAMES.some((re) => re.test(path.basename(String(file || ''))));

export function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
export function writeJson(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}
// Security: config.json is trusted. Anything that can write it runs as this OS user, which is the trust boundary.
export const cfg = () => readJson(CONFIG, {});
export const saveCfg = (c) => writeJson(CONFIG, c);

export function log(line) {
  const file = path.join(LOGS, 'relayd.log');
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > 5 * 1024 * 1024) fs.renameSync(file, `${file}.1`);
    fs.appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
  } catch { /* logging must never break the tool */ }
}

// Environment for any child process: never the token (sessions must not be able to read it).
export const childEnv = helperEnv;

let tokenCache = null;
let tokenFrom = null;
export function setToken(t) { tokenCache = t; tokenFrom = t ? 'setup' : null; }
export const tokenSource = () => tokenFrom;
// Lookup order: 1. the store chosen at setup (config.json "tokenStore"), 2. the TTR_BOT_TOKEN variable.
export function token() {
  if (tokenCache) return tokenCache;
  const store = cfg().tokenStore;
  let t = store ? readToken(store, DATA_DIR) : null;
  if (t) tokenFrom = store;
  else if (process.env.TTR_BOT_TOKEN) { t = process.env.TTR_BOT_TOKEN; tokenFrom = 'env'; }
  if (!t) throw new Error(store ? `the bot token could not be read from its store (${store}). Run the setup command again in your own terminal.` : 'no bot token on this machine yet. Run the setup command in your own terminal.');
  tokenCache = t;
  return t;
}

function tgError(method, status, j) {
  const err = new Error(`telegram ${method}: ${j.error_code || status} ${j.description || ''}`.trim());
  err.code = j.error_code || status;
  err.retryAfter = j.parameters && j.parameters.retry_after;
  return err;
}
async function tgFetch(method, init, timeoutMs) {
  let res;
  try {
    res = await fetch(`${API}/bot${token()}/${method}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    // Security: the request URL contains the token, so it is never included in an error message.
    throw new Error(`telegram ${method}: ${e && e.name === 'TimeoutError' ? 'timeout' : 'network error'}`);
  }
  const j = await res.json().catch(() => ({}));
  if (!j.ok) throw tgError(method, res.status, j);
  return j.result;
}
export function tg(method, params = {}, timeoutMs = 20000) {
  return tgFetch(method, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params) }, timeoutMs);
}
export async function tgFile(method, field, filePath, params = {}) {
  const form = new FormData();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) form.append(k, String(v));
  form.append(field, await fs.openAsBlob(filePath), path.basename(filePath));
  return tgFetch(method, { method: 'POST', body: form }, 180000);
}
export async function tgDownload(fileId, dest) {
  const f = await tg('getFile', { file_id: fileId });
  let res;
  try { res = await fetch(`${API}/file/bot${token()}/${f.file_path}`, { signal: AbortSignal.timeout(180000) }); }
  catch { throw new Error('telegram download: network error'); }
  if (!res.ok) throw new Error(`telegram download: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > PEER_MAX) throw new Error('over 20 MB');
  fs.writeFileSync(dest, buf);
  return buf.length;
}
// Retries network errors and timeouts only: a refusal from Telegram is final.
export async function retry(send, tries = 4) {
  for (let i = 1; ; i++) {
    try { return await send(); } catch (e) {
      if (i >= tries || !/network error|timeout/.test(e.message)) throw e;
      await sleep(Number(process.env.TTR_RETRY_MS || 1500) * i);
    }
  }
}

// A question is answered exactly once: the process that renames the pending file first owns the answer.
export function claim(id) {
  if (!validId(id)) return null;
  const p = path.join(PENDING, `${id}.json`);
  const c = `${p}.claimed`;
  try { fs.renameSync(p, c); } catch { return null; }
  return { rec: readJson(c), c };
}
// Puts a claimed question back, still open.
export function unclaim(cl) {
  try { fs.renameSync(cl.c, path.join(PENDING, `${cl.rec.id}.json`)); } catch { /* gone */ }
}
export function finish(cl, answer) {
  cl.rec.answer = answer;
  writeJson(path.join(DONE, `${cl.rec.id}.json`), cl.rec);
  try { fs.unlinkSync(cl.c); } catch { /* already gone */ }
  return cl.rec;
}
export const getPending = (id) => (validId(id) ? readJson(path.join(PENDING, `${id}.json`)) : null);
export const getDone = (id) => (validId(id) ? readJson(path.join(DONE, `${id}.json`)) : null);
export const getMsg = (id) => (validId(id) ? readJson(path.join(MSGS, `${id}.json`)) : null);
export const getThread = (tid) => (validThread(tid) ? readJson(path.join(THREADS, `${tid}.json`)) : null);
// Telegram message id -> thread id, built once from the thread files and kept current by saveThread, so a reply
// finds its thread without reading every thread file.
let threadIdx = null;
function threadIndex() {
  if (threadIdx) return threadIdx;
  threadIdx = new Map();
  for (const f of fs.readdirSync(THREADS)) {
    const t = f.endsWith('.json') ? readJson(path.join(THREADS, f)) : null;
    if (t && Array.isArray(t.msgIds)) for (const m of t.msgIds) threadIdx.set(m, t.tid);
  }
  return threadIdx;
}
export function saveThread(t) {
  writeJson(path.join(THREADS, `${t.tid}.json`), t);
  const ix = threadIndex();
  for (const m of t.msgIds || []) ix.set(m, t.tid);
}
export const threadByMessage = (messageId) => (Number.isInteger(messageId) ? getThread(threadIndex().get(messageId)) : null);
// Records which session is behind each sent Telegram message, so a later reply to it reaches that session.
export function noteSent(msgIds, info) {
  for (const m of msgIds) writeJson(path.join(SENT, `${m}.json`), { ...info, ts: Date.now() });
}
// The session here that last wrote to another machine: that machine's next package is most likely its answer.
export const notePeer = (to, info) => writeJson(path.join(SENT, `peer-${keyOf(to)}.json`), { ...info, ts: Date.now() });
export const getPeer = (from) => readJson(path.join(SENT, `peer-${keyOf(from)}.json`));
export const getSent = (messageId) => (Number.isInteger(messageId) ? readJson(path.join(SENT, `${messageId}.json`)) : null);
export function listPending() {
  return fs.readdirSync(PENDING).filter((f) => f.endsWith('.json')).map((f) => readJson(path.join(PENDING, f))).filter(Boolean);
}
export function findByMessage(dir, messageId) {
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const rec = readJson(path.join(dir, f));
    if (rec && Array.isArray(rec.msgIds) && rec.msgIds.includes(messageId)) return rec;
  }
  return null;
}

// Removes records older than `days` from done/, sent/, msgs/, files/ and every terminal's read mail. Paths come
// only from the folder constants above, one entry at a time; links are never followed. Returns the count removed.
export function prune(days = 30, now = Date.now()) {
  const cut = now - days * 24 * 3600 * 1000;
  let n = 0;
  const list = (d) => { try { return fs.readdirSync(d); } catch { return []; } };
  const stat = (p) => { try { return fs.lstatSync(p); } catch { return null; } };
  const dropFile = (p) => { const s = stat(p); if (s && s.isFile() && s.mtimeMs < cut) { try { fs.unlinkSync(p); n++; } catch { /* in use */ } } };
  for (const dir of [DONE, SENT, MSGS]) for (const f of list(dir)) dropFile(path.join(dir, f));
  for (const k of list(MAIL)) {
    const read = path.join(MAIL, k, 'read');
    const s = stat(read);
    if (s && s.isDirectory()) for (const f of list(read)) dropFile(path.join(read, f));
  }
  for (const d of list(FILES)) {
    const dir = path.join(FILES, d);
    const s = stat(dir);
    if (!s || !s.isDirectory() || s.mtimeMs >= cut) continue;
    for (const f of list(dir)) { const p = path.join(dir, f); const sf = stat(p); if (sf && sf.isFile()) { try { fs.unlinkSync(p); } catch { /* in use */ } } }
    try { fs.rmdirSync(dir); n++; } catch { /* not empty: left alone */ }
  }
  return n;
}

// Control channel to the listener on 127.0.0.1.
// Security: any local process could bind the port first and claim to be the listener, and any local account can
// connect to it. So both directions carry an HMAC made with a 32-byte per-install key that only this OS user can
// read: the client signs its request with a fresh nonce, and accepts a reply only when it is signed over that nonce
// and the reply body. A program without the key can neither ask nor answer.
const KEY_FILE = path.join(DATA_DIR, 'control.key');
let keyCache = null;
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
export function controlKey() {
  if (keyCache) return keyCache;
  for (let i = 0; i < 40; i++) {
    let k = null;
    try { k = fs.readFileSync(KEY_FILE); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (k && k.length === 32) return (keyCache = k);
    if (!k) {
      // The complete key is written to a private temp file first and then linked into place, which fails when
      // another process got there first; a reader therefore never sees a partial key.
      const fresh = crypto.randomBytes(32);
      const tmp = `${KEY_FILE}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      fs.writeFileSync(tmp, fresh, { mode: 0o600, flag: 'wx' });
      restrictToUser(tmp);
      let placed = false;
      try { fs.linkSync(tmp, KEY_FILE); placed = true; } catch (e) {
        if (e.code !== 'EEXIST') {   // no hard links on this file system: exclusive create instead
          try { fs.writeFileSync(KEY_FILE, fresh, { mode: 0o600, flag: 'wx' }); restrictToUser(KEY_FILE); placed = true; } catch (e2) { if (e2.code !== 'EEXIST') { try { fs.unlinkSync(tmp); } catch { /* left */ } throw e2; } }
        }
      }
      try { fs.unlinkSync(tmp); } catch { /* already gone */ }
      if (placed) return (keyCache = fresh);
    }
    pause(50);   // another process is creating the key right now
  }
  throw new Error(`the control key ${KEY_FILE} is damaged (it must be 32 bytes). Stop the listener, delete that file, and start it again.`);
}
// Windows ignores the 0600 mode: the file's access list is reduced to the current user instead (best effort).
export function restrictToUser(file) {
  if (process.platform !== 'win32') { try { fs.chmodSync(file, 0o600); } catch { /* best effort */ } return; }
  const who = process.env.USERDOMAIN && process.env.USERNAME ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}` : os.userInfo().username;
  try { execFileSync('icacls', [file, '/inheritance:r', '/grant:r', `${who}:F`], { env: helperEnv(), stdio: 'ignore', windowsHide: true, timeout: 15000 }); } catch { /* best effort */ }
}
const mac = (parts) => crypto.createHmac('sha256', controlKey()).update(JSON.stringify(parts)).digest('hex');
export const signRequest = (n, cmd, args) => mac(['req', n, cmd, args]);
export const signReply = (n, body) => mac(['res', n, body]);

let problem = null;
export const daemonProblem = () => problem;
export function daemonCall(cmd, args = {}) {
  return new Promise((resolve) => {
    let buf = '';
    const n = crypto.randomBytes(16).toString('hex');
    const req = { n, cmd, args, mac: signRequest(n, cmd, args) };
    const s = net.createConnection({ port: PORT, host: '127.0.0.1' }, () => s.write(`${JSON.stringify(req)}\n`));
    const done = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(5000, () => done(null));
    s.on('data', (d) => { buf += d; if (buf.length > 1024 * 1024) done(null); });
    s.on('end', () => {
      let r = null;
      try { r = JSON.parse(buf); } catch { /* checked below */ }
      if (!r || typeof r.body !== 'string' || !safeEq(String(r.mac || ''), signReply(n, r.body))) {
        problem = `something answers on 127.0.0.1:${PORT} but not with this install's control key (another program, or a listener of another install)`;
        return done(null);
      }
      problem = null;
      try { done(JSON.parse(r.body)); } catch { done(null); }
    });
    s.on('error', () => { problem = null; done(null); });
  });
}
// The listener holds the local port as its single-instance lock and answers a status line on it.
export const probeDaemon = () => daemonCall('status');
// Security: asks the listener whether a recorded answer really came from the paired Telegram account.
export async function daemonVerify(id, tag, cmd = 'verify') {
  const r = await daemonCall(cmd, { id, tag: tag || undefined });
  return r && typeof r.ok === 'boolean' ? r : { ok: false, why: daemonProblem() || 'the listener is not running or did not answer' };
}
export async function ensureDaemon() {
  let st = await probeDaemon();
  if (st || problem) return st;
  // The only child that may receive the fallback token variable: the listener reads it and then removes it from
  // its own environment, so its sessions never see it.
  spawn(process.execPath, [path.join(TOOL_DIR, 'relayd.mjs')], { cwd: os.homedir(), detached: true, stdio: 'ignore', windowsHide: true }).unref();
  for (let i = 0; i < 20 && !st; i++) { await sleep(300); st = await probeDaemon(); }
  return st;
}
