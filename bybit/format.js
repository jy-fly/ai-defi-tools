// Bybit 的消息渲染。单交易对 + 只看两个价格，用不着通用的表格骨架，
// 自己写一份更贴合「等价位下手」这个场景。
import { fmtNum } from '../core/rules.js';
import { stripHtml, topSeverity } from '../core/format.js';
import { escapeHtml } from '../tg/index.js';
import './metrics.js';   // 触发指标注册，让规则详情里的价格也带够小数位

// 价格显示不走全局注册表 —— 那个要靠 import 副作用生效，
// 少 import 一个文件就会把 1.0003 显示成 1.00，太容易踩
const price = (v) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(4) : '-');

export const DEFAULT_TG = {
  timezone: 'Asia/Hong_Kong',
  mode: 'digest',
  fields: ['ask1Price', 'bid1Price'],
  heartbeatFields: ['ask1Price', 'bid1Price'],
  showRuleId: false,
  showTimestamp: true,
  silentSeverities: ['info'],
};

const SEV = { info: 'ℹ️', warn: '🔔', critical: '🚨' };

export const tgOptions = (cfg) => ({ ...DEFAULT_TG, ...(cfg?.telegram || {}) });

function fmtTime(ts, tz) {
  const d = new Date(ts);
  const t = new Intl.DateTimeFormat('sv-SE', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(d);
  const zone = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' })
    .formatToParts(d).find((p) => p.type === 'timeZoneName')?.value || '';
  return `${t}${zone ? ' ' + zone : ''}`;
}
const stamp = (snap, tg) => fmtTime(snap.ts, tg.timezone || DEFAULT_TG.timezone);

/** 一行给出买一卖一。不用 <pre> —— 一行里没有列要对齐，
 *  普通文本在通知栏的预览里也显示得更完整 */
function priceLine(r) {
  const pair = r.symbol.replace(/USDT$/, '/USDT');
  return `${escapeHtml(pair)} 卖一 ${price(r.ask1Price)}　买一 ${price(r.bid1Price)}`;
}

const stamp2 = (snap, tg) => fmtTime(snap.ts, tg.timezone || DEFAULT_TG.timezone);

export function digestMessage(items, snapshot, tg = DEFAULT_TG) {
  const fires = items.filter((i) => i.kind !== 'recover');
  const icon = fires.length ? (SEV[topSeverity(fires)] || '🔔') : '✅';
  const out = [];
  const seen = new Set();

  for (const { ev, kind } of items) {
    if (seen.has(ev.symbol)) continue;
    seen.add(ev.symbol);
    out.push(`${kind === 'recover' ? '✅' : icon} <b>${priceLine(ev.reserve)}</b>`);
    const reasons = items.filter((i) => i.ev.symbol === ev.symbol)
      .map((i) => (i.kind === 'recover' ? '已回到阈值之上' : i.ev.title));
    for (const r of reasons) out.push(escapeHtml(r));
  }
  if (tg.showTimestamp) out.push('', stamp2(snapshot, tg));
  return out.join('\n');
}

export function alertMessage(ev, snapshot, kind, tg = DEFAULT_TG) {
  return digestMessage([{ ev, kind }], snapshot, tg);
}

export function summaryMessage(snapshot, prev, title = '📊', tg = DEFAULT_TG) {
  const out = [];
  for (const r of Object.values(snapshot.reserves)) {
    let line = `${title} <b>${priceLine(r)}</b>`;
    const p = prev?.reserves?.[r.symbol];
    if (p && typeof p.ask1Price === 'number') {
      const d = r.ask1Price - p.ask1Price;
      if (Math.abs(d) >= 0.00005) line += `　${d > 0 ? '🟢▲' : '🔴▼'}${Math.abs(d).toFixed(4)}`;
    }
    out.push(line);
  }
  if (tg.showTimestamp) out.push('', stamp2(snapshot, tg));
  return out.join('\n');
}

export const statusMessage = (snap, tg = DEFAULT_TG, title = '📊 USDC/USDT') =>
  summaryMessage(snap, null, title, tg);

export function printTable(snapshot) {
  console.log(`\n${new Date(snapshot.ts).toLocaleString()}`);
  console.table(Object.values(snapshot.reserves).map((r) => ({
    交易对: r.symbol,
    卖一: price(r.ask1Price),
    买一: price(r.bid1Price),
    最新: price(r.lastPrice),
    '24h': fmtNum('price24hPcnt', r.price24hPcnt),
  })));
}

export function printThresholds(cfg, snapshot) {
  const rows = [];
  for (const m of cfg.monitors || []) {
    const r = snapshot.reserves[m.symbol];
    if (!r) continue;
    for (const [metric, specRaw] of Object.entries(m.alerts || {})) {
      if (!specRaw) continue;
      const spec = typeof specRaw === 'object' ? specRaw : { value: specRaw };
      const op = spec.op || '>=';
      const cur = r[metric];
      const hit = ({ '>': (a, b) => a > b, '>=': (a, b) => a >= b, '<': (a, b) => a < b, '<=': (a, b) => a <= b }[op] || (() => false))(cur, spec.value);
      rows.push({ 交易对: m.symbol, 指标: metric, 条件: `${op} ${price(spec.value)}`,
                  当前值: price(cur), 状态: hit ? '🔴 触发' : '🟢 未到' });
    }
    // cfg.rules 的前 thresholdRuleCount 条就是上面 alerts 展开来的，跳过避免重复
    for (const rule of (cfg.rules || []).slice(cfg.thresholdRuleCount || 0)) {
      const c = (rule.when || [])[0];
      if (!c) continue;
      const cur = r[c.metric];
      const hit = c.op === '<=' ? cur <= c.value : false;
      rows.push({ 交易对: m.symbol, 指标: c.metric, 条件: `${c.op} ${price(c.value)}`,
                  当前值: price(cur), 状态: hit ? '🔴 触发' : '🟢 未到' });
    }
  }
  console.table(rows);
}

export { stripHtml, topSeverity };
