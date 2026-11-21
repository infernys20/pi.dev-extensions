import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

const ID = "chatgpt-quota";
const USAGE_PAGE = "https://chatgpt.com/settings/usage";
// Experimental read-only endpoints. The direct openai OAuth token is never sent here.
const BACKEND = "https://chatgpt.com/backend-api/wham/usage";
const POLL_MS = 3 * 60_000;
const WINDOWS = [[18_000, "5h"], [604_800, "Week"]] as const;
type Window = { remaining: number; resetAt?: number };
type Quota = Map<number, Window>;
class QuotaError extends Error {}

const object = (value: unknown): Record<string, unknown> | undefined =>
	value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const origin = (url?: string) => url ? new URL(url).origin : undefined;
const isPercent = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 100;

function bearer(auth: { apiKey?: string; headers?: Record<string, string | null | undefined> }) {
	const overrides = Object.entries(auth.headers ?? {}).filter(([key]) => key.toLowerCase() === "authorization");
	if (overrides.length === 0) return auth.apiKey;
	if (overrides.length === 1) return /^Bearer\s+(\S+)$/i.exec(overrides[0][1] ?? "")?.[1];
}

function matchesRegistration(payload: unknown, clientId: string) {
	const body = object(payload);
	if (!body || !Array.isArray(body.items) || body.items.length > 128 ||
		Object.keys(body).some(key => !["items", "has_more", "next_cursor"].includes(key)) ||
		(body.has_more !== undefined && body.has_more !== false) ||
		(body.next_cursor !== undefined && body.next_cursor !== null && body.next_cursor !== "")) return false;
	const ids = body.items.map(item => object(item)?.id);
	return ids.every(id => typeof id === "string" && id.trim()) && ids.filter(id => id === clientId).length === 1;
}

function parseQuota(payload: unknown): Quota {
	const quota: Quota = new Map();
	const limits = object(object(payload)?.rate_limit);
	for (const key of ["primary_window", "secondary_window"]) {
		const slot = object(limits?.[key]);
		const seconds = slot?.limit_window_seconds;
		if (typeof seconds !== "number" || !WINDOWS.some(([duration]) => duration === seconds)) continue;
		const used = slot?.used_percent;
		if (quota.has(seconds) || !isPercent(used)) throw new QuotaError("OpenAI returned invalid plan limits.");
		const remaining = slot?.remaining_percent;
		if (remaining !== undefined && (!isPercent(remaining) || Math.abs(used + remaining - 100) > 1)) {
			throw new QuotaError("OpenAI returned inconsistent plan limits.");
		}
		const reset = slot?.reset_at;
		quota.set(seconds, {
			remaining: isPercent(remaining) ? remaining : 100 - used,
			resetAt: typeof reset === "number" && Number.isSafeInteger(reset) && reset > 0 && reset <= 8.64e12 ? reset * 1000 : undefined,
		});
	}
	if (!quota.size) throw new QuotaError("OpenAI did not report a 5-hour or weekly plan window.");
	return quota;
}

function describe(window: Window | undefined, now: number): string {
	if (!window) return "n/a";
	if (window.resetAt !== undefined && window.resetAt <= now) return "awaiting refresh";
	const remaining = `${Number(window.remaining.toFixed(1))}% left`;
	if (window.resetAt === undefined) return `${remaining} (reset n/a)`;
	const minutes = Math.ceil((window.resetAt - now) / 60_000);
	const days = Math.floor(minutes / 1440), hours = Math.floor(minutes / 60) % 24, mins = minutes % 60;
	return `${remaining} (↻ ${days ? `${days}d ${hours}h` : hours ? `${hours}h ${mins}m` : `${mins}m`})`;
}

async function credentials() {
	try {
		return object(JSON.parse(await readFile(join(getAgentDir(), "auth.json"), "utf8")));
	} catch {
		return undefined;
	}
}

