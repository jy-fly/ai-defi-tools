// 历史指标落库：append 到 CSV，用于看趋势
// 刻意不引入数据库 —— 每小时 3 行、一年不到 2MB，CSV + git 足够，
// 且少一个外部服务就少一套凭据和一个故障点。
import { readFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// 列的顺序就是 CSV 的列顺序，改动会影响已有文件的对齐，只往后加不要插中间
export const COLUMNS = [
  'time', 'block', 'symbol', 'priceUsd',
  'supplyAPY', 'borrowAPY', 'utilizationRate',
  'reserveSize', 'reserveSizeUsd',
  'availableLiquidity', 'availableLiquidityUsd',
  'totalDebt', 'totalDebtUsd', 'supplyCapUsedPct',
];

// 各列的小数位，避免 CSV 里出现 3.0739481029384756 这种噪音
const PRECISION = {
  priceUsd: 6, supplyAPY: 4, borrowAPY: 4, utilizationRate: 4, supplyCapUsedPct: 4,
  reserveSize: 6, availableLiquidity: 6, totalDebt: 6,
  reserveSizeUsd: 2, availableLiquidityUsd: 2, totalDebtUsd: 2,
};

/** 读最后一行的时间戳。用文件自身判断间隔，而不依赖外部 state —— 天然幂等，
 *  CI 上 cache 丢了也不会重复写入 */
export function lastWrittenAt(path) {
  if (!existsSync(path)) return 0;
  const txt = readFileSync(path, 'utf8').trimEnd();
  if (!txt) return 0;
  const lines = txt.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line || line.startsWith('time,')) continue;
    const ts = Date.parse(line.split(',')[0]);
    if (!Number.isNaN(ts)) return ts;
  }
  return 0;
}

/**
 * 把一次快照追加成 CSV 行（每个资产一行）
 * @param {string} path CSV 路径
 * @param {object} snapshot fetchReserves 的结果
 * @param {number} minIntervalMs 最小写入间隔，默认 1 小时；0 = 每次都写
 * @returns {{written:number, skipped:boolean, reason?:string}}
 */
export function appendHistory(path, snapshot, minIntervalMs = 3_600_000) {
  const last = lastWrittenAt(path);
  if (minIntervalMs > 0 && last && snapshot.ts - last < minIntervalMs) {
    const mins = Math.ceil((minIntervalMs - (snapshot.ts - last)) / 60_000);
    return { written: 0, skipped: true, reason: `距上次写入不足 ${minIntervalMs / 60_000} 分钟，还差 ${mins} 分钟` };
  }

  const iso = new Date(snapshot.ts).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const cell = (col, r) => {
    if (col === 'time') return iso;
    if (col === 'block') return String(snapshot.blockNumber);
    if (col === 'symbol') return r.symbol;
    const v = r[col];
    if (typeof v !== 'number' || !Number.isFinite(v)) return '';
    return v.toFixed(PRECISION[col] ?? 4);
  };

  mkdirSync(dirname(path), { recursive: true });
  const isNew = !existsSync(path) || readFileSync(path, 'utf8').trim() === '';
  const rows = Object.values(snapshot.reserves).map((r) => COLUMNS.map((c) => cell(c, r)).join(','));
  appendFileSync(path, (isNew ? COLUMNS.join(',') + '\n' : '') + rows.join('\n') + '\n');
  return { written: rows.length, skipped: false };
}
