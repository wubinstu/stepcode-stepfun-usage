/**
 * StepFun 平台 Web 会话 Token 管理。
 *
 * 背景: platform.stepfun.com 的账户余额 / Credit 用量只能通过登录态访问
 * (Dashboard RPC, API key 会被拒: "api key not permitted for this method")。
 * 浏览器登录态由两个 cookie 组成:
 *   - Oasis-Webid  : 设备 ID(长期不变)
 *   - Oasis-Token  : "<accessJWT>...<refreshJWT>" —— access JWT 只有 30 分钟有效期
 *
 * 因此插件需要:
 *   1. 从用户导出的 cookie 文件中读取种子凭证;
 *   2. 在 access 过期前调用 PassportService/RefreshToken 自动续期(返回全新 pair,
 *      oasis_id 保持不变 —— 已验证);
 *   3. 把续期后的 pair 持久化到本地状态文件, 避免每次刷新都依赖种子。
 *
 * 注意: access 已过期时再刷新, 服务端会签发一个*新的匿名会话*(oasis_id 变化),
 * 那意味着登录态真的丢了, 需要用户重新导出 cookie。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const PLATFORM_BASE = "https://platform.stepfun.com";
export const ACCOUNT_BASE = "https://account.stepfun.com";
export const REFRESH_PATH = "/passport/proto.api.passport.v1.PassportService/RefreshToken";
export const OASIS_APP_ID = "10300";

/** access 剩余寿命低于该值时提前刷新(秒) */
const REFRESH_MARGIN_SECONDS = 240;

export type TokenErrorKind =
	| "no-cookie"
	| "expired"
	| "refresh-failed"
	| "network"
	| "session-mismatch";

export class TokenError extends Error {
	readonly kind: TokenErrorKind;
	constructor(message: string, kind: TokenErrorKind) {
		super(message);
		this.name = "TokenError";
		this.kind = kind;
	}
}

export interface SeedCredentials {
	webid: string;
	access: string;
	refresh: string;
	/** 除 Oasis-Token / Oasis-Webid 之外的 cookie(如 WAF cookie), 原样转发 */
	extras: Record<string, string>;
}

export interface AuthContext {
	webid: string;
	access: string;
	refresh: string;
	extras: Record<string, string>;
	/** 完整 Cookie 请求头 */
	cookieHeader: string;
}

interface PersistedState {
	webid: string;
	access: string;
	refresh: string;
	extras: Record<string, string>;
	oasisId: string | null;
	updatedAt: number;
}

/** 解析浏览器 cookie 文件, 同时兼容两种常见格式 */
export function parseCookieFile(text: string): Record<string, string> {
	const out: Record<string, string> = {};

	// 格式 1: Netscape cookies.txt(可能带 #HttpOnly_ 前缀)
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trimEnd();
		if (!line) continue;
		const bare = line.startsWith("#HttpOnly_") ? line.slice("#HttpOnly_".length) : line;
		if (bare.startsWith("#")) continue;
		const cols = bare.split("\t");
		if (cols.length >= 7 && !bare.startsWith(" ")) {
			const name = cols[5]?.trim();
			const value = cols.slice(6).join("\t").trim();
			if (name) out[name] = value;
		}
	}

	// 格式 2: "名称: xxx\n值: yyy" 块(部分浏览器导出插件的格式)
	const nameMatches = text.matchAll(/^名称[:：]\s*(.+)$/gm);
	const valueMatches = text.matchAll(/^值[:：]\s*(.+)$/gm);
	const names = [...nameMatches].map((m) => m[1].trim());
	const values = [...valueMatches].map((m) => m[1].trim());
	if (names.length > 0 && names.length === values.length) {
		names.forEach((name, i) => {
			out[name] = values[i]!;
		});
	}

	// 格式 3: "name=value; name2=value2" 一行式
	if (Object.keys(out).length === 0 && /[;=]/.test(text)) {
		for (const part of text.split(";")) {
			const idx = part.indexOf("=");
			if (idx <= 0) continue;
			out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
		}
	}

	return out;
}

function b64urlDecode(input: string): string {
	const padded = input + "=".repeat((4 - (input.length % 4)) % 4);
	return Buffer.from(padded, "base64url").toString("utf8");
}

