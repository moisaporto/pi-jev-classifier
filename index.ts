/**
 * Jev Classifier Extension
 *
 * Uses TypeSafe's Jev classification model, routed through OpenRouter, to add
 * three capabilities to Pi. Pi ships Jev as a built-in classifier model, so no
 * SDK, HTTP client, or build step is needed — extensions call it through
 * `ctx.modelRegistry.classify()`.
 *
 * 1. Pre-tool risk gate (`tool_call`): classifies bash/powershell/write/edit
 *    calls and blocks high-risk, irreversible operations before they run.
 *    Read-only commands are bypassed locally with zero API latency and
 *    identical calls are served from a cache.
 * 2. Post-execution verification (`tool_result`): classifies test/build output
 *    after verification commands (npm test, pytest, tsc, ...) and appends a
 *    targeted alert to the tool result on hard failures, so the model fixes
 *    the root cause in the same turn.
 * 3. `/jev-trim <task>`: ranks workspace files for relevance to a task in a
 *    single Jev call.
 * 4. `/jev`: status, gate/verify toggles, and available-model listing.
 *
 * Jev answers typed questions (choice / bool / score) about a JSON state with
 * probabilities. A classification call is one round trip; the gate fails open
 * on errors, timeouts, or aborts so agent work is never blocked by it.
 *
 * Two call paths, tried in order:
 * 1. Registry: `ctx.modelRegistry.classify()` with the catalog's classifier
 *    model (pi normalizes credentials, usage, and cost accounting).
 * 2. Direct fallback: OpenRouter's Decisions API
 *    (`POST https://openrouter.ai/api/alpha/decisions`, model
 *    `typesafe/jev-1.13`) using the credential the registry resolves. This
 *    covers pi builds whose model catalog omits OpenRouter classifier models.
 *
 * Set JEV_DEBUG=1 to trace model resolution, gate, and verify decisions on
 * stderr.
 *
 * Configuration (environment variables, all optional):
 *   OPENROUTER_API_KEY          OpenRouter credential (or use `/login` OAuth).
 *   JEV_PROVIDER                Classifier provider. Default: openrouter
 *   JEV_MODEL                   Classifier model id. Default: typesafe/jev-1.13
 *   JEV_GATE                    on|off — pre-tool gate. Default: on
 *   JEV_VERIFY                  on|off — post-run verification. Default: on
 *   JEV_IRREVERSIBLE_THRESHOLD  0..1 — block when risk=destructive AND
 *                               irreversible >= threshold. Default: 0.65
 *   JEV_FAIL_SEVERITY           0..1 — alert threshold for hard failures. Default: 0.6
 *   JEV_TIMEOUT_MS              Per-call timeout; fails open. Default: 6000
 *
 * Model fallback chain (first available wins):
 *   $JEV_PROVIDER/$JEV_MODEL → openrouter/typesafe/jev-1.13 →
 *   openrouter/~typesafe/jev-latest → typesafe/jev-latest →
 *   vercel-ai-gateway/typesafe-ai/jev → cloudflare-workers-ai/typesafe/jev →
 *   opencode/jev-1.13 → any available classifier.
 */

import * as fs from "node:fs";

import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ToolCallEvent,
	ToolCallEventResult,
	ToolResultEvent,
	ToolResultEventResult,
} from "@earendil-works/pi-coding-agent";
import type {
	ClassifierBoolAnswer,
	ClassifierChoiceAnswer,
	ClassifierContext,
	ClassifierQuestion,
	ClassifierScoreAnswer,
	TextContent,
} from "@earendil-works/pi-ai";

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

function envFlag(name: string, fallback: boolean): boolean {
	const raw = process.env[name]?.trim().toLowerCase();
	if (raw === "on" || raw === "true" || raw === "1" || raw === "yes") return true;
	if (raw === "off" || raw === "false" || raw === "0" || raw === "no") return false;
	return fallback;
}

function envNumber(name: string, fallback: number): number {
	const raw = Number(process.env[name]);
	return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : fallback;
}

const CONFIG = {
	provider: process.env.JEV_PROVIDER?.trim() || "openrouter",
	model: process.env.JEV_MODEL?.trim() || "typesafe/jev-1.13",
	irreversibleThreshold: envNumber("JEV_IRREVERSIBLE_THRESHOLD", 0.65),
	failSeverity: envNumber("JEV_FAIL_SEVERITY", 0.6),
	timeoutMs: Number(process.env.JEV_TIMEOUT_MS) || 6000,
};

