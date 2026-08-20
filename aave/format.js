// 消息与终端表格渲染。TG 消息的字段/样式全部由 config.json 的 telegram 段驱动
import { fmtNum } from './rules.js';
import { METRICS, COMPOSITE_FIELDS, metricLabel, metricEmoji } from './metrics.js';
import { escapeHtml } from '../tg/index.js';

const SEV = { info: 'ℹ️', warn: '⚠️', critical: '🚨' };

export const DEFAULT_TG = {
  // digest = 一轮检查的所有报警合并成一条消息（按池子分组）；single = 每条报警各发一条
  mode: 'digest',
  // digest 里是否附上「其余未触发池子」的一行对照
  digestIncludeOthers: true,
  // 测试阶段用：没有任何报警时也推一条状态快照，好确认监控活着。
  // 上线后关掉，否则每轮都来一条会麻木，真报警反而被淹没。
  alwaysSend: false,
  fields: ['supplyAPY', 'reserveSize', 'availableLiquidity', 'utilizationRate', 'supplyCap', 'borrowLine', 'riskParams', 'status'],
  heartbeatFields: ['supplyAPY', 'utilizationRate', 'reserveSizeUsd', 'availableLiquidityUsd'],
  showRuleId: true,
  showAaveLink: true,
  showTimestamp: true,
  silentSeverities: ['info'],
};

export const tgOptions = (cfg) => ({ ...DEFAULT_TG, ...(cfg?.telegram || {}) });

export const aaveUrl = (addr) =>
  `https://app.aave.com/reserve-overview/?underlyingAsset=${addr.toLowerCase()}&marketName=proto_mainnet_v3`;

/** 渲染单个字段成一行；返回 null 表示这行不显示 */
function renderField(field, r) {
  switch (field) {
    case 'supplyCap':
      return `🧱 供应上限: ${r.supplyCap > 0
        ? `${fmtNum('reserveSize', r.supplyCap)}（已用 ${fmtNum('supplyCapUsedPct', r.supplyCapUsedPct)}）`
        : '无上限'}`;
    case 'riskParams':
      return `⚙️ LTV ${fmtNum('ltv', r.ltv)} ｜ 清算线 ${fmtNum('liquidationThreshold', r.liquidationThreshold)} ｜ 清算罚金 ${fmtNum('liquidationPenalty', r.liquidationPenalty)} ｜ Reserve Factor ${fmtNum('reserveFactor', r.reserveFactor)}`;
    case 'borrowLine':
      return `📉 借款 APY ${fmtNum('borrowAPY', r.borrowAPY)} ｜ 总借出 ${fmtNum('totalDebtUsd', r.totalDebtUsd)}`;
    case 'status':
      return (r.isFrozen || r.isPaused || !r.isActive)
        ? `🛑 状态异常: active=${r.isActive} frozen=${r.isFrozen} paused=${r.isPaused}`
        : null;
    default: {
      const meta = METRICS[field];
      if (!meta) return r[field] === undefined ? null : `• ${field}: ${fmtNum(field, r[field])}`;
      const main = fmtNum(field, r[field]);
      // reserveSize 这类同时给出代币量和美元值
      const usd = meta.usdPair ? ` (${fmtNum(meta.usdPair, r[meta.usdPair])})` : '';
      const unit = meta.usdPair ? ` ${r.symbol}` : '';
      return `${metricEmoji(field)} ${metricLabel(field)}: <b>${main}${unit}</b>${usd}`;
    }
  }
}

/** reserveSize 与 reserveSizeUsd 视为同一条信息 */
const baseMetric = (m) => m.replace(/Usd$/, '');

export function reserveBlock(r, tg = DEFAULT_TG, exclude = null) {
  let fields = tg.fields || DEFAULT_TG.fields;
  if (exclude?.size) fields = fields.filter((f) => !exclude.has(baseMetric(f)));
  return fields.map((f) => renderField(f, r)).filter(Boolean).join('\n');
}

const stamp = (snapshot) =>
  `block ${snapshot.blockNumber} ｜ ${new Date(snapshot.ts).toISOString().replace('T', ' ').slice(0, 19)} UTC`;

