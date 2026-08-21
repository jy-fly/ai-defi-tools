# ai-defi-tools

DeFi 监控工具集。按协议分目录，推送通道独立成模块，以后加别的协议直接在根目录再开一层。

```
ai-defi-tools/
├── core/                  # 协议无关的引擎：规则、状态、配置展开、消息渲染
│   ├── rules.js
│   ├── state.js
│   ├── config.js
│   └── format.js
├── tg/                    # 通用 Telegram 推送模块
│   └── index.js
├── bybit/                 # Bybit 现货价格监控（发到独立的 TG 群）
│   ├── monitor             # 入口，./bybit/monitor check
│   ├── market.js           # Bybit V5 公开行情接口
│   ├── config.json         ← 价格阈值
│   └── ...
├── aave/                  # Aave V3 池子监控
│   ├── monitor             # 入口脚本（自带代理开关），./aave/monitor check
│   ├── config.json         ← 阈值配置（你要改的就是这个文件）
│   ├── config.example.json
│   ├── index.js            # CLI 入口
│   ├── reserves.js         # 链上数据抓取
│   ├── rules.js            # 规则引擎
│   ├── history.js          # CSV 落库
│   ├── mongo.js            # MongoDB 落库
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
| `MONGODB_URI` | 可选 | MongoDB 连接串，含密码所以只走环境变量/Secrets。不设则不写 mongo |
| `ETH_RPC_URLS` | 按链 | 以太坊主网 RPC，逗号分隔按序故障转移。同链上的其他协议共用 |
| `HTTPS_PROXY` / `NODE_USE_ENV_PROXY` | 环境 | 见「国内网络」一节 |

回落顺序是 `AAVE_TELEGRAM_* > TELEGRAM_*`。所以两种玩法都成立：

- **每个协议一个 bot / 一个群**（当前配置）：各设 `AAVE_...`、`COMPOUND_...`，互不干扰
- **所有协议共用一个 bot**：只设不带前缀的 `TELEGRAM_*`，各协议不用重复配

`ETH_RPC_URLS` 按链而不按协议，是因为以后 compound 也在以太坊主网，共用同一份节点列表；真要监控 BSC 上的协议才需要 `BSC_RPC_URLS`。

`./aave/monitor check` 会打印当前实际用的是哪个变量，配错了一眼能看出来。

## GitHub Actions 上的实测

cron 写的是每 5 分钟，但**实际做不到**。这个仓库的真实数据：15:21 跑了一次（`schedule` 触发，22 秒完成），之后 15:25 / 15:30 / 15:35 三次全部没跑 —— 15 分钟里应该 3 次，实际 0 次。

GitHub 官方文档明说定时任务在高峰期会被延迟或跳过，所以别把它当准点闹钟。对「利用率突破 95%、流动性告急」这类事件，实际发现时间可能是 10-30 分钟后。

社区经验：`*/5` 这种整点边界竞争最激烈，用带偏移的写法（`3,8,13,18,...`）据说好一些，可以试。

手动触发时可以选模式（Actions 页面 → Run workflow → 下拉框）：

- `once` — 正常检查，只在命中阈值时推送
- `snapshot` — 无条件推一条当前状态到 TG，**用来验证 CI 上的凭据链路**
- `check` — 只打印指标和阈值对照，不推送

最后这点很实用：阈值全绿时 `once` 不发消息，所以 workflow 显示 "success" 并不能证明 Telegram 通了。用 `snapshot` 跑一次才能真正验证。

## 报警确认

```json
"confirmDelaySeconds": 20,
"confirmRetrySeconds": 10,
"confirmMinVotes": 2
```

规则命中后不立刻发，**最多抓三次、累计命中两次才推送**。挡掉 RPC 返回异常值、区块重组这类只出现一次的假警报。

```
[confirm] 第 1 次有 2 条命中，2 条待确认，等 20s 后重查
[confirm] 第 2 次完成 block 25802203 → 25802205
[confirm] ✓ USDC-liq-drop-60m::USDC 2/2 次命中，确认发送
[confirm] ✗ USDT-liq-drop-5m::USDT 仅 1/2 次命中，判定为抖动，不发送
```

**不要求连续命中** —— 「中、没中、中」也算两票就发送。指标在阈值附近来回跳，恰恰说明它确实到了危险水位，没理由因为中间那次回落就当没事。

| 三次结果 | 票数 | 结果 |
|---|---|---|
| ✓ ✓ — | 2 | **发送**（攒够票提前收工，不跑第三次） |
| ✓ ✗ ✓ | 2 | **发送** |
| ✓ ✗ ✗ | 1 | 丢弃 |
| ✗ ✓ ✓ | 2 | **发送** |
| ✗ ✓ ✗ | 1 | 丢弃 |

判定是个纯函数（`confirmedByVotes`，7 个用例覆盖），因为这块逻辑错了会直接导致漏报或误报，内联在流程里没法单独验证。

四个实现细节：

- **确认必须在抢占发送权之前**。否则第一次评估就占了 cooldown，最终没发的话这条报警在整个 cooldown 期内都报不出来了。
- **攒够票就提前结束**，不白跑第三次 RPC。
- **消息内容取自命中那次的评估结果**，数据用最新一次抓取的。否则会出现「跌幅 4.5%（阈值 5%）」却发了报警的矛盾显示。
- **抓取失败就用已有票数判定**，不再重试。

`confirmDelaySeconds: 0` 关闭整个机制。代价是报警延迟 20-30 秒，多一到两次 RPC 抓取。

## 双 runner 与共享状态

GitHub 对单个 workflow 的定时调度延迟很大 —— 配 `*/5`，实测 33 分钟才跑一次。所以开了两个功能相同、cron 错开的 workflow：

| workflow | cron |
|---|---|
| `aave-monitor.yml` | `*/5` |
| `aave-monitor-2.yml` | `2,7,12,17,...`（错开整点边界） |

**两边都判规则、都推送，但不会重复通知。** 关键在于报警状态存在 MongoDB 的 `runner_state` 集合里，靠原子操作抢占发送权：

- **报警**：`findOneAndUpdate` 带 cooldown 条件，谁先跑到谁拿到发送权，另一个读到已占用就跳过
- **每日推送**：用 `daily:<日期>` 做唯一键 `insertOne`，重复插入会撞 duplicate key，所以一天只可能发出一条
- **限流计数**：`sent:*` 记录共享，两个 runner 不会各算一套额度

日志里能看到抢占结果：

```
[skip] 2026-08-21 的每日推送已由其他 runner 发出
[skip] USDC-liq-drop-60m::USDC 已由其他 runner 处理或在 cooldown 内
```

所以两个 workflow **必须配同一个 `MONGODB_URI`**，否则状态不互通，就真的会重复通知了。

### 窗口规则的历史也走 MongoDB

窗口类规则（`dropPctOver`）原来读 `state.history`，那是各自 Actions cache 里的滑动窗口 —— 副 runner 采的数据主 runner 看不见。现在改成从最细粒度那层（`aave_5m`）读回历史：

```
[history] 从 aave_5m 读回 52 个时间点（覆盖 1440 分钟窗口）
```

两个 runner 的采样都能用于窗口对比，数据密度直接翻倍，`⚠采样密度不足` 的降级标注也会少很多。没配 MongoDB 时自动退回本地滑动窗口。

## Bybit 价格监控

盯 USDC/USDT 的卖一价，到 1.0002 / 1.0 时推送到独立的 TG 群。

```bash
./bybit/monitor check          # 当前价格 + 阈值对照
./bybit/monitor once           # 检查一次并报警
./bybit/monitor watch          # 常驻（5 分钟一轮）
./bybit/monitor snapshot       # 把当前价格发到 TG
```

消息就一行，通知栏预览不用点开就能看全：

```
🔔 USDC/USDT 卖一 1.0002　买一 1.0001
到 1.0002 了
```

**盯 `ask1Price`（卖一价）而不是最新成交价** —— 用 USDT 买 USDC 时吃的是卖单，卖一价才是实际能成交的价格。`lastPrice` 是别人几秒前的成交价，看着到位了未必买得到。

### CI 上怎么连 Bybit

**Bybit 封禁美国 IP**，而 GitHub Actions 的 runner 跑在 Azure 美国节点，直连 `api.bybit.com` 一律 403。

解决办法是在 runner 上起一个 mihomo（Clash Meta 内核），用机场订阅把流量从非美国出口送出去：

1. 下载 mihomo 二进制（约 18MB）
2. 用 `proxy-provider` 引用订阅，自己掌控端口和出口规则，不受机场配置里的分组影响
3. 起在 `127.0.0.1:7890`，探测能连通 Bybit 才继续（最多等 40 秒）
4. 给 Node 设 `HTTPS_PROXY` + `NODE_USE_ENV_PROXY=1`

需要一个 Secret：**`CLASH_SUBSCRIPTION_URL`**（机场订阅链接）。没配的话代理那步会自动跳过，然后 Bybit 请求就会 403 失败。

三个注意事项：

- **订阅链接绝不进日志**。这是 public 仓库，Actions 日志谁都能看。配置文件只写不读，没有 `set -x`，GitHub 也会对 secret 做打码 —— 但仍然建议用一个专用订阅，别拿主力账号的。
- **机场可能封 CI 的 IP**。每 5 分钟一次请求量很小，但 runner 的 IP 每次都变，某些机场的风控会当成异常。
- **代理起不来就整个失败**，不会静默降级 —— 宁可让 workflow 红着，也别让你以为在监控其实没有。

不想用代理的话，把 `source` 改成 `kraken` 并配 `priceOffset: -0.0001`（实测 Kraken 卖一稳定比 Bybit 高这么多，平移后两边吻合）。代价是这个偏差只在平静行情下稳定，两家流动性差 15 倍，波动时会拉开。

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


### 每日定时推送

```json
"dailyReport": { "enabled": true, "hour": 10, "minute": 0, "timezone": "Asia/Hong_Kong" }
```

每天早上 10 点推一份三池状态，带涨跌对比。

**刻意不做「精确到点触发」**：GitHub cron 会抖动十几分钟甚至跳过整轮，如果要求「10:00 那一轮」才发，很可能整天都不发。所以判定逻辑是「今天过了 10:00、且今天还没发过」—— 哪怕上午全漏了，14:45 第一次跑到也会补发当天这一份。日期按配置时区计算，记在 `state.lastDailyReport`。

涨跌用 emoji 上色（**Telegram 的 HTML 不支持自定义颜色**，只有 bold/italic/code/spoiler 这些，emoji 是唯一手段），沿用 crypto 惯例涨绿跌红：

```
☀️ Aave V3 每日状态 · 2026-08-21

