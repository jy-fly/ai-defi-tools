// Aave V3 (Ethereum mainnet) 链上数据抓取
// 所有地址都从 PoolAddressesProvider 动态解析，Aave 升级换 DataProvider 也不用改代码
import { createPublicClient, http, fallback, parseAbi } from 'viem';
import { mainnet } from 'viem/chains';

export const POOL_ADDRESSES_PROVIDER = '0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e';

const RAY = 10n ** 27n;
const SECONDS_PER_YEAR = 31_536_000;

const providerAbi = parseAbi([
  'function getPool() view returns (address)',
  'function getPoolDataProvider() view returns (address)',
  'function getPriceOracle() view returns (address)',
]);

const dataProviderAbi = parseAbi([
  'function getReserveData(address asset) view returns (uint256 unbacked, uint256 accruedToTreasuryScaled, uint256 totalAToken, uint256 totalStableDebt, uint256 totalVariableDebt, uint256 liquidityRate, uint256 variableBorrowRate, uint256 stableBorrowRate, uint256 averageStableBorrowRate, uint256 liquidityIndex, uint256 variableBorrowIndex, uint40 lastUpdateTimestamp)',
  'function getReserveConfigurationData(address asset) view returns (uint256 decimals, uint256 ltv, uint256 liquidationThreshold, uint256 liquidationBonus, uint256 reserveFactor, bool usageAsCollateralEnabled, bool borrowingEnabled, bool stableBorrowRateEnabled, bool isActive, bool isFrozen)',
  'function getReserveCaps(address asset) view returns (uint256 borrowCap, uint256 supplyCap)',
  'function getPaused(address asset) view returns (bool)',
  'function getLiquidationProtocolFee(address asset) view returns (uint256)',
]);

const oracleAbi = parseAbi(['function getAssetPrice(address asset) view returns (uint256)']);
const erc20Abi = parseAbi(['function symbol() view returns (string)', 'function decimals() view returns (uint8)']);

export function makeClient(rpcUrls) {
  const urls = (rpcUrls && rpcUrls.length ? rpcUrls : ['https://ethereum-rpc.publicnode.com']);
  return createPublicClient({
    chain: mainnet,
    transport: fallback(urls.map((u) => http(u.trim(), { timeout: 20_000, retryCount: 2 })), { rank: false }),
    batch: { multicall: { wait: 20 } },
  });
}

/** Aave 前端展示的 APY = APR 按秒复利 */
function aprToApy(apr) {
  return (1 + apr / SECONDS_PER_YEAR) ** SECONDS_PER_YEAR - 1;
}

function toUnits(raw, decimals) {
  return Number(raw) / 10 ** decimals;
}

let cachedAddrs = null;
export async function resolveAddresses(client) {
  if (cachedAddrs) return cachedAddrs;
  const [pool, dataProvider, oracle] = await Promise.all([
    client.readContract({ address: POOL_ADDRESSES_PROVIDER, abi: providerAbi, functionName: 'getPool' }),
    client.readContract({ address: POOL_ADDRESSES_PROVIDER, abi: providerAbi, functionName: 'getPoolDataProvider' }),
    client.readContract({ address: POOL_ADDRESSES_PROVIDER, abi: providerAbi, functionName: 'getPriceOracle' }),
  ]);
  cachedAddrs = { pool, dataProvider, oracle };
  return cachedAddrs;
}

/**
 * 抓取一组资产的全部监控指标
 * @param {object} client viem client
 * @param {Array<{symbol?:string,address:string}>} assets
 * @returns {Promise<{blockNumber:number, ts:number, reserves:Record<string,object>}>}
 */
export async function fetchReserves(client, assets) {
  const { dataProvider, oracle } = await resolveAddresses(client);
  const blockNumber = await client.getBlockNumber();

  const calls = [];
  for (const a of assets) {
    const asset = a.address;
    calls.push(
      { address: dataProvider, abi: dataProviderAbi, functionName: 'getReserveData', args: [asset] },
      { address: dataProvider, abi: dataProviderAbi, functionName: 'getReserveConfigurationData', args: [asset] },
      { address: dataProvider, abi: dataProviderAbi, functionName: 'getReserveCaps', args: [asset] },
      { address: dataProvider, abi: dataProviderAbi, functionName: 'getPaused', args: [asset] },
      { address: oracle, abi: oracleAbi, functionName: 'getAssetPrice', args: [asset] },
      { address: asset, abi: erc20Abi, functionName: 'symbol' },
    );
  }

  const results = await client.multicall({ contracts: calls, blockNumber, allowFailure: true });

  const reserves = {};
  assets.forEach((a, i) => {
    const slice = results.slice(i * 6, i * 6 + 6);
    const failed = slice.find((r) => r.status === 'failure');
    if (failed) throw new Error(`读取 ${a.symbol || a.address} 失败: ${failed.error?.shortMessage || failed.error}`);
    const [rd, cfg, caps, paused, priceRaw, onchainSymbol] = slice.map((r) => r.result);

    const decimals = Number(cfg[0]);
    const symbol = a.symbol || onchainSymbol;

    const totalATokenRaw = rd[2];
    const totalDebtRaw = rd[3] + rd[4];
    const availableRaw = totalATokenRaw > totalDebtRaw ? totalATokenRaw - totalDebtRaw : 0n;

    const reserveSize = toUnits(totalATokenRaw, decimals);
    const totalDebt = toUnits(totalDebtRaw, decimals);
    const availableLiquidity = toUnits(availableRaw, decimals);
    const priceUsd = Number(priceRaw) / 1e8; // Aave oracle base currency unit = 1e8 (USD)

    const supplyApr = Number(rd[5]) / Number(RAY);
    const borrowApr = Number(rd[6]) / Number(RAY);

    const supplyCap = Number(caps[1]); // 单位为整枚代币，0 = 无上限
    const borrowCap = Number(caps[0]);

    reserves[symbol] = {
      symbol,
      address: a.address,
      decimals,
      priceUsd,

      // —— 核心 5 项监控指标 ——
      supplyAPY: aprToApy(supplyApr) * 100,
      supplyAPR: supplyApr * 100,
      reserveSize,
      reserveSizeUsd: reserveSize * priceUsd,
      availableLiquidity,
      availableLiquidityUsd: availableLiquidity * priceUsd,
      utilizationRate: reserveSize > 0 ? (totalDebt / reserveSize) * 100 : 0,

      // —— Supply info 其余字段 ——
      supplyCap,
      supplyCapUsedPct: supplyCap > 0 ? (reserveSize / supplyCap) * 100 : 0,
      supplyCapRemaining: supplyCap > 0 ? Math.max(supplyCap - reserveSize, 0) : Infinity,
      collateralEnabled: cfg[5],
      ltv: Number(cfg[1]) / 100,
      liquidationThreshold: Number(cfg[2]) / 100,
      liquidationPenalty: Number(cfg[3]) / 100 - 100,
      reserveFactor: Number(cfg[4]) / 100,

      // —— 借贷侧（做规则时常用作交叉判断）——
      borrowAPY: aprToApy(borrowApr) * 100,
      borrowAPR: borrowApr * 100,
      totalDebt,
      totalDebtUsd: totalDebt * priceUsd,
      borrowCap,
      borrowCapUsedPct: borrowCap > 0 ? (totalDebt / borrowCap) * 100 : 0,
      borrowingEnabled: cfg[6],

      // —— 状态 ——
      isActive: cfg[8],
      isFrozen: cfg[9],
      isPaused: paused,
      lastUpdate: Number(rd[11]),
    };
  });

  return { blockNumber: Number(blockNumber), ts: Date.now(), reserves };
}
