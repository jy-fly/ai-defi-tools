# ai-defi-tools

DeFi 监控工具集。按协议分目录，推送通道独立成模块，以后加别的协议直接在根目录再开一层。

```
ai-defi-tools/
├── tg/                    # 通用 Telegram 推送模块（协议无关，可被任意监控复用）
│   └── index.js
├── aave/                  # Aave V3 池子监控
│   ├── monitor             # 入口脚本（自带代理开关），./aave/monitor check
│   ├── config.json         ← 阈值配置（你要改的就是这个文件）
│   ├── config.example.json
│   ├── index.js            # CLI 入口
│   ├── reserves.js         # 链上数据抓取
│   ├── rules.js            # 规则引擎
│   ├── config.js           # 配置加载 + 阈值展开成规则
│   ├── format.js           # 消息 / 表格渲染
│   ├── state.js            # 上次快照 + 报警去重状态
│   └── data/state.json     # 运行时生成
├── .env                    # TG token / RPC
└── package.json            # 共用依赖（viem）
```

以后加协议（比如 Compound、Morpho）：新建 `compound/`，复用 `tg/` 和同样的 `rules.js` 套路即可。

## 当前配置的阈值

配置在 [aave/config.json](aave/config.json)：

| 池子 | Supply APY | 利用率 | 可用流动性 |
|---|---|---|---|
| USDT | ≥ 5% | ≥ 95% | < $200M |
| USDC | ≥ 5% | ≥ 95% | < $100M |
| WETH | ≥ 5% | ≥ 85% | < $300M |

**三个条件是各自独立报警**（任一命中就推一条，不是 AND）。APY 那条是机会信号（`info`，静音推送），利用率和流动性那两条是风险信号（`critical`，响铃）。

改阈值就改 `value`，一眼可见：

```json
{
  "symbol": "USDC",
  "address": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  "alerts": {
    "supplyAPY":             { "op": ">=", "value": 5,         "severity": "info" },
    "utilizationRate":       { "op": ">=", "value": 95,        "severity": "critical" },
    "availableLiquidityUsd": { "op": "<",  "value": 100000000, "severity": "critical" }
  }
}
```

每条阈值可选加 `cooldownMinutes`（重复提醒间隔）、`repeat: false`（只报首次）、`notifyOnRecover: false`（不发恢复通知）、`message`（自定义文案）、`enabled: false`（临时关闭）。

想要「利用率高 **且** 流动性低」这种组合条件，写到 `rules` 数组里（语法见下）。

## 快速开始

```bash
npm install
cp .env.example .env            # 填 AAVE_TELEGRAM_BOT_TOKEN / AAVE_TELEGRAM_CHAT_ID
./aave/monitor check            # 看当前值 vs 阈值对照 + TG 配置状态
./aave/monitor test-tg          # 验证 TG 通不通
./aave/monitor watch            # 常驻监控
```

`./aave/monitor` 是包装脚本，等价于 `node aave/index.js`，但会自动带上代理开关（见下面「国内网络」一节）。`npm run check` / `npm run watch` 等同。

Telegram 配置：`@BotFather` → `/newbot` 拿 token 填进 `.env`，把 bot 拉进群（或私聊发一条消息），然后 `node aave/index.js chat-id` 直接列出 chat_id（群 id 是负数）。

## 命令

```bash
node aave/index.js check              # 指标 + 阈值对照 + TG 推送配置自检，最常用
node aave/index.js preview [资产]     # 按当前数据渲染样例消息，调格式用（--send 真发一条）
node aave/index.js fields             # 列出 telegram.fields 所有可用字段
node aave/index.js show [--json]      # 只打印指标；--json 输出全部字段
node aave/index.js once [--dry-run]   # 检查一次并报警；--dry-run 只在终端预览消息
node aave/index.js watch [--quiet]    # 常驻循环，间隔取 intervalSeconds
node aave/index.js test-tg            # 发一条快照到 TG
node aave/index.js chat-id            # 列出 bot 能看到的 chat_id
                     --config=path    # 用别的配置文件
```

