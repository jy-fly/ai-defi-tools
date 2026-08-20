#!/usr/bin/env node
// Aave V3 池子监控 -> Telegram 报警
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { makeClient, fetchReserves } from './reserves.js';
import { evaluateRules } from './rules.js';
import { loadState, saveState } from './state.js';
import { loadConfig } from './config.js';
import { appendHistory } from './history.js';
import { writeMongo } from './mongo.js';
import {
  alertMessage, summaryMessage, printTable, printThresholds, stripHtml,
  tgOptions, DEFAULT_TG, METRICS, COMPOSITE_FIELDS, digestMessage, topSeverity, statusMessage,
} from './format.js';
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

const rpcList = (cfg) =>
  (process.env.ETH_RPC_URLS || process.env.RPC_URLS || (cfg.rpcUrls || []).join(','))
    .split(',').map((s) => s.trim()).filter(Boolean);

// TG 凭据两级回落：AAVE_TELEGRAM_* 优先（专属 bot / 专属群），
// 没设则回落到通用的 TELEGRAM_*（多个协议共用一个 bot 时用这个）
const aaveToken = () => process.env.AAVE_TELEGRAM_BOT_TOKEN || undefined;
const aaveChat = () => process.env.AAVE_TELEGRAM_CHAT_ID || undefined;
const creds = () => ({ token: aaveToken(), chatId: aaveChat() });
const send = (text, opts = {}) => tg.sendMessage(text, { ...creds(), ...opts });
const tgReady = () => tg.isConfigured(creds());

/** 需要真发消息的命令用它先卡一道，把「到底该配哪个变量」讲清楚 */
function requireTg() {
  if (tgReady()) return;
  const seen = (k) => (process.env[k] ? '✅ 有值' : '— 空');
  throw new Error(
    'Telegram 凭据没读到。当前环境变量：\n'
    + `  AAVE_TELEGRAM_BOT_TOKEN  ${seen('AAVE_TELEGRAM_BOT_TOKEN')}\n`
    + `  AAVE_TELEGRAM_CHAT_ID    ${seen('AAVE_TELEGRAM_CHAT_ID')}\n`
    + `  TELEGRAM_BOT_TOKEN       ${seen('TELEGRAM_BOT_TOKEN')}   （兜底）\n`
    + `  TELEGRAM_CHAT_ID         ${seen('TELEGRAM_CHAT_ID')}   （兜底）\n`
    + '  优先级 AAVE_TELEGRAM_* > TELEGRAM_*，两组都空就是这个错。\n'
    + '  本地：填 .env。GitHub Actions：Settings → Secrets and variables → Actions，\n'
    + '  Secret 名字必须是 AAVE_TELEGRAM_BOT_TOKEN / AAVE_TELEGRAM_CHAT_ID（大小写和前缀都要一致）。'
  );
}

const snapshotNow = (cfg) => fetchReserves(makeClient(rpcList(cfg)), cfg.assets);


// 供窗口类规则回看的指标。只存这几个，288 个点(1天)约 60KB，
// 放在 Actions cache 里没问题；存全字段会膨胀好几倍。
const HISTORY_METRICS = ['availableLiquidityUsd', 'utilizationRate', 'reserveSizeUsd', 'supplyAPY'];

/** 追加当前快照到滑动窗口，并裁掉超出最长窗口需求的旧点 */
function pushHistory(state, snapshot, rules) {
  const windows = rules.flatMap((r) => (r.when || []).map((c) => c.windowMinutes || 0));
  const maxWindow = Math.max(0, ...windows);
  if (!maxWindow) return;                       // 没有窗口类规则就不用留历史

  const d = {};
  for (const r of Object.values(snapshot.reserves)) {
    const m = {};
    for (const k of HISTORY_METRICS) {
      const v = r[k];
      if (typeof v === 'number' && Number.isFinite(v)) {
        // 大额取整、百分比留两位，省体积
        m[k] = k.endsWith('Usd') ? Math.round(v) : Math.round(v * 100) / 100;
      }
    }
    d[r.symbol] = m;
  }
  state.history.push({ t: snapshot.ts, d });

  // 多留 20% 余量，避免 cron 抖动时刚好差一点导致窗口规则失效
  const keepMs = maxWindow * 60_000 * 1.2;
  const cutoff = snapshot.ts - keepMs;
  state.history = state.history.filter((p) => p.t >= cutoff);
}

