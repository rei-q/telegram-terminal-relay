// Sessions on this machine: list them, start one in the background, hand a message to a running one.
// Uses the Claude Code CLI's own session list and its native session messaging, so nothing is typed into a
// terminal and no inbox file is written. Other agents use mailbox mode (relay listen / say), which needs no CLI.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { createInterface } from 'node:readline';
import { childEnv } from './lib.mjs';

const FAKE = process.env.TTR_SESSIONS_FAKE; // test seam: a folder that stands in for the CLI
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The Claude Code CLI version these calls were tested with. Older versions may lack one of them.
export const MIN_CLAUDE = '2.1.323';
// Modes the CLI accepts for --permission-mode. Sessions started from the phone default to acceptEdits: file edits
// in the project go ahead, anything else waits for approval. "inherit" passes no flag (the user's own settings).
export const PERMISSION_MODES = ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'];
export const DEFAULT_PERMISSION_MODE = 'acceptEdits';

const isFile = (f) => { try { return fs.statSync(f).isFile(); } catch { return false; } };
// Returns { cmd, pre } to run the CLI without a shell, or { unusable } with the reason. Text from Telegram never
// becomes part of a shell command line.
export function findClaude(env = process.env, platform = process.platform, home = os.homedir()) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  let found = env.TTR_CLAUDE_BIN || null;
  const names = platform === 'win32' ? ['claude.exe', 'claude.cmd'] : ['claude'];
  for (const d of found ? [] : [p.join(home, '.local', 'bin'), ...String(env.PATH || '').split(platform === 'win32' ? ';' : ':')]) {
    const hit = d && names.map((n) => p.join(d, n)).find(isFile);
    if (hit) { found = hit; break; }
  }
  if (!found) return { cmd: names[0], pre: [] };   // reported as "not found" when it is run
  if (/\.[cm]?js$/i.test(found)) return { cmd: process.execPath, pre: [found] };
  if (/\.(cmd|bat)$/i.test(found)) {
    // An npm launcher needs a shell to start. Its JavaScript entry point is run with Node directly instead.
    const js = p.join(p.dirname(found), 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
    if (isFile(js)) return { cmd: process.execPath, pre: [js] };
    return { cmd: found, pre: [], unusable: `found ${found}, a launcher that cannot be started without a shell. Set TTR_CLAUDE_BIN to claude.exe or to the CLI's cli.js` };
  }
  return { cmd: found, pre: [] };
}
const BIN = findClaude();

// A session started from here must be its own top-level session, not a child of whatever started the listener,
// and it never inherits the bot token.
export function sessionEnv() {
  const e = childEnv();
  for (const k of Object.keys(e)) if (/^(CLAUDE_CODE_|CLAUDECODE$|CLAUDE_PID$|TTR_LABEL$)/.test(k)) delete e[k];
  return e;
}
const run = (args, cwd, timeout = 60000) => new Promise((resolve, reject) => {
  if (BIN.unusable) return reject(Object.assign(new Error(BIN.unusable), { missing: true }));
  execFile(BIN.cmd, [...BIN.pre, ...args], { cwd, env: sessionEnv(), timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
    (err, stdout, stderr) => (err ? reject(Object.assign(new Error(err.code === 'ENOENT' ? 'the claude command was not found' : err.killed ? 'the claude command timed out' : (String(stderr || '').trim().split(/\r?\n/)[0] || `claude exit ${err.code}`).slice(0, 160)), { missing: err.code === 'ENOENT' })) : resolve(stdout)));
});
const fakeFile = (name) => path.join(FAKE, name);
const fakeRead = (name, fallback) => { try { return JSON.parse(fs.readFileSync(fakeFile(name), 'utf8')); } catch { return fallback; } };

export function permissionArgs(mode) {
  const m = mode || DEFAULT_PERMISSION_MODE;
  if (m === 'inherit') return [];
  if (!PERMISSION_MODES.includes(m)) throw new Error(`sessionPermissionMode "${m}" is not one of ${PERMISSION_MODES.join(', ')}, inherit`);
  return ['--permission-mode', m];
}

const newer = (a, b) => { // true when version a >= b
  const x = a.split('.').map(Number); const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); }
  return true;
};

