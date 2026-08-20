// 历史指标写入 MongoDB
// 幂等设计：时间戳规整到「桶」（默认整小时）+ (symbol, bucketTs) 唯一索引 + upsert。
// 这样 CI 重试、手动补跑都不会产生重复文档，同一小时内重复运行只是刷新那条的值。
const FIELDS = [
  'priceUsd', 'supplyAPY', 'supplyAPR', 'borrowAPY', 'utilizationRate',
  'reserveSize', 'reserveSizeUsd', 'availableLiquidity', 'availableLiquidityUsd',
  'totalDebt', 'totalDebtUsd', 'supplyCap', 'supplyCapUsedPct',
  'ltv', 'liquidationThreshold', 'reserveFactor',
  'isActive', 'isFrozen', 'isPaused',
];

/** 时间戳规整到桶的起点。同一个桶内多次调用得到同一个 bucketTs，
 *  配合 (symbol, bucketTs) 唯一索引就实现了幂等 */
export function bucketOf(ts, intervalMinutes) {
  const bucketMs = Math.max(1, intervalMinutes) * 60_000;
  return new Date(Math.floor(ts / bucketMs) * bucketMs);
}

/** 构造 bulkWrite 的 ops。提取成纯函数，方便在没有数据库的环境下验证 */
export function buildOps(snapshot, intervalMinutes = 60) {
  const bucketTs = bucketOf(snapshot.ts, intervalMinutes);
  return Object.values(snapshot.reserves).map((r) => {
    const doc = {
      symbol: r.symbol, address: r.address,
      ts: new Date(snapshot.ts), block: snapshot.blockNumber,
    };
    for (const f of FIELDS) {
      const v = r[f];
      // Infinity / NaN 存不进 BSON，直接跳过
      if (typeof v === 'number' && !Number.isFinite(v)) continue;
      if (v !== undefined) doc[f] = v;
    }
    return {
      updateOne: {
        filter: { symbol: r.symbol, bucketTs },
        update: { $set: doc, $setOnInsert: { bucketTs } },
        upsert: true,
      },
    };
  });
}

/**
 * @param {string} uri mongodb+srv://...
 mongodb+srv://...
 * @param {object} snapshot fetchReserves 的结果
 * @param {{db?:string, collection?:string, intervalMinutes?:number}} opts
 */
export async function writeMongo(uri, snapshot, opts = {}) {
  const { db = 'defi', collection = 'aave_reserves', intervalMinutes = 60 } = opts;

  let MongoClient;
  try {
    ({ MongoClient } = await import('mongodb'));
  } catch {
    throw new Error('未安装 mongodb 驱动，跑 `npm i mongodb`');
  }

  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 15_000,
    connectTimeoutMS: 15_000,
  });

  try {
    await client.connect();
    const col = client.db(db).collection(collection);

    // 首次会建索引，之后是空操作
    await col.createIndex({ symbol: 1, bucketTs: 1 }, { unique: true });
    await col.createIndex({ bucketTs: -1 });

    const ops = buildOps(snapshot, intervalMinutes);

    const res = await col.bulkWrite(ops, { ordered: false });
    return {
      inserted: res.upsertedCount,
      updated: res.modifiedCount,
      total: await col.estimatedDocumentCount(),
    };
  } finally {
    // 必须关，否则 Node 进程不退出，CI 会一直挂到 timeout
    await client.close().catch(() => {});
  }
}
