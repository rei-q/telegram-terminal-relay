// relayd: the single listener for this machine's Telegram bot. It turns a button tap or a reply on one of this
// machine's questions into an answer file that the waiting `relay` command picks up, and hands every other message
// from the owner to a session on this machine (see inbound.mjs). One instance per machine.
import net from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PORT, DONE, PENDING, INBOX, ACKS, OFFSET, PEER_MAX, cfg, saveCfg, tg, tgDownload, token, esc, log, sleep, retry, claim, unclaim, finish, getDone, findByMessage, writeJson, readJson, peerName, peerHead, parsePeer, LISTENING, getSession, listSessions, listPending, listMail, mailDir, findMail, getSent, noteSent, safeEq, validId, signRequest, signReply, daemonCall, prune } from './lib.mjs';
import { makeInbound, safeName } from './inbound.mjs';
import { checkClaude } from './sessions.mjs';

const POLL = Number(process.env.TTR_POLL_TIMEOUT || 50);
const WEEK = 7 * 24 * 3600 * 1000;
const ID_JUMP = 100000;
const REASK_MS = Number(process.env.TTR_REASK_MS || 60000);
const status = { pid: process.pid, started: new Date().toISOString(), lastPollOk: null, conflict: false, error: null, bot: null, botId: null, seesAll: false, claude: null };

// Security: the verifier key exists only in this process's memory, so nothing written to disk can produce a valid
// tag. A tag is an HMAC over a JSON array of every field of the record, including who it is for.
const KEY = crypto.randomBytes(32);
const sign = (fields) => crypto.createHmac('sha256', KEY).update(JSON.stringify(fields)).digest('hex').slice(0, 12);
// An outcome's tag covers the question and its options too, so editing the record afterwards breaks it.
const answerTag = (rec, a) => sign(['answer', rec.id, rec.key || null, rec.q || null, rec.options || [], a.via, a.ts, a.text]);
const mailTag = (m) => sign(['mail', m.id, m.key, m.via, m.ts, m.text, m.third || null, m.msgId ?? null]);
// Mailbox ids already handed to a terminal: a message file moved back into a mailbox is not delivered twice.
const consumed = new Set();
const FORGED = 'the record was not written by the running listener (forged, edited, or the listener restarted since)';

// Any outcome this listener recorded (an answer, a default, a close), checked against its tag. The asking command
// prints only outcomes confirmed here.
function outcome({ id }) {
  const d = getDone(id);
  if (!d || !d.answer) return { ok: false, why: 'no outcome is recorded for that id' };
  const a = d.answer;
  if (!['button', 'reply', 'default', 'closed'].includes(a.via)) return { ok: false, why: `unknown outcome (${a.via})` };
  const good = answerTag(d, a);
  if (!safeEq(String(a.tag), good)) return { ok: false, why: FORGED };
  return { ok: true, id: d.id, via: a.via, ts: a.ts, text: a.text, tag: good, header: d.header };
}
// Records a default (after the timeout) or a close (settled in the terminal) for an open question.
function settle({ id, via, note, expect, minutes }) {
  if (via !== 'default' && via !== 'closed') return { ok: false, why: 'bad request' };
  const cl = claim(id);
  if (!cl) return getDone(id) ? { ok: false, closed: true, why: 'already closed' } : { ok: false, why: 'no open question with that id' };
  let text = String(note || 'no longer needed').slice(0, 300);
  if (via === 'default') {
    text = cl.rec.default;
    if (!text || (expect != null && expect !== text)) { unclaim(cl); return { ok: false, why: 'the default on disk is not the one the question was asked with' }; }
  }
  const ans = { text, via, ts: Date.now() };
  ans.tag = answerTag(cl.rec, ans);
  const rec = finish(cl, ans);
  log(`${id} ${via === 'default' ? 'went ahead with its default' : 'closed on the machine'}`);
  const min = Number(minutes);
  closeMessage(rec, via === 'default' ? `<b>No answer${min > 0 ? ` in ${min} min` : ''}:</b> went ahead with ${esc(text)}` : `<b>Closed on the machine:</b> ${esc(text)}`);
  return { ok: true, id, via, text, tag: ans.tag };
}

