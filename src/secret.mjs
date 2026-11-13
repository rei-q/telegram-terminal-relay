// Bot token storage with no dependencies. Order of lookup: the store chosen at setup (recorded in config.json as
// "tokenStore"), then the TTR_BOT_TOKEN environment variable as a fallback.
//   Windows: a DPAPI user-scope blob (PowerShell ConvertFrom-SecureString), only this OS user can decrypt it
//   macOS:   the login keychain (security add-generic-password / find-generic-password)
//   Linux:   the desktop secret service through secret-tool when present, else a file with mode 0600
// Security: the token never goes on a command line (argv is visible to other processes); it is passed on stdin.
// It is never logged, and it is written in plain text only by the Linux file fallback.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { APP } from './paths.mjs';

export const TOKEN_RE = /^\d{3,20}:[A-Za-z0-9_-]{20,100}$/;
const ACCOUNT = 'bot-token';

// The environment for every child process: no token variable, and no PSModulePath (a value set by a newer
// PowerShell keeps Windows PowerShell from loading its own modules).
export function helperEnv() {
  const e = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(TTR_BOT_TOKEN|PSModulePath)$/i.test(k)) e[k] = v;
  return e;
}

// Finds a program on PATH without running it.
export function hasCommand(name, env = process.env, platform = process.platform) {
  const exts = platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const d of String(env.PATH || '').split(path.delimiter)) {
    if (!d) continue;
    for (const x of exts) { try { if (fs.statSync(path.join(d, name + x)).isFile()) return true; } catch { /* not here */ } }
  }
  return false;
}

// Which store a new token goes into on this platform.
export function tokenBackend(platform = process.platform, has = hasCommand) {
  if (platform === 'win32') return 'dpapi';
  if (platform === 'darwin') return 'keychain';
  return has('secret-tool') ? 'secret-tool' : 'file';
}

export const describeBackend = (b) => ({
  dpapi: 'a file encrypted for your Windows user account (DPAPI)',
  keychain: 'your macOS login keychain',
  'secret-tool': 'your desktop keyring (secret-tool)',
  file: 'a file readable only by your user account (mode 0600; no keyring was found)',
  env: 'the TTR_BOT_TOKEN environment variable',
}[b] || b);

const run = (cmd, args, input) => execFileSync(cmd, args, { input, encoding: 'utf8', env: helperEnv(), windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], timeout: 30000 });
const ps = (script, input) => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], input);

function writePrivate(file, data) {
  fs.writeFileSync(file, data, { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* best effort on Windows */ }
}

// Stores the token; returns the name of the store used.
export function storeToken(t, dataDir) {
  if (!TOKEN_RE.test(t)) throw new Error('that does not look like a bot token from BotFather');
  const b = tokenBackend();
  if (b === 'dpapi') {
    const blob = ps('$t = [Console]::In.ReadLine(); $s = ConvertTo-SecureString -String $t -AsPlainText -Force; [Console]::Out.Write((ConvertFrom-SecureString -SecureString $s))', `${t}\n`).trim();
    if (!/^[0-9a-f]+$/i.test(blob)) throw new Error('Windows could not encrypt the token');
    writePrivate(path.join(dataDir, 'token.dpapi'), blob);
    return b;
  }
  if (b === 'keychain') {
    // `security -i` reads its commands from stdin, so the token is not in any process's argument list.
    run('security', ['-i'], `add-generic-password -U -a ${ACCOUNT} -s ${APP} -w "${t}"\n`);
    return b;
  }
  if (b === 'secret-tool') {
    try { run('secret-tool', ['store', `--label=${APP}`, 'service', APP, 'account', ACCOUNT], t); return b; } catch { /* no keyring running: file below */ }
  }
  writePrivate(path.join(dataDir, 'token'), t);
  return 'file';
}

// Reads the token from the named store; null when it is not there.
export function readToken(b, dataDir) {
  try {
    let t = null;
    if (b === 'dpapi') {
      const blob = fs.readFileSync(path.join(dataDir, 'token.dpapi'), 'utf8').trim();
      t = ps("$b = [Console]::In.ReadLine(); $s = ConvertTo-SecureString -String $b; [Console]::Out.Write([System.Net.NetworkCredential]::new('', $s).Password)", `${blob}\n`);
    } else if (b === 'keychain') t = run('security', ['find-generic-password', '-a', ACCOUNT, '-s', APP, '-w']);
    else if (b === 'secret-tool') t = run('secret-tool', ['lookup', 'service', APP, 'account', ACCOUNT]);
    else if (b === 'file') t = fs.readFileSync(path.join(dataDir, 'token'), 'utf8');
    t = String(t || '').trim();
    return t || null;
  } catch { return null; }
}

export function deleteToken(b, dataDir) {
  try {
    if (b === 'dpapi') fs.unlinkSync(path.join(dataDir, 'token.dpapi'));
    else if (b === 'keychain') run('security', ['delete-generic-password', '-a', ACCOUNT, '-s', APP]);
    else if (b === 'secret-tool') run('secret-tool', ['clear', 'service', APP, 'account', ACCOUNT]);
    else if (b === 'file') fs.unlinkSync(path.join(dataDir, 'token'));
    return true;
  } catch { return false; }
}
