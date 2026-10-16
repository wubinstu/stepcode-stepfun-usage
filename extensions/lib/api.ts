/**
 * StepFun 账户用量数据获取 —— 全部走官方 API, Bearer API Key 鉴权, 无需 cookie。
 *
 * 1. 余额: GET https://api.stepfun.com/v1/accounts
 *    官方文档: platform.stepfun.com/docs/zh/api-reference/accounts/get
 *
 * 2. Credit 用量: GET https://api.stepfun.com/step_plan/v1/usage
 *    StepCode 官方 /usage 面板同源接口(见 stepfun-ai/Step-Code 仓库
 *    packages/coding-agent/src/step/usage/account.ts 的 PlanUsageController)。
 *    返回 schema_version=1 的 JSON: 套餐信息 + 5小时/周限额窗口 + credit 桶。
 *
 * API Key 解析顺序: $STEPFUN_API_KEY / $STEP_API_KEY → ~/.stepcode/auth.json
 * (stepcode 自身的登录凭证, oauth access), 通常无需任何配置。
 */

const ACCOUNTS_URL = "https://api.stepfun.com/v1/accounts";
const PLAN_USAGE_URL =
	process.env.STEPFUN_USAGE_PLAN_URL ?? "https://api.stepfun.com/step_plan/v1/usage";

export interface AccountInfo {
	/** 账户余额(元) */
	balance: number;
	/** 总充值金额(元) */
	payment: number;
	/** 总赠送金额(元) */
	voucher: number;
	/** 账户类型: prepaid / postpaid */
	type: string;
}

export interface CreditBucket {
	/** "subscription" | "topup" | 其他(unsupported) */
	type: string;
	unsupported: boolean;
	/** 总额度(原始 credit 数, 1e6 = 1M) */
	total: number;
	/** 剩余(原始 credit 数) */
	remaining: number;
	/** 官方 used_percent(0-100) */
	usedPercent: number | null;
	resetsAtMs: number | null;
	expiresAtMs: number | null;
}

export interface UsageWindow {
	id: "five_hour" | "weekly";
	limited: boolean;
	usedPercent: number | null;
	resetsAtMs: number | null;
}

export interface PlanUsageInfo {
	planState: "known" | "unavailable";
	/** coding = 旧版按次套餐; token = Credit 月池; none = 无套餐 */
	planFamily: "coding" | "token" | "none";
	planName: string | null;
	subscriptionExpiresAtMs: number | null;
	quotaState: "known" | "partial";
	allowed: boolean;
	reason: string | null;
	windows: UsageWindow[];
	creditBuckets: CreditBucket[];
	observedAtMs: number;
}

export interface UsageSnapshot {
	fetchedAt: number;
	/** 官方 /v1/accounts */
	account: AccountInfo | null;
	/** 官方 /step_plan/v1/usage */
	plan: PlanUsageInfo | null;
}

/** 统一取余额 */
export function resolveBalance(snapshot: UsageSnapshot): number | null {
	return snapshot.account ? snapshot.account.balance : null;
}

function num(v: unknown): number {
	if (v === null || v === undefined || v === "") return 0;
	const n = Number(v);
	return Number.isFinite(n) ? n : 0;
}

function numOrNull(v: unknown): number | null {
	if (v === null || v === undefined || v === "") return null;
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
}

function intOrNull(v: unknown): number | null {
	const n = numOrNull(v);
	return n !== null && Number.isSafeInteger(n) ? n : null;
}

/** 官方 API: 查询账户信息(余额) */
export async function fetchAccountInfo(apiKey: string): Promise<AccountInfo> {
	const res = await fetch(ACCOUNTS_URL, {
		headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
		signal: AbortSignal.timeout(15000),
	});
	const text = await res.text();
	if (!res.ok) throw new Error(`accounts API HTTP ${res.status}: ${text.slice(0, 100)}`);
	const json = JSON.parse(text) as Record<string, unknown>;
	if (json.error) throw new Error(`accounts API: ${JSON.stringify(json.error).slice(0, 120)}`);
	return {
		balance: num(json.balance),
		payment: num(json.total_cash_balance),
		voucher: num(json.total_voucher_balance),
		type: String(json.type ?? ""),
	};
}

