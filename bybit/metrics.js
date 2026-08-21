// Bybit 行情指标的中文标签和图标
export const METRICS = {
  lastPrice:          { label: '最新价',    emoji: '💱' },
  midPrice:           { label: '中间价',    emoji: '💱' },
  bid1Price:          { label: '买一价',    emoji: '🟢' },
  ask1Price:          { label: '卖一价',    emoji: '🔴' },
  pegDeviationPct:    { label: '脱锚幅度',  emoji: '⚖️' },
  pegAbsDeviationPct: { label: '脱锚幅度',  emoji: '⚖️' },
  spreadPct:          { label: '买卖价差',  emoji: '↔️' },
  bidDepthUsd:        { label: '买盘深度',  emoji: '🟩' },
  askDepthUsd:        { label: '卖盘深度',  emoji: '🟥' },
  depthUsd:           { label: '盘口深度',  emoji: '📚' },
  depthSkewPct:       { label: '买卖失衡',  emoji: '⚖️' },
  price24hPcnt:       { label: '24h 涨跌',  emoji: '📈' },
  highPrice24h:       { label: '24h 最高',  emoji: '📈' },
  lowPrice24h:        { label: '24h 最低',  emoji: '📉' },
  turnover24hUsd:     { label: '24h 成交额', emoji: '💰' },
  volume24h:          { label: '24h 成交量', emoji: '💰' },
  usdIndexPrice:      { label: '指数价',    emoji: '🎯' },
};

export const SHORT_LABEL = {
  lastPrice: '最新价', midPrice: '中间价',
  pegAbsDeviationPct: '脱锚', pegDeviationPct: '脱锚',
  spreadPct: '价差', depthUsd: '深度', bidDepthUsd: '买盘', askDepthUsd: '卖盘',
  depthSkewPct: '失衡', price24hPcnt: '24h', turnover24hUsd: '成交额',
};

// 这些字段本身就是百分比，注册后格式化才会带 %
export const PCT_METRICS = [
  'pegDeviationPct', 'pegAbsDeviationPct', 'spreadPct', 'depthSkewPct', 'price24hPcnt',
];

// 稳定币价格差异都在小数点后三四位，必须多给几位小数
export const PRICE_METRICS = ['lastPrice', 'midPrice', 'bid1Price', 'ask1Price', 'highPrice24h', 'lowPrice24h', 'usdIndexPrice'];

export const metricLabel = (m) => METRICS[m]?.label || m;
export const metricEmoji = (m) => METRICS[m]?.emoji || '•';
export const shortLabel = (m) => SHORT_LABEL[m] || METRICS[m]?.label || m;
