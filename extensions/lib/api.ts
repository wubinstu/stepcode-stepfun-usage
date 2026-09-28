/**
 * StepFun 账户用量数据获取。
 *
 * 两个数据源:
 *
 * 1. 官方 API(稳定, 推荐):
 *      GET https://api.stepfun.com/v1/accounts   (API Key 鉴权)
 *    返回账户余额 / 总充值 / 总赠送。API Key 直接复用 stepcode 自己的登录态
 *    (~/.stepcode/auth.json 中的 oauth access), 或环境变量。
 *
 * 2. 网页端内部接口(需要浏览器登录态, 用于 Credit 用量):
 *      POST https://platform.stepfun.com/api/step.openapi.devcenter.Dashboard/QueryAccountBalance
 *      POST https://platform.stepfun.com/api/step.openapi.devcenter.Dashboard/QueryStepPlanRateLimit
 *    官方 API 不提供 Credit 额度查询(试遍 api.stepfun.com 所有路径)。
 *    登录态(Oasis-Token)30 分钟过期, 插件会在过期前自动续期(见 tokens.ts)。
 */

import { OASIS_APP_ID, PLATFORM_BASE, type AuthContext, type TokenManager } from "./tokens.ts";

const DASHBOARD_SERVICE = "step.openapi.devcenter.Dashboard";
const OFFICIAL_ACCOUNTS_URL = "https://api.stepfun.com/v1/accounts";

export interface AccountInfo {
	/** 账户余额(元) */
	balance: number;
	/** 总充值金额(元) */
	payment: number;
	/** 总赠送金额(元) */
	voucher: number;
	/** 账户类型: preped / postpaid */
	type: string;
}

export interface WebBalanceInfo {
	balance: number;
	payment: number;
	voucher: number;
	credit: number;
	costYesterday: number;
	costMonth: number;
	costTotal: number;
	voucherExpireTime: number | null;
	notifyThreshold: number | null;
}

export interface CreditBucket {
	/** "SUBSCRIPTION" | "TOPUP" | "UNSPECIFIED" ... */
	type: string;
	total: number;
	residual: number;
	expireAt: number | null;
	nextResetAt: number | null;
}

export interface RateLimitInfo {
	subscriptionLeftRate: number | null;
	topupLeftRate: number | null;
	fiveHourLeftRate: number | null;
	weeklyLeftRate: number | null;
	buckets: CreditBucket[];
}

export interface UsageSnapshot {
	fetchedAt: number;
	/** 官方 API 返回的账户信息(优先展示) */
	account: AccountInfo | null;
	/** 网页端余额(官方 API 不可用时的回退, 字段更全) */
	webBalance: WebBalanceInfo | null;
	/** Credit 限额与用量 */
	rateLimit: RateLimitInfo | null;
}

