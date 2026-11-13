// Starts the listener at login, per operating system:
//   Windows: a scheduled task (scripts/install-task.ps1)
//   macOS:   a launchd user agent in ~/Library/LaunchAgents
//   Linux:   a systemd user unit in ~/.config/systemd/user
// When none of these is available, the listener is started for this login only and a plain command is printed.
// The text of the plist and the unit is made by pure functions, so the test can check it on any machine.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { APP, resolveServiceFile } from './paths.mjs';
import { helperEnv, hasCommand } from './secret.mjs';

const SRC = path.dirname(fileURLToPath(import.meta.url));
export const LISTENER = path.join(SRC, 'relayd.mjs');

export function serviceKind(platform = process.platform, has = hasCommand) {
  if (platform === 'win32') return 'task';
  if (platform === 'darwin') return 'launchd';
  return has('systemctl') ? 'systemd' : 'none';
}

// The PATH a login service gets: the current PATH at install time, with the Node binary's folder first, so the
// listener finds node and the claude CLI even though launchd and systemd start it with a minimal PATH.
export function servicePath(node = process.execPath, envPath = process.env.PATH, platform = process.platform) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const sep = platform === 'win32' ? ';' : ':';
  return [...new Set([p.dirname(node), ...String(envPath || '').split(sep)].filter(Boolean))].join(sep);
}

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export function launchdPlist({ node, script, logFile, pathEnv = servicePath(node, process.env.PATH, 'darwin') }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${APP}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(node)}</string>
    <string>${xml(script)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${xml(pathEnv)}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>60</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardErrorPath</key><string>${xml(logFile)}</string>
</dict>
</plist>
`;
}

// systemd reads double-quoted values; % starts a specifier, so it is doubled, and in ExecStart $ starts a
// variable, so it is doubled there too.
const unitQuote = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;
const unitArg = (s) => unitQuote(s).replace(/\$/g, '$$$$');
export function systemdUnit({ node, script, pathEnv = servicePath(node, process.env.PATH, 'linux') }) {
  return `[Unit]
Description=Telegram Terminal Relay listener

[Service]
Type=simple
Environment=${unitQuote(`PATH=${pathEnv}`)}
ExecStart=${unitArg(node)} ${unitArg(script)}
Restart=on-failure
RestartSec=60

[Install]
WantedBy=default.target
`;
}

export const manualStart = (node = process.execPath, script = LISTENER, platform = process.platform) => (platform === 'win32'
  ? `start "" /b "${node}" "${script}"`
  : `nohup "${node}" "${script}" >/dev/null 2>&1 &`);

const run = (cmd, args) => execFileSync(cmd, args, { env: helperEnv(), stdio: 'ignore', windowsHide: true, timeout: 60000 });
const uid = () => (typeof process.getuid === 'function' ? process.getuid() : 0);
const ps1 = () => path.join(SRC, '..', 'scripts', 'install-task.ps1');
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Registers the login start and starts the listener. Returns { kind, ok, note }.
export function installService({ logDir }) {
  const kind = serviceKind();
  const node = process.execPath;
  try {
    if (kind === 'task') {
      run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1(), '-Node', node, '-StartNow']);
      return { kind, ok: true, note: `scheduled task "${APP}" (starts at login)` };
    }
    const file = resolveServiceFile();
    if (kind === 'launchd') {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, launchdPlist({ node, script: LISTENER, logFile: path.join(logDir, 'launchd.log'), pathEnv: servicePath(node) }));
      try { run('launchctl', ['bootout', `gui/${uid()}/${APP}`]); } catch { /* not loaded yet */ }
      // launchd can refuse a bootstrap for a moment right after a bootout, so it is tried once more.
      try { run('launchctl', ['bootstrap', `gui/${uid()}`, file]); } catch { pause(2000); run('launchctl', ['bootstrap', `gui/${uid()}`, file]); }
      return { kind, ok: true, note: `launchd user agent ${file}` };
    }
    if (kind === 'systemd') {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, systemdUnit({ node, script: LISTENER, pathEnv: servicePath(node) }));
      run('systemctl', ['--user', 'daemon-reload']);
      run('systemctl', ['--user', 'enable', '--now', `${APP}.service`]);
      return { kind, ok: true, note: `systemd user unit ${file}` };
    }
  } catch (e) { return { kind, ok: false, note: `could not register the login start (${kind}): ${String(e.message).split('\n')[0]}` }; }
  return { kind, ok: false, note: 'no launchd or systemd user session found' };
}

// What uninstall does, as a list of steps; dryRun only lists them.
export function uninstallService({ dryRun = false } = {}) {
  const kind = serviceKind();
  const file = resolveServiceFile();
  const steps = [];
  const step = (what, fn) => { steps.push(what); if (!dryRun) { try { fn(); } catch { /* already gone */ } } };
  if (kind === 'task') step(`remove the scheduled task "${APP}"`, () => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1(), '-Uninstall']));
  if (kind === 'launchd') {
    step(`unload the launchd agent ${APP}`, () => run('launchctl', ['bootout', `gui/${uid()}/${APP}`]));
    if (fs.existsSync(file)) step(`delete ${file}`, () => fs.unlinkSync(file));
  }
  if (kind === 'systemd') {
    step(`stop and disable ${APP}.service`, () => run('systemctl', ['--user', 'disable', '--now', `${APP}.service`]));
    if (fs.existsSync(file)) step(`delete ${file}`, () => { fs.unlinkSync(file); run('systemctl', ['--user', 'daemon-reload']); });
  }
  return { kind, steps };
}

// "installed", "not installed" or "unknown"; read-only.
export function serviceState() {
  const kind = serviceKind();
  if (kind === 'task') {
    try { execFileSync('schtasks', ['/Query', '/TN', APP], { env: helperEnv(), stdio: 'ignore', windowsHide: true, timeout: 15000 }); return 'installed (scheduled task)'; } catch { return 'not installed'; }
  }
  if (kind === 'none') return 'not available (start it yourself: see docs/commands.md)';
  return fs.existsSync(resolveServiceFile()) ? `installed (${kind})` : 'not installed';
}