/** 当前是否处于静默时段（支持跨午夜，如 23 点到次日 7 点） */
function inQuietHours(q, at = new Date(), fallbackTz = 'Asia/Hong_Kong') {
  if (!q || q.enabled === false || q.start === undefined || q.end === undefined) return false;
  const hour = Number(
    new Intl.DateTimeFormat('en-US', {
      hour: 'numeric', hour12: false, timeZone: q.timezone || fallbackTz,
    }).format(at)
  ) % 24;
  return q.start <= q.end ? hour >= q.start && hour < q.end : hour >= q.start || hour < q.end;
}


/** 每天固定时刻推一份状态。
 *  刻意不做「精确到点触发」—— GitHub cron 会抖动十几分钟甚至跳过整轮，
 *  所以判定改成「今天过了该时刻、且今天还没发过」，第一次跑到就补发。 */
function dueDailyReport(cfg, state, nowMs) {
  const d = cfg?.dailyReport;
  if (!d || d.enabled === false) return null;
  const tz = d.timezone || cfg?.timezone || 'Asia/Hong_Kong';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(nowMs)).reduce((a, p) => (a[p.type] = p.value, a), {});

  const today = `${parts.year}-${parts.month}-${parts.day}`;
  if (state.lastDailyReport === today) return null;          // 今天已经发过

  const nowMin = Number(parts.hour) % 24 * 60 + Number(parts.minute);
  const dueMin = (d.hour ?? 10) * 60 + (d.minute ?? 0);
  if (nowMin < dueMin) return null;                          // 还没到点

  return { date: today, tz, at: `${String(d.hour ?? 10).padStart(2,'0')}:${String(d.minute ?? 0).padStart(2,'0')}` };
}

/** 推送前的闸门：静默时段 / 每小时条数上限。返回 null 表示放行，否则返回拦截原因 */
function gateCheck(tgCfg, severity, state, now) {
  const exempt = (list) => (list || ['critical']).includes(severity);

  if (inQuietHours(tgCfg.quietHours, new Date(now), tgCfg.timezone) && !exempt(tgCfg.quietHours?.exceptSeverities)) {
    const q = tgCfg.quietHours;
    return `静默时段 ${q.start}:00-${q.end}:00 ${q.timezone || 'Asia/Hong_Kong'}`;
  }

  const rl = tgCfg.rateLimit;
  if (rl?.maxPerHour > 0 && !exempt(rl.exceptSeverities)) {
    const recent = (state.sentLog || []).filter((t) => now - t < 3_600_000);
    if (recent.length >= rl.maxPerHour) return `已达每小时上限 ${rl.maxPerHour} 条`;
  }
  return null;
}