/** 官方 /usage 接口: 查询套餐与 Credit 用量 */
export async function fetchPlanUsage(apiKey: string): Promise<PlanUsageInfo> {
	const res = await fetch(PLAN_USAGE_URL, {
		headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
		redirect: "error",
		signal: AbortSignal.timeout(15000),
	});
	const text = await res.text();
	if (res.status === 404) throw new PlanUsageUnavailableError("用量接口暂未开放(404)");
	if (res.status === 403) throw new Error("当前 API Key 无权查询个人套餐用量(403)");
	if (!res.ok) throw new Error(`usage API HTTP ${res.status}: ${text.slice(0, 100)}`);
	const json = JSON.parse(text) as Record<string, unknown>;
	if (json.schema_version !== 1 || json.scope !== "personal_account") {
		throw new Error("usage API 返回了无法识别的数据结构");
	}
	const plan = (json.plan ?? {}) as Record<string, unknown>;
	const quota = (json.quota ?? {}) as Record<string, unknown>;
	const windows: UsageWindow[] = (Array.isArray(quota.windows) ? quota.windows : []).flatMap((v) => {
		const w = v as Record<string, unknown>;
		const id = String(w.id ?? "");
		if (id !== "five_hour" && id !== "weekly") return [];
		return [{ id, limited: w.limited === true, usedPercent: numOrNull(w.used_percent), resetsAtMs: intOrNull(w.resets_at_ms) }];
	});
	const rawBuckets = Array.isArray(quota.credit_buckets) ? quota.credit_buckets : [];
	const creditBuckets: CreditBucket[] = rawBuckets.map((v) => {
		const b = v as Record<string, unknown>;
		const type = String(b.type ?? "");
		const supported = type === "subscription" || type === "topup";
		return {
			type,
			unsupported: !supported,
			total: num(b.total),
			remaining: num(b.remaining),
			usedPercent: numOrNull(b.used_percent),
			resetsAtMs: intOrNull(b.resets_at_ms),
			expiresAtMs: intOrNull(b.expires_at_ms),
		};
	});
	return {
		planState: plan.state === "unavailable" ? "unavailable" : "known",
		planFamily: plan.family === "coding" || plan.family === "none" ? plan.family : "token",
		planName: typeof plan.name === "string" ? plan.name : null,
		subscriptionExpiresAtMs: intOrNull((plan.subscription as Record<string, unknown> | null)?.expires_at_ms),
		quotaState: quota.state === "partial" ? "partial" : "known",
		allowed: quota.allowed === true,
		reason: typeof quota.reason === "string" ? quota.reason : null,
		windows,
		creditBuckets,
		observedAtMs: intOrNull(json.observed_at_ms) ?? Date.now(),
	};
}

export class PlanUsageUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PlanUsageUnavailableError";
	}
}

export type CreditViewKind = "buckets" | "windows" | "none" | "unknown";

export interface CreditView {
	kind: CreditViewKind;
	/** Credit 已用量(单位 M) */
	usedM: number | null;
	/** 剩余百分比(0-100) */
	leftPercent: number | null;
	/** 总量(单位 M) */
	totalM: number | null;
	fiveHourLeftPercent: number | null;
	weeklyLeftPercent: number | null;
}

/**
 * 汇总 Credit 用量视图:
 *  - token 套餐(月池): 聚合 subscription + topup 桶 → 已用 M / 剩余 %
 *  - coding 套餐: 5 小时 / 周限额窗口的剩余 %
 *  - 无套餐: kind = none
 */
export function computeCreditView(plan: PlanUsageInfo | null): CreditView {
	const empty: CreditView = {
		kind: "unknown",
		usedM: null,
		leftPercent: null,
		totalM: null,
		fiveHourLeftPercent: null,
		weeklyLeftPercent: null,
	};
	if (!plan || plan.planState !== "known") return plan ? { ...empty, kind: "none" } : empty;

	if (plan.planFamily === "token") {
		const buckets = plan.creditBuckets.filter((b) => !b.unsupported);
		let total = 0;
		let remaining = 0;
		let hasOfficialPercent = false;
		let weightedPercent = 0;
		for (const b of buckets) {
			total += b.total;
			remaining += b.remaining;
			if (b.usedPercent !== null) {
				hasOfficialPercent = true;
				weightedPercent += b.usedPercent * b.total;
			}
		}
		if (total > 0) {
			const usedPercent = hasOfficialPercent ? weightedPercent / total : ((total - remaining) / total) * 100;
			return {
				kind: "buckets",
				usedM: (total - remaining) / 1e6,
				leftPercent: 100 - usedPercent,
				totalM: total / 1e6,
				fiveHourLeftPercent: null,
				weeklyLeftPercent: null,
			};
		}
		// token 套餐但暂无 bucket 数据(如 quota.state=partial)
		return empty;
	}

	if (plan.planFamily === "coding") {
		const pct = (w: UsageWindow | undefined): number | null => {
			if (!w) return null;
			if (w.usedPercent !== null) return 100 - w.usedPercent;
			return w.limited ? null : 100;
		};
		const fiveHour = plan.windows.find((w) => w.id === "five_hour");
		const weekly = plan.windows.find((w) => w.id === "weekly");
		return {
			kind: "windows",
			usedM: null,
			leftPercent: pct(weekly) ?? pct(fiveHour),
			totalM: null,
			fiveHourLeftPercent: pct(fiveHour),
			weeklyLeftPercent: pct(weekly),
		};
	}

	return { ...empty, kind: "none" };
}
