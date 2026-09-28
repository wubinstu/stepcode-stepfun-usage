/**
 * 自定义 footer:复刻 step 内置 footer 的左侧信息(模式 · 模型 · 思考档位 · 目录),
 * 并把 StepFun 用量信息右对齐显示, 保留最右边的 "N% context left"。
 *
 * 内置 footer 的呈现逻辑(逆向自 step 二进制):
 *   左: ⏵ <模式> (shift+tab) · <模型> · <思考档位> · <cwd> · <其他扩展状态>
 *   右: <N% context left>  (按使用率上色)
 * 本渲染器保持一致, 仅把用量块插入到右侧区域(context left 之前)。
 */

import { truncateToWidth, visibleWidth } from "@step-harness/pi-tui";
import { computeCreditView, resolveBalance, type UsageSnapshot } from "./api.ts";

export type FooterDataLike = {
	getExtensionStatuses(): ReadonlyMap<string, string>;
};

export type ThemeLike = {
	fg(name: string, text: string): string;
};

export type ContextLike = {
	model?: { id?: string; reasoning?: boolean; provider?: string } | null;
	thinkingLevel?: string | null;
	cwd?: string;
	getContextUsage?: () => { percent?: number | null } | undefined | null;
};

export const STATUS_KEY = "stepfun-usage";

interface ModeInfo {
	label: string;
	paint: (text: string) => string;
}

function abbreviateThinkingLevel(level: string): string {
	switch (level) {
		case "medium":
			return "med";
		case "xhigh":
			return "xhi";
		default:
			return level;
	}
}

function formatCwd(cwd: string, home: string): string {
	if (!home) return cwd;
	const norm = (p: string) => (p.endsWith("/") ? p.slice(0, -1) : p);
	const h = norm(home);
	if (cwd === h) return "~";
	if (cwd.startsWith(`${h}/`)) return `~${cwd.slice(h.length)}`;
	return cwd;
}

/** 中间截断: a…b */
function truncateMiddle(value: string, maxWidth: number): string {
	if (maxWidth <= 0) return "";
	if (visibleWidth(value) <= maxWidth) return value;
	if (maxWidth === 1) return "…";
	const chars = [...value];
	const budget = maxWidth - 1;
	const head = Math.ceil(budget / 2);
	const tail = budget - head;
	return `${chars.slice(0, head).join("")}…${chars.slice(chars.length - tail).join("")}`;
}

function parseMode(footerData: FooterDataLike, theme: ThemeLike): ModeInfo {
	const raw = footerData.getExtensionStatuses().get("step-permission");
	const m = raw?.match(/^Mode:\s*(.+?)(?:\s*\(auto-resume\))?$/);
	const label = (m?.[1] ?? "Ask").trim();
	switch (label.toLowerCase()) {
		case "autopilot":
			return { label: "Autopilot", paint: (t) => theme.fg("warning", t) };
		case "bypass":
			return { label: "Bypass", paint: (t) => theme.fg("warning", t) };
		case "readonly":
		case "read-only":
			return { label: "Read-only", paint: (t) => theme.fg("muted", t) };
		default:
			return { label, paint: (t) => theme.fg("accent", t) };
	}
}

/** 与网页一致的 half-up 舍入到两位小数(避免浮点边界 0.185 → 0.18) */
function roundHalfUp2(n: number): number {
	return (Math.sign(n) * Math.floor(Math.abs(n) * 100 + 0.5)) / 100;
}

/**
 * 渲染用量块(右对齐区域的左半部分):
 *   余额 -0.04 · credit 用 0.50M 剩 99.00%
 */
export function renderUsageText(
	theme: ThemeLike,
	snapshot: UsageSnapshot | null,
	error: string | null,
): string {
	if (error || !snapshot) {
		return theme.fg("dim", error ? "余额 -- · credit --" : "余额 … · credit …");
	}
	const balance = resolveBalance(snapshot);
	const balanceSeg =
		balance === null
			? theme.fg("dim", "余额 …")
			: balance.balance < 0
				? theme.fg("error", `余额 ${balance.balance.toFixed(2)}`)
				: theme.fg("success", `余额 ${balance.balance.toFixed(2)}`);

	const credit = computeCreditView(snapshot.rateLimit);
	let creditSeg: string;
	if (credit.leftPercent === null && credit.usedM === null) {
		creditSeg = theme.fg("dim", "credit --");
	} else {
		const parts: string[] = [];
		if (credit.usedM !== null) parts.push(`用 ${roundHalfUp2(credit.usedM).toFixed(2)}M`);
		if (credit.leftPercent !== null) parts.push(`剩 ${credit.leftPercent.toFixed(2)}%`);
		const pct = credit.leftPercent;
		const paint =
			pct === null
				? (t: string) => theme.fg("dim", t)
				: pct >= 50
					? (t: string) => theme.fg("success", t)
					: pct >= 10
						? (t: string) => theme.fg("warning", t)
						: (t: string) => theme.fg("error", t);
		creditSeg = paint(`credit ${parts.join(" ")}`);
	}
	return `${balanceSeg} ${theme.fg("dim", "·")} ${creditSeg}`;
}