`npm run check` / `npm run watch` 等同上。

## 数据来源

**链上直读**，不爬 app.aave.com（前端 JS 渲染 + 会改 DOM，爬不稳）。从 `PoolAddressesProvider`（`0x2f39...E9e`）动态解析出 `PoolDataProvider` 和 `AaveOracle`，一次 multicall 取全部资产，Aave 升级换合约地址也不用改代码。

- `supplyAPY` 用前端同款按秒复利公式：`(1 + APR/31536000)^31536000 - 1`
- `availableLiquidity` = Reserve Size − 总借出量
- `utilizationRate` = 总借出量 / Reserve Size
- USD 计价用 Aave 自己的预言机（`AaveOracle`），与前端同源

## 可用指标（写规则用的 metric 名）

`node aave/index.js show --json` 可看全部字段实时值。

| 分类 | metric |
|---|---|
| 存款 | `supplyAPY`、`supplyAPR` |
| 规模 | `reserveSize`、`reserveSizeUsd` |
| 流动性 | `availableLiquidity`、`availableLiquidityUsd` |
| 利用率 | `utilizationRate` |
| Supply info | `supplyCap`、`supplyCapUsedPct`、`supplyCapRemaining`、`collateralEnabled`、`ltv`、`liquidationThreshold`、`liquidationPenalty`、`reserveFactor` |
| 借贷侧 | `borrowAPY`、`borrowAPR`、`totalDebt`、`totalDebtUsd`、`borrowCap`、`borrowCapUsedPct`、`borrowingEnabled` |
| 状态 | `priceUsd`、`isActive`、`isFrozen`、`isPaused` |

带 `Usd` 后缀的是美元计价，不带的是代币计价（阈值单位跟着 metric 走）。

## 环境变量

命名原则：**协议专属优先，通用的做兜底，链相关按链命名。**

| 变量 | 归属 | 说明 |
|---|---|---|
| `AAVE_TELEGRAM_BOT_TOKEN` | aave 专属 | `aave_risk_bot` 的 token |
| `AAVE_TELEGRAM_CHAT_ID` | aave 专属 | Aave 报警发到哪个群 |
| `TELEGRAM_BOT_TOKEN` | `tg/` 兜底 | **可选**。多个协议想共用一个 bot 时设这个 |
| `TELEGRAM_CHAT_ID` | `tg/` 兜底 | **可选**。共用同一个群时设这个 |
| `ETH_RPC_URLS` | 按链 | 以太坊主网 RPC，逗号分隔按序故障转移。同链上的其他协议共用 |
| `HTTPS_PROXY` / `NODE_USE_ENV_PROXY` | 环境 | 见「国内网络」一节 |

回落顺序是 `AAVE_TELEGRAM_* > TELEGRAM_*`。所以两种玩法都成立：

- **每个协议一个 bot / 一个群**（当前配置）：各设 `AAVE_...`、`COMPOUND_...`，互不干扰
- **所有协议共用一个 bot**：只设不带前缀的 `TELEGRAM_*`，各协议不用重复配

`ETH_RPC_URLS` 按链而不按协议，是因为以后 compound 也在以太坊主网，共用同一份节点列表；真要监控 BSC 上的协议才需要 `BSC_RPC_URLS`。

`./aave/monitor check` 会打印当前实际用的是哪个变量，配错了一眼能看出来。

## 国内网络：代理

`api.telegram.org` 需要代理。坑在于 **Node 的内置 `fetch` 默认忽略 `HTTPS_PROXY` 环境变量**（`curl` 会读，所以 `curl` 通不代表 Node 通），直接 `node aave/index.js` 会报 `fetch failed`。

解决办法是启动时带上 `NODE_USE_ENV_PROXY=1`（Node 24+ 支持，让内置 fetch 遵守代理变量）。下面三种方式都已经带好了：

