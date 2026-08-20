// 配置加载：把 monitors[].alerts 的阈值表展开成规则引擎能吃的 rules
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { metricLabel } from './metrics.js';


const OP_TEXT = {
  '>': '高于', '>=': '达到', '<': '低于', '<=': '不高于', '==': '等于', '!=': '不等于',
  changeUp: '单次上涨超过', changeDown: '单次下跌超过', changeAbs: '单次变动超过',
  changePctUp: '单次涨幅超过', changePctDown: '单次跌幅超过', changePct: '单次波动超过',
  crossUp: '上穿', crossDown: '下穿',
};

/** 单条阈值 -> 一条规则 */
function alertToRule(symbol, metric, spec) {
  const op = spec.op || '>=';
  const label = metricLabel(metric);
  return {
    id: spec.id || `${symbol}-${metric}`,
    severity: spec.severity || 'warn',
    assets: [symbol],
    when: [{ metric, op, value: spec.value }],
    cooldownMinutes: spec.cooldownMinutes,
    repeat: spec.repeat,
    notifyOnRecover: spec.notifyOnRecover,
    enabled: spec.enabled,
    message: spec.message || `${symbol} ${label} ${OP_TEXT[op] || op}阈值 → 当前 {${metric}}`,
  };
}

export function loadConfig(root, file) {
  const candidates = [
    file && resolve(root, file),
    resolve(root, 'aave/config.json'),
    resolve(root, 'aave/config.example.json'),
  ].filter(Boolean);
  const path = candidates.find((p) => existsSync(p));
  if (!path) throw new Error('找不到配置文件 aave/config.json');

  const cfg = JSON.parse(readFileSync(path, 'utf8'));
  const monitors = cfg.monitors || [];
  if (!monitors.length) throw new Error(`${path} 里 monitors 为空`);

  const assets = monitors.map((m) => {
    if (!m.address) throw new Error(`monitor ${m.symbol || '?'} 缺少 address`);
    return { symbol: m.symbol, address: m.address };
  });

  const expanded = [];
  for (const m of monitors) {
    for (const [metric, spec] of Object.entries(m.alerts || {})) {
      if (spec === null || spec === false) continue;
      const norm = typeof spec === 'object' ? spec : { value: spec };
      if (norm.value === undefined) throw new Error(`${m.symbol}.${metric} 缺少 value`);
      expanded.push(alertToRule(m.symbol, metric, norm));
    }
  }

  return {
    ...cfg,
    __path: path,
    assets,
    // 阈值展开的规则 + 手写的高级规则
    rules: [...expanded, ...(cfg.rules || [])],
    thresholdRuleCount: expanded.length,
  };
}