/** 解码 JWT payload(不验签, 只取 exp/oasis_id 等声明) */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
	try {
		const parts = token.split(".");
		if (parts.length < 2) return null;
		return JSON.parse(b64urlDecode(parts[1]!)) as Record<string, unknown>;
	} catch {
		return null;
	}
}

export function jwtExp(token: string): number | null {
	const payload = decodeJwtPayload(token);
	const exp = payload?.exp;
	return typeof exp === "number" ? exp : null;
}

function buildCookieHeader(webid: string, access: string, refresh: string, extras: Record<string, string>): string {
	const parts = [`Oasis-Token=${access}...${refresh}`, `Oasis-Webid=${webid}`];
	for (const [name, value] of Object.entries(extras)) {
		if (name === "Oasis-Token" || name === "Oasis-Webid") continue;
		parts.push(`${name}=${value}`);
	}
	return parts.join("; ");
}

export class TokenManager {
	readonly cookieFilePath: string;
	private readonly stateDir: string;
	private readonly stateFilePath: string;
	private state: PersistedState | null = null;
	private seed: SeedCredentials | null = null;
	private seedOasisId: string | null = null;

	constructor(cookieFilePath: string, stateDir: string = join(homedir(), ".stepcode", "stepfun-usage")) {
		this.cookieFilePath = cookieFilePath;
		this.stateDir = stateDir;
		this.stateFilePath = join(stateDir, "state.json");
	}

	/** 读取并解析用户导出的 cookie 文件 */
	private loadSeed(): SeedCredentials {
		if (this.seed) return this.seed;
		if (!existsSync(this.cookieFilePath)) {
			throw new TokenError(`找不到 cookie 文件: ${this.cookieFilePath}`, "no-cookie");
		}
		const cookies = parseCookieFile(readFileSync(this.cookieFilePath, "utf8"));
		const webid = cookies["Oasis-Webid"];
		const token = cookies["Oasis-Token"];
		if (!webid || !token) {
			throw new TokenError(
				`cookie 文件中缺少 Oasis-Webid / Oasis-Token (${this.cookieFilePath}), 请从 platform.stepfun.com 重新导出`,
				"no-cookie",
			);
		}
		const [access, refresh] = token.split("...");
		if (!access || !refresh) {
			throw new TokenError("cookie 中 Oasis-Token 格式不正确(应为 <access>...<refresh>)", "no-cookie");
		}
		const extras: Record<string, string> = {};
		for (const [name, value] of Object.entries(cookies)) {
			if (name !== "Oasis-Token" && name !== "Oasis-Webid") extras[name] = value;
		}
		this.seed = { webid, access, refresh, extras };
		this.seedOasisId = (decodeJwtPayload(access)?.oasis_id as string | undefined) ?? null;
		return this.seed;
	}

	private loadPersisted(): PersistedState | null {
		if (this.state) return this.state;
		try {
			if (!existsSync(this.stateFilePath)) return null;
			const parsed = JSON.parse(readFileSync(this.stateFilePath, "utf8")) as PersistedState;
			if (parsed?.access && parsed?.refresh && parsed?.webid) {
				this.state = parsed;
				return parsed;
			}
		} catch {
			// 状态文件损坏则忽略, 回退到种子
		}
		return null;
	}

	private persist(s: PersistedState): void {
		this.state = s;
		try {
			mkdirSync(dirname(this.stateFilePath), { recursive: true });
			writeFileSync(this.stateFilePath, JSON.stringify(s, null, 2), { mode: 0o600 });
		} catch {
			// 持久化失败不致命, 内存里仍然可用
		}
	}

