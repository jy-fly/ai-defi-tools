import { loadConfig as load } from '../core/config.js';
import { metricLabel } from './metrics.js';

export function loadConfig(root, file) {
  return load(root, [file, 'aave/config.json', 'aave/config.example.json'].filter(Boolean), metricLabel);
}