function verify({ id, tag }) {
  const d = getDone(id);
  if (!d || !d.answer) {
    const direct = inbound.verifyMsg(id, tag); // a message handed straight to a session
    if (direct) return direct;
    const m = findMail(id); // a message typed to a terminal, queued for its next listen
    if (!m) return { ok: false, why: 'no answer or message is recorded for that id on this machine' };
    const good = mailTag(m);
    if (!safeEq(String(m.tag), good)) return { ok: false, why: FORGED };
    if (tag && !safeEq(String(tag), good)) return { ok: false, why: 'the tag does not match the recorded message' };
    return { ok: true, id: m.id, via: 'message', ts: m.ts, text: m.text, third: m.third || null, tag: good, header: m.key, mail: true };
  }
  if (d.answer.via !== 'button' && d.answer.via !== 'reply') return { ok: false, why: `it was closed on the machine (${d.answer.via}), not answered by the owner` };
  const o = outcome({ id });
  if (o.ok && tag && !safeEq(String(tag), o.tag)) return { ok: false, why: 'the tag does not match the recorded answer' };
  return o;
}
// Like verify, for a terminal reading its mailbox: each message id is handed out once.
function consume(args) {
  const v = verify(args);
  if (!v.ok || !v.mail) return v.ok ? { ok: false, why: 'that id is not a mailbox message' } : v;
  if (consumed.has(v.id)) return { ok: false, why: 'this message was already delivered once; a copy is not delivered again' };
  consumed.add(v.id);
  return v;
}
// Security: the paired chat and account are fixed in memory at start, so editing config.json cannot change
// who may answer while the listener runs.
const pin = { chatId: null, userId: null, threadId: null, peerChannelId: null };

let refusedLogged = 0;
const server = net.createServer((s) => {
  let buf = '';
  s.on('error', () => {});
  s.setTimeout(2000, () => s.destroy());
  s.on('data', (d) => {
    buf += d;
    const nl = buf.indexOf('\n');
    if (nl < 0) { if (buf.length > 8192) s.destroy(); return; }
    let req = null;
    try { req = JSON.parse(buf.slice(0, nl)); } catch { /* refused below */ }
    if (!req || typeof req.n !== 'string' || typeof req.cmd !== 'string' || !safeEq(String(req.mac || ''), signRequest(req.n, req.cmd, req.args ?? {}))) {
      if (Date.now() - refusedLogged > 60000) { refusedLogged = Date.now(); log('control request without this install\'s key refused'); }
      s.end(JSON.stringify({ error: 'unauthenticated' }));
      return;
    }
    let out = status;
    const args = req.args || {};
    const calls = { verify, consume, outcome, settle };
    if (calls[req.cmd]) { try { out = calls[req.cmd](args); } catch { out = { ok: false, why: 'bad request' }; } }
    else if (req.cmd === 'stop') out = { ok: true, stopping: process.pid };
    const body = JSON.stringify(out);
    s.end(JSON.stringify({ body, mac: signReply(req.n, body) }));
    if (req.cmd === 'stop') { log('stop requested on the control port'); setTimeout(() => process.exit(0), 200); }
  });
});
server.on('error', async (e) => {
  // Never exit silently: say whether this install's listener already runs, or something else holds the port.
  if (e.code === 'EADDRINUSE') {
    const st = await daemonCall('status');
    const line = st
      ? `another listener of this install already runs (pid ${st.pid}); this one exits`
      : `PROBLEM: port ${PORT} on 127.0.0.1 is held by a program that is not this install's listener (it cannot sign with the control key). Free the port or set TTR_PORT for every relay command, then start the listener again.`;
    log(line); process.stderr.write(`relayd: ${line}\n`);
    process.exit(st ? 0 : 1);
  }
  log(`lock port error ${e.code}`); process.stderr.write(`relayd: lock port error ${e.code}\n`); process.exit(1);
});
server.listen(PORT, '127.0.0.1', main);

const quiet = (p) => p.catch((e) => { log(`send failed: ${e.message}`); return null; });
const where = (c, extra = {}) => ({ chat_id: c.chatId, ...(c.threadId ? { message_thread_id: c.threadId } : {}), ...extra });
const newId = () => crypto.randomBytes(4).toString('hex');
const inbound = makeInbound({ sign, status, where, quiet, newId });

async function closeMessage(rec, line) {
  if (!rec.mainMsgId) return;
  await quiet(tg('editMessageText', { chat_id: rec.chatId, message_id: rec.mainMsgId, parse_mode: 'HTML', text: `${rec.text}\n\n${line}` }));
}