async function runOnce(cfg, { notify = true, quiet = false, historyPath = null, collectOnly = false } = {}) {
  const statePath = resolve(ROOT, cfg.statePath || 'aave/data/state.json');
  const state = loadState(statePath);
  const tgCfg = tgOptions(cfg);
  const snapshot = await snapshotNow(cfg);
  if (!quiet) printTable(snapshot);

  const events = collectOnly ? [] : evaluateRules(cfg.rules, snapshot, state.lastSnapshot, state.history);
  const now = Date.now();
  state.sentLog = (state.sentLog || []).filter((t) => now - t < 3_600_000);
  const outbox = [];

  for (const ev of events) {
    const prev = state.alerts[ev.key] || {};
    const wasFiring = Boolean(prev.firing);
    const wasNotified = prev.notified ?? wasFiring; // 兼容旧 state 文件
    const cooldownMs = (ev.rule.cooldownMinutes ?? cfg.defaultCooldownMinutes ?? 60) * 60_000;
    const repeat = ev.rule.repeat !== false;
    const notifyOnRecover = ev.rule.notifyOnRecover ?? tgCfg.notifyOnRecover ?? cfg.notifyOnRecover ?? true;

    if (ev.firing) {
      const since = wasFiring ? prev.since || now : now;
      // 还没推过（含被闸门拦下的） 或 cooldown 已过
      const wantNotify = !wasNotified || (repeat && now - (prev.lastNotifiedAt || 0) >= cooldownMs);
      if (wantNotify) {
        outbox.push({ ev, kind: wasNotified ? 'repeat' : 'fire' });
        state.alerts[ev.key] = { firing: true, notified: wasNotified, lastNotifiedAt: prev.lastNotifiedAt || 0, since };
      } else {
        state.alerts[ev.key] = { ...prev, firing: true, notified: wasNotified, since };
      }
    } else if (wasFiring) {
      // 只有真的推送过，才需要告诉你「恢复了」
      if (notifyOnRecover && wasNotified) outbox.push({ ev, kind: 'recover' });
      state.alerts[ev.key] = { firing: false, notified: false, lastNotifiedAt: prev.lastNotifiedAt || 0, since: 0 };
    }
  }

  const hb = cfg.heartbeatHours || 0;
  const heartbeat = hb > 0 && now - (state.lastHeartbeatAt || 0) >= hb * 3_600_000;

  const configured = tgReady();
  const digestMode = (tgCfg.mode || 'digest') !== 'single';
  let sent = 0;

  for (const { ev, kind } of outbox) {
    console.log(`[alert] ${kind === 'recover' ? '恢复' : '触发'} ${ev.key} :: ${ev.details.join(' | ')}`);
  }

  const markNotified = (items) => {
    for (const { ev, kind } of items) {
      if (kind !== 'recover') {
        state.alerts[ev.key] = { ...state.alerts[ev.key], notified: true, lastNotifiedAt: now };
      }
    }
  };

  if (outbox.length && !notify) {
    // 终端预览：按实际会发出去的形态渲染
    if (digestMode) {
      console.log(`--- 报警内容预览（digest：${outbox.length} 条合并为 1 条消息）---\n${stripHtml(digestMessage(outbox, snapshot, tgCfg))}\n`);
    } else {
      for (const { ev, kind } of outbox) {
        console.log(`--- 报警内容预览 ---\n${stripHtml(alertMessage(ev, snapshot, kind, tgCfg))}\n`);
      }
    }
  } else if (outbox.length && configured && digestMode) {
    // 一轮所有报警合并成一条：按最高级别过闸、按最高级别决定是否响铃
    const fires = outbox.filter((i) => i.kind !== 'recover');
    const sev = fires.length ? topSeverity(fires) : 'info';
    const blocked = fires.length ? gateCheck(tgCfg, sev, state, now) : null;
    if (blocked) {
      console.log(`[hold] ${outbox.length} 条暂不推送（${blocked}），条件持续满足则下轮补发`);
    } else {
      try {
        await send(digestMessage(outbox, snapshot, tgCfg), {
          silent: (tgCfg.silentSeverities || []).includes(sev),
        });
        sent = 1;
        state.sentLog.push(now);
        markNotified(outbox);
        console.log(`[sent] ${outbox.length} 条合并为 1 条消息已推送`);
      } catch (e) {
        console.error(`[telegram] ${e.message}`);
      }
    }
  } else if (outbox.length && configured) {
    // single 模式：逐条发
    for (const { ev, kind } of outbox) {
      const blocked = kind === 'recover' ? null : gateCheck(tgCfg, ev.severity, state, now);
      if (blocked) {
        console.log(`[hold] ${ev.key} 暂不推送（${blocked}），条件持续满足则下轮补发`);
        continue;
      }
      try {
        await send(alertMessage(ev, snapshot, kind, tgCfg), {
          silent: (tgCfg.silentSeverities || []).includes(ev.severity),
        });
        sent++;
        state.sentLog.push(now);
        markNotified([{ ev, kind }]);
      } catch (e) {
        console.error(`[telegram] ${e.message}`);
      }
    }
  }

  // 每日定时推送先判定：它和 alwaysSend 都是「无报警也发」，
  // 同一轮里两个都发就是两条几乎一样的消息，所以 daily 优先、alwaysSend 让位
  const daily = notify && configured ? dueDailyReport(tgCfg, state, now) : null;

  // 测试阶段：没报警也发一条，用来确认监控在跑（消息时间戳就是实际运行时刻，
  // 正好能看出 GitHub cron 抖得多厉害）
  if (!outbox.length && !daily && notify && configured && tgCfg.alwaysSend) {
    const blocked = gateCheck(tgCfg, 'info', state, now);
    if (blocked) {
      console.log(`[hold] 状态快照暂不推送（${blocked}）`);
    } else {
      try {
        await send(summaryMessage(snapshot, state.lastSnapshot, '✅ Aave V3 · 一切正常', tgCfg), { silent: true });
        sent++;
        state.sentLog.push(now);
        console.log('[sent] 无报警，已推送状态快照（alwaysSend）');
      } catch (e) {
        console.error(`[telegram] ${e.message}`);
      }
    }
  }

  // 每日定时状态推送
  if (daily) {
    try {
      await send(
        summaryMessage(snapshot, state.lastSnapshot, `☀️ Aave V3 每日状态 · ${daily.date}`, tgCfg),
        { silent: false }
      );
      state.lastDailyReport = daily.date;
      sent++;
      state.sentLog.push(now);
      console.log(`[sent] 每日状态推送（${daily.date} ${daily.at} ${daily.tz}）`);
    } catch (e) {
      console.error(`[telegram] 每日推送失败: ${e.message}`);
    }
  }

  if (heartbeat && notify && configured) {
    try {
      await send(summaryMessage(snapshot, state.lastSnapshot, '📊 Aave V3 定时快照', tgCfg), { silent: true });
      state.lastHeartbeatAt = now;
    } catch (e) { console.error(`[telegram] ${e.message}`); }
  }

  if (!outbox.length && !quiet) console.log(collectOnly ? '[ok] 采集模式，未判规则' : '[ok] 无规则触发');
  if (notify && !configured && outbox.length) {
    console.warn('[warn] 未配置 AAVE_TELEGRAM_BOT_TOKEN / AAVE_TELEGRAM_CHAT_ID，报警只打印在终端');
  }

  // ── 历史落库 ──
  // 放在报警之后：报警是主线，落库是附加价值，任何一个后端挂了都不能影响推送。
  // 复用上面那次抓取的快照，不额外发 RPC 请求。
  const bucketMinutes = cfg.historyIntervalMinutes ?? 60;
  if (historyPath) {
    try {
      const r = appendHistory(historyPath, snapshot, bucketMinutes * 60_000);
      if (r.written) console.log(`[history] 已写入 ${r.written} 行 -> ${historyPath}`);
      else if (!quiet) console.log(`[history] 跳过（${r.reason}）`);
    } catch (e) {
      console.error(`[history] 写入失败（不影响报警）: ${e.message}`);
    }
  }
  if (process.env.MONGODB_URI) {
    try {
      const rs = await writeMongo(process.env.MONGODB_URI, snapshot, {
        db: cfg.mongo?.db,
        tiers: cfg.mongo?.tiers,
      });
      for (const r of rs) {
        const note = r.indexNote === 'ok' ? '' : `（TTL 索引${r.indexNote === 'created' ? '已创建' : '已更新'}）`;
        console.log(`[mongo] ${r.collection.padEnd(8)} 新增 ${r.inserted} · 刷新 ${r.updated} · 共 ${r.total} 条 · 留存 ${r.ttlDays} 天${note}`);
      }
    } catch (e) {
      console.error(`[mongo] 写入失败（不影响报警）: ${e.message}`);
    }
  }

  pushHistory(state, snapshot, cfg.rules);
  state.lastSnapshot = snapshot;
  saveState(statePath, state);
  return { snapshot, events, sent };
}