/** 统一取余额: 优先官方 API, 回退网页端 */
export function resolveBalance(snapshot: UsageSnapshot): { balance: number; payment: number; voucher: number } | null {
	if (snapshot.account) {
		return { balance: snapshot.account.balance, payment: snapshot.account.payment, voucher: snapshot.account.voucher };
	}
	if (snapshot.webBalance) {
		return {
			balance: snapshot.webBalance.balance,
			payment: snapshot.webBalance.payment,
			voucher: snapshot.webBalance.voucher,
		};
	}
	return null;
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

/** 官方 API: 查询账户信息(余额) */
export async function fetchAccountInfo(apiKey: string): Promise<AccountInfo> {
	const res = await fetch(OFFICIAL_ACCOUNTS_URL, {
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

async function rpcCall<T = Record<string, unknown>>(
	method: string,
	body: Record<string, unknown>,
	auth: AuthContext,
	onUnauthenticated: () => Promise<AuthContext>,
): Promise<T> {
	const call = async (a: AuthContext): Promise<T> => {
		const res = await fetch(`${PLATFORM_BASE}/api/${DASHBOARD_SERVICE}/${method}`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json",
				"Oasis-appID": OASIS_APP_ID,
				"Oasis-Platform": "web",
				"Oasis-Webid": a.webid,
				Cookie: a.cookieHeader,
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(15000),
		});
		const text = await res.text();
		let json: Record<string, unknown>;
		try {
			json = JSON.parse(text) as Record<string, unknown>;
		} catch {
			throw new Error(`HTTP ${res.status}: ${text.slice(0, 120)}`);
		}
		if (json.code === "unauthenticated" || res.status === 401) {
			const err = new Error(`unauthenticated: ${String(json.message ?? "")}`) as Error & {
				unauthenticated?: boolean;
			};
			err.unauthenticated = true;
			throw err;
		}
		if (json.code) {
			throw new Error(`${String(json.code)}: ${String(json.message ?? "")}`);
		}
		return json as T;
	};

	try {
		return await call(auth);
	} catch (err) {
		if ((err as { unauthenticated?: boolean }).unauthenticated) {
			// token 可能在请求间隙过期, 刷新一次再重试
			const fresh = await onUnauthenticated();
			return await call(fresh);
		}
		throw err;
	}
}

function parseWebBalance(json: Record<string, unknown>): WebBalanceInfo {
	// 页面源码: 余额显示 = 原值 / 100(原值单位为分)
	// 注意: Connect RPC 返回的 JSON 使用 snake_case 字段名
	return {
		balance: num(json.balance) / 100,
		payment: num(json.payment) / 100,
		voucher: num(json.voucher) / 100,
		credit: num(json.credit) / 100,
		costYesterday: num(json.cost_yesterday) / 100,
		costMonth: num(json.cost_month) / 100,
		costTotal: num(json.cost_total) / 100,
		voucherExpireTime: numOrNull(json.voucher_expire_time),
		notifyThreshold: numOrNull(json.notify_threshold),
	};
}

/** Connect JSON 的 enum 可能是数字也可能是字符串名, 统一成字符串 */
const BUCKET_TYPE_NAMES: Record<number, string> = { 0: "UNSPECIFIED", 1: "SUBSCRIPTION", 2: "TOPUP" };
function normalizeBucketType(v: unknown): string {
	if (typeof v === "number" && v in BUCKET_TYPE_NAMES) return BUCKET_TYPE_NAMES[v]!;
	if (typeof v === "string") return v.toUpperCase();
	return "UNSPECIFIED";
}

function parseRateLimit(json: Record<string, unknown>): RateLimitInfo {
	const pclr = (json.plan_credit_rate_limit ?? {}) as Record<string, unknown>;
	const rawBuckets = Array.isArray(pclr.credit_buckets) ? (pclr.credit_buckets as Record<string, unknown>[]) : [];
	const buckets: CreditBucket[] = rawBuckets.map((b) => ({
		type: normalizeBucketType(b.type),
		total: num(b.credit_total),
		residual: num(b.credit_residual),
		expireAt: numOrNull(b.expire_at),
		nextResetAt: numOrNull(b.next_reset_at),
	}));
	return {
		subscriptionLeftRate: numOrNull(pclr.subscription_credit_left_rate),
		topupLeftRate: numOrNull(pclr.topup_credit_left_rate),
		fiveHourLeftRate: numOrNull(json.five_hour_usage_left_rate),
		weeklyUsageLeftRate: numOrNull(json.weekly_usage_left_rate),
		buckets,
	};
}

/** 拉取网页端的余额与 Credit 限额信息(需要登录态) */
export async function fetchWebUsage(tokens: TokenManager, auth: AuthContext): Promise<{
	webBalance: WebBalanceInfo;
	rateLimit: RateLimitInfo | null;
}> {
	const refreshAuth = () => tokens.refresh(true);
	const [balanceJson, rateJson] = await Promise.all([
		rpcCall("QueryAccountBalance", {}, auth, refreshAuth),
		rpcCall("QueryStepPlanRateLimit", {}, auth, refreshAuth),
	]);
	return { webBalance: parseWebBalance(balanceJson), rateLimit: parseRateLimit(rateJson) };
}

export interface CreditView {
	/** Credit 已用量(单位 M) */
	usedM: number | null;
	/** 剩余百分比(0-100) */
	leftPercent: number | null;
	/** 总量(单位 M) */
	totalM: number | null;
}

/**
 * 汇总 credit 用量。统计 SUBSCRIPTION + TOPUP 两种 bucket:
 *   used = Σ(total - residual);  left% = Σresidual / Σtotal
 * 没有 bucket 时回退到 subscriptionCreditLeftRate(仅百分比)。
 */
export function computeCreditView(rateLimit: RateLimitInfo | null): CreditView {
	if (!rateLimit) return { usedM: null, leftPercent: null, totalM: null };
	const buckets = rateLimit.buckets.filter((b) => b.type === "SUBSCRIPTION" || b.type === "TOPUP");
	let total = 0;
	let residual = 0;
	for (const b of buckets) {
		total += b.total;
		residual += b.residual;
	}
	if (total > 0) {
		return {
			usedM: (total - residual) / 1e6,
			leftPercent: (residual / total) * 100,
			totalM: total / 1e6,
		};
	}
	const rate = rateLimit.subscriptionLeftRate;
	if (rate !== null && rate !== undefined) {
		return { usedM: null, leftPercent: rate * 100, totalM: null };
	}
	return { usedM: null, leftPercent: null, totalM: null };
}