// Checks once that the CLI calls this module depends on exist. Returns { ok, version, line }: line is one plain
// sentence for the log, status and Telegram.
export async function checkClaude() {
  if (FAKE) return fakeRead('claude.json', { ok: true, version: 'fake', line: 'Claude Code CLI: fake (test)' });
  const fallback = 'Mailbox mode (relay listen, relay say) still works without it.';
  let version;
  try { version = (/(\d+\.\d+\.\d+)/.exec(await run(['--version'], os.homedir(), 20000)) || [])[1]; }
  catch (e) { return { ok: false, version: null, line: `Claude Code CLI not found (${e.message}); sessions cannot be started or messaged from the phone. ${fallback}` }; }
  const missing = [];
  try {
    const help = await run(['--help'], os.homedir(), 20000);
    if (!/--bg\b/.test(help)) missing.push('claude --bg');
    if (!/--permission-mode\b/.test(help)) missing.push('claude --permission-mode');
    for (const sub of ['agents', 'stop', 'rm', 'mcp']) if (!new RegExp(`^\\s+${sub}\\b`, 'm').test(help) && !new RegExp(`^\\s+\\w+\\|${sub}\\b`, 'm').test(help)) missing.push(`claude ${sub}`);
    const ag = await run(['agents', '--help'], os.homedir(), 20000);
    if (!/--json\b/.test(ag)) missing.push('claude agents --json');
    const tools = await mcpTools();
    for (const t of ['ListAgents', 'SendMessage']) if (!tools.includes(t)) missing.push(`claude mcp serve ${t}`);
  } catch (e) { missing.push(`(check failed: ${e.message})`); }
  const old = version && !newer(version, MIN_CLAUDE) ? ` Version ${version} is older than the tested ${MIN_CLAUDE}.` : '';
  if (missing.length) return { ok: false, version, line: `Claude Code CLI ${version || '?'} lacks ${missing.join(', ')}; sessions from the phone are off.${old} ${fallback}` };
  return { ok: true, version, line: `Claude Code CLI ${version}: ok (tested with ${MIN_CLAUDE}).${old}` };
}

// all: also include background sessions that already finished (they stay on the list until removed).
export async function listSessions(all = false) {
  if (FAKE) return fakeRead('sessions.json', []);
  const list = JSON.parse(await run(['agents', '--json', ...(all ? ['--all'] : [])], os.homedir(), 30000));
  if (!Array.isArray(list)) throw new Error('claude agents: unexpected output');
  return list;
}
export async function findSession({ sessionId, name }) {
  const hits = (await listSessions()).filter((s) => (sessionId ? s.sessionId === sessionId : s.name === name));
  return hits.length === 1 ? hits[0] : null;
}

// Starts a new background session with this prompt. Resolves once the session appears in the session list.
export async function startSession({ name, cwd, prompt, mode }) {
  const perm = permissionArgs(mode);
  if (FAKE) {
    const s = { name, cwd, kind: 'background', status: 'busy', sessionId: `fake-${name}`, pid: 1 };
    const env = sessionEnv();
    fs.writeFileSync(fakeFile(`start-${name}.json`), JSON.stringify({ ...s, prompt, permission: perm, tokenInSessionEnv: 'TTR_BOT_TOKEN' in env, tokenInListenerEnv: 'TTR_BOT_TOKEN' in process.env }));
    fs.writeFileSync(fakeFile('sessions.json'), JSON.stringify([...fakeRead('sessions.json', []), s]));
    return s;
  }
  await run(['--bg', '--name', name, ...perm, '--', prompt], cwd);
  for (let i = 0; i < 40; i++) {
    const s = await findSession({ name }).catch(() => null);
    if (s) return s;
    await sleep(750);
  }
  throw new Error('the session was launched but did not show up in the session list');
}