// /pair <code> in a group, or /start <code> from the t.me link in a private chat.
async function onPair(msg, c) {
  const m = /^\/(?:pair|start)(?:@(\w+))?\s+(\S+)/.exec(msg.text);
  if (m[1] && status.bot && m[1].toLowerCase() !== status.bot.toLowerCase()) return; // another bot's command
  const code = m[2].toUpperCase();
  const cc = cfg();
  const p = cc.pair;
  if (!p) { log('pair line seen but setup is not waiting'); return; }
  if (Date.now() > p.exp) { delete cc.pair; saveCfg(cc); log('pair code expired; run setup again'); return; }
  // Security: the code is compared in constant time, and five wrong tries cancel it.
  if (!safeEq(code, String(p.code).toUpperCase())) {
    p.tries = (p.tries || 0) + 1;
    if (p.tries >= 5) { delete cc.pair; log('pairing cancelled after 5 wrong codes; run setup again'); } else log(`pair code does not match (${p.tries} of 5 tries)`);
    saveCfg(cc);
    return;
  }
  // Security: once paired, only the same Telegram account can pair again, so a session cannot hand the bot to someone else.
  if (pin.userId && msg.from.id !== pin.userId) { log('pair line refused: it did not come from the paired owner account'); return; }
  cc.chatId = msg.chat.id;
  cc.userId = msg.from.id;
  cc.threadId = msg.is_topic_message ? msg.message_thread_id : null;
  delete cc.pair;
  saveCfg(cc);
  Object.assign(pin, { chatId: cc.chatId, userId: cc.userId, threadId: cc.threadId });
  if (cc.chatId > 0) status.seesAll = true; // a private chat: the bot sees every message
  log(`paired chat ${cc.chatId} thread ${cc.threadId || 'none'}`);
  await quiet(retry(() => tg('sendMessage', where(cc, { parse_mode: 'HTML', text: `<b>${esc(cc.pcName)}</b> is paired. Questions, reviews and end states from this machine will show up here. Only you can answer them.` }))));
}

async function onButton(q, c) {
  const reply = (text) => quiet(tg('answerCallbackQuery', { callback_query_id: q.id, text }));
  // Security: only the paired account, in the paired chat, can press a button.
  if (!c.chatId || !q.message || q.message.chat.id !== c.chatId || q.from.id !== c.userId) return reply('Not allowed.');
  const [tag, id, idxRaw] = String(q.data || '').split('|');
  if (tag === 'c') return reply(String(await inbound.onChoice(id, Number(idxRaw), c)).slice(0, 190));
  if (tag === 's' || tag === 'y' || tag === 'n') return reply(String(await inbound.onStop(tag, id, Number(idxRaw), c, q)).slice(0, 190));
  if (tag === 'o') return reply(String(await openPackage(id, c, q)).slice(0, 190));
  if (tag !== 'q') return reply('Unknown button.');
  const cl = claim(id);
  if (!cl) {
    const old = getDone(id);
    return reply(old ? `Already closed: ${old.answer.text}`.slice(0, 190) : `This is not an open question from ${c.pcName}.`);
  }
  // Security: the answer is the text of the button Telegram reports the owner tapped. The record on disk can be
  // edited, so a tap whose recorded option differs from that button is refused and the question stays open.
  const btn = ((q.message.reply_markup && q.message.reply_markup.inline_keyboard) || []).flat().find((b) => b && b.callback_data === q.data);
  const text = cl.rec.options[Number(idxRaw)];
  if (!btn || text === undefined || btn.text !== String(text).slice(0, 60)) {
    unclaim(cl);
    log(`button tap on ${id} refused: ${btn ? 'the recorded option differs from the button the owner saw' : 'Telegram did not report the button'}`);
    return reply(btn ? 'This question changed on the machine after it was sent, so the tap was not recorded. Reply with your answer instead.' : 'This button can no longer be read. Reply with your answer instead.');
  }
  const ans = { text, via: 'button', ts: Date.now() };
  ans.tag = answerTag(cl.rec, ans);
  const rec = finish(cl, ans);
  log(`answered ${id} via button`);
  await reply(`Sent to ${rec.header}`.slice(0, 190));
  await closeMessage(rec, `<b>Answered:</b> ${esc(text)}`);
}