export function alertMessage(ev, snapshot, kind, tg = DEFAULT_TG) {
  const icon = kind === 'recover' ? '✅' : (SEV[ev.severity] || '⚠️');
  const ruleLine = tg.showRuleId
    ? `\n规则: <code>${escapeHtml(ev.ruleId)}</code>${ev.rule.any ? '（任一条件满足）' : ''}`
    : '';
  const head = kind === 'recover'
    ? `${icon} <b>恢复正常</b> · ${escapeHtml(ev.symbol)}${tg.showRuleId ? ` · <code>${escapeHtml(ev.ruleId)}</code>` : ''}`
    : `${icon} <b>${escapeHtml(ev.title)}</b>${ruleLine}`;

  const footerBits = [];
  if (tg.showAaveLink) footerBits.push(`<a href="${aaveUrl(ev.reserve.address)}">Aave 页面</a>`);
  if (tg.showTimestamp) footerBits.push(stamp(snapshot));

  return [
    head,
    ...ev.details.map((d) => `• ${escapeHtml(d)}`),
    '',
    `<b>${escapeHtml(ev.symbol)}</b> 当前状态`,
    reserveBlock(ev.reserve, tg),
    ...(footerBits.length ? ['', footerBits.join(' ｜ ')] : []),
  ].join('\n');
}


const SEV_RANK = { info: 1, warn: 2, critical: 3 };
const topSeverity = (items) =>
  items.reduce((acc, i) => (SEV_RANK[i.ev.severity] > SEV_RANK[acc] ? i.ev.severity : acc), 'info');

/** 池子的紧凑单行，用于概览区和定时快照 */
function compactLine(r, tg, icon = '', prev = null) {
  const fields = tg.heartbeatFields || DEFAULT_TG.heartbeatFields;
  const name = tg.showAaveLink
    ? `<a href="${aaveUrl(r.address)}">${escapeHtml(r.symbol)}</a>`
    : escapeHtml(r.symbol);
  // Telegram 的 HTML 不支持 color，只能用 emoji 上色。
  // 沿用 crypto/美股惯例：涨绿跌红。
  const arrow = (k) => {
    if (!prev || typeof prev[k] !== 'number') return '';
    const d = r[k] - prev[k];
    if (Math.abs(d) < 1e-9) return ' ⚪️→';
    const pct = prev[k] !== 0 ? Math.abs(d / prev[k]) * 100 : 0;
    const amt = `${fmtNum(k, Math.abs(d))}${pct >= 0.01 ? `/${pct.toFixed(1)}%` : ''}`;
    return d > 0 ? ` 🟢▲${amt}` : ` 🔴▼${amt}`;
  };
  // symbol 补齐到 5 字符，多资产时概览区仍能对齐。
  // 必须用 U+00A0 字符本身，不能用 &nbsp; 实体 —— Telegram 的 HTML 模式只认
  // &lt; &gt; &amp; 三个实体，&nbsp; 会被原样显示成字面文本。
  const pad = '\u00A0'.repeat(Math.max(0, 5 - r.symbol.length));
  const body = fields.map((k) => `${metricLabel(k)} ${fmtNum(k, r[k])}${arrow(k)}`).join(' ｜ ');
  return `${icon}<b>${name}</b>${pad}  ${body}`;
}

/**
 * 把一轮检查的所有报警合并成一条消息
 * 布局由 telegram.digestLayout 控制：overview+detail（默认）/ overview / detail
 * @param {Array<{ev:object, kind:string}>} items
 */
