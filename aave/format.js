// Aave 的消息渲染：把协议差异（复合字段、Aave 链接）注入通用骨架
import { fmtNum } from '../core/rules.js';
import { createFormatter, stripHtml, topSeverity } from '../core/format.js';
import { METRICS, COMPOSITE_FIELDS, metricLabel, metricEmoji, shortLabel } from './metrics.js';

export const DEFAULT_TG = {
  timezone: 'Asia/Hong_Kong',
  mode: 'digest',
  digestLayout: 'overview+detail',
  digestIncludeOthers: true,
  digestDedupeFields: true,
  alwaysSend: false,
  fields: ['supplyAPY', 'reserveSize', 'availableLiquidity', 'utilizationRate', 'supplyCap', 'borrowLine', 'riskParams', 'status'],
  heartbeatFields: ['supplyAPY', 'utilizationRate', 'availableLiquidityUsd'],
  showRuleId: true,
  showAaveLink: true,
  showTimestamp: true,
  silentSeverities: ['info'],
};

export const aaveUrl = (addr) =>
  `https://app.aave.com/reserve-overview/?underlyingAsset=${addr.toLowerCase()}&marketName=proto_mainnet_v3`;

// 一行塞多个值的复合字段，只能用在 fields 里
const composites = {
  supplyCap: (r) => `🧱 供应上限: ${r.supplyCap > 0
    ? `${fmtNum('reserveSize', r.supplyCap)}（已用 ${fmtNum('supplyCapUsedPct', r.supplyCapUsedPct)}）` : '无上限'}`,
  riskParams: (r) => `⚙️ LTV ${fmtNum('ltv', r.ltv)} ｜ 清算线 ${fmtNum('liquidationThreshold', r.liquidationThreshold)}`
    + ` ｜ 清算罚金 ${fmtNum('liquidationPenalty', r.liquidationPenalty)} ｜ Reserve Factor ${fmtNum('reserveFactor', r.reserveFactor)}`,
  borrowLine: (r) => `📉 借款 APY ${fmtNum('borrowAPY', r.borrowAPY)} ｜ 总借出 ${fmtNum('totalDebtUsd', r.totalDebtUsd)}`,
  // 只在池子异常时出现，正常时整行省略
  status: (r) => (r.isFrozen || r.isPaused || !r.isActive)
    ? `🛑 状态异常: active=${r.isActive} frozen=${r.isFrozen} paused=${r.isPaused}` : null,
};

const f = createFormatter({
  defaults: DEFAULT_TG, shortLabel, metricLabel, metricEmoji,
  metricsMeta: METRICS, composites, linkOf: (r) => aaveUrl(r.address),
});

export const tgOptions = f.tgOptions;
export const reserveBlock = f.reserveBlock;
export const alertMessage = f.alertMessage;
export const printThresholds = f.printThresholds;
export const summaryMessage = (snap, prev, title = '📊 Aave V3 定时快照', tg = DEFAULT_TG) =>
  f.summaryMessage(snap, prev, title, tg);
export const statusMessage = (snap, tg = DEFAULT_TG, title = '📊 Aave V3 当前状态') =>
  f.statusMessage(snap, tg, title);
export const digestMessage = (items, snap, tg = DEFAULT_TG) =>
  f.digestMessage(items, snap, tg, 'Aave V3');
// 终端表格自己实现：通用版一列只能放一个值，这里要同时给出代币量和美元值
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
export { stripHtml, topSeverity, METRICS, COMPOSITE_FIELDS };
