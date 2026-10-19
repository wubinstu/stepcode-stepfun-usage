/**
 * stepfun-usage —— StepCode 插件
 *
 * 在输入框下方的信息行(footer)右对齐显示 StepFun 账户用量:
 *   余额 -0.04 · credit 用 812.04M 剩 89.85%        100% context left
 *
 * 数据源(全部为官方 API, Bearer API Key 鉴权, 无需 cookie):
 *
 *   余额   → GET https://api.stepfun.com/v1/accounts
 *            (官方文档: platform.stepfun.com/docs/zh/api-reference/accounts/get)
 *
 *   credit → GET https://api.stepfun.com/step_plan/v1/usage
 *            (StepCode 官方 /usage 面板同源接口; 实现参考 stepfun-ai/Step-Code
 *             packages/coding-agent/src/step/usage/account.ts)
 *            返回 schema 1 JSON: 套餐信息 + 5小时/周限额窗口 + credit 桶。
 *
 * API Key 解析顺序: $STEPFUN_API_KEY / $STEP_API_KEY → ~/.stepcode/auth.json
 * (stepcode 自身的登录凭证), 通常无需任何配置。
 */

import type { ExtensionAPI, ExtensionContext } from "@step-harness/coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	computeCreditView,
	fetchAccountInfo,
	fetchPlanUsage,
	type UsageSnapshot,
} from "./lib/api.ts";
import { renderFooterLines, STATUS_KEY } from "./lib/footer.ts";

const POLL_INTERVAL_MS = 30_000;

/** 用量块对齐方式 */
type Align = "left" | "right";

interface RuntimeState {
	snapshot: UsageSnapshot | null;
	error: string | null;
	lastNotifiedError: string | null;
	/** 用量 footer 开关(on/off) */
	enabled: boolean;
	/** 对齐方式(默认右对齐) */
	align: Align;
	inFlight: boolean;
	timer: ReturnType<typeof setInterval> | null;
	tui: { requestRender(): void } | null;
}

/** 跨会话共享的模块级状态(session 切换时保留快照, 避免重复请求) */
const state: RuntimeState = {
	snapshot: null,
	error: null,
	lastNotifiedError: null,
	enabled: true,
	align: "right",
	inFlight: false,
	timer: null,
	tui: null,
};

/**
 * 解析 API Key。优先环境变量, 其次 stepcode 自己的登录态 ~/.stepcode/auth.json。
 */
function resolveApiKey(): string | null {
	const env = process.env.STEPFUN_API_KEY || process.env.STEP_API_KEY;
	if (env) return env.trim();
	try {
		const authPath = join(homedir(), ".stepcode", "auth.json");
		if (!existsSync(authPath)) return null;
		const data = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, unknown>;
		for (const entry of Object.values(data)) {
			const rec = entry as { type?: string; access?: unknown; key?: unknown } | null;
			if (rec && typeof rec.access === "string" && rec.access.length > 0) return rec.access.trim();
			if (rec && typeof rec.key === "string" && rec.key.length > 0) return rec.key.trim();
		}
	} catch {
		// 忽略解析失败
	}
	return null;
}

function describeError(err: unknown): string {
	const kind = (err as { name?: string } | null)?.name;
	if (kind === "PlanUsageUnavailableError") return "用量接口暂未开放(404)";
	return (err as Error)?.message ?? String(err);
}