export function digestMessage(items, snapshot, tg = DEFAULT_TG) {
  const layout = tg.digestLayout || 'overview+detail';
  const fires = items.filter((i) => i.kind !== 'recover');
  const recovers = items.filter((i) => i.kind === 'recover');

  // 按池子分组：同一个池子触发多条规则时，状态块只出现一次
  const groups = new Map();
  for (const it of items) {
    if (!groups.has(it.ev.symbol)) groups.set(it.ev.symbol, []);
    groups.get(it.ev.symbol).push(it);
  }
  const groupIcon = (list) => {
    const f = list.filter((i) => i.kind !== 'recover');
    return f.length ? (SEV[topSeverity(f)] || '⚠️') : '✅';
  };

  const counts = [
    fires.length ? `${fires.length} 条报警` : null,
    recovers.length ? `${recovers.length} 条恢复` : null,
  ].filter(Boolean).join(' · ');
  const out = [`${fires.length ? (SEV[topSeverity(fires)] || '⚠️') : '✅'} <b>Aave V3 · ${counts}</b>`, ''];

  // ── 概览区：所有池子各一行，触发的排在前面 ──
  if (layout !== 'detail') {
    const all = Object.values(snapshot.reserves);
    const hit = all.filter((r) => groups.has(r.symbol));
    const rest = all.filter((r) => !groups.has(r.symbol));
    for (const r of hit) out.push(compactLine(r, tg, `${groupIcon(groups.get(r.symbol))} `));
    if (tg.digestIncludeOthers !== false) {
      for (const r of rest) out.push(compactLine(r, tg, '✅ '));
    }
    out.push('');
  }

  // ── 详情区：只有触发的池子 ──
  if (layout !== 'overview') {
    // 概览已经列过的指标就不在详情里重复了，消息能短一半
    const dedupe = layout === 'overview+detail' && tg.digestDedupeFields !== false
      ? new Set((tg.heartbeatFields || DEFAULT_TG.heartbeatFields).map(baseMetric))
      : null;
    if (layout === 'overview+detail') out.push('━━━━━ 触发详情 ━━━━━', '');
    // 顺序与概览区保持一致
    const ordered = Object.keys(snapshot.reserves).filter((sym) => groups.has(sym));
    for (const symbol of ordered) {
      const list = groups.get(symbol);
      const r = list[0].ev.reserve;
      const link = tg.showAaveLink
        ? `<a href="${aaveUrl(r.address)}">${escapeHtml(symbol)}</a>`
        : escapeHtml(symbol);
      out.push(`${groupIcon(list)} <b>${link}</b>${list.length > 1 ? `　<i>${list.length} 条</i>` : ''}`);
      for (const { ev, kind } of list) {
        out.push(`  ${kind === 'recover' ? '✅' : '•'} ${escapeHtml(kind === 'recover' ? '已恢复' : ev.title)}`);
        for (const d of ev.details) out.push(`     <i>${escapeHtml(d)}</i>`);
        if (tg.showRuleId) out.push(`     <code>${escapeHtml(ev.ruleId)}</code>`);
      }
      const block = reserveBlock(r, tg, dedupe);
      if (block) out.push(block);
      out.push('');
    }
  }

  if (tg.showTimestamp) out.push(stamp(snapshot));
  return out.join('\n');
}

export function summaryMessage(snapshot, prev, title = '📊 Aave V3 定时快照', tg = DEFAULT_TG) {
  const out = [`<b>${title}</b>`, ''];
  for (const r of Object.values(snapshot.reserves)) {
    out.push(compactLine(r, tg, '', prev?.reserves?.[r.symbol] || null));
  }
  if (tg.showTimestamp) out.push('', stamp(snapshot));
  return out.join('\n');
}


/** 完整状态消息：每个池子展开全部配置字段（手动查状态用，不是报警格式） */
export function statusMessage(snapshot, tg = DEFAULT_TG, title = '📊 Aave V3 当前状态') {
  const out = [`<b>${title}</b>`, ''];
  for (const r of Object.values(snapshot.reserves)) {
    const name = tg.showAaveLink
      ? `<a href="${aaveUrl(r.address)}">${escapeHtml(r.symbol)}</a>`
      : escapeHtml(r.symbol);
    out.push(`<b>${name}</b>`, reserveBlock(r, tg), '');
  }
  if (tg.showTimestamp) out.push(stamp(snapshot));
  return out.join('\n');
}

/** HTML -> 终端纯文本预览（去标签并还原实体） */
export function stripHtml(s) {
  return s.replace(/<[^>]+>/g, '').replace(/\u00A0/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

export function printTable(snapshot) {
  const rows = Object.values(snapshot.reserves).map((r) => ({
    资产: r.symbol,
    'Supply APY': fmtNum('supplyAPY', r.supplyAPY),
    'Reserve Size': `${fmtNum('reserveSize', r.reserveSize)} (${fmtNum('reserveSizeUsd', r.reserveSizeUsd)})`,
    'Available Liq.': `${fmtNum('reserveSize', r.availableLiquidity)} (${fmtNum('availableLiquidityUsd', r.availableLiquidityUsd)})`,
    Utilization: fmtNum('utilizationRate', r.utilizationRate),
    'Cap 用量': r.supplyCap > 0 ? fmtNum('supplyCapUsedPct', r.supplyCapUsedPct) : '-',
    'Borrow APY': fmtNum('borrowAPY', r.borrowAPY),
  }));
  console.log(`\nblock ${snapshot.blockNumber} · ${new Date(snapshot.ts).toLocaleString()}`);
  console.table(rows);
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
      rows.push({
        资产: m.symbol, 指标: metric,
        条件: `${op} ${fmtNum(metric, spec.value)}`,
        当前值: fmtNum(metric, cur),
        状态: hit ? '🔴 触发' : '🟢 正常',
      });
    }
  }
  console.table(rows);
}

export { COMPOSITE_FIELDS, METRICS, topSeverity };
