# Security

## What the relay does to keep you safe

- **One account only.** After pairing, the listener acts only on messages and button taps from the Telegram account that paired, in the paired chat. Everything else is ignored. Posts sent anonymously (as a group or a channel) carry no personal account, so they can neither pair nor speak for you.
- **Pairing code.** Ten random characters, used once, valid for 15 minutes. A paired machine can be paired again only from the same account. Anyone who can message the bot can send codes, so five wrong codes from anyone cancel a pending pairing; if that happens, run setup again.
- **Bot token.** Typed into a hidden prompt in your own terminal, never passed on a command line, never written to logs or command output. It is kept in the operating system's secret store: Windows DPAPI, the macOS Keychain, or the Linux desktop keyring (secret-tool). Every program the relay starts (sessions, helper commands, the installer's test run) gets an environment without it. The one exception is the fallback variable `TTR_BOT_TOKEN`: it reaches the listener, which removes it from its own environment at start.
- **No inbound port.** The listener asks Telegram for updates (long polling) and opens nothing to the network.
- **Local control port.** The listener answers only on 127.0.0.1. Every request and every reply is signed with a 32-byte key in a file only your user account can read. A program that takes the port without the key is detected and reported, not trusted.
- **Answers are signed.** The listener signs each answer, default, close and message it records, with a key that lives only in its memory; the signature also covers the question and its options. The asking command prints an outcome only after the listener confirms it recorded it, and `relay verify` checks a claimed answer the same way. This catches answers that were copied, edited or made up as they pass between agents. It does not stop a program running as your user that is built to defeat it: such a program can read the control key and talk to the listener directly. A question is answered once, and a message is handed to a session once. Secret comparisons take constant time.
- **Buttons are checked.** A tap counts only when the text of the button Telegram reports matches the option recorded on the machine. If the record was changed after the question was sent, the tap is refused and the question stays open.
- **No replays after a restart.** The position in Telegram's update stream is saved before each update is handled, so a restart never handles an old update again. After 7 days without updates Telegram may restart its update numbers, so a position that old is dropped. Records on disk are not trusted after a restart; the listener asks again. Records older than 30 days are deleted.
- **Content from others is marked.** Forwarded and quoted messages, replies to outside messages, and attachments are labeled as third-party content for the session. A forwarded message cannot answer a question.
- **Files.** File names from Telegram are reduced to a plain name inside a folder per message, with a 20 MB limit. `--file` refuses secret-looking names such as `.env`, private keys, `.npmrc`, credential and token files.
- **Phone sessions are limited.** Sessions started from the phone use the permission mode in `config.json` (default `acceptEdits`, never the bypass mode unless you set it). `/cwd` takes a full path and refuses a drive or filesystem root and your home folder. The same check applies to every folder a phone session would start in, including one written into `config.json` by hand.
- **Stop takes two taps.** The phone can only stop sessions it started, or sessions that marked themselves as stoppable.
- **Second machine is off by default.** The link to another machine only works after `setup --link`, and only through a channel your own account created. Packages from the other machine are stored until you tap Open, unless you chose `--auto`.

## What it does not protect against

- **Your Telegram account is the key.** Whoever controls it controls these terminals. Turn on two-step verification in Telegram.
- **Bot chats are not end to end encrypted.** Telegram's servers can read them. Do not send what you would not put in a normal cloud chat.
- **Your computer account is the boundary.** Anything running as your user can read the control key, `config.json` and the stored token. The relay does not defend against software that already runs as you.
- **`config.json` is trusted.** Whoever can edit it can change the paired chat, the permission mode and the session folder.
- **`TTR_API` redirects the token.** When this variable is set, every Telegram request, bot token included, goes to that address instead of api.telegram.org. It is meant for a self-hosted Bot API server or for tests. `status` prints a warning line while it is set.
- **Phone sessions do real work.** They run with the configured permission mode and can be misled by text they read (prompt injection), including text you forward to them.
- **File contents are not scanned.** Only file names are checked.
- **Groups are shared.** In a group, every member can read everything the bot posts.
- **An update can be lost, not repeated.** If the listener crashes while handling a message, that message is dropped; send it again.
- **Claude Code internals.** Starting and continuing sessions uses Claude Code CLI features that may change. The relay checks for version 2.1.323 or newer at listener start and in `status`, and reports one line when something is missing. Questions and answers work without it.
- **Linux without a keyring.** When `secret-tool` is not available, the token is stored in a plain file readable only by your user (mode 0600).

## What was tested

The offline test (`node test/test.mjs`) runs against a fake Telegram server and fake sessions. It was run on Windows 11, including a real DPAPI round trip. The macOS Keychain, Linux secret-tool, launchd and systemd paths are covered only by checks of the generated files and command choices, not run on those systems. This version has not yet been run against the real Telegram service.

## Reporting a problem

Please use GitHub's private vulnerability reporting on this repository (Security tab, "Report a vulnerability"). Do not open a public issue for security problems.
