/**
 * Watchdog extension for Pi.
 *
 * When an assistant turn ends with an error — for example a provider capacity
 * error that Pi's built-in retry does not classify as retryable — this extension
 * queues a single "." user message after the run has settled, causing the
 * session to continue automatically.
 *
 * It stops after a bounded number of consecutive retries and resets after any
 * successful assistant response.
 *
 * Commands:
 *   /watchdog          show status
 *   /watchdog on       enable watchdog
 *   /watchdog off      disable watchdog
 *   /watchdog reset    reset retry counter
 *   /watchdog now      send "." immediately
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface AssistantLike {
	role?: string;
	stopReason?: string;
	errorMessage?: string;
}

export default function (pi: ExtensionAPI) {
	let enabled = true;
	let armed = false;
	let lastError: string | undefined;
	let retries = 0;

	const maxRetries = 8;
	const baseDelayMs = 2_000;
	const maxDelayMs = 60_000;

	let timer: ReturnType<typeof setTimeout> | undefined;

	const clearTimer = () => {
		if (timer !== undefined) {
			clearTimeout(timer);
			timer = undefined;
		}
	};

	const delayForAttempt = (attempt: number) => {
		const exponent = Math.min(Math.max(attempt - 1, 0), 10);
		return Math.min(baseDelayMs * 2 ** exponent, maxDelayMs);
	};

	const notify = (ctx: any, message: string, type?: "info" | "warning" | "error") => {
		try {
			ctx?.ui?.notify?.(message, type);
		} catch {
			// UI may be unavailable in print/JSON modes or after session replacement.
		}
	};

	const setStatus = (ctx: any, text: string | undefined) => {
		try {
			ctx?.ui?.setStatus?.("watchdog", text);
		} catch {
			// Ignore status failures in non-interactive modes.
		}
	};

	const reset = () => {
		armed = false;
		lastError = undefined;
		retries = 0;
		clearTimer();
	};

	pi.on("session_start", async (_event, ctx) => {
		reset();
		setStatus(ctx, enabled ? "wd: on" : "wd: off");
	});

	pi.on("session_shutdown", async () => {
		clearTimer();
		armed = false;
	});

	pi.on("message_end", async (event, ctx) => {
		const message = event.message as AssistantLike | undefined;
		if (message?.role !== "assistant") return;

		if (message.stopReason === "error") {
			armed = true;
			lastError = message.errorMessage;
			setStatus(ctx, enabled ? "wd: error queued" : undefined);
			return;
		}

		if (message.stopReason !== "aborted") {
			if (armed || retries > 0) {
				reset();
				setStatus(ctx, enabled ? "wd: ready" : undefined);
			}
		}
	});

	pi.on("agent_before_settle", async (event) => {
		if (event.outcome === "error") {
			armed = true;
			lastError ??= "agent run error";
		}
	});

	pi.on("agent_settled", async (event, ctx) => {
		if (event.aborted) {
			armed = false;
			setStatus(ctx, enabled ? "wd: ready" : undefined);
			return;
		}

		if (!enabled || !armed) {
			setStatus(ctx, enabled ? undefined : "wd: off");
			return;
		}

		armed = false;

		if (retries >= maxRetries) {
			notify(
				ctx,
				`Watchdog: giving up after ${maxRetries} consecutive retries. Last error: ${lastError ?? "unknown"}. Use /watchdog reset to try again.`,
				"warning",
			);
			setStatus(ctx, "wd: stopped");
			return;
		}

		retries += 1;
		const delayMs = delayForAttempt(retries);
		const delaySec = Math.round(delayMs / 1000);

		notify(
			ctx,
			`Watchdog: assistant error (${lastError ?? "unknown"}). Sending "." in ${delaySec}s (retry ${retries}/${maxRetries}).`,
			"info",
		);
		setStatus(ctx, `wd: retry ${retries}/${maxRetries} in ${delaySec}s`);

		clearTimer();
		const settleCtx = ctx;

		timer = setTimeout(() => {
			timer = undefined;

			try {
				setStatus(settleCtx, undefined);

				if (!enabled) return;
				if (!settleCtx.isIdle?.()) return;

				pi.sendUserMessage(".", { deliverAs: "followUp" });
			} catch {
				// Session may have been replaced or reloaded; ignore stale timer work.
			}
		}, delayMs);
	});

	pi.registerCommand("watchdog", {
		description: "Control automatic continuation after errors",
		handler: async (args, ctx) => {
			const sub = args.trim().toLowerCase();

			if (sub === "off") {
				enabled = false;
				clearTimer();
				setStatus(ctx, "wd: off");
				notify(ctx, "Watchdog disabled", "info");
				return;
			}

			if (sub === "on") {
				enabled = true;
				retries = 0;
				armed = false;
				setStatus(ctx, "wd: on");
				notify(ctx, "Watchdog enabled", "info");
				return;
			}

			if (sub === "reset") {
				reset();
				setStatus(ctx, enabled ? "wd: on" : "wd: off");
				notify(ctx, "Watchdog retry counter reset", "info");
				return;
			}

			if (sub === "now") {
				pi.sendUserMessage(".", { deliverAs: "followUp" });
				return;
			}

			notify(
				ctx,
				`Watchdog ${enabled ? "enabled" : "disabled"}; retries ${retries}/${maxRetries}; armed ${armed}; last error: ${lastError ?? "none"}`,
				"info",
			);
		},
	});
}