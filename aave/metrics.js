// 指标元数据：中文名 + 图标 + 是否有 USD 配对字段
// config.js（生成规则文案）和 format.js（渲染 TG 消息）共用这一份，避免两处各写一套
export const METRICS = {
  supplyAPY:             { label: '存款 APY',     emoji: '📈', short: 'APY'  },
  supplyAPR:             { label: '存款 APR',     emoji: '📈', short: 'APR'  },
  borrowAPY:             { label: '借款 APY',     emoji: '📉', short: '借APY'  },
  borrowAPR:             { label: '借款 APR',     emoji: '📉', short: '借APR'  },
  utilizationRate:       { label: '利用率',       emoji: '🔥', short: '用率'  },
  reserveSize:           { label: '池子规模',     emoji: '🏦', short: '规模', usdPair: 'reserveSizeUsd'  },
  reserveSizeUsd:        { label: '池子规模',     emoji: '🏦', short: '规模'  },
  availableLiquidity:    { label: '可用流动性',   emoji: '💧', short: '可用', usdPair: 'availableLiquidityUsd'  },
  availableLiquidityUsd: { label: '可用流动性',   emoji: '💧', short: '可用'  },
  totalDebt:             { label: '总借出',       emoji: '📤', short: '借出', usdPair: 'totalDebtUsd'  },
  totalDebtUsd:          { label: '总借出',       emoji: '📤', short: '借出'  },
  supplyCapUsedPct:      { label: '供应上限用量', emoji: '🧱', short: '上限'  },
  borrowCapUsedPct:      { label: '借款上限用量', emoji: '🧱', short: '借上限'  },
  priceUsd:              { label: '价格',         emoji: '💵', short: '价格'  },
  ltv:                   { label: 'LTV',          emoji: '⚙️', short: 'LTV'  },
  liquidationThreshold:  { label: '清算线',       emoji: '⚙️', short: '清算线'  },
  liquidationPenalty:    { label: '清算罚金',     emoji: '⚙️', short: '罚金'  },
  reserveFactor:         { label: 'Reserve Factor', emoji: '⚙️', short: 'RF'  },
};

// 复合字段：一行里塞多个值，只能用在 telegram.fields 里，不能当规则的 metric
export const COMPOSITE_FIELDS = {
  supplyCap:  '🧱 供应上限（含已用百分比）',
  riskParams: '⚙️ LTV / 清算线 / 清算罚金 / Reserve Factor 一行',
  borrowLine: '📉 借款 APY + 总借出 一行',
  status:     '🛑 仅在 frozen / paused / inactive 时出现的告警行',
};

// 表格列头用的短名（等宽表格里空间紧张）
export const SHORT_LABEL = {
  supplyAPY: 'APY', supplyAPR: 'APR', borrowAPY: '借款', borrowAPR: '借款',
  utilizationRate: '用率', supplyCapUsedPct: '上限', borrowCapUsedPct: '借限',
  reserveSize: '规模', reserveSizeUsd: '规模',
  availableLiquidity: '可用', availableLiquidityUsd: '可用',
  totalDebt: '借出', totalDebtUsd: '借出', priceUsd: '价格',
};

export const shortLabel = (m) => SHORT_LABEL[m] || METRICS[m]?.label || m;
export const metricLabel = (m) => METRICS[m]?.label || m;
export const metricEmoji = (m) => METRICS[m]?.emoji || '•';
/** 等宽表格里的窄列名 */
export const metricShort = (m) => METRICS[m]?.short || METRICS[m]?.label || m;
