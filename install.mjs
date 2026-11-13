#!/usr/bin/env node
// Copies the relay from this checkout into ~/.telegram-terminal-relay, so every machine runs the same files.
//   node install.mjs                  install, then run the offline test
//   node install.mjs --check          only report what differs; change nothing
//   node install.mjs --no-test        install without running the test
//   node install.mjs --uninstall      stop the listener, remove the login start and the installed files; keep the data
//   node install.mjs --uninstall --purge   also delete the data folder and the stored bot token
//   add --dry-run to --uninstall to only list what it would do
// Installing never touches the running listener, the bot token or the data folder.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { APP, resolveInstallDir, resolveDataDir } from './src/paths.mjs';
import { helperEnv } from './src/secret.mjs';

const REPO = path.dirname(fileURLToPath(import.meta.url));
const has = (f) => process.argv.includes(f);
const CHECK = has('--check');
const NO_TEST = has('--no-test');
const DEST = resolveInstallDir();

// [path in the repo, true when the listener loads it]
const FILES = [
  ['src/relay.mjs', false],
  ['src/relayd.mjs', true],
  ['src/lib.mjs', true],
  ['src/paths.mjs', true],
  ['src/secret.mjs', true],
  ['src/service.mjs', false],
  ['src/inbound.mjs', true],
  ['src/sessions.mjs', true],
  ['scripts/install-task.ps1', true],
  ['test/test.mjs', false],
  ['package.json', false],
];

if (path.resolve(REPO).toLowerCase() === path.resolve(DEST).toLowerCase()) {
  console.error('install: run this from the repository checkout, not from the installed folder');
  process.exit(1);
}
const [major] = process.versions.node.split('.').map(Number);
if (major < 20) { console.error(`install: Node 20 or newer is needed (this is ${process.version})`); process.exit(1); }

if (has('--uninstall')) await uninstall(); else install();

function install() {
  const changed = [];
  let restart = false;
  for (const [rel, listener] of FILES) {
    const dest = path.join(DEST, rel);
    const want = fs.readFileSync(path.join(REPO, rel));
    const have = fs.existsSync(dest) ? fs.readFileSync(dest) : null;
    if (have && have.equals(want)) continue;
    changed.push(`${have ? 'update' : 'new   '}  ${dest}`);
    if (listener && have) restart = true;
    if (CHECK) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, want);
  }

  let commit = 'unknown';
  try { commit = `v${JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version}`; } catch { /* keeps "unknown" */ }
  try { commit = execFileSync('git', ['-C', REPO, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8', env: helperEnv(), stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* not a git checkout */ }

  console.log(`${CHECK ? 'CHECK' : 'INSTALL'} from ${REPO} at ${commit} into ${DEST}`);
  console.log(changed.length ? changed.join('\n') : `all ${FILES.length} files already match this checkout`);
  if (CHECK) process.exit(changed.length ? 2 : 0);

  fs.writeFileSync(path.join(DEST, 'INSTALLED.json'), `${JSON.stringify({ commit, installed: new Date().toISOString(), from: REPO }, null, 2)}\n`);

  if (!NO_TEST) {
    const t = spawnSync(process.execPath, [path.join(DEST, 'test', 'test.mjs')], { encoding: 'utf8', env: helperEnv() });
    const last = String(t.stdout || '').trim().split('\n').pop() || '(no output)';
    console.log(`test: ${t.status === 0 ? last : `FAILED (exit ${t.status}); ${last}`}`);
    if (t.status !== 0) { process.stdout.write(String(t.stdout || '').slice(-2000)); process.exit(1); }
  }
  console.log(restart
    ? 'LISTENER: its files changed. A running listener keeps the old code until it is restarted.'
    : 'LISTENER: no restart needed.');
  console.log(`Next, in your own terminal: node "${path.join(DEST, 'src', 'relay.mjs')}" setup`);
}

async function uninstall() {
  const dry = has('--dry-run');
  const purge = has('--purge');
  const data = resolveDataDir();
  const say = (s) => console.log(`${dry ? 'would ' : ''}${s}`);
  const { uninstallService } = await import('./src/service.mjs');
  const svc = uninstallService({ dryRun: dry });
  for (const s of svc.steps) say(s);
  if (!svc.steps.length) say(`find no login start to remove (${svc.kind})`);
  // The listener is asked to stop over its signed control port; nothing else is ended.
  if (fs.existsSync(path.join(data, 'control.key'))) {
    const lib = await import('./src/lib.mjs');
    const st = await lib.probeDaemon();
    if (st) { say(`stop the listener (pid ${st.pid})`); if (!dry) await lib.daemonCall('stop'); }
  }
  for (const [rel] of [...FILES, ['INSTALLED.json']]) {
    const f = path.join(DEST, rel);
    if (fs.existsSync(f)) { say(`delete ${f}`); if (!dry) fs.unlinkSync(f); }
  }
  for (const d of ['src', 'scripts', 'test', '']) {
    const dir = path.join(DEST, d);
    try { if (!dry && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir); } catch { /* not there, or not empty: left alone */ }
  }
  if (!purge) { console.log(`Kept the data folder ${data} (settings, logs, stored token). Add --purge to delete it.`); return; }
  // Security: --purge deletes only this tool's own data folder, never a root or the home folder.
  const ok = path.basename(data) === APP || process.env.TTR_HOME === data;
  if (!ok || data === path.parse(data).root || path.resolve(data) === path.resolve(os.homedir())) { console.error(`install: refusing to delete ${data}`); process.exit(1); }
  const conf = (() => { try { return JSON.parse(fs.readFileSync(path.join(data, 'config.json'), 'utf8')); } catch { return {}; } })();
  if (conf.tokenStore) {
    say(`delete the bot token from ${conf.tokenStore}`);
    if (!dry) { const { deleteToken } = await import('./src/secret.mjs'); deleteToken(conf.tokenStore, data); }
  }
  say(`delete the data folder ${data}`);
  if (!dry) fs.rmSync(data, { recursive: true, force: true });
  console.log('The bot itself still exists in Telegram. To remove it, send /deletebot to BotFather.');
}