/** Set JEV_DEBUG=1 to trace gate/verify decisions on stderr. */
const DEBUG = process.env.JEV_DEBUG === "1" || process.env.JEV_DEBUG?.toLowerCase() === "true";
function debugLog(message: string): void {
	if (DEBUG) process.stderr.write(`[jev] ${message}\n`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Session-scoped runtime state (reset by session_start)
// ─────────────────────────────────────────────────────────────────────────────

const runtime = {
	gateEnabled: envFlag("JEV_GATE", true),
	verifyEnabled: envFlag("JEV_VERIFY", true),
	model: undefined as { provider: string; id: string } | undefined,
	/** True when the last classification used the direct Decisions API fallback. */
	usingDirectApi: false,
	lastError: undefined as string | undefined,
	stats: { classified: 0, blocked: 0, alerts: 0, errors: 0 },
	/** Result cache for the pre-tool gate, keyed by `${tool}\u0000${command}`. */
	gateCache: new Map<string, { risk: string; irreversible: number }>(),
};

const GATE_CACHE_MAX = 256;

/** Fallback classifier models, tried in order after the configured one. */
const FALLBACKS: Array<{ provider: string; id: string }> = [
	{ provider: "openrouter", id: "typesafe/jev-1.13" },
	{ provider: "openrouter", id: "~typesafe/jev-latest" },
	{ provider: "typesafe", id: "jev-latest" },
	{ provider: "vercel-ai-gateway", id: "typesafe-ai/jev" },
	{ provider: "cloudflare-workers-ai", id: "typesafe/jev" },
	{ provider: "opencode", id: "jev-1.13" },
];

// ─────────────────────────────────────────────────────────────────────────────
// Classifier plumbing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve a Jev classifier model. Prefers credential-aware availability checks,
 * then falls back to the static chain and finally to any available classifier.
 */
async function resolveJevModel(ctx: ExtensionContext): Promise<{ provider: string; id: string } | undefined> {
	if (runtime.model) return runtime.model;
	try {
		const available = await ctx.modelRegistry.getAvailableOfType("classifier");
		const chain = [{ provider: CONFIG.provider, id: CONFIG.model }, ...FALLBACKS];
		for (const { provider, id } of chain) {
			const hit = available.find((m) => m.provider === provider && m.id === id);
			if (hit) {
				runtime.model = { provider, id };
				debugLog(`model resolved: ${provider}/${id} (${available.length} classifiers available)`);
				return runtime.model;
			}
		}
		if (available.length > 0) {
			runtime.model = { provider: available[0].provider, id: available[0].id };
			debugLog(`model resolved (fallback): ${runtime.model.provider}/${runtime.model.id} (${available.length} classifiers available)`);
			return runtime.model;
		}
		runtime.lastError = "No classifier model with working credentials (set OPENROUTER_API_KEY or run /login)";
		runtime.stats.errors++;
	} catch (err) {
		runtime.lastError = err instanceof Error ? err.message : String(err);
		runtime.stats.errors++;
	}
	debugLog(`model resolution failed: ${runtime.lastError}`);
	return undefined;
}

interface ClassifyOutcome {
	answers?: Record<string, unknown>;
	error?: string;
	aborted?: boolean;
}

/**
 * Run one Jev classification call. Never throws: check `outcome.error` /
 * `outcome.aborted` before using `outcome.answers`. Tries the registry first,
 * then falls back to OpenRouter's Decisions API when the registry cannot serve
 * a classifier (e.g. a pi build whose catalog lacks classifier models).
 */
async function classify(
	ctx: ExtensionContext,
	state: Record<string, unknown>,
	questions: Record<string, ClassifierQuestion>,
): Promise<ClassifyOutcome> {
	const resolved = await resolveJevModel(ctx);
	if (resolved) {
		const outcome = await classifyViaRegistry(ctx, resolved, state, questions);
		if (!outcome.error || outcome.aborted) return outcome;
		// Registry path failed (not aborted) — fall through to the direct API.
	}
	return classifyViaDirectApi(ctx, state, questions);
}

async function classifyViaRegistry(
	ctx: ExtensionContext,
	resolved: { provider: string; id: string },
	state: Record<string, unknown>,
	questions: Record<string, ClassifierQuestion>,
): Promise<ClassifyOutcome> {
	const model = ctx.modelRegistry.findOfType("classifier", resolved.provider, resolved.id);
	if (!model) {
		runtime.model = undefined; // stale cache entry; re-resolve next time
		return { error: `Classifier ${resolved.provider}/${resolved.id} disappeared from the catalog` };
	}

	const signals = [ctx.signal, AbortSignal.timeout(CONFIG.timeoutMs)].filter(
		(s): s is AbortSignal => s instanceof AbortSignal,
	);
	const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];

	const context: ClassifierContext = { state, questions };
	const result = await ctx.modelRegistry.classify(model, context, { signal });

	runtime.stats.classified++;

	if (result.stopReason === "aborted") {
		debugLog("classify aborted");
		return { aborted: true, error: "aborted" };
	}
	if (result.stopReason === "error" || !result.answers) {
		runtime.stats.errors++;
		runtime.lastError = result.errorMessage ?? "unknown classifier error";
		debugLog(`classify error: ${runtime.lastError}`);
		return { error: runtime.lastError };
	}
	debugLog(
		`classify ok via ${result.provider}/${result.model}` +
			(result.usage ? ` (${result.usage.totalTokens} tokens)` : ""),
	);
	return { answers: result.answers };
}

// ─────────────────────────────────────────────────────────────────────────
// Direct Decisions API fallback (OpenRouter)
// ─────────────────────────────────────────────────────────────────────────

const DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";
const DIRECT_MODEL = "typesafe/jev-1.13";

/** Answers from the raw Decisions API, before normalization to pi shapes. */
interface RawDecisionsResponse {
	answers?: Record<string, { type: string; choice?: string; probabilities?: Record<string, number>; noul?: number; score?: number; confidence?: number }>;
	usage?: { input_tokens?: number; output_tokens?: number; cost?: number };
}

/**
 * Call OpenRouter's Decisions API directly with the credential the registry
 * resolves (OAuth login or API key). The endpoint expects the request fields
 * at the top level; bool questions are named "noul" on the wire and come back
 * as `{ type: "noul", noul: <probability> }`, which we normalize to pi's
 * `{ type: "bool", probability }`.
 */
async function classifyViaDirectApi(
	ctx: ExtensionContext,
	state: Record<string, unknown>,
	questions: Record<string, ClassifierQuestion>,
): Promise<ClassifyOutcome> {
	const apiKey = await ctx.modelRegistry.getApiKeyForProvider("openrouter");
	if (!apiKey) {
		runtime.lastError = "No OpenRouter credential for the direct Decisions API fallback";
		debugLog(`classify failed: ${runtime.lastError}`);
		runtime.stats.errors++;
		return { error: runtime.lastError };
	}

	const wireQuestions = Object.fromEntries(
		Object.entries(questions).map(([id, q]) => [
			id,
			q.type === "bool" ? { type: "noul", instructions: q.instructions, criteria: q.criteria } : q,
		]),
	);

	const signals = [ctx.signal, AbortSignal.timeout(CONFIG.timeoutMs)].filter(
		(s): s is AbortSignal => s instanceof AbortSignal,
	);
	const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];

	let response: Response;
	try {
		response = await fetch(DECISIONS_URL, {
			method: "POST",
			headers: {
				authorization: `Bearer ${apiKey}`,
				"content-type": "application/json",
				"x-title": "pi-jev-classifier",
			},
			body: JSON.stringify({ model: DIRECT_MODEL, state, questions: wireQuestions }),
			signal,
		});
	} catch (err) {
		if (ctx.signal?.aborted) return { aborted: true, error: "aborted" };
		runtime.lastError = err instanceof Error ? err.message : String(err);
		debugLog(`direct API fetch failed: ${runtime.lastError}`);
		runtime.stats.errors++;
		return { error: runtime.lastError };
	}

	if (!response.ok) {
		const body = await response.text().catch(() => "");
		runtime.lastError = `Decisions API returned HTTP ${response.status}: ${body.slice(0, 200)}`;
		debugLog(`direct API error: ${runtime.lastError}`);
		runtime.stats.errors++;
		return { error: runtime.lastError };
	}

	const json = (await response.json().catch(() => undefined)) as RawDecisionsResponse | undefined;
	if (!json?.answers) {
		runtime.lastError = "Decisions API response missing answers";
		debugLog(`direct API error: ${runtime.lastError}`);
		runtime.stats.errors++;
		return { error: runtime.lastError };
	}

	runtime.stats.classified++;
	runtime.usingDirectApi = true;
	runtime.lastError = undefined;
	const tokenCount = (json.usage?.input_tokens ?? 0) + (json.usage?.output_tokens ?? 0);
	debugLog(
		`classify ok via direct Decisions API (${DIRECT_MODEL})` +
			(tokenCount > 0 ? ` (${tokenCount} tokens)` : ""),
	);

	const answers: Record<string, unknown> = {};
	for (const [id, raw] of Object.entries(json.answers)) {
		if (raw.type === "noul" && typeof raw.noul === "number") {
			answers[id] = { type: "bool", probability: raw.noul };
		} else if (raw.type === "choice" && typeof raw.choice === "string") {
			answers[id] = {
				type: "choice",
				choice: raw.choice,
				probabilities: raw.probabilities ?? { [raw.choice]: 1 },
				confidence: raw.confidence ?? 1,
			};
		} else if (raw.type === "score" && typeof raw.score === "number") {
			answers[id] = { type: "score", score: raw.score, confidence: raw.confidence ?? 1 };
		}
	}
	if (Object.keys(answers).length === 0) {
		runtime.lastError = "Decisions API returned no usable answers";
		debugLog(`direct API error: ${runtime.lastError}`);
		runtime.stats.errors++;
		return { error: runtime.lastError };
	}
	return { answers };
}