资产  APY    用率    可用
─────────────────────────────
USDT  3.06%  87.82%  $357.20M
USDC  4.25%  92.79%  $157.00M
WETH  1.47%  80.93%  $959.50M

较上次变化
USDT 可用 🔴▼$14.80M/4.0%
USDC APY 🟢▲0.58%/15.8%
     可用 🔴▼$11.00M/6.5%
```

排版用 `<pre>` 等宽表格，三行看完全局还能横向对比。原来的横排在手机上会把 `$357.24M` 折成 `$3` + `57.24M`，数字断在中间没法读。

三个要点：

- **表格区不放 emoji** —— emoji 在等宽字体里宽度不统一，会毁掉列对齐。emoji 只出现在状态列和变化区，那里不需要对齐
- **变化区只列真正变了的**，平静时整块消失，消息缩到 8 行
- 池子名做成链接放在底部（Telegram 的 `<pre>` 块里不能嵌 `<a>` 标签）

报警 digest 的概览区是同一张表，多一列状态图标：

```
   资产  APY    用率    可用
   ─────────────────────────────
✅ USDT  3.06%  87.82%  $357.20M
🚨 USDC  4.25%  92.79%  $157.00M
✅ WETH  1.47%  80.93%  $959.50M
```

变化量同时给绝对值和百分比，百分比精度自适应（≥1% 留一位，更小的留两位，否则 0.014% 会显示成没意义的 `0.0%`）。

**变化小到看不出来就完全不显示**，不留占位符号 —— 一行里挤满 ⚪️→ 只是噪音（上面 WETH 那行就是没变化的样子）。判定标准是「变化量格式化后和 0 一样，或相对幅度不足 0.01%」，各指标自动按自己的显示精度来算，不用逐个调阈值。

### 3) 推送时机和频率

```json
"intervalSeconds": 300,
"defaultCooldownMinutes": 60,
"heartbeatHours": 0,
"telegram": {
  "notifyOnRecover": true,
  "quietHours": { "enabled": false, "start": 1, "end": 7, "timezone": "Asia/Hong_Kong", "exceptSeverities": ["critical"] },
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
"quietHours": { "enabled": true, "start": 23, "end": 8, "timezone": "Asia/Hong_Kong", "exceptSeverities": ["critical"] }
```

配好后跑一次自检，会把上面所有配置连同当前是否在静默期一起打出来：

```bash
node aave/index.js check
```

## 历史数据

报警只看当下，趋势要靠存下来。两个后端可以单独开也可以同时开，**都放在报警之后执行，任何一个挂了都不影响推送**，而且复用报警那次的 RPC 抓取，不额外发请求。

默认每小时落一次（`historyIntervalMinutes`），报警仍是每 5 分钟检查。

### CSV（零依赖，推荐先用这个）

```bash
./aave/monitor once --history=data/history.csv
```

14 列，每个池子一行：`time,block,symbol,priceUsd,supplyAPY,borrowAPY,utilizationRate,reserveSize,reserveSizeUsd,availableLiquidity,availableLiquidityUsd,totalDebt,totalDebtUsd,supplyCapUsedPct`

写入间隔靠**读 CSV 最后一行的 `time`**判断，不依赖状态文件 —— 天然幂等，CI 上 cache 丢了也不会重复写。

一年不到 2MB。查起来一条 SQL：

```bash
duckdb -c "SELECT symbol, min(availableLiquidityUsd) AS 最低流动性, max(utilizationRate) AS 最高利用率 FROM 'history.csv' GROUP BY symbol"
```

**GitHub Actions 里不写 CSV** —— 它和 MongoDB 的 `aave_1h` 层粒度相同、数据重复，而 Mongo 版本还多了 `min`/`max`/`samples`。去掉后 CI 的权限能降到 `contents: read`（不需要往仓库推任何东西），少一套 force-push 逻辑和它的失败模式。

CSV 保留作为本地临时导出手段：想丢给 DuckDB 或 Excel 看一眼时加 `--history=xxx.csv` 就行。

### MongoDB

设了 `MONGODB_URI` 就自动启用，不设就完全不碰：

```bash
MONGODB_URI="mongodb+srv://user:pass@cluster.xxx.mongodb.net/" ./aave/monitor once
```

**连接串写在 `.env` 里**（本地）或 GitHub Secrets（CI），绝不进 `config.json` —— 它含密码。库名和集合名才写配置文件的 `mongo` 段（默认 `defi.aave_reserves`）。

```
# .env
MONGODB_URI=mongodb+srv://user:pass@cluster.xxxxx.mongodb.net/
MONGODB_PROXY=socks5://127.0.0.1:7890    # 国内本地测试才需要
```

⚠️ **驱动不走 HTTP 代理**。MongoDB 是 TCP 连接，`HTTPS_PROXY` 和 `NODE_USE_ENV_PROXY` 对它完全无效（那套只管 Node 的 fetch）。国内本地连 Atlas 需要 SOCKS5，设 `MONGODB_PROXY`。填了 `http://` 开头的地址会被忽略并给出提示。部署到海外服务器或 Actions 上不用设。

幂等靠「时间桶 + 唯一索引 + upsert」：`time` 是精确抓取时刻，`timeBucket` 是规整到整小时的桶，配合 `(symbol, timeBucket)` 唯一索引。CI 重试、手动补跑都不会产生重复文档，同一小时内重复运行只是刷新那条的值。

⚠️ **Atlas 免费层的坑**：GitHub Actions runner 的 IP 是动态的 Azure 段，没法枚举，所以 Network Access 只能开 `0.0.0.0/0`。Atlas 原来那个能绕过白名单的 Data API 已经停服了，没有别的办法。安全性靠强密码 + TLS 兜着，另外给这个用户只授 `readWrite` 单库权限，别用 admin。

查询示例：

```js
// USDC 最近 7 天的利用率曲线
db.aave_reserves.find(
  { symbol: 'USDC', timeBucket: { $gte: new Date(Date.now() - 7*864e5) } },
  { timeBucket: 1, utilizationRate: 1, availableLiquidityUsd: 1, _id: 0 }
).sort({ timeBucket: 1 })
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
- `.env` 在 `.gitignore` 里，凭据不会进仓库；`aave/config.json` 已版本化，改阈值会产生 git 变更
