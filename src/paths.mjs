// Where things live, per operating system. Pure functions with no side effects, so the test can check every
// platform from any machine by passing a platform, an environment and a home folder.
import path from 'node:path';
import os from 'node:os';

export const APP = 'telegram-terminal-relay';

const P = (platform) => (platform === 'win32' ? path.win32 : path.posix);

// Per-user data folder. TTR_HOME overrides it (used by the test).
export function resolveDataDir(platform = process.platform, env = process.env, home = os.homedir()) {
  if (env.TTR_HOME) return env.TTR_HOME;
  const p = P(platform);
  if (platform === 'win32') return p.join(env.LOCALAPPDATA || p.join(home, 'AppData', 'Local'), APP);
  if (platform === 'darwin') return p.join(home, 'Library', 'Application Support', APP);
  return p.join(env.XDG_DATA_HOME || p.join(home, '.local', 'share'), APP);
}

// Where install.mjs puts the program files.
export const resolveInstallDir = (platform = process.platform, home = os.homedir()) => P(platform).join(home, `.${APP}`);

// The file that starts the listener at login: a launchd user agent on macOS, a systemd user unit on Linux.
// Windows uses a scheduled task, which has no file of its own.
export function resolveServiceFile(platform = process.platform, env = process.env, home = os.homedir()) {
  const p = P(platform);
  if (platform === 'darwin') return p.join(home, 'Library', 'LaunchAgents', `${APP}.plist`);
  if (platform === 'win32') return null;
  return p.join(env.XDG_CONFIG_HOME || p.join(home, '.config'), 'systemd', 'user', `${APP}.service`);
}