// ─────────────────────────────────────────────────────────────────────────────
// Pattern A — pre-tool permission gate
// ─────────────────────────────────────────────────────────────────────────────

/** First tokens that are pure read-only inspection, safe with any arguments. */
const READ_ONLY_COMMANDS = new Set([
	"ls", "pwd", "cat", "head", "tail", "grep", "rg", "find", "fd", "tree", "which", "whoami",
	"id", "date", "uname", "echo", "printenv", "wc", "file", "stat", "du", "df", "true",
]);

/** Interpreters and compilers: safe only as version/help probes. */
const INTERPRETERS = new Set(["node", "python", "python3", "java", "rustc", "go", "cargo", "dotnet"]);
const VERSION_ARGS = /^(--?v(ersion)?|-v|-V|--help|-h)$/;

/** `git` subcommands that only inspect repository state. */
const READ_ONLY_GIT = new Set([
	"status", "log", "diff", "show", "branch", "remote", "rev-parse", "describe",
	"blame", "ls-files", "shortlog", "reflog", "version", "--version",
]);

/** `git` arguments that change state even under an otherwise read-only subcommand. */
const GIT_DANGER = new Set([
	"push", "pull", "gc", "prune", "expire", "clean", "reset", "checkout", "switch",
	"restore", "rebase", "merge", "am", "apply", "revert", "cherry-pick", "bisect",
	"filter-branch", "filter-repo", "update-ref", "add", "commit", "stash", "tag",
	"notes", "replace", "repack", "worktree", "remove", "set-url", "rename",
	"-d", "-D", "--force", "-f",
]);

