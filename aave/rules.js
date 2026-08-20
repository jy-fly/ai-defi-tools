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

function evalCondition(cond, cur, prev) {
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
export function evaluateRules(rules, snapshot, prevSnapshot) {
  const out = [];
  for (const rule of rules) {
    if (rule.enabled === false) continue;
    const wanted = !rule.assets || rule.assets === '*' ? Object.keys(snapshot.reserves) : rule.assets;
    for (const symbol of wanted) {
      const cur = snapshot.reserves[symbol];
      if (!cur) continue;
      const prev = prevSnapshot?.reserves?.[symbol];
      const results = (rule.when || []).map((c) => evalCondition(c, cur, prev));
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
