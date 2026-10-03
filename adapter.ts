/**
 * strands-adapter — transport for the strands-decider "System One" structured API.
 *
 * This is the successor to the jev-adapter's chat-completions transport. The
 * strands service is a purpose-built decision endpoint: you POST one `state`
 * plus a map of typed questions to `POST /v1/systemone` and it returns one
 * structured, probability-distributed answer per question — no prompt
 * engineering, no reasoning_effort vocabulary, no max_tokens juggling, no
 * parse-retry tier. The endpoint owns model selection, decoding and
 * normalisation; this module only translates to/from the tool's shape.
 *
 * Question types (tool  →  wire):
 *   choice  → choice   (Pick one of N named options; criteria is option→desc)
 *   score   → score    (Rate against an ordered rubric; criteria low→high)
 *   boolean → noul     (P(statement is true); "noul" is the API's name for it)
 *
 * The API serves ONE state per request. `states` batch mode is therefore one
 * `/v1/systemone` call PER state, keyed by state id — not one giant prompt the
 * way the old chat-completions transport batched them.
 *
 * Batching note (measured against the strands-server): asking MANY questions about
 * ONE state is much cheaper than a separate call each — the state is encoded once
 * and its KV cache is broadcast across the question batch, so the marginal cost of
 * an extra question (~20ms) is well below a fresh call (~45ms), though total
 * latency still grows roughly linearly with question count. So the real efficiency
 * win is to put all the questions you need in a single `state` call, not to fan
 * out. `states`
 * batch mode is only for genuinely INDEPENDENT states, and the upstream server
 * explicitly does NOT verify concurrent-request behaviour (there is a documented
 * race in the torch engine), so per-state requests run SEQUENTIALLY by default
 * (maxConcurrency=1); raise it via STRANDS_MAX_CONCURRENCY only if you have
 * confirmed your deployment tolerates parallelism.
 *
 * Endpoint resolution (no secrets in this repo):
 *   1. optional strands-adapter.config.json next to index.ts (baseURL / model /
 *      timeoutMs / maxConcurrency; apiKey is env-only, see below)
 *   2. STRANDS_BASE_URL / STRANDS_API_KEY / STRANDS_MODEL / STRANDS_TIMEOUT_MS /
 *      STRANDS_MAX_CONCURRENCY env overrides
 *   3. built-in default: http://127.0.0.1:8008 (bring your own service)
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type StrandQuestionType = "choice" | "score" | "boolean" | "noul";

/** A tool-authored question. `type` may use `boolean` as an alias for `noul`. */
export interface JevQuestion {
	type: StrandQuestionType;
	instructions?: string;
	criteria?: unknown;
}

export interface JevStateEntry {
	/** Unique key for this state in the batch output. */
	id: string;
	/** The state to judge (string or object/array). */
	state: unknown;
}

export interface StrandConfig {
	/** Decision endpoint origin (no trailing slash), e.g. "http://host:8008". */
	baseURL?: string;
	/** Optional Bearer key; the strands service is typically open, so none by default. */
	apiKey?: string;
	/** Optional model id sent in the request; omit to use the server default. */
	model?: string;
	timeoutMs?: number;
	/** `states` batch mode: max simultaneous /v1/systemone requests. */
	maxConcurrency?: number;
}

export interface JevAnswer {
	type: "choice" | "score" | "boolean";
	choice?: string;
	score?: number;
	probability?: number;
	probabilities?: Record<string, number>;
	confidence?: number;
	legend?: Record<string, string>;
}

export interface JevDecisionResult {
	channel: string;
	answers: Record<string, JevAnswer>;
	caveat: string;
	/** question ids the server did not answer (omitted). */
	missingQuestions?: string[];
	usage?: { inputTokens: number; outputTokens: number };
	/** Wall-clock time of the whole call (requests + assembly), ms. */
	elapsedMs?: number;
	/** The endpoint's own reported latency for the request, ms. */
	latencyMs?: number;
	/** Model id that answered (read from the response). */
	model?: string;
}

export interface JevBatchResult {
	channel: string;
	/** answers[stateId][questionId] */
	answers: Record<string, Record<string, JevAnswer>>;
	caveat: string;
	/** state ids the service returned nothing for. */
	missingStates?: string[];
	/** question id -> state ids that answered the batch but dropped this question. */
	missingQuestions?: Record<string, string[]>;
	usage?: { inputTokens: number; outputTokens: number };
	elapsedMs?: number;
	latencyMs?: number;
	model?: string;
}

