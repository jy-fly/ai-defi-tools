// 消息渲染骨架。协议之间只有「指标标签、复合字段、链接」不同，
// 表格排版、digest 分组、变化区、时间戳这些都是共用的。
import { fmtNum } from './rules.js';
import { escapeHtml } from '../tg/index.js';

const SEV = { info: 'ℹ️', warn: '⚠️', critical: '🚨' };
const SEV_RANK = { info: 1, warn: 2, critical: 3 };

export const topSeverity = (items) =>
  items.reduce((acc, i) => (SEV_RANK[i.ev.severity] > SEV_RANK[acc] ? i.ev.severity : acc), 'info');

/** 显示宽度：CJK 和全角符号占 2 格。Telegram 的等宽字体里 CJK 正好是 ASCII 两倍宽 */
function dispWidth(s) {
  return [...s].reduce((n, c) => n + (/[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(c) ? 2 : 1), 0);
}
const padTo = (s, w) => s + ' '.repeat(Math.max(0, w - dispWidth(s)));
const baseMetric = (m) => m.replace(/Usd$/, '');

/** HTML -> 终端纯文本预览 */
export function stripHtml(s) {
  return s.replace(/<[^>]+>/g, '').replace(/\u00A0/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

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

/**
 * @param {object} opts
 *   defaults      协议自己的 DEFAULT_TG
 *   shortLabel    指标 -> 表格列头短名
 *   metricLabel   指标 -> 中文全名
 *   metricEmoji   指标 -> 图标
 *   metricsMeta   指标元数据（含 usdPair）
 *   composites    复合字段渲染器 { key: (r) => string|null }
 *   linkOf        (reserve) => url | null
 */
export function createFormatter(opts) {
  const {
    defaults, shortLabel, metricLabel, metricEmoji,
    metricsMeta = {}, composites = {}, linkOf = () => null,
  } = opts;

  const tgOptions = (cfg) => ({ ...defaults, ...(cfg?.telegram || {}) });
  const stamp = (snapshot, tg = defaults) => {
    const t = fmtTime(snapshot.ts, tg.timezone || defaults.timezone);
    return snapshot.blockNumber ? `${t} ｜ block ${snapshot.blockNumber}` : t;
  };
  const nameOf = (r, tg) => {
    const url = tg.showAaveLink === false ? null : linkOf(r);
    return url ? `<a href="${url}">${escapeHtml(r.symbol)}</a>` : escapeHtml(r.symbol);
  };

  function renderField(field, r) {
    if (composites[field]) return composites[field](r);
    const meta = metricsMeta[field];
    if (!meta) return r[field] === undefined ? null : `• ${field}: ${fmtNum(field, r[field])}`;
    const main = fmtNum(field, r[field]);
    const usd = meta.usdPair ? ` (${fmtNum(meta.usdPair, r[meta.usdPair])})` : '';
    const unit = meta.usdPair ? ` ${r.symbol}` : '';
    return `${metricEmoji(field)} ${metricLabel(field)}: <b>${main}${unit}</b>${usd}`;
  }

  function reserveBlock(r, tg = defaults, exclude = null) {
    let fields = tg.fields || defaults.fields;
    if (exclude?.size) fields = fields.filter((f) => !exclude.has(baseMetric(f)));
    return fields.map((f) => renderField(f, r)).filter(Boolean).join('\n');
  }

  /** 等宽表格 + 变化摘要。表格区不放 emoji —— emoji 宽度不统一会毁掉对齐 */
  function renderTable(snapshot, tg, prevReserves = null) {
    const fields = tg.heartbeatFields || defaults.heartbeatFields;
    const rows = Object.values(snapshot.reserves);
    const head = ['资产', ...fields.map(shortLabel)];
    const body = rows.map((r) => [r.symbol, ...fields.map((k) => fmtNum(k, r[k]))]);
    const widths = head.map((h, i) => Math.max(dispWidth(h), ...body.map((b) => dispWidth(b[i]))));

    const line = (cells, gap) => cells.map((c, i) => padTo(c, widths[i])).join(gap).trimEnd();
    const totalW = widths.reduce((a, b) => a + b + 2, -2);
    const table = [
      line(head, '    '),
      '─'.repeat(Math.max(8, Math.round(totalW * 0.51))),
      ...body.map((b) => line(b, '  ')),
    ];

    const changes = [];
    for (const r of rows) {
      const p = prevReserves?.[r.symbol];
      if (!p) continue;
      const bits = [];
      for (const k of fields) {
        if (typeof p[k] !== 'number' || typeof r[k] !== 'number') continue;
        const d = r[k] - p[k];
        const pct = p[k] !== 0 ? Math.abs(d / p[k]) * 100 : 0;
        const shown = fmtNum(k, Math.abs(d));
        if (shown === fmtNum(k, 0) || pct < 0.01) continue;
        const pctStr = pct >= 1 ? pct.toFixed(1) : pct.toFixed(2);
        bits.push(`${shortLabel(k)} ${d > 0 ? '🟢▲' : '🔴▼'}${shown}/${pctStr}%`);
      }
      bits.forEach((b, i) => changes.push(`${i === 0 ? escapeHtml(r.symbol) : ' '.repeat(dispWidth(r.symbol))} ${b}`));
    }
    return { table, changes };
  }

  function summaryMessage(snapshot, prev, title, tg = defaults) {
    const { table, changes } = renderTable(snapshot, tg, prev?.reserves || null);
    const out = [`<b>${title}</b>`, '', `<pre>${escapeHtml(table.join('\n'))}</pre>`];
    if (changes.length) out.push('', '较上次变化', ...changes);
    const links = Object.values(snapshot.reserves).map((r) => nameOf(r, tg))
      .filter((n) => n.startsWith('<a'));
    if (links.length) out.push('', links.join(' ｜ '));
    if (tg.showTimestamp) out.push('', stamp(snapshot, tg));
    return out.join('\n');
  }

  function statusMessage(snapshot, tg = defaults, title = '当前状态') {
    const out = [`<b>${title}</b>`, ''];
    for (const r of Object.values(snapshot.reserves)) {
      out.push(`<b>${nameOf(r, tg)}</b>`, reserveBlock(r, tg), '');
    }
    if (tg.showTimestamp) out.push(stamp(snapshot, tg));
    return out.join('\n');
  }

  function alertMessage(ev, snapshot, kind, tg = defaults) {
    const icon = kind === 'recover' ? '✅' : (SEV[ev.severity] || '⚠️');
    const ruleLine = tg.showRuleId
      ? `\n规则: <code>${escapeHtml(ev.ruleId)}</code>${ev.rule.any ? '（任一条件满足）' : ''}` : '';
    const head = kind === 'recover'
      ? `${icon} <b>恢复正常</b> · ${escapeHtml(ev.symbol)}${tg.showRuleId ? ` · <code>${escapeHtml(ev.ruleId)}</code>` : ''}`
      : `${icon} <b>${escapeHtml(ev.title)}</b>${ruleLine}`;
    return [
      head,
      ...ev.details.map((d) => `• ${escapeHtml(d)}`),
      '',
      `<b>${nameOf(ev.reserve, tg)}</b> 当前状态`,
      reserveBlock(ev.reserve, tg),
      ...(tg.showTimestamp ? ['', stamp(snapshot, tg)] : []),
    ].join('\n');
  }

  function digestMessage(items, snapshot, tg = defaults, brand = '') {
    const layout = tg.digestLayout || 'overview+detail';
    const fires = items.filter((i) => i.kind !== 'recover');
    const recovers = items.filter((i) => i.kind === 'recover');
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
    const out = [`${fires.length ? (SEV[topSeverity(fires)] || '⚠️') : '✅'} <b>${brand} · ${counts}</b>`, ''];

    if (layout !== 'detail') {
      const { table } = renderTable(snapshot, tg, null);
      const marked = table.map((row, i) => {
        if (i <= 1) return '   ' + row;
        const sym = row.split(/\s+/)[0];
        return `${groups.has(sym) ? groupIcon(groups.get(sym)) : '✅'} ${row}`;
      });
      out.push(`<pre>${escapeHtml(marked.join('\n'))}</pre>`, '');
    }

    if (layout !== 'overview') {
      const dedupe = layout === 'overview+detail' && tg.digestDedupeFields !== false
        ? new Set((tg.heartbeatFields || defaults.heartbeatFields).map(baseMetric)) : null;
      if (layout === 'overview+detail') out.push('━━━━━ 触发详情 ━━━━━', '');
      for (const symbol of Object.keys(snapshot.reserves).filter((s) => groups.has(s))) {
        const list = groups.get(symbol);
        const r = list[0].ev.reserve;
        out.push(`${groupIcon(list)} <b>${nameOf(r, tg)}</b>${list.length > 1 ? `　<i>${list.length} 条</i>` : ''}`);
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
    if (tg.showTimestamp) out.push(stamp(snapshot, tg));
    return out.join('\n');
  }

  function printTable(snapshot, cols) {
    const rows = Object.values(snapshot.reserves).map((r) => {
      const o = { 资产: r.symbol };
      for (const c of cols) o[shortLabel(c)] = fmtNum(c, r[c]);
      return o;
    });
    console.log(`\n${snapshot.blockNumber ? `block ${snapshot.blockNumber} · ` : ''}${new Date(snapshot.ts).toLocaleString()}`);
    console.table(rows);
  }

  function printThresholds(cfg, snapshot) {
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
        rows.push({ 资产: m.symbol, 指标: metric, 条件: `${op} ${fmtNum(metric, spec.value)}`,
                    当前值: fmtNum(metric, cur), 状态: hit ? '🔴 触发' : '🟢 正常' });
      }
    }
    console.table(rows);
  }

  return { tgOptions, stamp, reserveBlock, renderTable, summaryMessage, statusMessage,
           alertMessage, digestMessage, printTable, printThresholds, stripHtml, topSeverity };
}