/** Routine, non-destructive build/test invocations that skip the gate. */
const BUILD_RUNNERS = new Set(["vitest", "jest", "mocha", "pytest", "tsc", "eslint", "ruff", "pyright"]);
const BUILD_PAIRS = new Set([
	"npm test", "pnpm test", "yarn test", "bun test",
	"cargo test", "cargo check", "cargo build", "go test", "go vet", "go build", "npx tsc",
]);

/** Redirects to files, command/process substitution, or tee — anything that can write or execute. */
function hasWriteOrSubstitution(command: string): boolean {
	const withoutStreamDup = command.replace(/2>&1/g, "");
	if (/(^|\s)[0-9]*&?>{1,2}/.test(withoutStreamDup)) return true; // >, >>, n>, &>
	if (/\s<\(|\$\(|`/.test(command)) return true; // process/command substitution
	return false;
}

function isReadOnlyCommand(command: string): boolean {
	if (hasWriteOrSubstitution(command)) return false;
	const segments = command.split(/&&|\|\||;|\|/).filter((s) => s.trim() !== "");
	if (segments.length === 0) return false;
	for (const segment of segments) {
		const tokens = segment.trim().split(/\s+/);
		const first = tokens[0];
		const second = tokens[1] ?? "";
		if (!first) return false;
		if (first === "git") {
			if (!READ_ONLY_GIT.has(second)) return false;
			if (tokens.slice(2).some((t) => GIT_DANGER.has(t))) return false;
			continue;
		}
		if (first === "find" && tokens.some((t) => /^-(delete|exec|execdir|ok|okdir)$/.test(t))) return false;
		if (BUILD_PAIRS.has(`${first} ${second}`)) continue;
		if (BUILD_RUNNERS.has(first)) continue;
		if ((first === "npm" || first === "pnpm" || first === "yarn" || first === "bun") && second === "run") {
			if (["build", "lint", "test", "check"].includes(tokens[2] ?? "")) continue;
			return false;
		}
		if (INTERPRETERS.has(first)) {
			const rest = tokens.slice(1);
			if (first === "go" && rest[0] === "version" && rest.length === 1) continue;
			if (rest.length === 0 || !rest.every((a) => VERSION_ARGS.test(a))) return false;
			continue;
		}
		if (!READ_ONLY_COMMANDS.has(first)) return false;
	}
	return true;
}

/** Extract the command / path text a gate decision is made about. */
function gateTarget(event: ToolCallEvent): { kind: "command" | "path"; value: string } | undefined {
	const input = event.input as unknown as Record<string, unknown>;
	if (event.toolName === "bash" || event.toolName === "powershell") {
		const command = input.command;
		return typeof command === "string" && command.trim() ? { kind: "command", value: command } : undefined;
	}
	const path = input.path ?? input.file_path;
	return typeof path === "string" && path.trim() ? { kind: "path", value: path } : undefined;
}

function cacheGateResult(key: string, value: { risk: string; irreversible: number }): void {
	if (runtime.gateCache.size >= GATE_CACHE_MAX) runtime.gateCache.clear();
	runtime.gateCache.set(key, value);
}

const RISK_QUESTION: ClassifierQuestion = {
	type: "choice",
	instructions: "Classify the risk of this tool call the agent is about to make.",
	criteria: {
		safe: "Read-only inspection, running tests, building, or a contained edit inside the workspace",
		elevated: "Modifying source or config files, installing dependencies, or touching areas outside the immediate task",
		destructive: "Deleting or overwriting important data, changing system state, force-pushing, or otherwise hard to undo",
	},
};

const IRREVERSIBLE_QUESTION: ClassifierQuestion = {
	type: "bool",
	instructions: "Would this operation be difficult or impossible to revert if it turned out to be a mistake?",
	criteria: {
		true: "Destructive and difficult to revert (data loss, system change, remote rewrite)",
		false: "Reversible or confined to recoverable workspace files",
	},
};

async function handleToolCall(event: ToolCallEvent, ctx: ExtensionContext): Promise<ToolCallEventResult | undefined> {
	if (!runtime.gateEnabled) return undefined;
	if (
		!isToolCallEventType("bash", event) &&
		!isToolCallEventType("powershell", event) &&
		!isToolCallEventType("write", event) &&
		!isToolCallEventType("edit", event)
	) {
		return undefined;
	}

	const target = gateTarget(event);
	if (!target) return undefined;

	// Fast local bypass for read-only commands: zero API latency.
	if (target.kind === "command" && isReadOnlyCommand(target.value)) {
		debugLog(`gate bypass (read-only): ${target.value.slice(0, 100)}`);
		return undefined;
	}

	const key = `${event.toolName}\u0000${target.value}`;
	const cached = runtime.gateCache.get(key);
	let risk: string;
	let irreversible: number;

	if (cached) {
		({ risk, irreversible } = cached);
		debugLog(`gate cache hit: risk=${risk} irreversible=${(irreversible * 100).toFixed(0)}%`);
	} else {
		const state: Record<string, unknown> = {
			tool: event.toolName,
			[target.kind]: target.value,
			cwd: ctx.cwd,
		};
		if (target.kind === "path") {
			const input = event.input as unknown as Record<string, unknown>;
			let preview: string | undefined;
			if (typeof input.content === "string") {
				preview = input.content.slice(0, 200); // write tool
			} else if (Array.isArray(input.edits)) {
				// edit tool: edits: [{ oldText, newText }]
				preview = (input.edits as unknown[])
					.slice(0, 3)
					.map((e) => {
						const edit = e as Record<string, unknown>;
						return `old:${String(edit.oldText ?? "").slice(0, 60)} new:${String(edit.newText ?? "").slice(0, 60)}`;
					})
					.join(" | ")
					.slice(0, 200);
			}
			if (preview) state.preview = preview;
		}
		const outcome = await classify(ctx, state, {
			risk: RISK_QUESTION,
			irreversible: IRREVERSIBLE_QUESTION,
		});
		if (outcome.aborted || outcome.error || !outcome.answers) return undefined; // fail open

		const riskAnswer = outcome.answers.risk as ClassifierChoiceAnswer | undefined;
		const irreversibilityAnswer = outcome.answers.irreversible as ClassifierBoolAnswer | undefined;
		if (riskAnswer?.type !== "choice" || irreversibilityAnswer?.type !== "bool") return undefined;

		risk = riskAnswer.choice;
		irreversible = irreversibilityAnswer.probability;
		cacheGateResult(key, { risk, irreversible });
	}

	if (risk === "destructive" && irreversible >= CONFIG.irreversibleThreshold) {
		runtime.stats.blocked++;
		debugLog(`gate BLOCKED ${event.toolName}: ${target.value.slice(0, 100)} (risk=destructive, irreversible ${(irreversible * 100).toFixed(0)}%)`);
		ctx.ui.notify(
			`JEV gate blocked ${event.toolName}: ${target.value.slice(0, 120)} (irreversible ${(irreversible * 100).toFixed(0)}%)`,
			"warning",
		);
		return {
			block: true,
			reason:
				`Blocked by Jev risk gate: \`${target.value.slice(0, 200)}\` was classified as destructive and ` +
				`irreversible (probability ${(irreversible * 100).toFixed(0)}%). Do not attempt to work around this. ` +
					`If the user really wants this, explain the risk and ask them to run /jev gate off, or propose a safer reversible alternative.`,
		};
	}
	debugLog(`gate allowed ${event.toolName}: ${target.value.slice(0, 100)} (risk=${risk}, irreversible ${(irreversible * 100).toFixed(0)}%)`);
	return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pattern B — workspace file ranking (/jev-trim)
// ─────────────────────────────────────────────────────────────────────────────

const SKIP_DIRS = new Set([
	".git", ".hg", ".svn", "node_modules", "dist", "build", "out", "target", ".next",
	"__pycache__", ".venv", "venv", "coverage", ".cache", ".pi", ".idea", ".vscode",
]);

const SKIP_FILES = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|poetry\.lock|\.DS_Store)$/;

interface CollectedFile {
	path: string;
	mtimeMs: number;
}

/** Bounded, synchronous walk of the working directory, newest files first. */
function collectWorkspaceFiles(cwd: string, maxFiles = 400, maxDepth = 5): CollectedFile[] {
	const found: CollectedFile[] = [];
	const walk = (dir: string, depth: number): void => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (found.length >= maxFiles) return;
			const full = `${dir}/${entry.name}`;
			const rel = full.slice(cwd.length + 1);
			if (entry.isDirectory()) {
				if (depth >= maxDepth || SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
				walk(full, depth + 1);
			} else if (entry.isFile() && !SKIP_FILES.test(rel) && !entry.name.startsWith(".")) {
				try {
					found.push({ path: rel, mtimeMs: fs.statSync(full).mtimeMs });
				} catch {
					/* file vanished; ignore */
				}
			}
		}
	};
	walk(cwd, 0);
	found.sort((a, b) => b.mtimeMs - a.mtimeMs);
	return found.slice(0, maxFiles);
}

