import { loadConfig as load } from '../core/config.js';
import { metricLabel } from './metrics.js';   // import 即完成指标注册

export function loadConfig(root, file) {
  return load(root, [file, 'bybit/config.json', 'bybit/config.example.json'].filter(Boolean), metricLabel);
}