/** 打印 TG 相关配置的自检信息 */
function printTgConfig(cfg) {
  const t = tgOptions(cfg);
  console.log('\n── Telegram 推送配置 ──');
  console.log(`凭据        : ${tgReady() ? '✅ 已配置' : '❌ 未配置（.env 填 AAVE_TELEGRAM_BOT_TOKEN / AAVE_TELEGRAM_CHAT_ID）'}`);
  console.log(`凭据来源    : token=${process.env.AAVE_TELEGRAM_BOT_TOKEN ? 'AAVE_TELEGRAM_BOT_TOKEN' : 'TELEGRAM_BOT_TOKEN'}`
    + ` ｜ chat=${process.env.AAVE_TELEGRAM_CHAT_ID ? 'AAVE_TELEGRAM_CHAT_ID' : 'TELEGRAM_CHAT_ID'}`);
  console.log(`推送模式    : ${(t.mode || 'digest') === 'single' ? 'single（每条报警各发一条）' : `digest（一轮所有报警合并成一条${t.digestIncludeOthers !== false ? '，附未触发池子对照' : ''}）`}`);
  console.log(`消息字段    : ${(t.fields || []).join(', ')}`);
  console.log(`快照字段    : ${(t.heartbeatFields || []).join(', ')}`);
  console.log(`静音级别    : ${(t.silentSeverities || []).join(', ') || '（无）'}`);
  if (t.alwaysSend) console.log('⚠️ alwaysSend  : 开启 —— 每轮无论有无报警都推送（测试用，上线记得关）');
  const d = t.dailyReport;
  console.log(`每日推送    : ${d && d.enabled !== false
    ? `每天 ${String(d.hour ?? 10).padStart(2,'0')}:${String(d.minute ?? 0).padStart(2,'0')} ${d.timezone || 'Asia/Hong_Kong'}（过点后第一次运行补发）`
    : '关闭'}`);
  console.log(`Aave 链接   : ${t.showAaveLink ? '显示' : '隐藏'} ｜ 区块时间: ${t.showTimestamp ? '显示' : '隐藏'} ｜ 规则 ID: ${t.showRuleId ? '显示' : '隐藏'}`);
  const q = t.quietHours;
  console.log(`静默时段    : ${q && q.enabled !== false && q.start !== undefined
    ? `${q.start}:00-${q.end}:00 ${q.timezone || 'Asia/Hong_Kong'}（${(q.exceptSeverities || ['critical']).join('/')} 穿透）｜ 当前${inQuietHours(q) ? '在静默中' : '不在静默'}`
    : '未启用'}`);
  console.log(`每小时上限  : ${t.rateLimit?.maxPerHour > 0
    ? `${t.rateLimit.maxPerHour} 条（${(t.rateLimit.exceptSeverities || ['critical']).join('/')} 穿透）` : '不限'}`);
  console.log(`轮询间隔    : ${cfg.intervalSeconds || 300}s ｜ 默认重复间隔: ${cfg.defaultCooldownMinutes ?? 60} 分钟 ｜ 定时快照: ${cfg.heartbeatHours ? `每 ${cfg.heartbeatHours}h` : '关闭'}`);
}

