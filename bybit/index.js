#!/usr/bin/env node
// Bybit 现货行情监控 -> Telegram 报警
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { fetchMarkets } from './market.js';
import { evaluateRules, confirmedByVotes } from '../core/rules.js';
import { loadState, saveState } from '../core/state.js';
import { loadConfig } from './config.js';
import { alertMessage, summaryMessage, statusMessage, digestMessage, printTable,
         printThresholds, stripHtml, tgOptions, topSeverity, DEFAULT_TG } from './format.js';
import * as tg from '../tg/index.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function loadEnv() {
  const p = resolve(ROOT, '.env');
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const v = m[2].replace(/^['"]|['"]$/g, '');
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

// 凭据两级回落：BYBIT_TELEGRAM_* 优先（发到专属群），没设则用通用的
const btToken = () => process.env.BYBIT_TELEGRAM_BOT_TOKEN || undefined;
const btChat = () => process.env.BYBIT_TELEGRAM_CHAT_ID || undefined;
const creds = () => ({ token: btToken(), chatId: btChat() });
const send = (text, opts = {}) => tg.sendMessage(text, { ...creds(), ...opts });
const tgReady = () => tg.isConfigured(creds());

function requireTg() {
  if (tgReady()) return;
  const seen = (k) => (process.env[k] ? '✅ 有值' : '— 空');
  throw new Error(
    'Telegram 凭据没读到。当前环境变量：\n'
    + `  BYBIT_TELEGRAM_BOT_TOKEN  ${seen('BYBIT_TELEGRAM_BOT_TOKEN')}\n`
    + `  BYBIT_TELEGRAM_CHAT_ID    ${seen('BYBIT_TELEGRAM_CHAT_ID')}\n`
    + `  TELEGRAM_BOT_TOKEN        ${seen('TELEGRAM_BOT_TOKEN')}   （兜底）\n`
    + `  TELEGRAM_CHAT_ID          ${seen('TELEGRAM_CHAT_ID')}   （兜底）\n`
    + '  优先级 BYBIT_TELEGRAM_* > TELEGRAM_*，两组都空就是这个错。'
  );
}

const snapshotNow = (cfg) => fetchMarkets(cfg.assets, cfg.depthLevels ?? 5);

function inQuietHours(q, at = new Date(), fallbackTz = 'Asia/Hong_Kong') {
  if (!q || q.enabled === false || q.start === undefined || q.end === undefined) return false;
  const hour = Number(new Intl.DateTimeFormat('en-US', {
    hour: 'numeric', hour12: false, timeZone: q.timezone || fallbackTz,
  }).format(at)) % 24;
  return q.start <= q.end ? hour >= q.start && hour < q.end : hour >= q.start || hour < q.end;
}

function gateCheck(tgCfg, severity, state, now) {
  const exempt = (list) => (list || ['critical']).includes(severity);
  if (inQuietHours(tgCfg.quietHours, new Date(now), tgCfg.timezone) && !exempt(tgCfg.quietHours?.exceptSeverities)) {
    const q = tgCfg.quietHours;
    return `静默时段 ${q.start}:00-${q.end}:00 ${q.timezone || tgCfg.timezone}`;
  }
  const rl = tgCfg.rateLimit;
  if (rl?.maxPerHour > 0 && !exempt(rl.exceptSeverities)) {
    const recent = (state.sentLog || []).filter((t) => now - t < 3_600_000);
    if (recent.length >= rl.maxPerHour) return `已达每小时上限 ${rl.maxPerHour} 条`;
  }
  return null;
}

/** 每天固定时刻推一份状态。不做精确到点触发 —— cron 会抖动，
 *  改成「过了该时刻且今天还没发过」，第一次跑到就补发 */
function dueDailyReport(cfg, state, nowMs) {
  const d = cfg?.dailyReport;
  if (!d || d.enabled === false) return null;
  const tz = d.timezone || cfg?.timezone || 'Asia/Hong_Kong';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(nowMs)).reduce((a, p) => (a[p.type] = p.value, a), {});
  const today = `${parts.year}-${parts.month}-${parts.day}`;
  if (state.lastDailyReport === today) return null;
  const nowMin = (Number(parts.hour) % 24) * 60 + Number(parts.minute);
  if (nowMin < (d.hour ?? 10) * 60 + (d.minute ?? 0)) return null;
  return { date: today, tz, at: `${String(d.hour ?? 10).padStart(2, '0')}:${String(d.minute ?? 0).padStart(2, '0')}` };
}

const HISTORY_METRICS = ['midPrice', 'lastPrice', 'depthUsd', 'spreadPct', 'pegAbsDeviationPct'];

function pushHistory(state, snapshot, rules) {
  const maxWindow = Math.max(0, ...rules.flatMap((r) => (r.when || []).map((c) => c.windowMinutes || 0)));
  if (!maxWindow) return;
  const d = {};
  for (const r of Object.values(snapshot.reserves)) {
    const m = {};
    for (const k of HISTORY_METRICS) if (typeof r[k] === 'number') m[k] = r[k];
    d[r.symbol] = m;
  }
  state.history.push({ t: snapshot.ts, d });
  state.history = state.history.filter((p) => p.t >= snapshot.ts - maxWindow * 60_000 * 1.2);
}

async function runOnce(cfg, { notify = true, quiet = false } = {}) {
  const statePath = resolve(ROOT, cfg.statePath || 'bybit/data/state.json');
  const state = loadState(statePath);
  const tgCfg = tgOptions(cfg);
  const now = Date.now();

  let snapshot = await snapshotNow(cfg);
  if (!quiet) printTable(snapshot);

  let events = evaluateRules(cfg.rules, snapshot, state.lastSnapshot, state.history);

  // 多轮确认：最多抓三次，累计命中两次才发。挡掉只出现一次的假警报
  const confirmSec = cfg.confirmDelaySeconds ?? 0;
  const retrySec = cfg.confirmRetrySeconds ?? 0;
  const minVotes = cfg.confirmMinVotes ?? 2;
  if (confirmSec > 0 && events.some((e) => e.firing)) {
    const votes = new Map();
    const lastHit = new Map();
    const tally = (evs) => {
      for (const e of evs) {
        if (!e.firing) continue;
        votes.set(e.key, (votes.get(e.key) || 0) + 1);
        lastHit.set(e.key, e);
      }
    };
    tally(events);
    let latest = events;
    let pass = 1;
    const pending = () => [...votes.keys()].filter((k) => (votes.get(k) || 0) < minVotes);
    for (const waitSec of [confirmSec, retrySec]) {
      if (waitSec <= 0 || !pending().length) break;
      pass++;
      console.log(`[confirm] 第 ${pass - 1} 次有 ${votes.size} 条命中，${pending().length} 条待确认，等 ${waitSec}s 后重查`);
      await new Promise((r) => setTimeout(r, waitSec * 1000));
      let snapN = null;
      try { snapN = await snapshotNow(cfg); }
      catch (e) { console.error(`[confirm] 第 ${pass} 次抓取失败: ${e.message}`); break; }
      latest = evaluateRules(cfg.rules, snapN, state.lastSnapshot, state.history);
      tally(latest);
      snapshot = snapN;
    }
    const confirmed = confirmedByVotes(votes, minVotes);
    for (const [k, n] of votes) {
      console.log(confirmed.has(k)
        ? `[confirm] ✓ ${k} ${n}/${pass} 次命中，确认发送`
        : `[confirm] ✗ ${k} 仅 ${n}/${pass} 次命中，判定为抖动，不发送`);
    }
    events = latest.map((e) => (confirmed.has(e.key)
      ? { ...(lastHit.get(e.key) || e), firing: true } : { ...e, firing: false }));
  }

  state.sentLog = (state.sentLog || []).filter((t) => now - t < 3_600_000);
  const outbox = [];
  for (const ev of events) {
    const prev = state.alerts[ev.key] || {};
    const wasFiring = Boolean(prev.firing);
    const wasNotified = prev.notified ?? wasFiring;
    const cooldownMs = (ev.rule.cooldownMinutes ?? cfg.defaultCooldownMinutes ?? 60) * 60_000;
    const repeat = ev.rule.repeat !== false;
    const notifyOnRecover = ev.rule.notifyOnRecover ?? tgCfg.notifyOnRecover ?? true;

    if (ev.firing) {
      const since = wasFiring ? prev.since || now : now;
      if (!wasNotified || (repeat && now - (prev.lastNotifiedAt || 0) >= cooldownMs)) {
        outbox.push({ ev, kind: wasNotified ? 'repeat' : 'fire' });
        state.alerts[ev.key] = { firing: true, notified: wasNotified, lastNotifiedAt: prev.lastNotifiedAt || 0, since };
      } else {
        state.alerts[ev.key] = { ...prev, firing: true, notified: wasNotified, since };
      }
    } else if (wasFiring) {
      if (notifyOnRecover && wasNotified) outbox.push({ ev, kind: 'recover' });
      state.alerts[ev.key] = { firing: false, notified: false, lastNotifiedAt: prev.lastNotifiedAt || 0, since: 0 };
    }
  }

  const daily = notify && tgReady() ? dueDailyReport(tgCfg, state, now) : null;
  const configured = tgReady();
  const digestMode = (tgCfg.mode || 'digest') !== 'single';
  let sent = 0;

  for (const { ev, kind } of outbox) {
    console.log(`[alert] ${kind === 'recover' ? '恢复' : '触发'} ${ev.key} :: ${ev.details.join(' | ')}`);
  }
  const markNotified = (items) => {
    for (const { ev, kind } of items) {
      if (kind !== 'recover') state.alerts[ev.key] = { ...state.alerts[ev.key], notified: true, lastNotifiedAt: now };
    }
  };

  if (outbox.length && !notify) {
    console.log(`--- 报警内容预览 ---\n${stripHtml(digestMode
      ? digestMessage(outbox, snapshot, tgCfg)
      : outbox.map(({ ev, kind }) => alertMessage(ev, snapshot, kind, tgCfg)).join('\n\n'))}\n`);
  } else if (outbox.length && configured) {
    const fires = outbox.filter((i) => i.kind !== 'recover');
    const sev = fires.length ? topSeverity(fires) : 'info';
    const blocked = fires.length ? gateCheck(tgCfg, sev, state, now) : null;
    if (blocked) {
      console.log(`[hold] ${outbox.length} 条暂不推送（${blocked}）`);
    } else {
      try {
        if (digestMode) {
          await send(digestMessage(outbox, snapshot, tgCfg), { silent: (tgCfg.silentSeverities || []).includes(sev) });
          sent = 1;
        } else {
          for (const { ev, kind } of outbox) {
            await send(alertMessage(ev, snapshot, kind, tgCfg), { silent: (tgCfg.silentSeverities || []).includes(ev.severity) });
            sent++;
          }
        }
        state.sentLog.push(now);
        markNotified(outbox);
        console.log(`[sent] ${outbox.length} 条已推送`);
      } catch (e) {
        console.error(`[telegram] ${e.message}`);
      }
    }
  }

  if (!outbox.length && notify && configured && tgCfg.alwaysSend && !daily) {
    const blocked = gateCheck(tgCfg, 'info', state, now);
    if (blocked) console.log(`[hold] 状态快照暂不推送（${blocked}）`);
    else {
      try {
        await send(summaryMessage(snapshot, state.lastSnapshot, '✅ Bybit 现货 · 一切正常', tgCfg), { silent: true });
        sent++; state.sentLog.push(now);
        console.log('[sent] 无报警，已推送状态快照（alwaysSend）');
      } catch (e) { console.error(`[telegram] ${e.message}`); }
    }
  }

  if (daily) {
    try {
      await send(summaryMessage(snapshot, state.lastSnapshot, `☀️ Bybit 现货每日状态 · ${daily.date}`, tgCfg), { silent: false });
      state.lastDailyReport = daily.date;
      sent++; state.sentLog.push(now);
      console.log(`[sent] 每日状态推送（${daily.date} ${daily.at} ${daily.tz}）`);
    } catch (e) { console.error(`[telegram] 每日推送失败: ${e.message}`); }
  }

  if (!outbox.length && !quiet) console.log('[ok] 无规则触发');
  if (notify && !configured && outbox.length) {
    console.warn('[warn] 未配置 BYBIT_TELEGRAM_BOT_TOKEN / BYBIT_TELEGRAM_CHAT_ID，报警只打印在终端');
  }

  pushHistory(state, snapshot, cfg.rules);
  state.lastSnapshot = snapshot;
  saveState(statePath, state);
  return { snapshot, events, sent };
}

function printTgConfig(cfg) {
  const t = tgOptions(cfg);
  console.log('\n── Telegram 推送配置 ──');
  console.log(`凭据        : ${tgReady() ? '✅ 已配置' : '❌ 未配置（.env 填 BYBIT_TELEGRAM_BOT_TOKEN / BYBIT_TELEGRAM_CHAT_ID）'}`);
  console.log(`凭据来源    : token=${process.env.BYBIT_TELEGRAM_BOT_TOKEN ? 'BYBIT_TELEGRAM_BOT_TOKEN' : 'TELEGRAM_BOT_TOKEN'}`
    + ` ｜ chat=${process.env.BYBIT_TELEGRAM_CHAT_ID ? 'BYBIT_TELEGRAM_CHAT_ID' : 'TELEGRAM_CHAT_ID'}`);
  const d = t.dailyReport;
  console.log(`每日推送    : ${d && d.enabled !== false
    ? `每天 ${String(d.hour ?? 10).padStart(2, '0')}:${String(d.minute ?? 0).padStart(2, '0')} ${d.timezone || t.timezone}` : '关闭'}`);
  console.log(`报警确认    : ${cfg.confirmDelaySeconds > 0
    ? `最多 ${cfg.confirmRetrySeconds > 0 ? 3 : 2} 次抓取，累计命中 ${cfg.confirmMinVotes ?? 2} 次才发` : '关闭'}`);
  console.log(`轮询间隔    : ${cfg.intervalSeconds || 60}s ｜ 默认重复间隔: ${cfg.defaultCooldownMinutes ?? 60} 分钟`);
}

// ---------- CLI ----------
loadEnv();
const argv = process.argv.slice(2);
const cmd = argv[0] || 'once';
const flags = new Set(argv.slice(1));
const cfgFlag = argv.find((a) => a.startsWith('--config='))?.split('=')[1];

try {
  const cfg = loadConfig(ROOT, cfgFlag);

  if (cmd === 'show') {
    const snap = await snapshotNow(cfg);
    if (flags.has('--json')) console.log(JSON.stringify(snap, null, 2));
    else printTable(snap);
  } else if (cmd === 'check') {
    const snap = await snapshotNow(cfg);
    console.log(`\n配置: ${cfg.__path}（阈值规则 ${cfg.thresholdRuleCount} 条，高级规则 ${cfg.rules.length - cfg.thresholdRuleCount} 条）`);
    printTable(snap);
    console.log('阈值对照：');
    printThresholds(cfg, snap);
    printTgConfig(cfg);
  } else if (cmd === 'once') {
    await runOnce(cfg, { notify: !flags.has('--dry-run'), quiet: flags.has('--quiet') });
  } else if (cmd === 'watch') {
    const everyMs = (cfg.intervalSeconds || 60) * 1000;
    console.log(`[watch] 每 ${everyMs / 1000}s 检查一次 ｜ 配置 ${cfg.__path} ｜ 规则 ${cfg.rules.length} 条`);
    for (;;) {
      try { await runOnce(cfg, { notify: true, quiet: flags.has('--quiet') }); }
      catch (e) { console.error(`[error] ${e.message}`); }
      await new Promise((r) => setTimeout(r, everyMs));
    }
  } else if (cmd === 'snapshot' || cmd === 'test-tg') {
    const snap = await snapshotNow(cfg);
    const t = tgOptions(cfg);
    const text = flags.has('--full') ? statusMessage(snap, t)
      : summaryMessage(snap, null, cmd === 'test-tg' ? '🔔 Bybit 监控连通性测试' : '📊 Bybit 现货当前状态', t);
    console.log(stripHtml(text));
    if (flags.has('--dry-run')) console.log('\n[dry-run] 未发送');
    else { requireTg(); await send(text, { silent: flags.has('--silent') }); console.log('\n[ok] 已发送到 Telegram'); }
  } else if (cmd === 'chat-id') {
    const ids = await tg.getChatIds(btToken());
    if (!ids.length) console.log('没抓到会话，先把 bot 拉进群或私聊发一条消息再试');
    else ids.forEach((c) => console.log(`${c.id}\t${c.name}`));
  } else {
    console.log(`用法: ./bybit/monitor <command> [flags]

  check                指标 + 阈值对照 + TG 配置自检
  show [--json]        只打印行情
  once [--dry-run]     检查一次并报警
  watch [--quiet]      常驻循环
  snapshot [--full]    把当前状态发到 TG
  test-tg              发连通性测试
  chat-id              列出 bot 能看到的 chat_id
    --config=path      指定配置文件
`);
  }
} catch (e) {
  console.error(`[fatal] ${e.message}`);
  process.exit(1);
}