	/** 调用 PassportService/RefreshToken 续期; 返回新的 AuthContext */
	async refresh(force = false): Promise<AuthContext> {
		const seed = this.loadSeed();
		const persisted = this.loadPersisted();

		let webid = seed.webid;
		let access = seed.access;
		let refreshToken = seed.refresh;
		let extras = seed.extras;

		if (persisted && !force) {
			webid = persisted.webid;
			access = persisted.access;
			refreshToken = persisted.refresh;
			extras = persisted.extras ?? seed.extras;
		}

		const seedExp = jwtExp(seed.access);
		const curExp = jwtExp(access);
		const nowSec = Math.floor(Date.now() / 1000);
		// access 已过期时刷新会丢会话, 直接报错让用户重新导出
		const effectiveExp = Math.max(seedExp ?? 0, curExp ?? 0);
		if (effectiveExp < nowSec) {
			throw new TokenError(
				"登录态已过期(Oasis-Token 超过 30 分钟有效期且未能自动续期), 请重新从平台导出 cookie",
				"expired",
			);
		}

		const body = JSON.stringify({});
		let response: Response;
		try {
			response = await fetch(`${ACCOUNT_BASE}${REFRESH_PATH}`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "application/json",
					"Oasis-appID": OASIS_APP_ID,
					"Oasis-Platform": "web",
					Cookie: buildCookieHeader(webid, access, refreshToken, extras),
				},
				body,
				signal: AbortSignal.timeout(15000),
			});
		} catch (err) {
			throw new TokenError(`刷新 token 网络错误: ${(err as Error).message}`, "network");
		}

		const text = await response.text();
		let json: {
			accessToken?: { raw?: string; duration?: number };
			refreshToken?: { raw?: string };
			code?: string;
			message?: string;
		};
		try {
			json = JSON.parse(text);
		} catch {
			throw new TokenError(`刷新 token 响应解析失败: ${text.slice(0, 120)}`, "refresh-failed");
		}
		if (!json.accessToken?.raw || !json.refreshToken?.raw) {
			throw new TokenError(`刷新 token 失败: ${json.message ?? json.code ?? text.slice(0, 120)}`, "refresh-failed");
		}

		const newOasisId = (decodeJwtPayload(json.accessToken.raw)?.oasis_id as string | undefined) ?? null;
		if (this.seedOasisId && newOasisId && this.seedOasisId !== newOasisId) {
			throw new TokenError("刷新后账号发生变化, 请重新从平台导出 cookie", "session-mismatch");
		}

		this.persist({
			webid,
			access: json.accessToken.raw,
			refresh: json.refreshToken.raw,
			extras,
			oasisId: newOasisId,
			updatedAt: Date.now(),
		});
		return this.toAuthContext();
	}

	private toAuthContext(): AuthContext {
		const seed = this.seed!;
		const s = this.state!;
		const webid = s.webid ?? seed.webid;
		const access = s.access ?? seed.access;
		const refreshToken = s.refresh ?? seed.refresh;
		const extras = s.extras ?? seed.extras;
		return {
			webid,
			access,
			refresh: refreshToken,
			extras,
			cookieHeader: buildCookieHeader(webid, access, refreshToken, extras),
		};
	}

	/**
	 * 返回一个可用的登录态:
	 *  - 持久化/种子中的 access 仍有效 → 直接使用
	 *  - 即将过期 → 先刷新
	 */
	async ensure(): Promise<AuthContext> {
		const seed = this.loadSeed();
		const persisted = this.loadPersisted();
		const nowSec = Math.floor(Date.now() / 1000);

		const candidates = [persisted?.access, seed.access].filter((x): x is string => !!x);
		const bestExp = Math.max(...candidates.map((t) => jwtExp(t) ?? 0));
		if (bestExp - nowSec > REFRESH_MARGIN_SECONDS && persisted) {
			return this.toAuthContext();
		}
		if (bestExp - nowSec > REFRESH_MARGIN_SECONDS && !persisted) {
			// 种子还有效: 采纳种子并持久化
			this.persist({
				webid: seed.webid,
				access: seed.access,
				refresh: seed.refresh,
				extras: seed.extras,
				oasisId: this.seedOasisId,
				updatedAt: Date.now(),
			});
			return this.toAuthContext();
		}
		return this.refresh();
	}

	/** access 到期时间(秒级 epoch), 用于展示 */
	currentAccessExpiry(): number | null {
		const s = this.state;
		if (!s?.access) return null;
		return jwtExp(s.access);
	}
}

/** 候选 cookie 路径, 按优先级 */
export function resolveCookiePath(explicit: string | undefined, cwd: string): string[] {
	const paths: string[] = [];
	if (explicit) paths.push(explicit);
	const env = process.env.STEPFUN_USAGE_COOKIE_FILE;
	if (env) paths.push(env);
	paths.push(join(homedir(), ".stepcode", "stepfun-usage", "cookie"));
	paths.push(join(cwd, "cookie"));
	return paths;
}
