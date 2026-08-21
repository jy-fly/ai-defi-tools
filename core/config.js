// 配置加载：把 monitors[].alerts 的阈值表展开成规则引擎能吃的 rules。
// 各协议只是指标名和中文标签不同，展开逻辑是一样的，所以放在 core。
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const OP_TEXT = {
  '>': '高于', '>=': '达到', '<': '低于', '<=': '不高于', '==': '等于', '!=': '不等于',
  changeUp: '单次上涨超过', changeDown: '单次下跌超过', changeAbs: '单次变动超过',
  changePctUp: '单次涨幅超过', changePctDown: '单次跌幅超过', changePct: '单次波动超过',
  crossUp: '上穿', crossDown: '下穿',
  dropPctOver: '窗口内跌幅超过', risePctOver: '窗口内涨幅超过',
};

function alertToRule(symbol, metric, spec, labelOf) {
  const op = spec.op || '>=';
  const label = labelOf(metric);
  return {
    id: spec.id || `${symbol}-${metric}`,
    severity: spec.severity || 'warn',
    assets: [symbol],
    when: [{ metric, op, value: spec.value, windowMinutes: spec.windowMinutes }],
    cooldownMinutes: spec.cooldownMinutes,
    repeat: spec.repeat,
    notifyOnRecover: spec.notifyOnRecover,
    enabled: spec.enabled,
    message: spec.message || `${symbol} ${label} ${OP_TEXT[op] || op}阈值 → 当前 {${metric}}`,
  };
}

/**
 * @param {string} root 项目根目录
 * @param {string[]} candidates 相对 root 的候选配置路径，按顺序取第一个存在的
 * @param {(m:string)=>string} labelOf 指标名 -> 中文标签
 */
export function loadConfig(root, candidates, labelOf = (m) => m) {
  const path = candidates.map((c) => resolve(root, c)).find((p) => existsSync(p));
  if (!path) throw new Error(`找不到配置文件：${candidates.join(' / ')}`);

  const cfg = JSON.parse(readFileSync(path, 'utf8'));
  const monitors = cfg.monitors || [];
  if (!monitors.length) throw new Error(`${path} 里 monitors 为空`);

  const assets = monitors.map((m) => {
    if (!m.symbol) throw new Error('monitor 缺少 symbol');
    return { symbol: m.symbol, address: m.address };
  });

  const expanded = [];
  for (const m of monitors) {
    for (const [metric, spec] of Object.entries(m.alerts || {})) {
      if (spec === null || spec === false) continue;
      const norm = typeof spec === 'object' ? spec : { value: spec };
      if (norm.value === undefined) throw new Error(`${m.symbol}.${metric} 缺少 value`);
      expanded.push(alertToRule(m.symbol, metric, norm, labelOf));
    }
  }

  return {
    ...cfg,
    __path: path,
    assets,
    rules: [...expanded, ...(cfg.rules || [])],
    thresholdRuleCount: expanded.length,
  };
}