/**
 * Built-in default decision endpoint (override with STRANDS_BASE_URL or config).
 * Neutral localhost so public users bring their own service; never ship a private
 * or internal host here.
 */
export const DEFAULT_BASE_URL = "http://127.0.0.1:8008";
const DEFAULT_TIMEOUT_MS = 120000;
/** Sequential by default: the upstream stages server does not verify concurrency. */
const DEFAULT_MAX_CONCURRENCY = 1;

/** The question types requested by the tool, translated into wire types. */
type WireQuestion = {
	type: "choice" | "score" | "noul";
	instructions: string;
	criteria?: unknown;
};

/* ------------------------------------------------------------------ */
/* Config resolution (kept deliberately lean — the service is fixed)   */
/* ------------------------------------------------------------------ */

/** This module's directory, tolerant of jiti (CJS) and plain node (ESM) hosts. */
const EXT_DIR = (() => {
	try {
		return dirname(fileURLToPath(import.meta.url));
	} catch {
		return process.cwd();
	}
})();

export interface ResolvedStrandConfig {
	baseURL: string;
	apiKey: string;
	/** undefined = send no model → server default. */
	model?: string;
	timeoutMs: number;
	maxConcurrency: number;
	configPath: string | null;
}

interface ConfigFile {
	baseURL?: string;
	model?: string;
	timeoutMs?: number;
	maxConcurrency?: number;
}

function optionalConfigPath(env?: string): string | null {
	if (env) return env;
	const local = join(EXT_DIR, "strands-adapter.config.json");
	if (existsSync(local)) return local;
	const user = join(process.env.HOME ?? "", ".pi", "agent", "strands-adapter.json");
	if (existsSync(user)) return user;
	return null;
}

