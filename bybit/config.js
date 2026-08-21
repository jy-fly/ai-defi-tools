import { loadConfig as load } from '../core/config.js';
import { registerPctMetrics, registerPreciseMetrics } from '../core/rules.js';
import { metricLabel, PCT_METRICS, PRICE_METRICS } from './metrics.js';

registerPctMetrics(PCT_METRICS);
registerPreciseMetrics(PRICE_METRICS, 4);

export function loadConfig(root, file) {
  return load(root, [file, 'bybit/config.json', 'bybit/config.example.json'].filter(Boolean), metricLabel);
}