```bash
./aave/monitor chat-id          # 包装脚本，推荐
npm run chat-id                 # npm scripts 也都带了
NODE_USE_ENV_PROXY=1 node aave/index.js chat-id   # 手动加前缀
```

前提是 shell 里有代理变量（一般代理客户端会自动注入，`env | grep -i proxy` 确认）：

```bash
export HTTPS_PROXY=http://127.0.0.1:7890
```

实测链上 RPC 走代理也正常（约 0.8s），所以全局开着没有副作用。忘了加的时候报错信息会直接告诉你怎么修。

## Telegram 配置

分三块，全在 [aave/config.json](aave/config.json) 的 `telegram` 段和 `.env` 里。

### 1) 凭据（.env）

密钥不进配置文件、不进仓库，只在 `.env`（已被 `.gitignore` 忽略）：

```
AAVE_TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
AAVE_TELEGRAM_CHAT_ID=-1001234567890
```

拿到它们的步骤：

1. Telegram 里找 `@BotFather` → `/newbot` → 拿到 token，填进 `.env`
2. 把 bot 拉进群，或者直接私聊它发一条消息（**这步必须做**，否则 bot 看不到任何会话）
3. 跑 `node aave/index.js chat-id`，直接列出 chat_id（群 id 是负数，形如 `-100...`）
4. 填进 `.env`，跑 `node aave/index.js test-tg` 验证

群里如果开了隐私模式，bot 可能收不到消息 —— 在 BotFather 里 `/setprivacy` → `Disable`，或者把 bot 设为管理员。

### 2) 消息内容和格式

**推送模式**：默认 `digest` —— 一轮检查里所有报警**合并成一条消息**，按池子分组（同一个池子触发多条规则时状态块只出现一次），并附上未触发池子的一行对照。这样三个池子同时出事也只收到一条，且能横向对比。

```json
"telegram": {
  "mode": "digest",
  "digestLayout": "overview+detail",
  "digestIncludeOthers": true,
  "digestDedupeFields": true,
  "fields": ["supplyAPY", "reserveSize", "availableLiquidity", "utilizationRate", "supplyCap", "borrowLine", "riskParams", "status"],
  "heartbeatFields": ["supplyAPY", "utilizationRate", "reserveSizeUsd", "availableLiquidityUsd"],
  "showRuleId": true,
  "showAaveLink": true,
  "showTimestamp": true,
  "silentSeverities": ["info"]
}
```

`digest` 模式长这样 —— 顶部概览一眼看清全局，下面才是触发池子的细节：

```
🚨 Aave V3 · 3 条报警

🚨 USDT   存款 APY 3.08% ｜ 利用率 88.08% ｜ 池子规模 $2.93B ｜ 可用流动性 $349.02M
ℹ️ USDC   存款 APY 3.74% ｜ 利用率 92.35% ｜ 池子规模 $2.18B ｜ 可用流动性 $166.84M
✅ WETH   存款 APY 1.46% ｜ 利用率 80.77% ｜ 池子规模 $4.95B ｜ 可用流动性 $952.55M

━━━━━ 触发详情 ━━━━━

🚨 USDT　2 条
  • USDT 存款 APY 达到阈值 → 当前 3.08%
     supplyAPY ≥ 1.00%（当前 3.08%）
  • USDT 利用率 达到阈值 → 当前 88.08%
     utilizationRate ≥ 50.00%（当前 88.08%）
🧱 供应上限: 3.480B（已用 84.14%）
📉 借款 APY 3.90% ｜ 总借出 $2.58B
⚙️ LTV 75.00% ｜ 清算线 78.00% ｜ 清算罚金 4.50% ｜ Reserve Factor 10.00%

block 25795680 ｜ 2026-08-20 10:18:03 UTC
```