export interface FooterRenderInput {
	width: number;
	theme: ThemeLike;
	ctx: ContextLike;
	footerData: FooterDataLike;
	snapshot: UsageSnapshot | null;
	error: string | null;
}

/** 渲染完整 footer(返回若干行, 与内置 footer 行数一致: 1 行) */
export function renderFooterLines(input: FooterRenderInput): string[] {
	const { width, theme, ctx, footerData, snapshot, error } = input;
	const safeWidth = Math.max(1, Math.floor(width));
	const muted = (t: string) => theme.fg("dim", t);

	// ---- 左侧段 ----
	const mode = parseMode(footerData, theme);
	const segments: string[] = [mode.paint(`⏵ ${mode.label}${safeWidth >= 60 ? " (shift+tab)" : ""}`)];

	const model = ctx.model?.id;
	if (safeWidth >= 60 && model) {
		segments.push(muted(model));
		const level = ctx.thinkingLevel ?? "off";
		if (ctx.model?.reasoning && level !== "off") {
			segments.push(muted(abbreviateThinkingLevel(level)));
		}
	}

	if (safeWidth >= 80 && ctx.cwd) {
		const home = process.env.HOME || process.env.USERPROFILE || "";
		const cwd = formatCwd(ctx.cwd, home);
		if (cwd.length > 0) {
			const display = safeWidth >= 100 ? truncateMiddle(cwd, Math.max(12, Math.floor(safeWidth / 3))) : cwd;
			segments.push(muted(display));
		}
	}

	if (safeWidth >= 100) {
		const statuses = [...footerData.getExtensionStatuses().entries()]
			.filter(([key, text]) => key !== "step-permission" && key !== STATUS_KEY && text.trim().length > 0)
			.sort(([a], [b]) => a.localeCompare(b));
		for (const [, text] of statuses) {
			segments.push(muted(text.replace(/[\r\n\t]+/gu, " ").replace(/ +/gu, " ").trim()));
		}
	}

	const left = segments.join(muted(" · "));

	// ---- 右侧块: 用量 + context left(空间不足时按优先级降级) ----
	const usageFull = renderUsageText(theme, snapshot, error);
	const credit = snapshot && !error ? computeCreditView(snapshot.rateLimit) : null;
	const balanceInfo = snapshot && !error ? resolveBalance(snapshot) : null;

	const paintBalance = (b: number): string =>
		b < 0 ? theme.fg("error", `余额 ${b.toFixed(2)}`) : theme.fg("success", `余额 ${b.toFixed(2)}`);
	const paintPct = (pct: number): string =>
		pct >= 50 ? theme.fg("success", `${pct.toFixed(2)}%`) : pct >= 10 ? theme.fg("warning", `${pct.toFixed(2)}%`) : theme.fg("error", `${pct.toFixed(2)}%`);

	const usageCompact =
		balanceInfo === null
			? usageFull
			: credit?.leftPercent !== null && credit?.leftPercent !== undefined
				? `${paintBalance(balanceInfo.balance)} ${theme.fg("dim", "·")} credit ${paintPct(credit.leftPercent)}`
				: paintBalance(balanceInfo.balance);
	const usageMinimal = balanceInfo === null ? usageFull : paintBalance(balanceInfo.balance);

	const ctxLeftRaw = (() => {
		const usage = ctx.getContextUsage?.();
		if (!usage || typeof usage.percent !== "number") return null;
		const usedPercent = Math.max(0, Math.min(100, usage.percent));
		const text = `${Math.round(100 - usedPercent)}% context left`;
		return usedPercent > 90 ? theme.fg("error", text) : usedPercent > 70 ? theme.fg("warning", text) : muted(text);
	})();

	/** 从信息最完整到最精简的右侧候选(空串 = 完全让位给 context left) */
	const usageCandidates = [usageFull, usageCompact, usageMinimal, ""];

	const leftWidth = visibleWidth(left);
	const minPadding = 2;
	const join = (parts: (string | null)[]): string => parts.filter((p): p is string => !!p).join(muted(" · "));

	let line: string | null = null;
	outer: for (const usage of usageCandidates) {
		for (const withCtx of [true, false]) {
			const right = join([usage, withCtx ? ctxLeftRaw : null]);
			if (leftWidth + minPadding + visibleWidth(right) <= safeWidth) {
				const padding = " ".repeat(Math.max(minPadding, safeWidth - leftWidth - visibleWidth(right)));
				line = left + padding + right;
				break outer;
			}
		}
	}
	if (line === null) {
		// 仍然放不下: 与内置 footer 一致, 优先截断右侧, 再截断左侧
		const availableForRight = safeWidth - leftWidth - minPadding;
		const right = usageCandidates
			.map((usage) => join([usage, ctxLeftRaw]))
			.filter((r) => r.length > 0)
			.sort((a, b) => visibleWidth(b) - visibleWidth(a))
			.find((r) => visibleWidth(r) <= availableForRight);
		if (right) {
			const padding = " ".repeat(Math.max(0, safeWidth - leftWidth - visibleWidth(right)));
			line = left + padding + right;
		} else {
			line = truncateToWidth(left, safeWidth, "");
		}
	}
	return [truncateToWidth(line, safeWidth, "")];
}
