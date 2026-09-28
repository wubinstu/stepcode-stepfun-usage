/**
 * stepfun-usage —— StepCode 插件
 *
 * 在输入框下方的信息行(footer)右对齐显示 StepFun 账户用量:
 *   余额 -0.04 · credit 用 0.50M 剩 99.00%        100% context left
 *
 * 数据源(两个都不依赖网页端登录会话的话优先生成稳定通道):
 *
 *   余额  → 官方 API: GET https://api.stepfun.com/v1/accounts
 *            API Key 按以下顺序解析:
 *              1. $STEPFUN_API_KEY / $STEP_API_KEY 环境变量
 *              2. ~/.stepcode/auth.json 中 stepcode 自己的登录凭证(oauth access)
 *            该通道稳定, 无需任何维护。
 *
 *   credit → platform.stepfun.com 网页端内部 RPC(官方 API 未提供):
 *            需要浏览器导出一次 cookie(登录态)。插件的 tokens.ts 会在
 *            access token 30 分钟到期前自动调用官方 RefreshToken 接口续期,
 *            续期后的 token 对持久化在本地; refresh token 有效期约 30 天,
 *            即: 导出一次 cookie 后, 只要 30 天内至少打开过一次 stepcode 即可。
 *
 *   cookie 文件位置(按优先级):
 *      1. $STEPFUN_USAGE_COOKIE_FILE 环境变量
 *      2. ~/.stepcode/stepfun-usage/cookie
 *      3. 本插件包根目录下的 cookie
 *      4. 当前工作目录下的 cookie
 *
 * 显示策略: 余额与 credit 各自独立降级——没有 API Key 时用网页端余额兜底,
 * 没有 cookie 时 credit 显示 "--" 不影响余额显示。
 */

import type { ExtensionAPI, ExtensionContext } from "@step-harness/coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	computeCreditView,
	fetchAccountInfo,
	fetchWebUsage,
	resolveBalance,
	type UsageSnapshot,
} from "./lib/api.ts";
import { renderFooterLines, renderUsageText, STATUS_KEY } from "./lib/footer.ts";
import { TokenManager } from "./lib/tokens.ts";

const POLL_INTERVAL_MS = 30_000;

type FooterMode = "footer" | "status";

interface RuntimeState {
	snapshot: UsageSnapshot | null;
	error: string | null;
	lastNotifiedError: string | null;
	mode: FooterMode;
	inFlight: boolean;
	timer: ReturnType<typeof setInterval> | null;
	tui: { requestRender(): void } | null;
}

/** 跨会话共享的模块级状态(session 切换时保留快照, 避免重复请求) */
const state: RuntimeState = {
	snapshot: null,
	error: null,
	lastNotifiedError: null,
	mode: "footer",
	inFlight: false,
	timer: null,
	tui: null,
};

function pickCookiePath(cwd: string): string {
	const here = dirname(fileURLToPath(import.meta.url)); // <pkg>/extensions
	const pkgRoot = dirname(here); // <pkg>
	const candidates: string[] = [];
	if (process.env.STEPFUN_USAGE_COOKIE_FILE) candidates.push(process.env.STEPFUN_USAGE_COOKIE_FILE);
	candidates.push(join(homedir(), ".stepcode", "stepfun-usage", "cookie"));
	candidates.push(join(pkgRoot, "cookie"));
	candidates.push(join(cwd, "cookie"));
	for (const p of candidates) {
		if (existsSync(p)) return p;
	}
	return candidates[0]!;
}

/**
 * 解析 API Key(用于官方 /v1/accounts 余额接口)。
 * 优先环境变量, 其次 stepcode 自己的登录态 ~/.stepcode/auth.json。
 */
function resolveApiKey(): string | null {
	const env = process.env.STEPFUN_API_KEY || process.env.STEP_API_KEY;
	if (env) return env.trim();
	try {
		const authPath = join(homedir(), ".stepcode", "auth.json");
		if (!existsSync(authPath)) return null;
		const data = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, unknown>;
		for (const entry of Object.values(data)) {
			const rec = entry as { type?: string; access?: unknown } | null;
			if (rec && typeof rec.access === "string" && rec.access.length > 0) {
				return rec.access.trim();
			}
		}
	} catch {
		// 忽略解析失败
	}
	return null;
}

function describeError(err: unknown): string {
	const kind = (err as { kind?: string } | null)?.kind;
	switch (kind) {
		case "no-cookie":
			return "未找到 cookie 文件或其中缺少 Oasis-Webid/Oasis-Token, 请从 platform.stepfun.com 重新导出 cookie";
		case "expired":
			return "登录态已过期(Oasis-Token 超过 30 分钟未续期), 请重新导出 cookie";
		case "session-mismatch":
			return "刷新后账号发生变化, 请重新导出 cookie";
		default:
			return (err as Error)?.message ?? String(err);
	}
}

