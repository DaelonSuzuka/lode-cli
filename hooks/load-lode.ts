/**
 * Put the lode entry files in context at the start of every new conversation,
 * before the user's first turn.
 *
 * Fires on exactly two things:
 *   - launching omp into a fresh conversation (not a resume)
 *   - `/new` within a running process
 *
 * Not on resume, not per request, not per process launch.
 *
 * ── Why it is shaped this way ────────────────────────────────────────────────
 *
 * `session_start` alone is wrong: it fires once per *process launch*, and omp
 * resumes by default, so it appended a fresh copy on every start — three copies
 * interleaved through an 8-message session, observed. `SessionStartEvent` is
 * `{ type }` and nothing else, so it cannot tell a new conversation from a
 * resume. The discriminator lives on `SessionSwitchEvent.reason`
 * (`new | resume | fork | handoff`), but that event is only emitted for
 * in-process transitions and never at launch. So neither event is sufficient
 * alone, and neither carries enough to dedupe.
 *
 * `ctx.sessionManager.getEntries()` is what makes it decidable: an empty
 * conversation is a new one. Both events therefore route through the same guard,
 * which makes the pair idempotent — whichever fires, the injection happens at
 * most once, and only into a conversation that has not started yet.
 *
 * A `context`-hook version was tried and rejected: it rebuilt the payload before
 * every LLM call, which fixed duplication but put volatile content at message
 * index 0. omp allows 4 cache breakpoints — up to 3 on system blocks, the rest
 * anchoring a 1-2 message tail window — so a first message that changes
 * mid-session cold-misses the whole conversation. Injecting once and letting it
 * persist makes the entry immutable for the life of the conversation, which is
 * what prefix caching wants.
 *
 * Fork and handoff deliberately fall through: both begin with inherited content,
 * so the emptiness guard skips them. A forked conversation already has the lode
 * from its parent.
 *
 * ── Why this shells out to `lode startup` ────────────────────────────────────
 *
 * The lode CLI (`lode-cli`) owns the entrypoint file list, the budget, sublode
 * summary inclusion, and the tool help text. The hook owns session detection
 * and injection — the omp-specific part. If `lode` is not on PATH, the hook
 * falls back to nothing (no lode loaded). This is deliberate: the tool is the
 * single source of truth for what gets loaded, the hook is the omp integration.
 */
import { execFileSync } from "node:child_process";
import type { HookAPI, HookContext } from "@oh-my-pi/pi-coding-agent/extensibility/hooks";

const MARKER = "lode";

const PREFIX =
	"Project lode, loaded from disk at the start of this conversation. This is the current map of the project; check it against the code rather than trusting it.";

/** A conversation nobody has spoken in yet, and which has no lode entry already. */
function isFreshConversation(ctx: HookContext): boolean {
	let entries: Array<{ type?: string; customType?: string; message?: { role?: string } }>;
	try {
		entries = ctx.sessionManager.getEntries() as typeof entries;
	} catch {
		// Cannot tell; do nothing rather than risk a duplicate.
		return false;
	}
	for (const entry of entries) {
		if (entry.customType === MARKER) return false;
		if (entry.type !== "message") continue;
		const role = entry.message?.role;
		if (role === "user" || role === "assistant") return false;
	}
	return true;
}

function buildPayload(cwd: string): { content: string; status: string } | undefined {
	let output: string;
	try {
		output = execFileSync("lode", ["startup"], { cwd, encoding: "utf8", timeout: 5000 }).trim();
	} catch {
		// lode not on PATH or no lode found — nothing to inject.
		return undefined;
	}
	if (!output) return undefined;

	const content = `${PREFIX}\n${output}`;
	const chars = Buffer.byteLength(content, "utf8");
	const status = `lode: ${chars} chars via lode startup`;

	return { content, status };
}

export default function hook(pi: HookAPI): void {
	const inject = (ctx: HookContext): void => {
		if (!isFreshConversation(ctx)) return;
		const payload = buildPayload(ctx.cwd);
		if (!payload) return;

		pi.logger.info(payload.status);
		pi.sendMessage({
			customType: MARKER,
			content: payload.content,
			display: false,
			attribution: "agent",
			details: { status: payload.status },
		});
	};

	// Launching into a fresh conversation. Fires per process; the guard rejects
	// the resume case.
	pi.on("session_start", async (_event, ctx) => inject(ctx));

	// `/new` inside a running process. `resume` lands on a populated
	// conversation and `fork`/`handoff` on an inherited one, so the guard
	// rejects those without needing to read `reason`.
	pi.on("session_switch", async (_event, ctx) => inject(ctx));
}