| 字段 | 作用 |
|---|---|
| `mode` | `digest`（默认，一轮合并成一条）/ `single`（每条报警各发一条） |
| `digestLayout` | `overview+detail`（默认）/ `overview`（只要概览，最短）/ `detail`（只要详情，无概览） |
| `digestIncludeOthers` | 概览区是否附上未触发的池子做对照，默认 true |
| `digestDedupeFields` | 详情区自动省略概览已列过的指标，避免同一个值出现两遍，默认 true |
| `fields` | 详情区里的行。任何 metric 名都能用，另有 4 个复合字段（见下） |
| `heartbeatFields` | 概览区和定时快照里每个池子显示哪几项（紧凑单行） |
| `showRuleId` | 是否显示规则 ID |
| `showAaveLink` | 池子名是否链到 Aave 页面 |
| `showTimestamp` | 是否附 `block 号 ｜ 时间` |
| `silentSeverities` | 哪些级别静音推送（不响铃，仍进消息列表）。默认 `["info"]`。digest 按本轮最高级别判定 |

只想知道"哪个池子出事了"，不要细节 —— 消息会压到 5 行：

```json
"digestLayout": "overview"
```

**复合字段**（一行塞多个值，只能用在 `fields` 里，不能当规则的 metric）：

| 字段 | 渲染成 |
|---|---|
| `supplyCap` | `🧱 供应上限: 2.500B（已用 87.21%）` |
| `riskParams` | `⚙️ LTV 75.00% ｜ 清算线 78.00% ｜ 清算罚金 4.50% ｜ Reserve Factor 10.00%` |
| `borrowLine` | `📉 借款 APY 4.47% ｜ 总借出 $2.01B` |
| `status` | `🛑 状态异常: ...` —— **只在池子 frozen/paused/inactive 时才出现**，正常时自动省略 |

写 `reserveSize` 会同时给出代币量和美元值（`2.180B USDC ($2.18B)`），只想要美元值就写 `reserveSizeUsd`。

两个命令帮你调格式，不用真发消息：

```bash
node aave/index.js fields          # 列出所有可用字段
node aave/index.js preview USDC    # 按当前真实数据渲染 single 和 digest 两种形态
```

确认好了再 `node aave/index.js preview USDC --send` 真发一条看手机上的效果。

### 3) 推送时机和频率

```json
"intervalSeconds": 300,
"defaultCooldownMinutes": 60,
"heartbeatHours": 0,
"telegram": {
  "notifyOnRecover": true,
  "quietHours": { "enabled": false, "start": 1, "end": 7, "timezone": "Asia/Shanghai", "exceptSeverities": ["critical"] },
  "rateLimit": { "maxPerHour": 20, "exceptSeverities": ["critical"] }
}
```

| 字段 | 作用 |
|---|---|
| `intervalSeconds` | 多久检查一次，默认 300（5 分钟） |
| `defaultCooldownMinutes` | 同一条报警持续满足时，隔多久再提醒一次，默认 60。可在单条阈值里覆盖 |
| `heartbeatHours` | >0 时每 N 小时推一条三池汇总（静音，带涨跌箭头）。设 `12` 就是早晚各一条 |
| `notifyOnRecover` | 条件不再满足时发一条 ✅ 恢复通知 |
| `quietHours` | 静默时段。`start`/`end` 是小时（支持跨午夜，如 `23`→`7`），`exceptSeverities` 里的级别照常推送 |
| `rateLimit.maxPerHour` | 每小时最多推几条，防止极端行情刷屏。`exceptSeverities` 里的级别不受限。`digest` 模式下一轮只算 1 条 |

**静默时段和限流不会丢报警**：被拦下的消息不标记「已通知」，出了静默期或下个小时的第一次轮询会自动补发。所以设 `quietHours` 不用担心夜里漏掉重要变化。

只想被真正的风险叫醒，机会信号白天再看：

```json
"quietHours": { "enabled": true, "start": 23, "end": 8, "timezone": "Asia/Shanghai", "exceptSeverities": ["critical"] }
```

配好后跑一次自检，会把上面所有配置连同当前是否在静默期一起打出来：

