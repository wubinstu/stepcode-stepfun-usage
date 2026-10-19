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
> v0.2.1 起移除 package.json（零 npm 依赖，约定式目录自动发现），安装无需 npm 环境。

**API Key 解析顺序**（通常无需任何配置）：

1. 环境变量 `$STEPFUN_API_KEY` / `$STEP_API_KEY`；
2. `~/.stepcode/auth.json` —— stepcode 自身的登录凭证（`step.access`）。

## 安装

**前置条件: 只需要 `git`。** 本插件没有任何 npm 依赖、也没有 package.json，
安装过程只有一次 git clone，**不需要 Node.js / npm 环境**。网络需能访问
github.com（国内网络不畅时配合代理即可）。

```bash
# GitHub 安装（推荐）
step install git:github.com/wubinstu/stepcode-stepfun-usage

# 或本地目录安装
step install .
```

安装后重启 stepcode（或 `/reload`），信息行右侧即出现用量。

### 更新插件

直接重新执行安装命令即可，该命令幂等——对已存在的克隆会原地 fetch 并 reconcile，
不会重复克隆：

```bash
step install git:github.com/wubinstu/stepcode-stepfun-usage
```

> 注意: v0.1.5 的 `step update` 只能更新 CLI 自身；文档中的 `step update --extensions`
> 等参数在该版本二进制里尚未生效（执行会提示 `Usage: step update [version]`）。
> 更新插件请用上面的 `step install` 命令。

### 卸载

```bash
step remove git:github.com/wubinstu/stepcode-stepfun-usage
```

该命令会同时把插件从设置中移除、并删除克隆目录。重启 stepcode 后，footer 右侧
不再显示用量，`/stepfun-usage` 命令也随之消失。

如需清理可能存在的残留文件（Windows 把 `~` 换成 `%USERPROFILE%`）：

```bash
# v0.1 旧版的 cookie / 登录态目录（v0.2+ 已不再使用；没用过旧版可忽略）
rm -rf ~/.stepcode/stepfun-usage
# 在 home 目录运行过 step 时，可能残留一份项目作用域克隆（见下方双克隆说明）
rm -rf ~/.stepcode/git/github.com/wubinstu/stepcode-stepfun-usage
# 用户作用域克隆（step remove 通常已删除；若仍存在则手动清理）
rm -rf ~/.stepcode/agent/git/github.com/wubinstu/stepcode-stepfun-usage
```

> 若当初是项目作用域安装的（`step install -l ...`），卸载同样加 `-l`：
> `step remove -l git:github.com/wubinstu/stepcode-stepfun-usage`

以后想重新使用，重新安装即可：`step install git:github.com/wubinstu/stepcode-stepfun-usage`

### 关于"安装了两份"（双克隆说明）

有反馈（Windows / Linux 均可复现）：`step install` 克隆到
`~/.stepcode/agent/git/github.com/wubinstu/stepcode-stepfun-usage`，但在 **home 目录**
下启动 step 时，又会克隆出一份到 `~/.stepcode/git/github.com/wubinstu/stepcode-stepfun-usage`。

**原因**: 当 cwd 恰好是 home 目录时，`~/.stepcode` 会同时被当作*项目*配置目录，
用户作用域的包会被以*项目*作用域解析，两个作用域的克隆路径不同（项目：
`~/.stepcode/git/`；用户：`~/.stepcode/agent/git/`），于是出现两份磁盘克隆。

**影响**: 按包身份去重（项目作用域优先），同时只有一份生效。从 home 目录启动时，
生效的是 `~/.stepcode/git/` 那份，而 `step install` 更新的是 `~/.stepcode/agent/git/`
那份——此时刚更新的版本不会生效。

**建议**: 在项目目录中使用 step（正常用法无此问题）；若习惯在 home 目录直接启动，
更新插件后删除项目作用域那份克隆，下次从 home 启动会重新克隆最新版：

```bash
rm -rf ~/.stepcode/git/github.com/wubinstu/stepcode-stepfun-usage
```

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
