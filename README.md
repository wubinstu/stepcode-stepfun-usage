# StepFun Usage —— StepCode 插件

在 stepcode 输入框下方的信息行中，**右对齐**显示 StepFun(阶跃星辰) 账户用量：

```
⏵ Full Access (shift+tab) · step-5-preview · high · ~/projects/stepcode-plugin-usage     余额 45.37 · credit 用 817.48M 剩 89.78% · 99% context left
```

- **余额**：账户可用余额（元）；
- **credit**：Credit 已用量（以 M 为单位、保留两位小数）与剩余百分比（保留两位小数）。

## 数据来源：两个官方 API,零 cookie

| 数据 | 接口 | 鉴权 |
| --- | --- | --- |
| **余额** | `GET https://api.stepfun.com/v1/accounts` | Bearer API Key |
| **Credit 用量** | `GET https://api.stepfun.com/step_plan/v1/usage` | Bearer API Key |

- `v1/accounts` 是官方文档接口（[获取账户信息](https://platform.stepfun.com/docs/zh/api-reference/accounts/get)）；
- `step_plan/v1/usage` 是 **StepCode 官方 `/usage` 面板的同源接口**（schema 1，见
  [stepfun-ai/Step-Code](https://github.com/stepfun-ai/Step-Code) 仓库
  `packages/coding-agent/src/step/usage/account.ts` 的 `PlanUsageController`）。
  它返回套餐信息、5 小时/周限额窗口、credit 桶（total/remaining/used_percent）。
  官方 CLI 的 `/usage` 面板用的就是它——本插件只是把同样的数据渲染进 footer。

> 历史说明：v0.1.0 曾通过 platform.stepfun.com 网页端内部 RPC + 浏览器 cookie 获取
> Credit（cookie 需 30 天内外加一次、插件自动续期）。官方开放 `/usage` 接口后，
> v0.2.0 起**彻底移除 cookie 依赖**，两个数据源均为官方 API，API Key 永不过期。

**API Key 解析顺序**（通常无需任何配置）：

1. 环境变量 `$STEPFUN_API_KEY` / `$STEP_API_KEY`；
2. `~/.stepcode/auth.json` —— stepcode 自身的登录凭证（`step.access`）。

## 安装

```bash
# 方式一: 本地目录
step install .

# 方式二: GitHub
step install git:github.com/wubinstu/stepcode-stepfun-usage
```

安装后重启 stepcode（或 `/reload`），信息行右侧即出现用量。之后随官方 CLI 一起
`step update --extensions` 即可保持最新。

## 命令

| 命令 | 作用 |
| --- | --- |
| `/stepfun-usage` 或 `/stepfun-usage toggle` | 在「右对齐自定义 footer」与「内置 footer + 状态行」间切换 |
| `/stepfun-usage refresh` | 立即刷新用量 |
| `/stepfun-usage footer` / `/stepfun-usage status` | 直接切换模式 |
| `/stepfun-usage detail` | 查看明细（余额构成、套餐、Credit 桶、限额窗口、到期时间） |

## 套餐类型的显示适配

| 套餐 | footer 显示 |
| --- | --- |
| Token Plan（Credit 月池，如 Token-Pro） | `credit 用 817.48M 剩 89.78%` |
| 旧版 Coding Plan（5 小时/周限额） | `credit 5h剩xx% 周剩xx%` |
| 无套餐 | `credit 无套餐` |
| 接口异常 | `credit --`（余额仍独立显示） |

## 实现说明

- 每 30 秒拉取一次；两个接口并行请求、独立容错（一个失败不影响另一个）；
- 自定义 footer 复刻内置 footer 左侧信息（模式 · 模型 · 思考档位 · 目录 · 其他扩展状态），
  将用量块右对齐插入 `N% context left` 之前，布局与宽度阈值（60/80/100）与内置一致；
  终端过窄时按「完整 → 精简 → 仅余额 → 仅 context left」逐级降级；
- `status` 模式不改动 footer 结构，仅通过 `ctx.ui.setStatus` 在内置 footer 追加一段，
  适合想最大限度保持原生行为的场景；
- 数值格式与官方一致：Credit 已用量 = Σ(桶 total − remaining)/1e6，half-up 保留两位小数；
  剩余百分比 = 100 − 官方 used_percent（按桶总量加权），保留两位小数。

## 目录结构

```
extensions/
├── index.ts          # 插件入口:事件、命令、轮询、双接口编排
└── lib/
    ├── api.ts        # 官方 /v1/accounts 与 /step_plan/v1/usage 客户端与数据换算
    └── footer.ts     # footer 复刻渲染 + 右对齐用量块
```