export default function stepfunUsage(pi: ExtensionAPI) {
	/** 当前会话的 ctx(session 切换时会更新), footer 渲染时使用 */
	let currentCtx: ExtensionContext | null = null;

	async function refreshUsage(opts: { notify?: boolean } = {}): Promise<void> {
		if (state.inFlight) return;
		state.inFlight = true;
		try {
			const apiKey = resolveApiKey();
			if (!apiKey) {
				state.error = "未找到 API Key(请检查 ~/.stepcode/auth.json 或 STEPFUN_API_KEY)";
				state.snapshot = null;
			} else {
				// 两个官方接口并行请求, 独立容错
				const [accountResult, planResult] = await Promise.allSettled([
					fetchAccountInfo(apiKey),
					fetchPlanUsage(apiKey),
				]);
				const account = accountResult.status === "fulfilled" ? accountResult.value : null;
				const plan = planResult.status === "fulfilled" ? planResult.value : null;
				state.snapshot = { fetchedAt: Date.now(), account, plan };
				if (!account && !plan) {
					const first =
						accountResult.status === "rejected"
							? describeError(accountResult.reason)
							: planResult.status === "rejected"
								? describeError(planResult.reason)
								: "无法获取用量";
					state.error = first;
				} else {
					state.error = null;
				}
			}
			if (state.error) {
				const isNew = state.lastNotifiedError !== state.error;
				state.lastNotifiedError = state.error;
				if (isNew && opts.notify !== false) {
					currentCtx?.ui.notify(`StepFun 用量获取失败: ${state.error}`, "warning");
				}
			} else if (state.lastNotifiedError) {
				state.lastNotifiedError = null;
				currentCtx?.ui.notify("StepFun 用量已恢复", "info");
			}
		} finally {
			state.inFlight = false;
			afterStateChange();
		}
	}

	function afterStateChange(): void {
		if (state.enabled) state.tui?.requestRender();
	}

	function applyFooterMode(): void {
		const ctx = currentCtx;
		if (!ctx?.hasUI) return;
		if (!state.enabled) {
			// 关闭: 恢复内置 footer, 并清理状态行
			state.tui = null;
			ctx.ui.setFooter(undefined);
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		ctx.ui.setStatus(STATUS_KEY, undefined);
		ctx.ui.setFooter((tui, theme, footerData) => {
			state.tui = tui;
			const renderCtx = currentCtx ?? ctx;
			return {
				invalidate() {},
				render(width: number): string[] {
					return renderFooterLines({
						width,
						theme,
						ctx: renderCtx as unknown as Parameters<typeof renderFooterLines>[0]["ctx"],
						footerData: footerData as unknown as Parameters<typeof renderFooterLines>[0]["footerData"],
						snapshot: state.snapshot,
						error: state.error,
						align: state.align,
					});
				},
				dispose() {
					state.tui = null;
				},
			};
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		currentCtx = ctx;
		if (ctx.hasUI) applyFooterMode();
		await refreshUsage({ notify: true });

		if (state.timer) clearInterval(state.timer);
		state.timer = setInterval(() => {
			void refreshUsage({ notify: false });
		}, POLL_INTERVAL_MS);
	});

	pi.on("session_shutdown", () => {
		if (state.timer) {
			clearInterval(state.timer);
			state.timer = null;
		}
		state.tui = null;
		currentCtx = null;
	});

	pi.registerCommand("stepfun-usage", {
		description: "StepFun 用量: /stepfun-usage on [left|right] | off | detail | refresh",
		handler: async (args: string, ctx) => {
			currentCtx = ctx;
			const [sub, arg] = args.trim().toLowerCase().split(/\s+/, 2);
			switch (sub) {
				case "on": {
					if (arg && arg !== "left" && arg !== "right") {
						ctx.ui.notify("用法: /stepfun-usage on [left|right] | off | detail | refresh", "info");
						break;
					}
					// on 默认右对齐; on left / on right 指定对齐(已在开启状态时即切换)
					state.align = arg === "left" ? "left" : "right";
					state.enabled = true;
					applyFooterMode();
					state.tui?.requestRender();
					ctx.ui.notify(`用量显示已开启(${state.align === "left" ? "左对齐" : "右对齐"})`, "info");
					break;
				}
				case "off": {
					state.enabled = false;
					applyFooterMode();
					ctx.ui.notify("用量显示已关闭(已恢复内置 footer)", "info");
					break;
				}
				case "refresh":
					await refreshUsage({ notify: true });
					ctx.ui.notify("已刷新 StepFun 用量", "info");
					break;
				case "detail":
				case "info": {
					const s = state.snapshot;
					if (!s) {
						ctx.ui.notify(`暂无数据${state.error ? `: ${state.error}` : ""}`, "warning");
						break;
					}
					const lines: string[] = [];
					if (s.account) {
						lines.push(
							`余额: ${s.account.balance.toFixed(2)} 元 (充值 ${s.account.payment.toFixed(2)} / 赠送 ${s.account.voucher.toFixed(2)}, ${s.account.type})`,
						);
					} else {
						lines.push("余额: 获取失败");
					}
					if (s.plan) {
						const p = s.plan;
						lines.push(`套餐: ${p.planName ?? p.planFamily} (${p.planFamily}${p.allowed ? "" : ", 已限流"})`);
						if (p.subscriptionExpiresAtMs) {
							lines.push(`到期: ${new Date(p.subscriptionExpiresAtMs).toLocaleString("zh-CN")}`);
						}
						const credit = computeCreditView(p);
						if (credit.kind === "buckets") {
							lines.push(
								`Credit: 已用 ${credit.usedM?.toFixed(2) ?? "--"}M / 剩 ${credit.leftPercent?.toFixed(2) ?? "--"}% (总额 ${credit.totalM?.toFixed(2) ?? "--"}M)`,
							);
							for (const b of p.creditBuckets) {
								lines.push(
									`  ${b.type}${b.unsupported ? "(不支持)" : ""}: 总 ${(b.total / 1e6).toFixed(2)}M / 余 ${(b.remaining / 1e6).toFixed(2)}M`,
								);
							}
						} else if (credit.kind === "windows") {
							lines.push(
								`限额: 5小时剩 ${credit.fiveHourLeftPercent?.toFixed(2) ?? "--"}% · 周剩 ${credit.weeklyLeftPercent?.toFixed(2) ?? "--"}%`,
							);
						} else if (credit.kind === "none") {
							lines.push("Credit: 无个人套餐");
						}
					} else {
						lines.push("套餐: 获取失败");
					}
					lines.push("数据源: api.stepfun.com/v1/accounts + /step_plan/v1/usage (API Key)");
					ctx.ui.notify(lines.join("\n"), "info");
					break;
				}
				default:
					ctx.ui.notify("用法: /stepfun-usage on [left|right] | off | detail | refresh", "info");
			}
		},
	});
}

export type { UsageSnapshot };