// Replies go to the place the message came from (its topic, when the group has topics).
const sayTo = (msg, c) => (text) => quiet(tg('sendMessage', { chat_id: c.chatId, message_thread_id: msg.is_topic_message ? msg.message_thread_id : (c.threadId || undefined), text, reply_parameters: { message_id: msg.message_id } }));
const react = (c, messageId, emoji) => tg('setMessageReaction', { chat_id: c.chatId, message_id: messageId, reaction: [{ type: 'emoji', emoji }] }).catch(() => {});
const isListening = (key) => { try { return Date.now() - fs.statSync(path.join(LISTENING, `${key}.json`)).mtimeMs < 90000; } catch { return false; } };

// A message for a terminal that is not an answer to an open question: queued, signed, for that terminal.
async function toMailbox(session, msg, c, extra = '') {
  const say = sayTo(msg, c);
  const text = (msg.text || msg.caption || '').trim();
  if (!text) return say('Text only for now. Nothing was delivered.');
  const m = { id: newId(), key: session.key, text, via: 'mail', ts: Date.now(), msgId: msg.message_id, third: inbound.thirdParty(msg) };
  m.tag = mailTag(m);
  writeJson(path.join(mailDir(session.key), `${m.ts}-${m.id}.json`), m);
  log(`message ${m.id} queued for ${session.key}`);
  const name = session.label || session.key;
  if (isListening(session.key) && !extra) return react(c, msg.message_id, '👀');
  await say(`${isListening(session.key) ? `Sent to ${name}.` : `${name} is not listening right now. Your message is queued; it gets it when it next checks in.`}${extra}`);
}

// A message for one terminal that is not an answer. Delivery order: a terminal waiting in `listen` reads its
// queue; a Claude Code session gets it pushed (or, when that session has ended, a new one starts with the earlier
// message as context); any other terminal finds it queued.
function toTerminal(session, msg, c, extra = '') {
  if (isListening(session.key) || !session.sessionId) return toMailbox(session, msg, c, extra);
  const sent = getSent(msg.reply_to_message && msg.reply_to_message.message_id);
  return inbound.onOwner(msg, c, sent || { header: session.header || session.label || session.key, task: 'its Telegram topic', q: '', sessionId: session.sessionId, cwd: session.cwd || null, thread: null });
}

async function onReply(msg, c) {
  const target = msg.reply_to_message.message_id;
  const open = findByMessage(PENDING, target);
  if (open) return answerQuestion(open, msg, c);
  // Not an open question: a message to the terminal behind the replied-to message (a closed question, an end
  // state), or, when no terminal owns it, a message to this machine like any other. Nothing is refused as closed.
  const old = getSent(target);
  const session = (old && old.key && getSession(old.key)) || listSessions().find((s) => (s.msgIds || []).includes(target));
  if (session) return toTerminal(session, msg, c);
  return inbound.onOwner(msg, c);
}

// Text typed in a terminal's own topic, without a reply. Returns false when the topic does not belong to this machine.
async function onTopic(msg, c) {
  const session = listSessions().find((s) => s.topicId === msg.message_thread_id && s.chatId === c.chatId);
  if (!session) return false; // another machine's topic, or one made by hand
  const open = listPending().filter((r) => r.key === session.key);
  if (open.length === 1) await answerQuestion(open[0], msg, c); // exactly one open question: the text answers it
  else await toTerminal(session, msg, c, open.length > 1 ? ` ${open.length} questions are open in this topic: to answer one, tap its button or reply to it.` : '');
  return true;
}

async function answerQuestion(open, msg, c) {
  const say = sayTo(msg, c);
  // Security: forwarded text is somebody else's words, so it never counts as the owner's answer.
  if (msg.forward_origin) return say('A forwarded message cannot answer a question. Tap a button or type your answer.');
  const text = (msg.text || msg.caption || '').trim();
  if (!text) return say('Text replies only for now. Nothing was delivered.');
  const cl = claim(open.id);
  if (!cl) return inbound.onOwner(msg, c);   // closed a moment ago: still delivered to the session
  const ans = { text, via: 'reply', ts: Date.now() };
  ans.tag = answerTag(cl.rec, ans);
  const rec = finish(cl, ans);
  log(`answered ${rec.id} via reply`);
  await say(`Delivered to ${rec.header}.`);
  await closeMessage(rec, `<b>Answered:</b> ${esc(text)}`);
}