const RELEVANCE_LEVELS = [
	"No meaningful relation to the task",
	"Marginal relation; background context only",
	"Moderate relation; likely needs reading",
	"Strong relation; directly affected",
	"Central to the task; the natural starting point",
];

async function runTrim(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const task = args.trim();
	if (!task) {
		ctx.ui.notify("Usage: /jev-trim <description of the task>", "info");
		return;
	}

	const files = collectWorkspaceFiles(ctx.cwd).slice(0, 40);
	if (files.length === 0) {
		ctx.ui.notify("No workspace files found to rank.", "warning");
		return;
	}

	ctx.ui.notify(`JEV: ranking ${files.length} workspace files for “${task.slice(0, 60)}”…`, "info");

	const paths = files.map((f) => f.path);
	const outcome = await classify(
		ctx,
		{ task, cwd: ctx.cwd, files: paths },
		{
			topFile: {
				type: "choice",
				instructions:
					"Which single file in `files` is the most critical starting point for `task`? Answer with its exact path.",
				criteria: Object.fromEntries(paths.map((p) => [p, "Workspace file relative to the project root"])),
			},
			relevance: {
				type: "score",
				instructions: "How relevant is the current workspace to `task` overall?",
				criteria: RELEVANCE_LEVELS,
			},
		},
	);

	if (outcome.error || !outcome.answers) {
		ctx.ui.notify(`JEV trim failed: ${outcome.error ?? "no answers"}`, "error");
		return;
	}

	const top = outcome.answers.topFile as ClassifierChoiceAnswer | undefined;
	const relevance = outcome.answers.relevance as ClassifierScoreAnswer | undefined;
	if (top?.type !== "choice" || relevance?.type !== "score") {
		ctx.ui.notify("JEV trim returned unexpected answer types.", "error");
		return;
	}

	const maxScore = RELEVANCE_LEVELS.length - 1;
	const relevancePct = Math.round((Math.min(relevance.score, maxScore) / maxScore) * 100);
	const alternates = Object.entries(top.probabilities)
		.filter(([file]) => file !== top.choice && paths.includes(file))
		.sort(([, a], [, b]) => b - a)
		.slice(0, 2)
		.map(([file, p]) => `${file} (${Math.round(p * 100)}%)`)
		.join(", ");

	const lines = [
		`JEV file ranking for “${task.slice(0, 80)}”`,
		`Primary: ${top.choice}`,
		`Workspace relevance: ${relevancePct}%`,
		alternates ? `Also consider: ${alternates}` : undefined,
	].filter(Boolean) as string[];
	ctx.ui.notify(lines.join("\n"), "info");
}

