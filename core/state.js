import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

const EMPTY = () => ({
  alerts: {}, lastSnapshot: null, lastHeartbeatAt: 0, sentLog: [],
  history: [],            // 滑动窗口，供窗口类规则回看（5m/10m/60m/1d 跌幅）
  lastDailyReport: null,  // 每日推送的日期标记（YYYY-MM-DD，按配置时区）
});

export function loadState(path) {
  try {
    if (!existsSync(path)) return EMPTY();
    const s = JSON.parse(readFileSync(path, 'utf8'));
    return {
      alerts: s.alerts || {},
      lastSnapshot: s.lastSnapshot || null,
      lastHeartbeatAt: s.lastHeartbeatAt || 0,
      sentLog: Array.isArray(s.sentLog) ? s.sentLog : [],
      history: Array.isArray(s.history) ? s.history : [],
      lastDailyReport: s.lastDailyReport || null,
    };
  } catch (e) {
    console.warn(`[state] 读取失败，按空状态启动: ${e.message}`);
    return EMPTY();
  }
}

export function saveState(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2));
}
