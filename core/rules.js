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

// 哪些指标本身就是百分比（格式化时带 %）。各协议用 registerPctMetrics 追加自己的。
const PCT_METRICS = new Set([
  'supplyAPY', 'supplyAPR', 'borrowAPY', 'borrowAPR', 'utilizationRate',
  'supplyCapUsedPct', 'borrowCapUsedPct', 'ltv', 'liquidationThreshold',
  'liquidationPenalty', 'reserveFactor',
]);

export function isPercentMetric(m) { return PCT_METRICS.has(m); }

/** 让其他协议注册自己的百分比指标 —— 规则引擎本身是通用的，
 *  只有「哪些字段是百分比」这件事因协议而异 */
export function registerPctMetrics(names) {
  for (const n of names) PCT_METRICS.add(n);
}

// 需要高精度显示的指标。稳定币价格差异都在小数点后三四位，
// 默认的两位小数会把 1.0003 显示成 1.00，完全看不出变化
const PRECISE_METRICS = new Set();
let PRECISE_DIGITS = 4;

export function registerPreciseMetrics(names, digits = 4) {
  for (const n of names) PRECISE_METRICS.add(n);
  PRECISE_DIGITS = digits;
}
export function isPreciseMetric(m) { return PRECISE_METRICS.has(m); }

export function fmtNum(metric, v) {
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v === Infinity) return '无上限';
  if (typeof v !== 'number' || Number.isNaN(v)) return String(v);
  if (PCT_METRICS.has(metric)) return `${v.toFixed(2)}%`;
  if (PRECISE_METRICS.has(metric)) return v.toFixed(PRECISE_DIGITS);
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
 *
 *  取时间戳 <= 目标时刻的最新一点。采样密度不够时（比如 GitHub Actions 的
 *  cron 实际 30+ 分钟才跑一次，根本没有 5 分钟前的点）默认降级使用最近可用的点，
 *  并在消息里标注实际回看了多久 —— 漏报比迟报危险，宁可用 33 分钟前的数据
 *  告诉你「跌了」，也别因为差 28 分钟就整条规则失效。
 *
 *  但「历史根本不够长」仍然跳过：最老的点都比目标时刻新，说明这个窗口
 *  压根没积累够数据，此时任何对比都是无意义的。
 *  规则里设 strictWindow: true 可以关掉降级，要求精确匹配。 */
function lookback(history, symbol, metric, windowMinutes, nowTs, strict = false) {
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
  const ageMinutes = Math.round((nowTs - found.t) / 60_000);
  const degraded = target - found.t > windowMinutes * 60_000;
  if (degraded && strict) {
    return { ok: false, reason: `最近的历史点是 ${ageMinutes} 分钟前，偏离 ${windowMinutes} 分钟窗口太多` };
  }
  const v = found.d?.[symbol]?.[metric];
  if (typeof v !== 'number') return { ok: false, reason: `历史里没有 ${symbol}.${metric}` };
  return { ok: true, value: v, at: found.t, ageMinutes, degraded };
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
    const past = lookback(ctx.history, ctx.symbol, metric, win, ctx.nowTs ?? Date.now(), cond.strictWindow === true);
    if (!past.ok) return { pass: false, detail: `${metric} ${win} 分钟窗口：${past.reason}` };
    if (past.value === 0) return { pass: false, detail: `${metric} ${win} 分钟前为 0，无法算百分比` };

    const pct = ((now - past.value) / Math.abs(past.value)) * 100;
    const moved = op === 'dropPctOver' ? -pct : pct;
    const label = op === 'dropPctOver' ? '跌幅' : '涨幅';
    // 降级回看时把实际时长写清楚，否则「5 分钟跌 5%」的报警其实是 33 分钟的跌幅，会误导
    const span = past.degraded
      ? `实际回看 ${past.ageMinutes} 分钟 ⚠采样密度不足`
      : (past.ageMinutes !== win ? `实际回看 ${past.ageMinutes} 分钟` : '');
    const text = `${metric} ${win} 分钟窗口${label} ${moved >= 0 ? moved.toFixed(2) : '(反向)' + Math.abs(moved).toFixed(2)}%`
      + `（阈值 ${Number(value).toFixed(2)}%，${fmtNum(metric, past.value)} → ${fmtNum(metric, now)}`
      + `${span ? '，' + span : ''}）`;
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

/**
 * 多轮确认的投票判定：一共最多跑三次，累计命中达到 minVotes 次就算确认。
 * 不要求连续 —— 「中、没中、中」也算两票，因为指标在阈值附近来回跳
 * 恰恰说明它确实到了危险水位。
 * @param {Map<string,number>} votes key -> 累计命中次数
 * @param {number} minVotes 需要几票，默认 2
 * @returns {Set<string>} 确认通过、该发送的 key
 */
export function confirmedByVotes(votes, minVotes = 2) {
  return new Set([...votes].filter(([, n]) => n >= minVotes).map(([k]) => k));
}