// ---------- CLI ----------
loadEnv();
const argv = process.argv.slice(2);
const cmd = argv[0] || 'once';
const flags = new Set(argv.slice(1));
const cfgFlag = argv.find((a) => a.startsWith('--config='))?.split('=')[1];
const histFlag = argv.find((a) => a.startsWith('--history='))?.split('=')[1];

try {
  const needCfg = ['show', 'once', 'watch', 'test-tg', 'snapshot', 'check', 'preview', 'fields'].includes(cmd);
  const cfg = needCfg ? loadConfig(ROOT, cfgFlag) : null;

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
  } else if (cmd === 'preview') {
    // 不管有没有触发，都按当前数据渲染一条样例消息，用来调 telegram.fields
    const snap = await snapshotNow(cfg);
    const symbol = argv.find((a) => !a.startsWith('--') && a !== 'preview') || Object.keys(snap.reserves)[0];
    const r = snap.reserves[symbol];
    if (!r) throw new Error(`找不到资产 ${symbol}，可选: ${Object.keys(snap.reserves).join(', ')}`);
    const fake = {
      symbol, ruleId: `${symbol}-preview`, severity: 'warn', rule: {},
      title: `${symbol} 样例报警（预览用）`, details: ['这是一条预览消息，用来确认字段和排版'], reserve: r,
    };
    const t = tgOptions(cfg);
    console.log(`\n===== 单条报警（single 模式）=====\n${stripHtml(alertMessage(fake, snap, 'fire', t))}`);
    const others = Object.keys(snap.reserves).filter((k) => k !== symbol);
    const fake2 = others[0] && {
      symbol: others[0], ruleId: `${others[0]}-preview`, severity: 'critical', rule: {},
      title: `${others[0]} 另一条样例报警`, details: ['演示多个池子同时触发时的合并效果'], reserve: snap.reserves[others[0]],
    };
    console.log(`\n===== 合并推送（digest 模式，两个池子同时触发）=====\n${stripHtml(digestMessage(
      [{ ev: fake, kind: 'fire' }, ...(fake2 ? [{ ev: fake2, kind: 'fire' }] : [])], snap, t))}`);
    console.log(`\n===== 定时快照 =====\n${stripHtml(summaryMessage(snap, null, '📊 Aave V3 定时快照', tgOptions(cfg)))}`);
    if (flags.has('--send')) {
      await send(alertMessage(fake, snap, 'fire', tgOptions(cfg)));
      console.log('\n[ok] 已把这条样例发到 TG');
    }
  } else if (cmd === 'fields') {
    console.log('\ntelegram.fields 可用值：\n');
    console.log('— 普通指标（自动带图标和单位）—');
    for (const [k, v] of Object.entries(METRICS)) console.log(`  ${k.padEnd(24)} ${v.emoji} ${v.label}`);
    console.log('\n— 复合字段（一行多值，只能用在 fields 里）—');
    for (const [k, v] of Object.entries(COMPOSITE_FIELDS)) console.log(`  ${k.padEnd(24)} ${v}`);
    console.log(`\n当前 fields: ${tgOptions(cfg).fields.join(', ')}`);
    console.log('默认 fields: ' + DEFAULT_TG.fields.join(', '));
  } else if (cmd === 'once') {
    // --collect-only: 只抓数据落库，不判规则不推送。
    // 用于开第二个低频 runner 提高采样密度 —— 报警交给主 runner，
    // 否则两边各自维护 cooldown，同一次下跌会被报两次
    const collectOnly = flags.has('--collect-only');
    await runOnce(cfg, {
      notify: !flags.has('--dry-run') && !collectOnly,
      quiet: flags.has('--quiet'),
      historyPath: histFlag,
      collectOnly,
    });
  } else if (cmd === 'watch') {
    const everyMs = (cfg.intervalSeconds || 300) * 1000;
    console.log(`[watch] 每 ${everyMs / 1000}s 检查一次 ｜ 配置 ${cfg.__path} ｜ 规则 ${cfg.rules.length} 条 ｜ Ctrl+C 退出`);
    for (;;) {
      try { await runOnce(cfg, { notify: true, quiet: flags.has('--quiet'), historyPath: histFlag }); }
      catch (e) { console.error(`[error] ${e.message}`); }
      await new Promise((r) => setTimeout(r, everyMs));
    }
  } else if (cmd === 'snapshot' || cmd === 'test-tg') {
    const snap = await snapshotNow(cfg);
    const t = tgOptions(cfg);
    const isTest = cmd === 'test-tg';
    const text = flags.has('--full')
      ? statusMessage(snap, t)
      : summaryMessage(snap, null, isTest ? '🔔 Aave V3 监控连通性测试' : '📊 Aave V3 当前状态', t);
    console.log(stripHtml(text));
    if (flags.has('--dry-run')) { console.log('\n[dry-run] 未发送'); }
    else { requireTg(); await send(text, { silent: flags.has('--silent') }); console.log('\n[ok] 已发送到 Telegram'); }
  } else if (cmd === 'chat-id') {
    const ids = await tg.getChatIds(aaveToken());
    if (!ids.length) console.log('没抓到会话，先把 bot 拉进群或私聊发一条消息再试');
    else ids.forEach((c) => console.log(`${c.id}\t${c.name}`));
  } else {
    console.log(`用法: node aave/index.js <command> [flags]

  check                打印指标 + 阈值对照 + TG 推送配置自检
  preview [资产] [--send]  按当前数据渲染样例消息，用来调 telegram.fields
  fields               列出 telegram.fields 所有可用字段
  show [--json]        只打印指标，不判规则
  once [--dry-run]     检查一次并报警；--dry-run 只在终端预览
       --collect-only  只抓数据落库，不判规则不推送（给副 runner 用）
  watch [--quiet]      常驻循环，间隔取 intervalSeconds
  snapshot [--full]    把当前状态发到 TG（--full 展开全部字段，--silent 静音，--dry-run 只预览）
  test-tg              同上，标题是「连通性测试」，用于首次验证凭据
  chat-id              列出 bot 能看到的 chat_id
    --config=path      指定配置文件（默认 aave/config.json）
    --history=path     把这次快照追加到 CSV（间隔由 historyIntervalMinutes 控制，默认 60 分钟）
`);
  }
} catch (e) {
  console.error(`[fatal] ${e.message}`);
  process.exit(1);
}