// Machine to machine (optional, off until `setup --link`): posts in the private channel where both bots are
// admins. A post from another machine is traffic from its agents. Security: it is never an owner answer and never
// gets a verifier tag, and by default it is only stored: the owner opens it with a tap or a reply.
const notOwners = new Set();
const pkgNotice = (p, meta, me, why, target) => `<b>PACKAGE</b> · ${esc(p.from)} → ${esc(me)} · ${p.id}${meta.file ? ` · ${esc(path.basename(meta.file))}` : ''}\n<b>${esc(p.note.split('\n')[0].slice(0, 160))}</b>\n<i>${why ? `${esc(why.slice(0, 200))} ` : ''}${target ? `From agents. ${esc(target.name)} on ${esc(me)} is on it; reply here to steer it.` : `From agents, stored only. Tap Open or reply here (for example "do it") and a ${esc(me)} session opens it.`}</i>`;
async function onChannelPost(post, c) {
  if (!pin.userId || !post.chat) return;
  const me = peerName(c);
  if (!pin.peerChannelId) {
    if (post.chat.type !== 'channel' || notOwners.has(post.chat.id)) return;
    if (cfg().peerLink !== true) { log('a channel post was ignored: the machine link is off (run setup --link to turn it on)'); return; }
    // Security: links only to a channel created by the paired owner account; no code needed, and no foreign channel.
    let admins;
    try { admins = await tg('getChatAdministrators', { chat_id: post.chat.id }); } catch (e) { log(`channel check failed: ${e.message}`); return; }
    const owner = admins.find((x) => x.status === 'creator');
    if (!owner || owner.user.id !== pin.userId) { notOwners.add(post.chat.id); log('a channel post was ignored: that channel was not created by the paired owner account'); return; }
    pin.peerChannelId = post.chat.id;
    const cc = cfg(); cc.peerChannelId = post.chat.id; saveCfg(cc);
    log(`linked to the machine to machine channel ${post.chat.id}`);
    await quiet(tg('sendMessage', { chat_id: pin.peerChannelId, disable_notification: true, text: `${peerHead({ from: me, to: 'all', id: newId(), kind: 'ping' })}\n${me} is linked to this channel.` }));
  }
  if (post.chat.id !== pin.peerChannelId) return;
  const p = parsePeer(post.text || post.caption);
  if (!p || p.from.toLowerCase() === me.toLowerCase()) return;
  if (p.to.toLowerCase() !== me.toLowerCase() && p.to !== 'all') return;
  const cc = cfg(); cc.peers = { ...cc.peers, [p.from]: Date.now() }; saveCfg(cc);
  if (p.kind === 'ack') { if (p.ref) writeJson(path.join(ACKS, `${p.ref}.json`), { from: p.from, note: p.note, ts: Date.now() }); return; }
  // The sender waits for this receipt, so it is retried on network errors.
  const ack = (note) => quiet(retry(() => tg('sendMessage', { chat_id: pin.peerChannelId, disable_notification: true, text: `${peerHead({ from: me, to: p.from, id: newId(), kind: 'ack', ref: p.id })}\n${note}` })));
  if (p.kind === 'ping') return ack('pong');
  const dir = path.join(INBOX, p.id);
  if (fs.existsSync(dir)) return ack('already received');
  fs.mkdirSync(dir);
  const meta = { id: p.id, from: p.from, note: p.note, thread: p.thread, ts: Date.now(), file: null, size: null, fileError: null };
  if (post.document) {
    // Security: the file name comes from another machine; only a plain name is kept, inside this package's folder.
    const safe = safeName(post.document.file_name);
    try {
      if ((post.document.file_size || 0) > PEER_MAX) throw new Error('over 20 MB');
      meta.size = await tgDownload(post.document.file_id, path.join(dir, safe));
      meta.file = path.join(dir, safe);
    } catch (e) { meta.fileError = e.message; }
  }
  writeJson(path.join(dir, 'meta.json'), meta);
  log(`peer package ${p.id} from ${p.from}${meta.file ? ' with a file' : ''}`);
  await ack(meta.fileError ? `received the note, but the file failed: ${meta.fileError}` : 'received');
  const auto = cfg().peerAuto === true;
  const hit = p.thread && pin.chatId ? inbound.peerThread(p) : null;
  // Part of a conversation the owner opened, and packages are handed on arrival: that thread's session gets it.
  if (hit && auto) return inbound.onPeerNote(p, meta, hit, c, (e) => bell(c, p, meta, `Could not reach a session (${e.message}).`));
  if (!pin.chatId) return;
  if (!auto) return bell(c, p, meta, '', null, hit);
  inbound.onPeerPackage(p, meta, c, (target) => bell(c, p, meta, '', target), (e) => bell(c, p, meta, `No session took it (${e.message}).`));
}
// The notice is recorded, so a reply to it ("do it") reaches a session on this machine together with the package.
async function bell(c, p, meta, why, target = null, hit = null) {
  const me = peerName(c);
  const stored = !target;
  const m = await quiet(retry(() => tg('sendMessage', where(c, { parse_mode: 'HTML', disable_notification: true, text: pkgNotice(p, meta, me, why, target),
    reply_markup: stored ? { inline_keyboard: [[{ text: `Open on ${me}`.slice(0, 60), callback_data: `o|${p.id}|0` }]] } : undefined }))));
  if (m && m.message_id) noteSent([m.message_id], { header: `${me} · package ${p.id}`, task: `package from agents on ${p.from}`, q: p.note.slice(0, 400), pkg: path.join(INBOX, p.id), sessionId: (target && target.sessionId) || null, cwd: (target && target.cwd) || null, thread: hit ? hit.th.tid : null, notice: m.message_id });
}
// The owner tapped Open on a stored package: it goes to a session now, once.
async function openPackage(id, c, q) {
  if (!validId(id)) return 'Unknown package.';
  const file = path.join(INBOX, id, 'meta.json');
  const meta = readJson(file);
  if (!meta) return 'That package is no longer stored here.';
  if (meta.opened) return 'Already opened.';
  meta.opened = Date.now(); writeJson(file, meta);
  const p = { id: meta.id, from: meta.from, note: meta.note, thread: meta.thread };
  const msgId = q.message && q.message.message_id;
  const edit = (target, why) => quiet(tg('editMessageText', { chat_id: c.chatId, message_id: msgId, parse_mode: 'HTML', text: pkgNotice(p, meta, peerName(c), why, target) }));
  const fail = (e) => { const m2 = readJson(file); if (m2) { delete m2.opened; writeJson(file, m2); } return edit(null, `Could not open it (${e.message}).`); };
  const hit = p.thread ? inbound.peerThread(p) : null;
  if (hit) inbound.onPeerNote(p, meta, hit, c, fail, edit);
  else inbound.onPeerPackage(p, meta, c, (target) => edit(target, ''), fail, true);
  log(`package ${id} opened by the owner`);
  return `Opening on ${peerName(c)}`;
}

