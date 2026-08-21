// Bybit 的消息渲染。没有链接和复合字段，比 Aave 简单
import { createFormatter, stripHtml, topSeverity } from '../core/format.js';
import { METRICS, metricLabel, metricEmoji, shortLabel } from './metrics.js';

export const DEFAULT_TG = {
  timezone: 'Asia/Hong_Kong',
  mode: 'digest',
  digestLayout: 'overview+detail',
  digestIncludeOthers: true,
  digestDedupeFields: true,
  alwaysSend: false,
  fields: ['lastPrice', 'bid1Price', 'ask1Price', 'price24hPcnt', 'turnover24hUsd'],
  heartbeatFields: ['lastPrice', 'bid1Price', 'ask1Price', 'price24hPcnt'],
  showRuleId: true,
  showAaveLink: false,
  showTimestamp: true,
  silentSeverities: ['info'],
};

const f = createFormatter({
  defaults: DEFAULT_TG, shortLabel, metricLabel, metricEmoji, metricsMeta: METRICS,
});

export const tgOptions = f.tgOptions;
export const alertMessage = f.alertMessage;
export const printThresholds = f.printThresholds;
export const summaryMessage = (snap, prev, title = '📊 Bybit 现货快照', tg = DEFAULT_TG) =>
  f.summaryMessage(snap, prev, title, tg);
export const statusMessage = (snap, tg = DEFAULT_TG, title = '📊 Bybit 现货当前状态') =>
  f.statusMessage(snap, tg, title);
export const digestMessage = (items, snap, tg = DEFAULT_TG) =>
  f.digestMessage(items, snap, tg, 'Bybit 现货');
export const printTable = (snap) =>
  f.printTable(snap, ['lastPrice', 'bid1Price', 'ask1Price', 'price24hPcnt', 'turnover24hUsd']);
export { stripHtml, topSeverity };
