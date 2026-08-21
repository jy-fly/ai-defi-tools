// 行情数据源。两家的 USDC/USDT 报价差异在 0.0001 量级，
// 但只有 Kraken 不封美国 IP —— GitHub Actions 的 runner 在 Azure 美国节点，
// 连 Bybit 一律 403，所以 CI 上只能用 Kraken。
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Bybit V5 现货。数据最贴近你实际下单的价格，但封美国 IP */
async function fromBybit(symbol) {
  const body = await getJson(`https://api.bybit.com/v5/market/tickers?category=spot&symbol=${symbol}`);
  if (body.retCode !== 0) throw new Error(`Bybit ${body.retCode}: ${body.retMsg}`);
  const t = (body.result?.list || [])[0];
  if (!t) throw new Error(`Bybit 没有返回 ${symbol}`);
  return {
    symbol,
    source: 'bybit',
    ask1Price: num(t.ask1Price),
    bid1Price: num(t.bid1Price),
    lastPrice: num(t.lastPrice),
    price24hPcnt: num(t.price24hPcnt) !== undefined ? num(t.price24hPcnt) * 100 : undefined,
    turnover24hUsd: num(t.turnover24h),
  };
}

/** Kraken 公开行情。美国合规交易所，不封 CI 的 IP */
async function fromKraken(symbol) {
  const body = await getJson(`https://api.kraken.com/0/public/Ticker?pair=${symbol}`);
  if (body.error?.length) throw new Error(`Kraken: ${body.error.join(', ')}`);
  // Kraken 有时会用别名做 key（比如 XBTUSD -> XXBTZUSD），直接取第一个
  const t = Object.values(body.result || {})[0];
  if (!t) throw new Error(`Kraken 没有返回 ${symbol}`);

  const last = num(t.c?.[0]);
  const open = num(t.o);
  return {
    symbol,
    source: 'kraken',
    ask1Price: num(t.a?.[0]),
    bid1Price: num(t.b?.[0]),
    lastPrice: last,
    price24hPcnt: open && last ? ((last - open) / open) * 100 : undefined,
    // v[1] 是近 24h 成交量（base），乘以均价折成计价币
    turnover24hUsd: num(t.v?.[1]) !== undefined && num(t.p?.[1]) !== undefined
      ? num(t.v[1]) * num(t.p[1]) : undefined,
  };
}

const SOURCES = { bybit: fromBybit, kraken: fromKraken };

/**
 * @param {number} offset 价格校准。用非 Bybit 的源做代理时，把报价平移到
 *   Bybit 口径，这样阈值始终按 Bybit 的价格写，换数据源不用改阈值。
 *   实测 Kraken 卖一稳定比 Bybit 高 0.0001，所以 offset 填 -0.0001。
 *   ⚠️ 这是经验值，行情剧烈时两家价差会变，别当成永远成立。
 */
export async function fetchTicker(symbol, source = 'kraken', offset = 0) {
  const fn = SOURCES[source];
  if (!fn) throw new Error(`未知数据源 ${source}，可选：${Object.keys(SOURCES).join(' / ')}`);
  const t = await fn(symbol);
  if (offset) {
    t.rawAsk1Price = t.ask1Price;
    t.rawBid1Price = t.bid1Price;
    for (const k of ['ask1Price', 'bid1Price', 'lastPrice']) {
      if (typeof t[k] === 'number') t[k] = t[k] + offset;
    }
    t.offset = offset;
  }
  return t;
}

/** 返回和规则引擎约定的快照结构 */
export async function fetchMarkets(symbols, source = 'kraken', offset = 0) {
  const list = await Promise.all(symbols.map((s) => fetchTicker(s.symbol || s, source, offset)));
  const reserves = {};
  for (const t of list) reserves[t.symbol] = t;
  return { ts: Date.now(), blockNumber: null, reserves };
}
