// Bybit 现货行情抓取（V5 公开接口，不需要 API key）
const BASE = 'https://api.bybit.com';

async function get(path, params) {
  const url = `${BASE}${path}?${new URLSearchParams(params)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Bybit HTTP ${res.status}`);
  const body = await res.json();
  if (body.retCode !== 0) throw new Error(`Bybit ${body.retCode}: ${body.retMsg}`);
  return body.result;
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/**
 * 抓一个交易对的行情 + 盘口深度
 * @param {string} symbol 如 USDCUSDT
 * @param {number} depthLevels 统计前几档的挂单量
 */
export async function fetchTicker(symbol, depthLevels = 5) {
  const [tick, book] = await Promise.all([
    get('/v5/market/tickers', { category: 'spot', symbol }),
    get('/v5/market/orderbook', { category: 'spot', symbol, limit: String(depthLevels) }),
  ]);

  const t = (tick.list || [])[0];
  if (!t) throw new Error(`Bybit 没有返回 ${symbol} 的行情`);

  const bid = num(t.bid1Price), ask = num(t.ask1Price), last = num(t.lastPrice);
  const mid = bid && ask ? (bid + ask) / 2 : last;
  // 挂单量按计价币折算，直接反映「这一侧能吃掉多少」
  const sum = (side) => (side || []).reduce((a, [p, q]) => a + Number(p) * Number(q), 0);
  const bidDepth = sum(book.b), askDepth = sum(book.a);

  return {
    symbol,
    lastPrice: last,
    bid1Price: bid,
    ask1Price: ask,
    midPrice: mid,
    // 脱锚幅度：偏离 1.0 多少（稳定币对才有意义），带符号
    pegDeviationPct: mid !== undefined ? (mid - 1) * 100 : undefined,
    // 绝对偏离，写阈值时不用管方向
    pegAbsDeviationPct: mid !== undefined ? Math.abs(mid - 1) * 100 : undefined,
    spreadPct: bid && ask ? ((ask - bid) / mid) * 100 : undefined,
    bidDepthUsd: bidDepth,
    askDepthUsd: askDepth,
    depthUsd: bidDepth + askDepth,
    // 买卖盘失衡：正数表示买盘厚，负数表示卖盘厚
    depthSkewPct: bidDepth + askDepth > 0
      ? ((bidDepth - askDepth) / (bidDepth + askDepth)) * 100 : undefined,
    price24hPcnt: num(t.price24hPcnt) !== undefined ? num(t.price24hPcnt) * 100 : undefined,
    highPrice24h: num(t.highPrice24h),
    lowPrice24h: num(t.lowPrice24h),
    volume24h: num(t.volume24h),
    turnover24hUsd: num(t.turnover24h),
    usdIndexPrice: num(t.usdIndexPrice),
  };
}

/** 抓多个交易对，返回和 aave 一致的快照结构，好复用同一套规则引擎 */
export async function fetchMarkets(symbols, depthLevels = 5) {
  const list = await Promise.all(symbols.map((s) => fetchTicker(s.symbol || s, depthLevels)));
  const reserves = {};
  for (const t of list) reserves[t.symbol] = t;
  return { ts: Date.now(), blockNumber: null, reserves };
}