function numEnv(name: string): number | undefined {
	const v = process.env[name];
	if (!v) return undefined;
	const n = Number(v);
	return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Resolve the effective endpoint. Layer order per field:
 * call opts → strands-adapter.config.json → STRANDS_* env → built-in default.
 */
export function resolveConfig(opts: StrandConfig = {}): ResolvedStrandConfig {
	let configPath: string | null = null;
	let file: ConfigFile = {};
	const explicit = process.env.STRANDS_CONFIG;
	const path = optionalConfigPath(explicit);
	if (path) {
		try {
			file = JSON.parse(readFileSync(path, "utf8")) as ConfigFile;
			configPath = path;
		} catch (e) {
			if (explicit) {
				throw new Error(`strands-adapter: STRANDS_CONFIG points at ${path}, which is not readable/valid JSON — ${(e as Error).message}`);
			}
			// optional config is best-effort; a broken one is surfaced, not fatal unless explicit
			configPath = path;
		}
	}
	return {
		baseURL: (opts.baseURL ?? process.env.STRANDS_BASE_URL ?? file.baseURL ?? DEFAULT_BASE_URL).replace(/\/$/, ""),
		// apiKey is deliberately env/call-only (never read from a config file) so it
		// can't be accidentally committed to a repo alongside the config.
		apiKey: opts.apiKey ?? process.env.STRANDS_API_KEY ?? "",
		model: opts.model ?? process.env.STRANDS_MODEL ?? file.model ?? undefined,
		timeoutMs: opts.timeoutMs ?? numEnv("STRANDS_TIMEOUT_MS") ?? file.timeoutMs ?? DEFAULT_TIMEOUT_MS,
		maxConcurrency:
			opts.maxConcurrency ?? numEnv("STRANDS_MAX_CONCURRENCY") ?? file.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY,
		configPath,
	};
}

/* ------------------------------------------------------------------ */
/* Translation                                                         */
/* ------------------------------------------------------------------ */

/** Normalise an optional criteria into the wire shape for a question type. */
function wireCriteria(q: JevQuestion): unknown | undefined {
	const c = q.criteria;
	if (q.type === "choice" || q.type === "noul" || q.type === "boolean") {
		if (q.type !== "choice") return undefined;
		// ChoiceQuestion.criteria is option→description. Coerce an array to {i: desc}.
		if (Array.isArray(c)) {
			const obj: Record<string, string> = {};
			c.forEach((d, i) => {
				obj[String(i)] = String(d);
			});
			return obj;
		}
		return c && typeof c === "object" ? c : {};
	}
	// score: ScoreQuestion.criteria is ascending string[] (index 0 low end).
	if (q.type === "score") {
		if (Array.isArray(c)) return c.map((d) => String(d));
		if (c && typeof c === "object") return Object.values(c as Record<string, unknown>).map((d) => String(d));
		return [];
	}
	return undefined;
}

const DEFAULT_NOUL_INSTRUCTION =
	"Return the probability that the following statement is true.";

/** Build the wire `questions` map from tool questions. */
export function buildWireQuestions(questions: Record<string, JevQuestion>): Record<string, WireQuestion> {
	const out: Record<string, WireQuestion> = {};
	for (const [id, q] of Object.entries(questions)) {
		if (q.type === "boolean" || q.type === "noul") {
			out[id] = {
				type: "noul",
				instructions: q.instructions?.trim() ? q.instructions : DEFAULT_NOUL_INSTRUCTION,
			};
		} else {
			const criteria = wireCriteria(q);
			out[id] = {
				type: q.type,
				instructions: q.instructions?.trim() || q.instructions || "",
				criteria,
			};
		}
	}
	return out;
}

/** Map one wire answer into a tool-facing JevAnswer. */
export function mapWireAnswer(a: {
	type?: string;
	choice?: string;
	score?: number;
	noul?: number;
	probabilities?: Record<string, number>;
	confidence?: number;
	legend?: Record<string, string>;
}): JevAnswer | null {
	switch (a?.type) {
		case "noul": {
			const p = Number(a.noul);
			if (!Number.isFinite(p)) return null;
			return { type: "boolean", probability: Math.max(0, Math.min(1, p)) };
		}
		case "choice":
			return {
				type: "choice",
				choice: String(a.choice),
				probabilities: a.probabilities ?? {},
				confidence: a.confidence ?? 0,
			};
		case "score":
			return {
				type: "score",
				score: Number(a.score),
				probabilities: a.probabilities ?? {},
				confidence: a.confidence ?? 0,
				legend: a.legend,
			};
		default:
			return null;
	}
}

/* ------------------------------------------------------------------ */
/* Transport                                                           */
/* ------------------------------------------------------------------ */

interface SystemOneResponse {
	model?: string;
	answers?: Record<string, Record<string, unknown>>;
	usage?: { input_tokens?: number; output_tokens?: number };
	latency_ms?: number;
}

/**
 * POST one state to /v1/systemone and return the mapped answers.
 * Throws with a helpful message on network or HTTP errors.
 */
export async function callSystemOne(
	cfg: ResolvedStrandConfig,
	state: unknown,
	questions: Record<string, JevQuestion>,
	signal?: AbortSignal,
): Promise<{ answers: Record<string, JevAnswer>; model?: string; usage?: JevDecisionResult["usage"]; latencyMs?: number }> {
	const url = `${cfg.baseURL}/v1/systemone`;
	const body: Record<string, unknown> = {
		state,
		questions: buildWireQuestions(questions),
	};
	if (cfg.model) body.model = cfg.model;

	let res: Response;
	try {
		res = await fetch(url, {
			method: "POST",
			headers: {
				...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
			signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(cfg.timeoutMs)]) : AbortSignal.timeout(cfg.timeoutMs),
		});
	} catch (e) {
		if (signal?.aborted) throw new Error("Aborted");
		throw new Error(
			`strands decision endpoint unreachable at ${cfg.baseURL} — ${(e as Error).message}`,
		);
	}

	if (!res.ok) {
		const detail = (await res.text()).slice(0, 400);
		// Surface FastAPI validation details ("boolean" is iconically rejected — the
		// wire type is "noul") so a translation bug is caught at the tool level.
		throw new Error(
			`strands decision endpoint returned HTTP ${res.status} for POST ${url}: ${detail}`,
		);
	}

	const data = (await res.json()) as SystemOneResponse;
	const wireAnswers = data.answers ?? {};
	const answers: Record<string, JevAnswer> = {};
	for (const [id, wire] of Object.entries(wireAnswers)) {
		const mapped = mapWireAnswer(wire as Record<string, unknown>);
		if (mapped) answers[id] = mapped;
	}
	return {
		answers,
		model: data.model,
		usage: data.usage
			? {
					inputTokens: data.usage.input_tokens ?? 0,
					outputTokens: data.usage.output_tokens ?? 0,
				}
			: undefined,
		latencyMs: data.latency_ms,
	};
}

