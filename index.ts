/**
 * strands-adapter — pi extension that registers `strands_decide`, running the Jev
 * (System One) decision paradigm over the strands-decider structured API
 * (`POST {baseURL}/v1/systemone`).
 *
 * This is the successor to `pi-jev-adapter`'s `jev_decide`. Unlike the
 * chat-completions transport it replaces, the strands service owns model
 * selection, decoding and probability normalisation server-side, so there is no
 * reasoning_effort vocabulary, no max_tokens juggling, no config-file model
 * registry. The tool surface mirrors jev_decide — choice/score/boolean questions
 * in, the same structured answer shape out — but under its OWN namespace
 * (`strands_decide` / `/strands-config`) so it can coexist with `jev-adapter`
 * in the same project without a tool-name conflict.
 *
 * Env overrides (all optional):
 *   STRANDS_BASE_URL        endpoint origin (default http://127.0.0.1:8008)
 *   STRANDS_API_KEY         optional Bearer key (env/call only, never from config)
 *   STRANDS_MODEL           optional model id (omit → server default)
 *   STRANDS_TIMEOUT_MS      per-request timeout (default 120000)
 *   STRANDS_MAX_CONCURRENCY states-batch: parallel requests (default 1)
 *   STRANDS_CONFIG          alternate config JSON path
 * Also read from an optional strands-adapter.config.json next to this file, or
 * ~/.pi/agent/strands-adapter.json (first existing wins).
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
	decide,
	decideBatch,
	type JevAnswer,
	type JevBatchResult,
	type JevDecisionResult,
	type JevQuestion,
	type JevStateEntry,
	resolveConfig,
} from "./adapter.js";

const jevDecideTool = defineTool({
	name: "strands_decide",
	label: "Strands Decide",
	description: [
		"Run a structured decision over one state: send typed questions (choice / score / boolean) and get back probability-distributed answers in a single call.",
		"",
		"Good for high-frequency atomic judgements: classification, routing, scoring, fact-checking, dedup, quality-gating another model's output.",
		"Not for text generation, explanations, or multi-step reasoning — use a normal model for those.",
		"",
		"You may ask many questions in one call; asking many is nearly free (the state is read once and its KV cache is reused across all questions), so batch every judgement you need against the same state.",
		"To judge MULTIPLE INDEPENDENT states (commits, tickets, diffs) against the SAME questions, pass `states` instead of `state`. The strands decision API serves one state per request, so `states` issues one call per state (SEQUENTIAL by default — the server does not verify concurrency; only raise STRANDS_MAX_CONCURRENCY if you confirm your deployment tolerates it) and returns answers keyed by state id. Prefer ONE `state` with many questions when the items share a context — that is where the API is cheap.",
		"Each question must be one atomic, single-dimension judgement; compose complex logic from the answers yourself.",
		"choice and score answers include probabilities and a confidence score (distribution shape, 0-1, NOT a correctness guarantee);",
		"boolean answers return probability = P(true) with no confidence.",
		"Route on risk: higher-risk actions need higher confidence; low confidence goes to a human.",
	].join("\n"),
	parameters: Type.Object({
		state: Type.Optional(
			Type.Union([Type.String(), Type.Record(Type.String(), Type.Unknown())], {
				description:
					"The state / context to judge. A string, or a JSON object (preferred: name each relevant field — ticket, order, policy… — the decision model reads the state once and answers every question against it). Omit when using `states` batch mode.",
			}),
		),
		states: Type.Optional(
			Type.Union(
				[
					Type.Array(
						Type.Object({
							id: Type.String({ description: "Unique state key (used in the answers) — e.g. a commit hash or ticket id" }),
							state: Type.Union([Type.String(), Type.Record(Type.String(), Type.Unknown())], {
								description: "The state to judge (string or JSON object).",
							}),
						}),
					),
					Type.String(),
				],
				{
					description:
						"Batch mode: judge MULTIPLE independent states against the SAME questions. Each state is one request to the decision API, run SEQUENTIALLY by default (the server does not verify concurrency; raise STRANDS_MAX_CONCURRENCY only if you confirm your deployment tolerates it). Keep it modest, and prefer a single `state` with many questions when the items share context.",
				},
			),
		),
		questions: Type.Union([
			Type.Record(
				Type.String({ description: "questionId — only used to key the answers" }),
				Type.Object({
					type: Type.Union([Type.Literal("choice"), Type.Literal("score"), Type.Literal("boolean")], {
						description: "Kind of atomic judgement.",
					}),
					instructions: Type.Optional(
						Type.String({
							description: "What to judge — direct, single-dimension wording works best.",
						}),
					),
					criteria: Type.Optional(
						Type.Unknown({
							description:
								"choice: object of option→description (up to 255 options) or array of descriptions; score: array of level descriptions, low→high, 2-10 levels; boolean: omit.",
						}),
					),
				}),
			),
			// Model-quirk tolerance: driving models sometimes emit nested JSON (the
			// states array, the questions record) as a JSON-encoded string. pi validates
			// against the widened schema (string | structure) and hands both forms through.
			Type.String(),
		]),
	}),

	async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
		const parseMaybe = (v: unknown): unknown => {
			if (typeof v !== "string") return v;
			const s = v.trim();
			if (!(s.startsWith("{") || s.startsWith("["))) return v;
			try {
				return JSON.parse(s);
			} catch {
				return v;
			}
		};
		const state = parseMaybe(params.state) as unknown;
		const statesParsed = parseMaybe(params.states) as JevStateEntry[] | string | undefined;
		const questions = parseMaybe(params.questions) as Record<string, JevQuestion> | string | undefined;
		const states = Array.isArray(statesParsed) ? statesParsed : undefined;
		if (!questions || typeof questions !== "object" || Array.isArray(questions) || !Object.keys(questions).length) {
			throw new Error("questions is required (at least one question)");
		}
		if (!state && !(states && states.length)) {
			throw new Error("state is required (or pass `states` for batch mode)");
		}
		if (state && states && states.length) {
			throw new Error("Pass either `state` or `states`, not both");
		}

		const opts = {};
		const batchMode = states && states.length;
		const result = batchMode
			? await decideBatch(opts, states, questions as Record<string, JevQuestion>, signal)
			: await decide(opts, state, questions as Record<string, JevQuestion>, signal);
		const batch = result as JevBatchResult;

		const lines: string[] = [`channel: ${result.channel}`, `caveat: ${result.caveat}`];
		if (batchMode) {
			for (const [sid, qa] of Object.entries(batch.answers)) {
				lines.push(`state ${sid}:`, ...formatAnswers(qa).slice(1).map((l) => `  ${l}`));
			}
			if (batch.missingStates?.length) {
				lines.push(`WARNING: no answer for state(s): ${batch.missingStates.join(", ")}`);
			}
			if (batch.missingQuestions && Object.keys(batch.missingQuestions).length) {
				const parts = Object.entries(batch.missingQuestions).map(
					([qid, sids]) => `${qid} (${sids.length}/${states.length} states)`,
				);
				lines.push(`WARNING: question(s) silently dropped by some state(s): ${parts.join(", ")} - treat results as partial`);
			}
		} else {
			const single = result as JevDecisionResult;
			lines.push(...formatAnswers(single.answers));
			if (single.missingQuestions?.length) {
				lines.push(`WARNING: question(s) silently dropped: ${single.missingQuestions.join(", ")} - treat results as partial`);
			}
		}
		const meta: string[] = [];
		if (result.model) meta.push(`model=${result.model}`);
		if (result.elapsedMs !== undefined) meta.push(`elapsed=${(result.elapsedMs / 1000).toFixed(1)}s`);
		if (result.latencyMs !== undefined && result.latencyMs > 0) {
			meta.push(`decoder=${(result.latencyMs / 1000).toFixed(1)}s`);
		}
		if (result.usage) meta.push(`tokens in/out=${result.usage.inputTokens}/${result.usage.outputTokens}`);
		if (meta.length) lines.push(`perf: ${meta.join("  ")}`);

		return {
			content: [{ type: "text", text: lines.join("\n") }],
			details: result,
		};
	},
});

/** Compact model-facing answer lines for one answer map. */
function formatAnswers(answers: Record<string, JevAnswer>): string[] {
	const out: string[] = ["answers:"];
	for (const [id, a] of Object.entries(answers)) {
		if (a.type === "boolean") {
			out.push(`- ${id} [boolean] P(true)=${a.probability}`);
		} else {
			const top = Object.entries(a.probabilities ?? {})
				.sort((x, y) => y[1] - x[1])
				.slice(0, 3)
				.map(([k, v]) => `${k}=${v}`)
				.join(", ");
			out.push(`- ${id} [${a.type}] ${a.type === "choice" ? a.choice : a.score} (confidence=${a.confidence}) top: ${top}`);
		}
	}
	return out;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool(jevDecideTool);

	pi.registerCommand("strands-config", {
		description: "Show the resolved strands decision endpoint (add \"check\" for a live round trip)",
		handler: async (args, ctx) => {
			let cfg;
			try {
				cfg = resolveConfig();
			} catch (e) {
				const msg = (e as Error).message;
				if (ctx.hasUI) ctx.ui.notify(msg, "warning");
				else console.log(msg);
				return;
			}
			const lines: string[] = [
				`baseURL:  ${cfg.baseURL}`,
				`model:    ${cfg.model ?? "(server default: strands-decider-latest)"}`,
				`apiKey:   ${cfg.apiKey ? "***" : "(none)"}`,
				`timeout:  ${cfg.timeoutMs}ms   batch concurrency: ${cfg.maxConcurrency}`,
				`config:   ${cfg.configPath ?? "(built-in defaults — no strands-adapter.config.json)"}`,
				`question mapping: boolean → noul (the API's name for P(true)); choice/score pass through`,
			];

			// Live probe: /health tells us what is actually loaded and served right now.
			try {
				const res = await fetch(`${cfg.baseURL}/health`, {
					signal: AbortSignal.timeout(10000),
				});
				if (res.ok) {
					const h = (await res.json()) as Record<string, unknown>;
					lines.push(
						`health:  OK — ${h.model ?? "?"}${h.checkpoint ? ` (${h.checkpoint})` : ""}`,
						`         base=${h.base_model ?? "?"}  temp=${h.temperature ?? "?"}  device=${h.device ?? "?"}  slots=${h.num_slots ?? "?"}`,
					);
				} else {
					lines.push(`health:  HTTP ${res.status}`);
				}
			} catch (e) {
				lines.push(`health:  unreachable (${(e as Error).message})`);
			}

			if (String(args ?? "").trim().toLowerCase() === "check") {
				try {
					const t0 = Date.now();
					const ping = await decide({}, { probe: "connectivity check" }, {
						alive: { type: "boolean", instructions: "Is the decision endpoint answering normally?" },
					});
					const p = ping.answers.alive?.probability;
					lines.push(
						`check:   OK — ${ping.model ?? cfg.model ?? "server default"} answered in ${((Date.now() - t0) / 1000).toFixed(1)}s (P(alive)=${p})`,
					);
				} catch (e) {
					lines.push(`check:   FAILED — ${(e as Error).message}`);
				}
			}

			const text = lines.join("\n");
			if (ctx.hasUI) ctx.ui.notify(text, "info");
			else console.log(text);
		},
	});
}
