# StepFun Usage —— StepCode 插件

在 stepcode 输入框下方的信息行中，**右对齐**显示 StepFun(阶跃星辰) 账户用量：

```
⏵ Autopilot (shift+tab) · step-5-preview · high · ~/projects/stepcode-plugin-usage     余额 -0.04 · credit 用 0.19M 剩 99.26% · 100% context left
```

## 数据来源(双通道, 各自独立降级)

| 数据 | 通道 | 稳定性 |
| --- | --- | --- |
| **余额** | 官方 API `GET https://api.stepfun.com/v1/accounts` (API Key 鉴权) | ⭐ 永久有效, 零维护 |
| **Credit 已用/剩余** | platform.stepfun.com 网页端内部 RPC (浏览器登录态) | 导出一次 cookie 后自动续期 |

- 官方 OpenAPI **不提供** Credit 额度查询(已试遍 `api.stepfun.com` 所有路径)，
  Credit 数据只能来自网页端自身接口(与 `/account-overview` 页面所见一致)。
- 没有 API Key 时余额会自动回退到网页端通道；没有 cookie 时 Credit 显示 `--`，不影响余额。
- API Key 按 `$STEPFUN_API_KEY` / `$STEP_API_KEY` → `~/.stepcode/auth.json`
  (stepcode 自己的登录凭证)顺序解析，通常**无需任何配置**。

## 安装

```bash
# 方式一: 本地目录
step install .

# 方式二: GitHub
step install git:github.com/wubinstu/stepcode-stepfun-usage
```

安装后重启 stepcode(或 `/reload`)，信息行右侧即出现用量。

## 配置 cookie(仅 Credit 需要, 导出一次即可)

浏览器登录 <https://platform.stepfun.com/account-overview>，用 cookie 导出工具
(如 "Get cookies.txt LOCALLY" 扩展)导出，保存为以下任一位置(按优先级命中):

1. 环境变量 `STEPFUN_USAGE_COOKIE_FILE` 指定的路径；
2. `~/.stepcode/stepfun-usage/cookie`(推荐)；
3. 本插件包根目录下的 `cookie`；
4. 当前工作目录下的 `cookie`。

登录态机制说明:

- 登录态 = `Oasis-Webid`(设备 ID) + `Oasis-Token`(`<accessJWT>...<refreshJWT>`)；
- access JWT 只有 **30 分钟**有效期，因此插件在过期前(剩余 < 4 分钟)自动调用
  网页端同款 `PassportService/RefreshToken` 接口续期，新 token 对持久化在
  `~/.stepcode/stepfun-usage/state.json`——**不需要反复导出 cookie**；
- refresh token 有效期约 **30 天**：30 天内至少打开过一次 stepcode 即可一直续期；
- 超过 30 天未运行导致续期失败时，footer 的 credit 显示 `--` 并提示重新导出，
  此时重新导出一次 cookie 即可。

> cookie 文件含账号登录态，**切勿提交到 git**(仓库 `.gitignore` 已忽略 `cookie`)。
> 推荐放到 `~/.stepcode/stepfun-usage/cookie` 而不是项目目录，避免被其他工具的
> 安全清理策略误删。

## 命令

| 命令 | 作用 |
| --- | --- |
| `/stepfun-usage` 或 `/stepfun-usage toggle` | 在「右对齐自定义 footer」与「内置 footer + 状态行」间切换 |
| `/stepfun-usage refresh` | 立即刷新用量 |
| `/stepfun-usage footer` / `/stepfun-usage status` | 直接切换模式 |
| `/stepfun-usage detail` | 查看明细(余额构成、Credit、昨日/本月/累计消耗、数据来源) |

## 实现说明

- 每 30 秒拉取一次；两个数据通道并行请求、独立容错；
- 自定义 footer 复刻内置 footer 左侧信息(模式 · 模型 · 思考档位 · 目录 · 其他扩展状态)，
  将用量块右对齐插入 `N% context left` 之前，布局与宽度阈值(60/80/100)与内置一致；
- `status` 模式不改动 footer 结构，仅通过 `ctx.ui.setStatus` 在内置 footer 追加一段，
  适合想最大限度保持原生行为的场景；
- 数值格式与网页端一致：余额精确到分；Credit 已用量以 M 为单位 half-up 保留两位小数，
  剩余百分比保留两位小数(来源:`creditTotal/creditResidual` bucket 汇总，
  无 bucket 时回退 `subscriptionCreditLeftRate`)。

## 目录结构

```
extensions/
├── index.ts          # 插件入口:事件、命令、轮询、双通道编排
└── lib/
    ├── tokens.ts     # cookie 解析、JWT 解码、自动续期、状态持久化
    ├── api.ts        # 官方 accounts API + 网页端 Dashboard RPC 与数据换算
    └── footer.ts     # footer 复刻渲染 + 右对齐用量块
```