// Talks to `claude mcp serve` over stdio (JSON-RPC, one object per line).
function mcpClient() {
  if (BIN.unusable) throw new Error(BIN.unusable);
  const p = spawn(BIN.cmd, [...BIN.pre, 'mcp', 'serve'], { cwd: os.homedir(), env: sessionEnv(), stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  const waiting = new Map(); let seq = 0; let dead = null;
  const failAll = (e) => { dead = dead || e; for (const w of waiting.values()) w.reject(dead); waiting.clear(); };
  p.on('error', failAll); p.stdin.on('error', failAll); p.on('exit', () => failAll(new Error('the session message server stopped')));
  createInterface({ input: p.stdout }).on('line', (line) => {
    let j; try { j = JSON.parse(line); } catch { return; }
    const w = waiting.get(j && j.id); if (!w) return;
    waiting.delete(j.id); clearTimeout(w.timer);
    if (j.error) w.reject(new Error(j.error.message || 'message server error')); else w.resolve(j.result);
  });
  const rpc = (method, params = {}) => new Promise((resolve, reject) => {
    if (dead) return reject(dead);
    const id = ++seq;
    const timer = setTimeout(() => { waiting.delete(id); reject(Object.assign(new Error(`timeout during ${method}${params.name ? ` ${params.name}` : ''}`), { timeout: true })); }, Number(process.env.TTR_MCP_TIMEOUT_MS || 45000));
    waiting.set(id, { resolve, reject, timer });
    p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const init = async () => {
    await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'telegram-terminal-relay', version: '0.1.0' } });
    p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  };
  return { rpc, init, close: () => p.kill() };
}
async function mcpTools() {
  const c = mcpClient();
  try { await c.init(); const r = await c.rpc('tools/list'); return ((r && r.tools) || []).map((t) => t.name); } finally { c.close(); }
}

// Hands a message to a running session. ok means the session will read it, not that it has acted on it.
// maybe means the hand-over timed out after it was sent: it may have arrived, so the caller must not start a
// second session for the same message.
export async function sendToSession(target, summary, message) {
  if (FAKE) {
    if (fs.existsSync(fakeFile('send-times-out'))) { fs.unlinkSync(fakeFile('send-times-out')); return { ok: false, maybe: true, why: 'timeout during tools/call SendMessage' }; }
    fs.appendFileSync(fakeFile('sent.jsonl'), `${JSON.stringify({ to: target.name, summary, message })}\n`);
    return { ok: true };
  }
  const c = mcpClient();
  let sending = false;
  const call = async (name, args) => {
    const r = await c.rpc('tools/call', { name, arguments: args });
    const text = r && r.content && (r.content.find((x) => x.type === 'text') || {}).text;
    if (r && r.isError) throw new Error(`${name} refused: ${String(text || '').slice(0, 160)}`);
    try { return JSON.parse(text); } catch { throw new Error(`${name}: unexpected result`); }
  };
  try {
    await c.init();
    const listing = await call('ListAgents', {});
    const rows = (listing.sections || []).filter((s) => s.kind === 'sessions').flatMap((s) => s.rows || []).filter((r) => r.name === target.name);
    if (rows.length !== 1) return { ok: false, why: rows.length ? 'two sessions share that name' : 'that session cannot be messaged right now' };
    sending = true;
    const r = await call('SendMessage', { to: rows[0].ref ? `${rows[0].name} [${rows[0].ref}]` : rows[0].name, summary, message });
    return r && r.success === true ? { ok: true } : { ok: false, why: String((r && (r.error || r.message)) || 'the session did not accept the message').slice(0, 160) };
  } catch (e) { return { ok: false, maybe: sending && !!e.timeout, why: e.message }; } finally { c.close(); }
}

// Ends a session. A background session is stopped through the CLI (its conversation is kept); an interactive
// session can only have its process ended.
export async function stopSession(s) {
  if (FAKE) {
    fs.writeFileSync(fakeFile('sessions.json'), JSON.stringify(fakeRead('sessions.json', []).filter((x) => x.sessionId !== s.sessionId)));
    return;
  }
  if (s.kind === 'background' && s.id) {
    const finished = s.state === 'done';
    if (!finished) await run(['stop', s.id], os.homedir());
    // Also removed from the session list. The conversation stays (claude --resume lists it).
    try { await run(['rm', s.id], os.homedir()); } catch (e) { if (finished) throw e; }
    return;
  }
  if (!Number.isInteger(s.pid)) throw new Error('that session has no process to end');
  if (process.platform !== 'win32') { process.kill(s.pid, 'SIGTERM'); return; }
  await new Promise((resolve, reject) => execFile('taskkill', ['/PID', String(s.pid), '/T', '/F'], { env: childEnv(), windowsHide: true }, (e) => (e ? reject(new Error('the process could not be ended')) : resolve())));
}