// Telegram's stand-in accounts for anonymous group admins, channel posts and linked-channel forwards.
const ANONYMOUS = new Set([1087968824, 136817688, 777000]);
let hinted = 0;
async function anonymousHint(msg, hint) {
  log('a message sent anonymously (as a group or channel) was refused');
  if (!hint || Date.now() - hinted < 10 * 60000) return;
  hinted = Date.now();
  await quiet(tg('sendMessage', { chat_id: msg.chat.id, message_thread_id: msg.is_topic_message ? msg.message_thread_id : undefined, reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true },
    text: 'Messages sent anonymously, as the group or a channel, are not accepted. Please send it from your own account (turn off "Remain anonymous" in your admin rights for this group).' }));
}

async function handle(u) {
  const c = cfg();
  if (pin.userId) Object.assign(c, pin);
  if (u.callback_query) return onButton(u.callback_query, c);
  if (u.channel_post) return onChannelPost(u.channel_post, c);
  const msg = u.message;
  if (!msg || !msg.from) return;
  // Telegram gives a group a new id when it is upgraded (for example when topics are enabled): follow it.
  if (msg.migrate_to_chat_id && c.chatId && msg.chat.id === c.chatId) {
    c.chatId = msg.migrate_to_chat_id; pin.chatId = c.chatId; saveCfg(c); log(`group upgraded, now chat ${c.chatId}`); return;
  }
  // While unpaired, the kind of each arriving message is logged (never its text) to help diagnose pairing.
  if (!c.chatId) log(`unpaired: message in a ${msg.chat.type} chat, ${typeof msg.text === 'string' && msg.text.startsWith('/') ? 'command ' + msg.text.split(/[\s@]/)[0] : 'not a command'}`);
  const pairLine = typeof msg.text === 'string' && /^\/(pair|start)(@\w+)?\s+\S/.test(msg.text) && !msg.forward_origin;
  // Security: a post sent as the group or a channel carries no person's account id, so it can neither pair nor speak
  // for the owner.
  if (msg.sender_chat || ANONYMOUS.has(msg.from.id)) {
    const asGroup = msg.from.id === 1087968824 || (msg.sender_chat && msg.sender_chat.id === msg.chat.id);
    const otherBot = pairLine && /^\/\w+@(\w+)/.exec(msg.text);
    const ownPair = pairLine && !(otherBot && status.bot && otherBot[1].toLowerCase() !== status.bot.toLowerCase());
    if (ownPair || (c.chatId && msg.chat.id === c.chatId)) return anonymousHint(msg, ownPair || asGroup);
    return;
  }
  if (pairLine) return onPair(msg, c);
  // Security: anything not from the paired account in the paired chat is ignored.
  if (!c.chatId || msg.chat.id !== c.chatId || msg.from.id !== c.userId) return;
  // In a topic, a plain message points at the topic's first message: that is not a real reply.
  const r = msg.reply_to_message;
  const realReply = r && !r.forum_topic_created && !(msg.is_topic_message && r.message_id === msg.message_thread_id);
  if (realReply) return onReply(msg, c);
  if (msg.is_topic_message && (await onTopic(msg, c))) return;
  // Everything else: @bot, @all, /new, /to, /sessions, /cwd, attachments, a plain message.
  return inbound.onOwner(realReply ? msg : { ...msg, reply_to_message: undefined }, c);
}