export default function stepfunUsage(pi: ExtensionAPI) {
	let tokens: TokenManager | null = null;
	let cookiePath = pickCookiePath(process.cwd());
	/** 当前会话的 ctx(session 切换时会更新), footer 渲染时使用 */
	let currentCtx: ExtensionContext | null = null;

	async function refreshUsage(opts: { notify?: boolean } = {}): Promise<void> {
		if (state.inFlight) return;
		state.inFlight = true;
		try {
			// 通道 1: 官方 API(余额, 稳定)
			let account = null as Awaited<ReturnType<typeof fetchAccountInfo>> | null;
			let accountError: string | null = null;
			const apiKey = resolveApiKey();
			if (apiKey) {
				try {
					account = await fetchAccountInfo(apiKey);
				} catch (err) {
					accountError = describeError(err);
				}
			}

			// 通道 2: 网页端会话(credit; 余额兜底)
			let webBalance = null as UsageSnapshot["webBalance"];
			let rateLimit: UsageSnapshot["rateLimit"] = null;
			let webError: string | null = null;
			try {
				if (!tokens) tokens = new TokenManager(cookiePath);
				const auth = await tokens.ensure();
				const web = await fetchWebUsage(tokens, auth);
				webBalance = web.webBalance;
				rateLimit = web.rateLimit;
			} catch (err) {
				webError = describeError(err);
			}

			state.snapshot = { fetchedAt: Date.now(), account, webBalance, rateLimit };

			// 两个通道都失败才算整体失败
			if (!account && !webBalance) {
				state.error = accountError ?? webError ?? "无法获取用量";
			} else {
				state.error = null;
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
		if (state.mode === "footer") {
			state.tui?.requestRender();
		} else if (currentCtx?.hasUI) {
			currentCtx.ui.setStatus(STATUS_KEY, renderUsageText(currentCtx.ui.theme, state.snapshot, state.error));
		}
	}

	function applyFooterMode(): void {
		const ctx = currentCtx;
		if (!ctx?.hasUI) return;
		if (state.mode === "footer") {
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
						});
					},
					dispose() {
						state.tui = null;
					},
				};
			});
		} else {
			state.tui = null;
			ctx.ui.setFooter(undefined);
			ctx.ui.setStatus(STATUS_KEY, renderUsageText(ctx.ui.theme, state.snapshot, state.error));
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		currentCtx = ctx;
		cookiePath = pickCookiePath(ctx.cwd ?? process.cwd());
		tokens = new TokenManager(cookiePath);

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
		description: "StepFun 用量: /stepfun-usage [refresh|footer|status|toggle|detail]",
		handler: async (args: string, ctx) => {
			currentCtx = ctx;
			if (!tokens) tokens = new TokenManager(cookiePath);
			const cmd = args.trim().toLowerCase();
			switch (cmd) {
				case "":
				case "toggle":
				case "mode": {
					state.mode = state.mode === "footer" ? "status" : "footer";
					applyFooterMode();
					ctx.ui.notify(
						state.mode === "footer" ? "已切换: 右对齐自定义 footer" : "已切换: 内置 footer + 状态行",
						"info",
					);
					break;
				}
				case "footer":
					state.mode = "footer";
					applyFooterMode();
					ctx.ui.notify("已切换: 右对齐自定义 footer", "info");
					break;
				case "status":
					state.mode = "status";
					applyFooterMode();
					ctx.ui.notify("已切换: 内置 footer + 状态行", "info");
					break;
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
					const bal = resolveBalance(s);
					const credit = computeCreditView(s.rateLimit);
					ctx.ui.notify(
						[
							`余额: ${bal ? bal.balance.toFixed(2) : "--"} 元 (充值 ${bal?.payment.toFixed(2) ?? "--"} / 赠送 ${bal?.voucher.toFixed(2) ?? "--"})`,
							`Credit: 已用 ${credit.usedM?.toFixed(2) ?? "--"}M / 剩 ${credit.leftPercent?.toFixed(2) ?? "--"}%`,
							s.webBalance
								? `昨日 ${s.webBalance.costYesterday.toFixed(2)} · 本月 ${s.webBalance.costMonth.toFixed(2)} · 累计 ${s.webBalance.costTotal.toFixed(2)} 元`
								: "消耗明细(需 cookie 登录态)",
							`数据源: 余额[${s.account ? "官方 API" : s.webBalance ? "网页端" : "无"}] · credit[${s.rateLimit ? "网页端" : "无"}] · cookie 文件: ${cookiePath}`,
						].join("\n"),
						"info",
					);
					break;
				}
				default:
					ctx.ui.notify(
						"用法: /stepfun-usage [refresh|footer|status|toggle|detail]",
						"info",
					);
			}
		},
	});
}

export type { UsageSnapshot };
