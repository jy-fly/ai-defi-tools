// 规则引擎：声明式条件，支持阈值比较 / 变化量 / 穿越阈值
const CMP = {
  '>': (a, b) => a > b,
  '>=': (a, b) => a >= b,
  '<': (a, b) => a < b,
  '<=': (a, b) => a <= b,
  '==': (a, b) => a === b,
  '!=': (a, b) => a !== b,
};

const OP_LABEL = {
  '>': '>', '>=': '≥', '<': '<', '<=': '≤', '==': '=', '!=': '≠',
  dropPctOver: '窗口内跌幅超过', risePctOver: '窗口内涨幅超过',
  changeUp: '单次上涨超过', changeDown: '单次下跌超过', changeAbs: '单次变动超过',
  changePctUp: '单次涨幅超过', changePctDown: '单次跌幅超过', changePct: '单次波动超过',
  crossUp: '上穿', crossDown: '下穿',
};

const PCT_METRICS = new Set([
  'supplyAPY', 'supplyAPR', 'borrowAPY', 'borrowAPR', 'utilizationRate',
  'supplyCapUsedPct', 'borrowCapUsedPct', 'ltv', 'liquidationThreshold',
  'liquidationPenalty', 'reserveFactor',
]);

export function isPercentMetric(m) { return PCT_METRICS.has(m); }

/** 表格里用的裸格式：去掉 % 和 $，列能窄一大截。
 *  单位靠表头和上下文说清楚，数字对齐后反而更好读。 */