// ─────────────────────────────────────────────────────────────────────────────
// Pattern D — post-execution verification
// ─────────────────────────────────────────────────────────────────────────────

const VERIFICATION_COMMAND =
	/\b(npm|pnpm|yarn|bun)\s+(run\s+)?(test|build)\b|\b(vitest|jest|mocha|pytest|cargo\s+(test|check)|go\s+(test|vet)|tsc|eslint|ruff|gradlew?\s+test|mvn\s+(test|verify)|dotnet\s+(test|build)|make\s+test)\b/;

const SEVERITY_LEVELS = [
	"Clean run; nothing to act on",
	"Warnings or flaky behavior; not blocking",
	"Real failures; should be fixed soon",
	"Serious failure; blocks current work",
	"Hard blocker; the task cannot proceed until fixed",
];

function tailText(event: ToolResultEvent, maxChars = 2000): string {
	const text = event.content
		.flatMap((block) => (block.type === "text" ? [block.text] : []))
		.join("\n");
	return text.length > maxChars ? text.slice(-maxChars) : text;
}

async function handleToolResult(event: ToolResultEvent, ctx: ExtensionContext): Promise<ToolResultEventResult | undefined> {
	if (!runtime.verifyEnabled) return undefined;
	if (event.toolName !== "bash" && event.toolName !== "powershell") return undefined;

	const command = String((event.input as unknown as Record<string, unknown>).command ?? "");
	if (!command || !VERIFICATION_COMMAND.test(command)) return undefined;

	const output = tailText(event);
	if (!output.trim()) return undefined;

	const outcome = await classify(
		ctx,
		{ command, isError: event.isError, output },
		{
			status: {
				type: "choice",
				instructions: "Evaluate the execution output of this verification command.",
				criteria: {
					passed: "Command succeeded without critical issues",
					transient: "Environmental, flaky, or non-critical warnings only",
					failed: "Compilation, syntax, or assertion failure requiring a code change",
				},
			},
			severity: {
				type: "score",
				instructions: "How urgently does this output require the agent to change code?",
				criteria: SEVERITY_LEVELS,
			},
		},
	);
	if (outcome.error || !outcome.answers) return undefined; // stay silent on classifier failure

	const status = outcome.answers.status as ClassifierChoiceAnswer | undefined;
	const severity = outcome.answers.severity as ClassifierScoreAnswer | undefined;
	if (status?.type !== "choice" || severity?.type !== "score") return undefined;

	const maxScore = SEVERITY_LEVELS.length - 1;
	const severityPct = Math.min(Math.max(severity.score, 0), maxScore) / maxScore;
	if (status.choice !== "failed" || severityPct < CONFIG.failSeverity) {
		debugLog(`verify: ${command.slice(0, 80)} → status=${status.choice}, severity ${Math.round(severityPct * 100)}% → no alert`);
		return undefined;
	}

	runtime.stats.alerts++;
	debugLog(`verify ALERT: ${command.slice(0, 80)} → status=${status.choice}, severity ${Math.round(severityPct * 100)}%`);
	const alert: TextContent = {
		type: "text",
		text:
			`[JEV verification] \`${command.slice(0, 120)}\` hard-failed (severity ${Math.round(severityPct * 100)}%, ` +
			`confidence ${Math.round(severity.confidence * 100)}%). Treat the output above as the primary failure signal: ` +
			`identify the root cause and fix it before continuing with anything else.`,
	};
	const result: ToolResultEventResult = { content: [...event.content, alert] };
	if (event.structuredContent !== undefined) result.structuredContent = event.structuredContent;
	return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// /jev command — status and toggles
// ─────────────────────────────────────────────────────────────────────────────

function statusLines(ctx: ExtensionContext): string[] {
	const path = runtime.usingDirectApi
		? "direct Decisions API (registry catalog has no OpenRouter classifiers)"
		: undefined;
	const model = runtime.model
		? `${runtime.model.provider}/${runtime.model.id}${path ? ` — ${path}` : ""}`
		: runtime.usingDirectApi
			? `openrouter/${DIRECT_MODEL} — direct Decisions API (registry catalog has no OpenRouter classifiers)`
			: "(unresolved — will resolve on first use)";
	const auth = ctx.modelRegistry.getProviderAuthStatus(CONFIG.provider);
	return [
		`Model: ${model}`,
		`${CONFIG.provider} auth: ${auth.configured ? `configured (${auth.source ?? "unknown"})` : "missing"}`,
		`Gate: ${runtime.gateEnabled ? "on" : "off"} (irreversible ≥ ${Math.round(CONFIG.irreversibleThreshold * 100)}%)`,
		`Verify: ${runtime.verifyEnabled ? "on" : "off"} (severity ≥ ${Math.round(CONFIG.failSeverity * 100)}%)`,
		`Calls: ${runtime.stats.classified} classified, ${runtime.stats.blocked} blocked, ${runtime.stats.alerts} alerts, ${runtime.stats.errors} errors`,
		runtime.lastError ? `Last error: ${runtime.lastError}` : undefined,
	].filter(Boolean) as string[];
}

async function handleJevCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const [sub, value] = args.trim().split(/\s+/, 2);
	switch (sub) {
		case undefined:
		case "":
		case "status":
			ctx.ui.notify(`JEV classifier\n${statusLines(ctx).join("\n")}`, "info");
			return;
		case "gate":
			if (value === "on" || value === "off") {
				runtime.gateEnabled = value === "on";
				ctx.ui.notify(`JEV gate ${runtime.gateEnabled ? "enabled" : "disabled"} for this session.`, "info");
			} else {
				ctx.ui.notify(`Gate is ${runtime.gateEnabled ? "on" : "off"}. Use /jev gate on|off.`, "info");
			}
			return;
		case "verify":
			if (value === "on" || value === "off") {
				runtime.verifyEnabled = value === "on";
				ctx.ui.notify(`JEV verification ${runtime.verifyEnabled ? "enabled" : "disabled"} for this session.`, "info");
			} else {
				ctx.ui.notify(`Verify is ${runtime.verifyEnabled ? "on" : "off"}. Use /jev verify on|off.`, "info");
			}
			return;
		case "models": {
			const models = ctx.modelRegistry.getModelsOfType("classifier");
			const lines = models.map((m) => `- ${m.provider}/${m.id}${m.name ? ` — ${m.name}` : ""}`);
			ctx.ui.notify(lines.length ? `Classifier models:\n${lines.join("\n")}` : "No classifier models in catalog.", "info");
			return;
		}
		case "trim":
			await runTrim(value ?? "", ctx);
			return;
		case "help":
			ctx.ui.notify(
				[
					"/jev            — status",
					"/jev gate on|off — toggle pre-tool risk gate",
					"/jev verify on|off — toggle post-run verification",
					"/jev models     — list classifier models",
					"/jev-trim <task> — rank workspace files for a task",
				].join("\n"),
				"info",
			);
			return;
		default:
			ctx.ui.notify(`Unknown subcommand “${sub}”. Try /jev help.`, "warning");
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Extension factory
// ─────────────────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	pi.on("session_start", () => {
		// New session, possibly a new cwd: drop cached results and model choice.
		runtime.gateCache.clear();
		runtime.model = undefined;
		runtime.lastError = undefined;
		runtime.stats = { classified: 0, blocked: 0, alerts: 0, errors: 0 };
		runtime.gateEnabled = envFlag("JEV_GATE", true);
		runtime.verifyEnabled = envFlag("JEV_VERIFY", true);
		runtime.usingDirectApi = false;
		debugLog(`session start (gate=${runtime.gateEnabled ? "on" : "off"}, verify=${runtime.verifyEnabled ? "on" : "off"})`);
	});

	pi.on("tool_call", handleToolCall);
	pi.on("tool_result", handleToolResult);

	pi.registerCommand("jev", {
		description: "Jev classifier: status, gate/verify toggles, model list (/jev help)",
		handler: handleJevCommand,
	});

	pi.registerCommand("jev-trim", {
		description: "Rank workspace files for a task with the Jev classifier",
		handler: runTrim,
	});
}