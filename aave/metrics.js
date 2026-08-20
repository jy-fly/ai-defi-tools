// 指标元数据：中文名 + 图标 + 是否有 USD 配对字段
// config.js（生成规则文案）和 format.js（渲染 TG 消息）共用这一份，避免两处各写一套
export const METRICS = {
  supplyAPY:             { label: '存款 APY',     emoji: '📈' },
  supplyAPR:             { label: '存款 APR',     emoji: '📈' },
  borrowAPY:             { label: '借款 APY',     emoji: '📉' },
  borrowAPR:             { label: '借款 APR',     emoji: '📉' },
  utilizationRate:       { label: '利用率',       emoji: '🔥' },
  reserveSize:           { label: '池子规模',     emoji: '🏦', usdPair: 'reserveSizeUsd' },
  reserveSizeUsd:        { label: '池子规模',     emoji: '🏦' },
  availableLiquidity:    { label: '可用流动性',   emoji: '💧', usdPair: 'availableLiquidityUsd' },
  availableLiquidityUsd: { label: '可用流动性',   emoji: '💧' },
  totalDebt:             { label: '总借出',       emoji: '📤', usdPair: 'totalDebtUsd' },
  totalDebtUsd:          { label: '总借出',       emoji: '📤' },
  supplyCapUsedPct:      { label: '供应上限用量', emoji: '🧱' },
  borrowCapUsedPct:      { label: '借款上限用量', emoji: '🧱' },
  priceUsd:              { label: '价格',         emoji: '💵' },
  ltv:                   { label: 'LTV',          emoji: '⚙️' },
  liquidationThreshold:  { label: '清算线',       emoji: '⚙️' },
  liquidationPenalty:    { label: '清算罚金',     emoji: '⚙️' },
  reserveFactor:         { label: 'Reserve Factor', emoji: '⚙️' },
};

// 复合字段：一行里塞多个值，只能用在 telegram.fields 里，不能当规则的 metric
export const COMPOSITE_FIELDS = {
  supplyCap:  '🧱 供应上限（含已用百分比）',
  riskParams: '⚙️ LTV / 清算线 / 清算罚金 / Reserve Factor 一行',
  borrowLine: '📉 借款 APY + 总借出 一行',
  status:     '🛑 仅在 frozen / paused / inactive 时出现的告警行',
};

export const metricLabel = (m) => METRICS[m]?.label || m;
export const metricEmoji = (m) => METRICS[m]?.emoji || '•';