async function fetchQuota(ctx: ExtensionContext, signal: AbortSignal): Promise<Quota> {
	const model = ctx.model;
	if (!model || model.provider !== "openai" || origin(model.baseUrl) !== "https://api.openai.com") {
		throw new QuotaError("Select a direct OpenAI model using ChatGPT sign-in.");
	}
	const registry = ctx.modelRegistry;
	const saved = await credentials();
	if (object(saved?.openai)?.type !== "oauth") throw new QuotaError("Use /login openai with ChatGPT sign-in, not an API key.");
	if (object(saved?.["openai-codex"])?.type !== "oauth") {
		throw new QuotaError("Run /login openai-codex with the same ChatGPT account and workspace. Keep your current model.");
	}
	if (origin(registry.getProvider("openai-codex")?.baseUrl) !== "https://chatgpt.com") {
		throw new QuotaError("The companion login must use the official ChatGPT endpoint.");
	}
	const native = await registry.getProviderAuth("openai");
	const effective = await registry.getApiKeyAndHeaders(model);
	const companion = await registry.getProviderAuth("openai-codex");
	const latest = await credentials(); // Re-read after Pi's OAuth resolver may have refreshed tokens.
	const nativeSaved = object(latest?.openai), codexSaved = object(latest?.["openai-codex"]);
	const nativeToken = native?.source === "OAuth" ? bearer(native.auth) : undefined;
	const codeToken = companion?.source === "OAuth" ? bearer(companion.auth) : undefined;
	const clientId = nativeSaved?.clientId, accountId = codexSaved?.accountId;
	if (!nativeToken || !effective.ok || bearer(effective) !== nativeToken ||
		(effective.baseUrl && origin(effective.baseUrl) !== "https://api.openai.com") ||
		nativeSaved?.access !== nativeToken || typeof clientId !== "string" || !clientId ||
		!Array.isArray(nativeSaved.scopes) || !nativeSaved.scopes.includes("chatgpt.tokens.use.direct")) {
		throw new QuotaError("The current model is not using the saved direct ChatGPT login.");
	}
	if (!codeToken || codeToken === nativeToken || codexSaved?.type !== "oauth" || codexSaved.access !== codeToken ||
		typeof accountId !== "string" || !/^[\x21-\x7e]{1,512}$/.test(accountId) ||
		(companion?.auth.baseUrl && origin(companion.auth.baseUrl) !== "https://chatgpt.com")) {
		throw new QuotaError("Could not verify the companion Codex login.");
	}
	const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
	async function read(suffix: "" | "/chatpass/apps"): Promise<unknown> {
		requestSignal.throwIfAborted();
		const response = await fetch(`${BACKEND}${suffix}`, {
			headers: { Authorization: `Bearer ${codeToken}`, "ChatGPT-Account-Id": accountId as string, Accept: "application/json" },
			redirect: "error", signal: requestSignal,
		});
		if (!response.ok) {
			await response.body?.cancel();
			throw new QuotaError(`OpenAI usage server returned HTTP ${response.status}.`);
		}
		const reader = response.body?.getReader();
		if (!reader) throw new QuotaError("OpenAI returned an empty usage response.");
		let bytes = 0;
		const chunks: Uint8Array[] = [];
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				bytes += value.byteLength;
				if (bytes > 256 * 1024) throw new QuotaError("OpenAI returned an oversized usage response.");
				chunks.push(value);
			}
		} finally {
			await reader.cancel().catch(() => {});
			reader.releaseLock();
		}
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	}
	if (!matchesRegistration(await read("/chatpass/apps"), clientId)) {
		throw new QuotaError("Could not match this Pi login to the companion account. Check that both logins use the same account and workspace.");
	}
	return parseQuota(await read(""));
}

export default function (pi: ExtensionAPI) {
	let ctx: ExtensionContext | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let pending: { controller: AbortController; done: Promise<void> } | undefined;
	let quota: Quota | undefined;
	let problem = "";
	let nextPoll = 0;
	const text = () => {
		if (!quota) return `ChatGPT quota: ${pending ? "checking…" : "unavailable · /chatgpt-quota"}`;
		const now = Date.now();
		return `ChatGPT plan · ${WINDOWS.map(([seconds, label]) => `${label} ${describe(quota?.get(seconds), now)}`).join(" · ")}`;
	};
	const render = () => ctx?.ui.setStatus(ID, ctx.model?.provider === "openai" ? text() : undefined);
	function refresh() {
		if (!ctx || ctx.model?.provider !== "openai") return;
		if (pending) return pending.done;
		nextPoll = Date.now() + POLL_MS;
		const controller = new AbortController();
		const done = fetchQuota(ctx, controller.signal).then(result => {
			if (!controller.signal.aborted) { quota = result; problem = ""; }
		}, error => {
			if (!controller.signal.aborted) {
				quota = undefined;
				// TypeErrors can contain settings or transport details; never print raw errors.
				problem = error instanceof QuotaError ? error.message : "Could not read the experimental OpenAI usage endpoint.";
			}
		}).finally(() => {
			if (pending?.controller !== controller) return;
			pending = undefined;
			render();
		});
		pending = { controller, done };
		render();
		return done;
	}
	function stop() {
		clearInterval(timer);
		pending?.controller.abort();
		pending = undefined;
		quota = undefined;
		problem = "";
	}
	function start(current: ExtensionContext) {
		stop();
		if (current.mode !== "tui") return;
		ctx = current;
		render();
		if (ctx.model?.provider !== "openai") return;
		void refresh();
		timer = setInterval(() => {
			if (Date.now() >= nextPoll) void refresh();
			else render();
		}, 30_000);
		timer.unref();
	}
	pi.on("session_start", (_event, current) => start(current));
	pi.on("model_select", (_event, current) => start(current));
	pi.on("session_shutdown", () => { stop(); ctx = undefined; });
	pi.registerCommand(ID, {
		description: "Refresh ChatGPT plan quota or show how to check it",
		handler: async (_args, current) => {
			if (!current.hasUI) return;
			if (current.mode === "tui" && current.model?.provider === "openai") {
				ctx = current;
				await refresh();
			}
			current.ui.notify(`${quota ? text() : problem || "ChatGPT plan quota is not available for this model."}\n${USAGE_PAGE}`, "info");
		},
	});
}
