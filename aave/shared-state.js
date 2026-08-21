// 多 runner 共享的报警状态
//
// 为什么需要：两个 GitHub Actions workflow 各有独立的 cache，互相看不见
// 对方发过什么。都跑完整流程的话，同一次下跌会被通知两次、每日推送来两条。
// 把「发送权」放到 MongoDB 并用原子操作抢占，才能实现「谁先跑到谁发，
// 另一个自动跳过」—— 这样加 runner 是提高及时性，而不是制造重复。
//
// 没有配 MONGODB_URI 时全部退化成本地文件状态（单机跑没有竞态问题）。

const COLL = 'runner_state';

/** 抢占一次报警的发送权。原子操作，并发下只有一个 runner 能拿到。
 *  @returns {Promise<boolean>} true = 该由我发送
 */
export async function claimAlert(db, key, cooldownMs, now, writer) {
  if (!db) return null;                       // 没有共享后端，交回本地逻辑处理
  const col = db.collection(COLL);
  const cutoff = now - cooldownMs;
  // 条件：从没通知过，或者上次通知已经超过 cooldown。
  // upsert 让首次出现的 key 也能被抢到。
  const res = await col.findOneAndUpdate(
    {
      _id: `alert:${key}`,
      $or: [{ lastNotifiedAt: { $exists: false } }, { lastNotifiedAt: { $lte: cutoff } }],
    },
    { $set: { lastNotifiedAt: now, firing: true, by: writer } },
    { upsert: true, returnDocument: 'after' }
  );
  return Boolean(res);
}

/** 条件不再满足时清掉记录，并回答「之前是否真的通知过」（决定要不要发恢复消息） */
export async function releaseAlert(db, key) {
  if (!db) return null;
  const col = db.collection(COLL);
  const prev = await col.findOneAndDelete({ _id: `alert:${key}` });
  return Boolean(prev && prev.lastNotifiedAt);
}

/** 当前是否处于 firing 状态（用于判断是不是新触发） */
export async function isFiring(db, key) {
  if (!db) return null;
  const doc = await db.collection(COLL).findOne({ _id: `alert:${key}` });
  return Boolean(doc);
}

/** 抢占某天的每日推送。同一天只有一个 runner 能拿到 */
export async function claimDaily(db, date, writer) {
  if (!db) return null;
  try {
    await db.collection(COLL).insertOne({ _id: `daily:${date}`, at: new Date(), by: writer });
    return true;
  } catch (e) {
    if (e?.code === 11000) return false;      // duplicate key = 别人已经发了
    throw e;
  }
}

/** 每小时推送条数的共享计数，避免两个 runner 各算一套额度 */
export async function countRecentSends(db, sinceMs) {
  if (!db) return null;
  return db.collection(COLL).countDocuments({ _id: /^sent:/, at: { $gte: new Date(sinceMs) } });
}

export async function recordSend(db, now, writer) {
  if (!db) return;
  await db.collection(COLL).insertOne({ _id: `sent:${now}:${writer}`, at: new Date(now), by: writer });
}

/** 清掉过期的发送记录，别让这个集合无限长 */
export async function pruneSends(db, beforeMs) {
  if (!db) return;
  await db.collection(COLL).deleteMany({ _id: /^sent:/, at: { $lt: new Date(beforeMs) } });
}
