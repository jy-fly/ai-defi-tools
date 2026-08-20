// 历史指标写入 MongoDB，多层级降采样 + TTL 自动过期
//
// 分层设计（在 config.json 的 mongo.tiers 里配）：
//   aave_5m  5 分钟粒度，留 90 天  —— 看细节、排查突发
//   aave_1h  1 小时粒度，留 3 年   —— 看中长期趋势
//
// 幂等：时间戳规整到各层的「桶」+ (symbol, timeBucket) 唯一索引 + upsert。
// CI 重试、手动补跑都不会产生重复文档。
//
// 1h / 1d 层因为一个桶内会被采样多次，除了末值还额外维护 min/max —— 对风控来说
// 「这一小时内最低可用流动性」比「整点那一刻的值」有意义得多。

// 存进每个文档的字段
const FIELDS = [
  'priceUsd', 'supplyAPY', 'supplyAPR', 'borrowAPY', 'utilizationRate',
  'reserveSize', 'reserveSizeUsd', 'availableLiquidity', 'availableLiquidityUsd',
  'totalDebt', 'totalDebtUsd', 'supplyCap', 'supplyCapUsedPct',
  'ltv', 'liquidationThreshold', 'reserveFactor',
  'isActive', 'isFrozen', 'isPaused',
];

// 开了 stats 的层，额外记这些指标的桶内极值
const STAT_FIELDS = [
  'supplyAPY', 'borrowAPY', 'utilizationRate',
  'availableLiquidityUsd', 'reserveSizeUsd', 'supplyCapUsedPct',
];

export const DEFAULT_TIERS = [
  { collection: 'aave_5m', intervalMinutes: 5,  ttlDays: 90 },
  { collection: 'aave_1h', intervalMinutes: 60, ttlDays: 1095, stats: true },
];

/** MongoDB 驱动走 TCP，不认 HTTPS_PROXY，只支持 SOCKS5。
 *  国内本地连 Atlas 基本需要它；GitHub Actions 在海外，不设即直连。
 *  接受 socks5://127.0.0.1:7890 或裸的 127.0.0.1:7890 */
export function proxyOptions() {
  const raw = process.env.MONGODB_PROXY || process.env.ALL_PROXY || process.env.all_proxy;
  if (!raw) return {};
  if (/^https?:\/\//i.test(raw)) {
    console.warn('[mongo] 忽略 HTTP 代理（驱动只支持 SOCKS5），需要代理请设 MONGODB_PROXY=socks5://host:port');
    return {};
  }
  const m = raw.trim().match(/^(?:socks5h?:\/\/)?(?:([^:@]+):([^@]*)@)?\[?([^\]:]+)\]?:(\d+)\/?$/i);
  if (!m) {
    console.warn(`[mongo] 无法解析代理地址 "${raw}"，将直连`);
    return {};
  }
  const opts = { proxyHost: m[3], proxyPort: Number(m[4]) };
  if (m[1]) { opts.proxyUsername = m[1]; opts.proxyPassword = m[2] || ''; }
  return opts;
}

/** 时间戳规整到桶的起点。同一个桶内多次调用得到同一个 timeBucket，
 *  配合 (symbol, timeBucket) 唯一索引就实现了幂等 */
export function bucketOf(ts, intervalMinutes) {
  const bucketMs = Math.max(1, intervalMinutes) * 60_000;
  return new Date(Math.floor(ts / bucketMs) * bucketMs);
}

/** 构造某一层的 bulkWrite ops。纯函数，方便在没有数据库的环境下验证 */
export function buildOps(snapshot, tier) {
  const timeBucket = bucketOf(snapshot.ts, tier.intervalMinutes);
  return Object.values(snapshot.reserves).map((r) => {
    const doc = {
      symbol: r.symbol, address: r.address,
      time: new Date(snapshot.ts), block: snapshot.blockNumber,
    };
    for (const f of FIELDS) {
      const v = r[f];
      // Infinity / NaN 存不进 BSON，直接跳过
      if (typeof v === 'number' && !Number.isFinite(v)) continue;
      if (v !== undefined) doc[f] = v;
    }

    const update = { $set: doc, $setOnInsert: { timeBucket } };

    if (tier.stats) {
      const min = {}, max = {};
      for (const f of STAT_FIELDS) {
        const v = r[f];
        if (typeof v !== 'number' || !Number.isFinite(v)) continue;
        min[`min.${f}`] = v;
        max[`max.${f}`] = v;
      }
      if (Object.keys(min).length) { update.$min = min; update.$max = max; }
      update.$inc = { samples: 1 };
    }

    return { updateOne: { filter: { symbol: r.symbol, timeBucket }, update, upsert: true } };
  });
}

/** 幂等地保证索引就位：唯一索引用于去重，TTL 索引用于自动过期。
 *  TTL 时长改了也能自动纠正（drop 后重建）。 */
async function ensureIndexes(col, ttlDays) {
  await col.createIndex({ symbol: 1, timeBucket: 1 }, { unique: true });

  const ttlSeconds = Math.round(ttlDays * 86400);
  const existing = await col.indexes();
  const keyOf = (i) => JSON.stringify(i.key);
  const ttlIdx = existing.find((i) => keyOf(i) === '{"timeBucket":1}');

  if (!ttlIdx) {
    // 早期版本建过 {timeBucket:-1}，被 TTL 索引取代，顺手清掉省空间
    const legacy = existing.find((i) => keyOf(i) === '{"timeBucket":-1}');
    if (legacy) await col.dropIndex(legacy.name).catch(() => {});
    await col.createIndex({ timeBucket: 1 }, { expireAfterSeconds: ttlSeconds });
    return { ttl: 'created', ttlSeconds };
  }
  if (ttlIdx.expireAfterSeconds !== ttlSeconds) {
    await col.dropIndex(ttlIdx.name);
    await col.createIndex({ timeBucket: 1 }, { expireAfterSeconds: ttlSeconds });
    return { ttl: 'updated', from: ttlIdx.expireAfterSeconds, ttlSeconds };
  }
  return { ttl: 'ok', ttlSeconds };
}

/**
 * 把一次快照写进所有层级
 * @param {string} uri
 * @param {object} snapshot
 * @param {{db?:string, tiers?:Array}} opts
 */
export async function writeMongo(uri, snapshot, opts = {}) {
  const { db = 'aave', tiers = DEFAULT_TIERS } = opts;

  let MongoClient;
  try {
    ({ MongoClient } = await import('mongodb'));
  } catch {
    throw new Error('未安装 mongodb 驱动，跑 `npm i mongodb`');
  }

  const proxy = proxyOptions();
  if (proxy.proxyHost) console.log(`[mongo] 经 SOCKS5 代理 ${proxy.proxyHost}:${proxy.proxyPort} 连接`);

  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 15_000,
    connectTimeoutMS: 15_000,
    ...proxy,
  });

  const results = [];
  try {
    await client.connect();
    const database = client.db(db);

    for (const tier of tiers) {
      const col = database.collection(tier.collection);
      const idx = await ensureIndexes(col, tier.ttlDays);
      const res = await col.bulkWrite(buildOps(snapshot, tier), { ordered: false });
      results.push({
        collection: tier.collection,
        inserted: res.upsertedCount,
        updated: res.modifiedCount,
        total: await col.estimatedDocumentCount(),
        ttlDays: tier.ttlDays,
        indexNote: idx.ttl,
      });
    }
    return results;
  } finally {
    // 必须关，否则 Node 进程不退出，CI 会一直挂到 timeout
    await client.close().catch(() => {});
  }
}