// Security: after a restart the old verifier key is gone, so unread answers and messages can no longer be proven.
// The files are not trusted; the owner is asked again instead.
// Runs synchronously before the first control request is served: an unread answer becomes an open question again
// at once, so a waiting command keeps waiting instead of finding an answer that can no longer be verified.
function reopenUnread() {
  for (const f of fs.readdirSync(DONE)) {
    if (!f.endsWith('.json')) continue;
    const rec = readJson(path.join(DONE, f));
    if (!rec || rec.v !== 2 || !rec.answer || (rec.answer.via !== 'button' && rec.answer.via !== 'reply')) continue;
    if (fs.existsSync(path.join(DONE, `${rec.id}.read`)) || Date.now() - rec.answer.ts > 24 * 3600 * 1000) continue;
    delete rec.answer; rec.reask = true;
    writeJson(path.join(PENDING, `${rec.id}.json`), rec);
    fs.unlinkSync(path.join(DONE, f));
  }
}
async function recover() {
  const c = cfg(); Object.assign(c, pin);
  for (const s of listSessions()) {
    const items = listMail(s.key);
    if (!items.length) continue;
    const lost = mailDir(s.key, 'lost');
    for (const m of items) fs.renameSync(m.file, path.join(lost, path.basename(m.file)));
    log(`${items.length} unread message(s) for ${s.key} dropped after restart`);
    await quiet(retry(() => tg('sendMessage', { chat_id: c.chatId, message_thread_id: s.topicId || c.threadId || undefined,
      text: `${c.pcName} restarted before ${s.label || s.key} read ${items.length === 1 ? 'your last message' : `your last ${items.length} messages`}. Please send ${items.length === 1 ? 'it' : 'them'} again.` })));
  }
  // The new messages go out here, and again later while they fail.
  await reask(c);
}
let lastReask = 0;
async function reask(c0) {
  lastReask = Date.now();
  const c = c0 || Object.assign(cfg(), pin);
  for (const rec of listPending().filter((r) => r.reask)) {
    try {
      const m = await retry(() => tg('sendMessage', { chat_id: rec.chatId, message_thread_id: rec.threadId || undefined, parse_mode: 'HTML',
        text: `${rec.text}\n\n<i>${esc(c.pcName)} restarted before the session read your answer. Please answer again.</i>`,
        reply_markup: rec.options.length ? { inline_keyboard: rec.options.map((o, i) => [{ text: o.slice(0, 60), callback_data: `q|${rec.id}|${i}` }]) } : undefined }));
      const cl = claim(rec.id);
      if (!cl) continue; // answered in the meantime
      cl.rec.mainMsgId = m.message_id; cl.rec.msgIds.push(m.message_id); delete cl.rec.reask;
      writeJson(path.join(PENDING, `${rec.id}.json`), cl.rec);
      try { fs.unlinkSync(cl.c); } catch { /* already gone */ }
      log(`asked ${rec.id} again after restart`);
    } catch (e) { log(`could not ask ${rec.id} again (${e.message}); trying again later`); }
  }
}