```bash
node aave/index.js check
```

## 高级规则（config.json 的 `rules` 数组）

```json
{
  "id": "usdc-squeeze",
  "severity": "critical",
  "assets": ["USDC", "USDT"],
  "any": false,
  "when": [
    { "metric": "utilizationRate", "op": ">=", "value": 93 },
    { "metric": "availableLiquidityUsd", "op": "<", "value": 150000000 }
  ],
  "cooldownMinutes": 120,
  "message": "{symbol} 利用率 {utilizationRate} + 可用流动性 {availableLiquidityUsd}，提款可能受限"
}
```

- `assets`：symbol 数组或 `"*"`（全部）
- `when` 默认全部满足（AND），`"any": true` 改成任一满足（OR）
- `message` 里 `{metric}` 会替换成格式化后的当前值，`{symbol}` 是资产名

**操作符**

阈值比较：`>` `>=` `<` `<=` `==` `!=`（`==` 可比 `true`/`false`，用于 `isFrozen` 这类）

变化类（与上一次轮询快照对比）：

| op | 含义 | value 单位 |
|---|---|---|
| `changeUp` / `changeDown` / `changeAbs` | 单次绝对上涨 / 下跌 / 变动超过 | 指标单位 |
| `changePctUp` / `changePctDown` / `changePct` | 单次涨幅 / 跌幅 / 波动超过 | % |
| `crossUp` / `crossDown` | 上穿 / 下穿阈值（只在穿越那一刻响一次） | 指标单位 |

```json
// APY 一个周期内涨了 25% 以上且站上 4%
{ "id": "apy-spike", "assets": "*", "when": [
  { "metric": "supplyAPY", "op": "changePctUp", "value": 25 },
  { "metric": "supplyAPY", "op": ">=", "value": 4 }
], "message": "{symbol} APY 拉升到 {supplyAPY}" }

// 大额撤资：池子规模单周期缩水 5% 以上
{ "id": "tvl-drop", "assets": "*", "when": [
  { "metric": "reserveSizeUsd", "op": "changePctDown", "value": 5 }
] }

// 池子被冻结 / 暂停
{ "id": "reserve-abnormal", "assets": "*", "any": true, "when": [
  { "metric": "isFrozen", "op": "==", "value": true },
  { "metric": "isPaused", "op": "==", "value": true }
], "severity": "critical" }
```

## 全局配置

| 字段 | 说明 |
|---|---|
| `intervalSeconds` | `watch` 轮询间隔，默认 300。变化类规则的「一个周期」就是这个间隔 |
| `defaultCooldownMinutes` | 未单独指定时的重复提醒间隔，默认 60 |
| `statePath` | 状态文件路径 |
| `rpcUrls` | RPC 列表，按序故障转移；`.env` 的 `ETH_RPC_URLS` 优先 |
| `monitors` | 监控的池子 + 阈值；加池子往这里加一项即可 |

## 常驻运行

**cron（每 5 分钟）**

```bash
*/5 * * * * ./aave/monitor once --quiet >> monitor.log 2>&1
```

**pm2**

```bash
pm2 start aave/monitor --name aave-monitor -- watch
```

`once` 模式下变化类规则的对比周期 = cron 间隔；`watch` 模式下 = `intervalSeconds`。

## 复用 tg 模块

```js
import * as tg from './tg/index.js';

await tg.sendMessage('<b>随便什么监控</b>\n出事了', { silent: false });
tg.isConfigured();          // 检查 env 是否齐
await tg.getChatIds();      // 列出 chat_id
tg.escapeHtml(userInput);   // HTML 模式必须转义
```

自带 429 限流退避和超时重试，token/chatId 默认从环境变量读，也可以按调用传入覆盖。

## 注意

- 删掉 `aave/data/state.json` 即重置：变化类规则会跳过一个周期，已触发的规则会重新报一次
- `aave/config.json` 和 `.env` 已在 `.gitignore` 里，改阈值不会污染仓库