/* ------------------------------------------------------------------ */
/* Public decision entry points                                        */
/* ------------------------------------------------------------------ */

const CAVEAT =
	"Probabilities are the model's self-reported estimates, not mathematically calibrated. Review high-risk decisions manually.";

/** Judge ONE state against the given questions. */
export async function decide(
	opts: StrandConfig,
	state: unknown,
	questions: Record<string, JevQuestion>,
	signal?: AbortSignal,
): Promise<JevDecisionResult> {
	const cfg = resolveConfig(opts);
	if (!Object.keys(questions ?? {}).length) throw new Error("questions is required (at least one question)");
	if (state === undefined || state === null || state === "") {
		throw new Error("state is required (a string or a non-empty object)");
	}
	const t0 = Date.now();
	const r = await callSystemOne(cfg, state, questions, signal);
	const missingQuestions = Object.keys(questions).filter((qid) => !(qid in r.answers));
	return {
		channel: `strands-decider (${r.model ?? cfg.model ?? "server default"})`,
		answers: r.answers,
		caveat: CAVEAT,
		usage: r.usage,
		elapsedMs: Date.now() - t0,
		latencyMs: r.latencyMs,
		model: r.model,
		...(missingQuestions.length ? { missingQuestions } : {}),
	};
}

async function mapWithConcurrency<T>(
	items: T[],
	limit: number,
	fn: (item: T, index: number) => Promise<unknown>,
): Promise<void> {
	const pool = Math.max(1, Math.min(limit, items.length));
	let next = 0;
	const workers = Array.from({ length: pool }, async () => {
		while (next < items.length) {
			const i = next;
			next += 1;
			await fn(items[i], i);
		}
	});
	await Promise.all(workers);
}

/**
 * Judge MULTIPLE independent states against the SAME questions.
 *
 * The strands API serves one state per request, so this issues one
 * `/v1/systemone` call per state. These run SEQUENTIALLY by default
 * (maxConcurrency=1) because the upstream server does not verify concurrent
 * requests; only raise STRANDS_MAX_CONCURRENCY when your deployment is confirmed
 * thread-safe. Usage / latency are summed across states.
 */
export async function decideBatch(
	opts: StrandConfig,
	entries: JevStateEntry[],
	questions: Record<string, JevQuestion>,
	signal?: AbortSignal,
): Promise<JevBatchResult> {
	if (!entries.length) throw new Error("decideBatch: entries must be non-empty");
	const ids = new Set<string>();
	for (const e of entries) {
		if (!e.id || ids.has(e.id)) throw new Error(`decideBatch: state ids must be unique and non-empty (got: "${e.id}")`);
		ids.add(e.id);
	}
	const cfg = resolveConfig(opts);
	if (!Object.keys(questions ?? {}).length) throw new Error("questions is required (at least one question)");

	const answers: JevBatchResult["answers"] = {};
	const missingStates: string[] = [];
	const missingQuestions = new Map<string, string[]>();
	let inputTokens = 0;
	let outputTokens = 0;
	let latencyMs = 0;
	let model = "";
	const t0 = Date.now();

	await mapWithConcurrency(entries, cfg.maxConcurrency, async (e) => {
		const r = await callSystemOne(cfg, e.state, questions, signal);
		if (!Object.keys(r.answers).length) {
			missingStates.push(e.id);
			return;
		}
		answers[e.id] = r.answers;
		if (r.usage) {
			inputTokens += r.usage.inputTokens;
			outputTokens += r.usage.outputTokens;
		}
		if (r.latencyMs !== undefined) latencyMs += r.latencyMs;
		if (r.model) model = r.model;
		for (const qid of Object.keys(questions)) {
			if (!(qid in r.answers)) {
				const sids = missingQuestions.get(qid) ?? [];
				sids.push(e.id);
				missingQuestions.set(qid, sids);
			}
		}
	});

	return {
		channel: `strands-decider (${model || cfg.model || "server default"})`,
		answers,
		caveat: CAVEAT,
		missingStates: missingStates.length ? missingStates : undefined,
		missingQuestions: missingQuestions.size ? Object.fromEntries(missingQuestions) : undefined,
		usage: { inputTokens, outputTokens },
		elapsedMs: Date.now() - t0,
		latencyMs,
		model: model || undefined,
	};
}