async function main() {
  // Exit code 1, so a login service (launchd, systemd, the scheduled task) tries again later.
  try { token(); } catch (e) { log(e.message); process.stderr.write(`relayd: ${e.message}\n`); process.exit(1); }
  // Security: the token is in memory now; removed from the environment so no child process inherits it.
  delete process.env.TTR_BOT_TOKEN;
  log(`relayd up pid ${process.pid}`);
  const tidy = () => { try { const n = prune(30); if (n) log(`removed ${n} records older than 30 days`); } catch (e) { log(`cleanup failed: ${e.message}`); } };
  tidy();
  setInterval(tidy, 24 * 3600 * 1000).unref();
  const c0 = cfg();
  if (c0.userId) pin.userId = c0.userId;
  if (c0.chatId && c0.userId) Object.assign(pin, { chatId: c0.chatId, threadId: c0.threadId || null, peerChannelId: c0.peerChannelId || null });
  if (pin.chatId) reopenUnread();
  checkClaude().then((r) => { status.claude = r; log(r.line); }).catch((e) => { status.claude = { ok: false, line: `Claude Code CLI check failed: ${e.message}` }; });
  try {
    const me = await tg('getMe'); status.bot = me.username; status.botId = me.id;
    // A private chat shows the bot every message. In a group with privacy mode on, a bot gets only replies to its
    // messages, commands and @mentions; an admin gets all.
    status.seesAll = me.can_read_all_group_messages === true || pin.chatId > 0;
    if (!status.seesAll && pin.chatId) status.seesAll = (await tg('getChatMember', { chat_id: pin.chatId, user_id: me.id })).status === 'administrator';
  } catch (e) { status.error = e.message; log(e.message); }
  if (pin.chatId) { try { await recover(); } catch (e) { log(`recover failed: ${e.message}`); } }
  // Updates already handled before a restart are skipped, so nothing is delivered twice. After a week without
  // updates Telegram may restart its update ids at a lower number, so a position that old is dropped, and a large
  // jump backwards counts as such a restart rather than as old updates.
  const saved = readJson(OFFSET, {}) || {};
  let last = Number(saved.last || 0);
  let lastTs = Number(saved.ts || 0);
  if (!lastTs) { try { lastTs = fs.statSync(OFFSET).mtimeMs; } catch { lastTs = 0; } }
  let offset = last ? last + 1 : 0;
  for (;;) {
    if (last && Date.now() - lastTs > WEEK) { log('no update for 7 days: the saved update position is dropped, as Telegram may restart its update ids'); last = 0; offset = 0; }
    try {
      const updates = await tg('getUpdates', { offset, timeout: POLL, allowed_updates: ['message', 'callback_query', 'channel_post'] }, (POLL + 15) * 1000);
      status.lastPollOk = new Date().toISOString(); status.conflict = false; status.error = null;
      for (const u of updates) {
        if (u.update_id <= last && last - u.update_id > ID_JUMP) { log(`update ids restarted (from ${last} to ${u.update_id}); continuing from the new ids`); last = u.update_id - 1; offset = 0; }
        offset = Math.max(offset, u.update_id + 1);
        if (u.update_id <= last) { log(`update ${u.update_id} skipped: already handled`); continue; }
        // Recorded before handling: after a crash an update is lost rather than delivered twice.
        last = u.update_id; lastTs = Date.now(); writeJson(OFFSET, { last, ts: lastTs });
        try { await handle(u); } catch (e) { log(`update ${u.update_id} failed: ${e.message}`); }
      }
      if (Date.now() - lastReask > REASK_MS && listPending().some((r) => r.reask)) await reask();
    } catch (e) {
      status.error = e.message;
      if (e.code === 409) {
        // Another process is polling this bot: usually the same token set on a second machine.
        if (!status.conflict) log('CONFLICT: another machine is listening on this bot. Each machine needs its own bot.');
        status.conflict = true; await sleep(30000);
      } else if (e.code === 401) { log('token rejected by Telegram'); await sleep(60000); }
      else { log(e.message); await sleep(e.retryAfter ? e.retryAfter * 1000 : 5000); }
    }
  }
}
