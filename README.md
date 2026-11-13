<p align="center">
  <a href="media/launch.mp4"><img src="media/readme-loop.gif" alt="A terminal asks a question in Telegram, one tap answers it" width="720"></a>
</p>

# Telegram Terminal Relay

Your coding-agent terminals, in your pocket. A session that needs a decision asks you in Telegram with tap buttons and gets your answer back as command output. You can also message a session from your phone, start a new one, send it files, and stop it in two taps.

It is free and small: about 2,500 lines of plain Node, no dependencies, one background process on your own computer. No account besides a Telegram bot, no server, no open network ports. Built for Windows, macOS and Linux; tested for real on Windows so far.

## Install

Paste this into your coding agent:

```
Install Telegram Terminal Relay for me from https://github.com/rei-q/telegram-terminal-relay
Clone it, read INSTALL.md in the repo and follow it step by step: run the installer and its offline test,
walk me through creating a bot with BotFather, then give me the one command to run in my own terminal.
Never ask me for the bot token. Finish by sending a test question with two buttons to my phone.
```

You do two things by hand: create a bot in Telegram, and tap one link on your phone.

If this is useful to you, a star helps other people find it. Thank you.

---

## Details

### What it does

- **Ask.** `relay ask` sends a question with buttons to your phone and prints your answer. `review` sends an image or video to look at; `done` reports an end state.
- **Message.** Reply to any message to reach that session. `@your_bot <task>` or `/new` starts a background session; `/to`, `/sessions` and `/cwd` steer them. Attachments up to Telegram's 20 MB bot limit.
- **Verify.** Every answer and message from your account gets an id and a signed tag. `relay verify` checks it against the listener's own record, which catches answers that were copied, edited or made up as they pass between agents. It does not stop a program running as your user that is built to defeat it (such a program can read the control key).
- **Stop.** `/stop` ends a session in two taps, limited to sessions started from the phone or ones that allowed it.
- **Several machines (optional).** One bot per machine; a private channel carries small packages between them. Off until you set it up.
- **Other agents.** Starting sessions from the phone uses the Claude Code CLI. Everything else works from any agent that can run a command, through a simple mailbox (`listen`, `say`).

Commands: [docs/commands.md](docs/commands.md). Setup steps: [INSTALL.md](INSTALL.md).

### Security

No inbound port: the listener asks Telegram for updates and answers only on 127.0.0.1. The bot token is typed into a hidden prompt and kept in your system's secret store. Only the paired account is obeyed.

What it does not do: Telegram bot chats are not end to end encrypted, so Telegram can read them, and whoever controls your Telegram account controls these terminals. Turn on two-step verification. The full list is in [SECURITY.md](SECURITY.md); please read it before you rely on this.

### What was tested

Windows 11 for real (install, pairing, phone round trip). macOS and Linux share the same code and pass the offline test's checks for their service files, but were not run on real machines yet. Reports are welcome.

Measured on Windows with Node 24: the listener idles at about 65 MB of memory.

### How it compares

Checked in November 2026 from each project's own docs. All of these are good tools; pick what fits.

| Tool | Needs | Good at | How the relay differs |
|---|---|---|---|
| Claude Code Remote Control | A paid Claude plan, the Claude app or a browser | The full live conversation on your phone | Works without a plan or the app; other agents too |
| Claude Code Channels (official Telegram plugin) | A recent Claude Code, Bun, a bot token | Chat pushed into one running session, permission buttons | Questions of any kind, sessions started from the phone, several machines, signed messages, no dependencies |
| Happy | Its phone app and CLI, a relay server (hosted or your own) | End to end encryption, voice, push alerts | No extra app or server. Happy is end to end encrypted; the relay is not |
| VibeTunnel | Node or its Mac app, plus a tunnel for remote access | A full terminal in the browser | Sends questions and answers, not a terminal mirror; no tunnel |
| claude-code-telegram | Python and its packages | The bot is the session, with voice and scheduled jobs | Works next to the sessions you already run |
| ccbot | Python, tmux | One topic per tmux window, terminal screenshots | No tmux, so it fits Windows; signed messages |
| OpenClaw | Node, a gateway process, model keys | A whole personal assistant across chat apps | One small, single-purpose bridge |
| ntfy with tmux | The ntfy app, a server or ntfy.sh, your own scripts | Simple push alerts with action buttons | Answers come back as command output, no glue code |

If you only need one running Claude Code session on your phone and are fine with a research preview, the official Channels plugin is the closest alternative.

### Uninstall

```
node install.mjs --uninstall
```

Add `--purge` to also delete settings, logs and the stored token.

### License

[MIT](LICENSE). Yours to read, change and share.

<sub>Not associated with Telegram.</sub>