export function fmtBare(metric, v) {
  if (typeof v === 'boolean') return v ? 'Y' : 'N';
  if (typeof v !== 'number' || !Number.isFinite(v)) return '-';
  if (PCT_METRICS.has(metric)) return v.toFixed(2);
  const abs = Math.abs(v);
  if (abs >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(v / 1e3).toFixed(2)}K`;
  return v.toFixed(2);
}

export function fmtNum(metric, v) {
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v === Infinity) return '无上限';
  if (typeof v !== 'number' || Number.isNaN(v)) return String(v);
  if (PCT_METRICS.has(metric)) return `${v.toFixed(2)}%`;
  const abs = Math.abs(v);
  if (metric.endsWith('Usd')) {
    if (abs >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
    if (abs >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
    if (abs >= 1e3) return `$${(v / 1e3).toFixed(2)}K`;
    return `$${v.toFixed(2)}`;
  }
  if (abs >= 1e9) return `${(v / 1e9).toFixed(3)}B`;
  if (abs >= 1e6) return `${(v / 1e6).toFixed(3)}M`;
  if (abs >= 1e3) return v.toLocaleString('en-US', { maximumFractionDigits: 2 });
  return v.toFixed(abs < 1 ? 4 : 2);
}


/** 从滑动窗口历史里取「windowMinutes 之前」的值。
 *  取时间戳 <= 目标时刻的最新一点；偏差超过一个窗口长度就算数据不足，
 *  避免历史稀疏时拿一个很老的点做对比、误报。 */
function lookback(history, symbol, metric, windowMinutes, nowTs) {
  if (!Array.isArray(history) || !history.length) return { ok: false, reason: '暂无历史数据' };
  const target = nowTs - windowMinutes * 60_000;
  let found = null;
  for (const p of history) {
    if (p.t <= target && (!found || p.t > found.t)) found = p;
  }
  if (!found) {
    const oldest = Math.min(...history.map((p) => p.t));
    const haveMin = Math.round((nowTs - oldest) / 60_000);
    return { ok: false, reason: `历史不足 ${windowMinutes} 分钟（目前只有 ${haveMin} 分钟）` };
  }
  if (target - found.t > windowMinutes * 60_000) {
    const age = Math.round((nowTs - found.t) / 60_000);
    return { ok: false, reason: `最近的历史点是 ${age} 分钟前，偏离 ${windowMinutes} 分钟窗口太多` };
  }
  const v = found.d?.[symbol]?.[metric];
  if (typeof v !== 'number') return { ok: false, reason: `历史里没有 ${symbol}.${metric}` };
  return { ok: true, value: v, at: found.t, ageMinutes: Math.round((nowTs - found.t) / 60_000) };
}

function evalCondition(cond, cur, prev, ctx = {}) {
  const { metric, op, value } = cond;
  const now = cur[metric];
  const before = prev ? prev[metric] : undefined;

  if (now === undefined) return { pass: false, detail: `未知指标 ${metric}` };

  // changePct* 的阈值本身是百分比，不能按指标单位（如 USD）格式化
  const isPctThreshold = op.startsWith('changePct');
  const valueText = typeof value === 'boolean'
    ? String(value)
    : (isPctThreshold ? `${Number(value).toFixed(2)}%` : fmtNum(metric, value));
  const detail = (extra = '') =>
    `${metric} ${OP_LABEL[op] ?? op} ${valueText}（当前 ${fmtNum(metric, now)}${extra}）`;

  if (CMP[op]) return { pass: CMP[op](now, value), detail: detail() };

  // 窗口类：和 windowMinutes 分钟前的历史值比，而不是和上一次快照比
  if (op === 'dropPctOver' || op === 'risePctOver') {
    const win = cond.windowMinutes;
    if (!win) return { pass: false, detail: `${metric} ${op} 缺少 windowMinutes` };
    const past = lookback(ctx.history, ctx.symbol, metric, win, ctx.nowTs ?? Date.now());
    if (!past.ok) return { pass: false, detail: `${metric} ${win} 分钟窗口：${past.reason}` };
    if (past.value === 0) return { pass: false, detail: `${metric} ${win} 分钟前为 0，无法算百分比` };

    const pct = ((now - past.value) / Math.abs(past.value)) * 100;
    const moved = op === 'dropPctOver' ? -pct : pct;
    const label = op === 'dropPctOver' ? '跌幅' : '涨幅';
    const text = `${metric} ${win} 分钟内${label} ${moved >= 0 ? moved.toFixed(2) : '(反向)' + Math.abs(moved).toFixed(2)}%`
      + `（阈值 ${Number(value).toFixed(2)}%，${win} 分钟前 ${fmtNum(metric, past.value)} → 现在 ${fmtNum(metric, now)}`
      + `${past.ageMinutes !== win ? `，实际回看 ${past.ageMinutes} 分钟` : ''}）`;
    return { pass: moved >= value, detail: text };
  }

  // 变化类条件需要上一次快照
  if (before === undefined || typeof now !== 'number' || typeof before !== 'number') {
    return { pass: false, detail: `${metric} 无上一次数据，跳过变化类判断` };
  }
  const delta = now - before;
  const pct = before === 0 ? (delta === 0 ? 0 : Infinity) : (delta / Math.abs(before)) * 100;
  const extra = `，上次 ${fmtNum(metric, before)}，变化 ${delta >= 0 ? '+' : ''}${fmtNum(metric, delta)} / ${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;

  switch (op) {
    case 'changeUp': return { pass: delta >= value, detail: detail(extra) };
    case 'changeDown': return { pass: -delta >= value, detail: detail(extra) };
    case 'changeAbs': return { pass: Math.abs(delta) >= value, detail: detail(extra) };
    case 'changePctUp': return { pass: pct >= value, detail: detail(extra) };
    case 'changePctDown': return { pass: -pct >= value, detail: detail(extra) };
    case 'changePct': return { pass: Math.abs(pct) >= value, detail: detail(extra) };
    case 'crossUp': return { pass: before < value && now >= value, detail: detail(extra) };
    case 'crossDown': return { pass: before > value && now <= value, detail: detail(extra) };
    default: return { pass: false, detail: `不支持的操作符 ${op}` };
  }
}

function renderTemplate(tpl, r) {
  return tpl.replace(/\{(\w+)\}/g, (_, k) => (k in r ? fmtNum(k, r[k]) : `{${k}}`));
}

/**
 * 评估全部规则
 * @returns {Array<{key:string, ruleId:string, symbol:string, severity:string, title:string, details:string[], firing:boolean, rule:object, reserve:object}>}
 */
export function evaluateRules(rules, snapshot, prevSnapshot, history = []) {
  const out = [];
  for (const rule of rules) {
    if (rule.enabled === false) continue;
    const wanted = !rule.assets || rule.assets === '*' ? Object.keys(snapshot.reserves) : rule.assets;
    for (const symbol of wanted) {
      const cur = snapshot.reserves[symbol];
      if (!cur) continue;
      const prev = prevSnapshot?.reserves?.[symbol];
      const ctx = { history, symbol, nowTs: snapshot.ts };
      const results = (rule.when || []).map((c) => evalCondition(c, cur, prev, ctx));
      if (!results.length) continue;
      const firing = rule.any ? results.some((r) => r.pass) : results.every((r) => r.pass);
      out.push({
        key: `${rule.id}::${symbol}`,
        ruleId: rule.id,
        symbol,
        severity: rule.severity || 'warn',
        title: rule.message ? renderTemplate(rule.message, cur) : `${symbol} 触发规则 ${rule.id}`,
        details: results.filter((r) => (rule.any ? r.pass : true)).map((r) => r.detail),
        firing,
        rule,
        reserve: cur,
      });
    }
  }
  return out;
}
