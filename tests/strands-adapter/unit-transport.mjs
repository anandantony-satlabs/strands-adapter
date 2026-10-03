// Unit tests for strands-adapter: question-type translation, request/response
// mapping against the /v1/systemone wire shape, and batch sequencing. Mocked
// fetch, no network. Run: node tests/strands-adapter/unit-transport.mjs

const {
	buildWireQuestions,
	decide,
	decideBatch,
	resolveConfig,
	callSystemOne,
	mapWireAnswer,
} = await import("../../adapter.ts");

let pass = 0;
let fail = 0;
function ok(cond, name) {
	if (cond) {
		pass += 1;
		console.log(`PASS ${name}`);
	} else {
		fail += 1;
		console.log(`FAIL ${name}`);
	}
}
function eq(a, b, name) {
	ok(JSON.stringify(a) === JSON.stringify(b), `${name} (${JSON.stringify(a)} === ${JSON.stringify(b)})`);
}

// --- 1. translation: tool questions -> wire ------------------------------------
const wire = buildWireQuestions({
	a: { type: "choice", instructions: "Pick one", criteria: { eng: "code", ops: "infra" } },
	b: { type: "score", instructions: "Rate", criteria: ["low", "med", "high"] },
	c: { type: "boolean", instructions: "Is it true?" },
	d: { type: "choice", instructions: "Pick", criteria: ["red", "blue"] },
});
eq(wire.a, { type: "choice", instructions: "Pick one", criteria: { eng: "code", ops: "infra" } }, "choice object criteria passes through");
eq(wire.b, { type: "score", instructions: "Rate", criteria: ["low", "med", "high"] }, "score array criteria passes through");
eq(wire.c, { type: "noul", instructions: "Is it true?" }, "boolean maps to noul");
eq(wire.d.criteria, { "0": "red", "1": "blue" }, "choice array criteria coerced to {i: desc}");
ok(wire.c.criteria === undefined, "noul omits criteria");

// boolean with missing instructions -> default prompt
eq(
	buildWireQuestions({ x: { type: "boolean" } }).x.instructions,
	"Return the probability that the following statement is true.",
	"boolean defaults instructions",
);

// --- 2. answer mapping ---------------------------------------------------------
eq(mapWireAnswer({ type: "noul", noul: 0.8277 }), { type: "boolean", probability: 0.8277 }, "noul -> boolean probability");
eq(mapWireAnswer({ type: "noul", noul: -0.4 }), { type: "boolean", probability: 0 }, "noul clamped to [0,1]");
eq(
	mapWireAnswer({ type: "score", score: 1.1, legend: { "0": "low", "1": "med" }, probabilities: { "0": 0.3, "1": 0.7 }, confidence: 0.51 }),
	{ type: "score", score: 1.1, probabilities: { "0": 0.3, "1": 0.7 }, confidence: 0.51, legend: { "0": "low", "1": "med" } },
	"score answer passthrough with legend",
);
eq(mapWireAnswer({ type: "bogus" }), null, "unknown answer type -> null");

// --- 3. decide(): request body + response mapping, mocked fetch ----------------
const requests = [];
globalThis.fetch = async (url, opts) => {
	requests.push({ url: String(url), body: JSON.parse(String(opts.body)), headers: opts.headers });
	return {
		ok: true,
		status: 200,
		json: async () => ({
			model: "strands-decider-2B-hobson-v19",
			answers: {
				dept: { type: "choice", choice: "eng", probabilities: { eng: 0.9, ops: 0.1 }, confidence: 0.8 },
				sev: { type: "score", score: 1.02, legend: { "0": "low", "1": "med", "2": "high" }, probabilities: { "0": 0.2, "1": 0.6, "2": 0.2 }, confidence: 0.4 },
				hmn: { type: "noul", noul: 0.31 },
			},
			usage: { input_tokens: 100, output_tokens: 3 },
			latency_ms: 42.0,
		}),
	};
};

const res = await decide({ baseURL: "http://test" }, { commit: "x" }, {
	dept: { type: "choice", instructions: "team?", criteria: { eng: "code", ops: "infra" } },
	sev: { type: "score", instructions: "sev?", criteria: ["low", "med", "high"] },
	hmn: { type: "boolean", instructions: "needs human?" },
});

const req = requests[0];
eq(req.url, "http://test/v1/systemone", "posts to /v1/systemone");
eq(req.body.state, { commit: "x" }, "state sent verbatim");
eq(req.body.model, undefined, "no model sent by default");
eq(Object.keys(req.body.questions).length, 3, "all questions sent");
eq(req.body.questions.hmn, { type: "noul", instructions: "needs human?" }, "boolean mapped to noul on the wire");
ok(!req.headers.Authorization, "no auth header when no apiKey");

eq(res.answers.dept, { type: "choice", choice: "eng", probabilities: { eng: 0.9, ops: 0.1 }, confidence: 0.8 }, "choice answer surfaced");
eq(res.answers.hmn, { type: "boolean", probability: 0.31 }, "noul -> boolean surfaced");
eq(res.answers.sev.confidence, 0.4, "score confidence surfaced");
eq(res.model, "strands-decider-2B-hobson-v19", "model read from response");
eq(res.usage, { inputTokens: 100, outputTokens: 3 }, "usage mapped");
eq(res.latencyMs, 42.0, "latency_ms surfaced");
ok(res.elapsedMs !== undefined && res.elapsedMs >= 0, "elapsedMs present");
ok(res.missingQuestions === undefined, "no missing questions when all answered");

// --- 4. decide(): missing question reported ------------------------------------
globalThis.fetch = async () => ({
	ok: true,
	status: 200,
	json: async () => ({
		model: "m",
		answers: { only: { type: "noul", noul: 0.5 } },
		usage: {},
	}),
});
const res2 = await decide({ baseURL: "http://test" }, "st", {
	only: { type: "boolean", instructions: "q" },
	dropped: { type: "choice", instructions: "c", criteria: { a: "x", b: "y" } },
});
eq(res2.missingQuestions, ["dropped"], "dropped question reported");

// --- 5. decideBatch(): one request per state, sequential, keyed ----------------
const seq = [];
globalThis.fetch = async (url, opts) => {
	const b = JSON.parse(String(opts.body));
	seq.push(b.state);
	return {
		ok: true,
		status: 200,
		json: async () => ({
			model: "m",
			answers: { ok: { type: "noul", noul: 0.9 } },
			usage: { input_tokens: 10, output_tokens: 1 },
			latency_ms: 5,
		}),
	};
};
const batch = await decideBatch({ baseURL: "http://test" }, [
	{ id: "a", state: "first" },
	{ id: "b", state: "second" },
	{ id: "c", state: "third" },
], { ok: { type: "boolean", instructions: "fine?" } });
eq(seq, ["first", "second", "third"], "one sequential request per state");
eq(Object.keys(batch.answers), ["a", "b", "c"], "answers keyed by state id");
eq(batch.answers.a.ok, { type: "boolean", probability: 0.9 }, "per-state answer mapped");
eq(batch.usage, { inputTokens: 30, outputTokens: 3 }, "usage summed across states");
eq(batch.latencyMs, 15, "latency summed across states");

// --- 6. config resolution ------------------------------------------------------
const cfgDefault = resolveConfig({});
eq(cfgDefault.baseURL, "http://127.0.0.1:8008", "default baseURL");
eq(cfgDefault.maxConcurrency, 1, "default sequential batch");
const cfgOverride = resolveConfig({ baseURL: "http://other:8000", apiKey: "k", model: "v19" });
eq(cfgOverride.baseURL, "http://other:8000", "opts override baseURL");
eq(cfgOverride.apiKey, "k", "apiKey override");
eq(cfgOverride.model, "v19", "model override");

// --- 7. auth header when apiKey set --------------------------------------------
globalThis.fetch = async (url, opts) => {
	requests.push({ url: String(url), body: JSON.parse(String(opts.body)), headers: opts.headers });
	return { ok: true, status: 200, json: async () => ({ model: "m", answers: {}, usage: {} }) };
};
await callSystemOne({ baseURL: "http://test2", apiKey: "tok", timeoutMs: 1000, maxConcurrency: 1 }, "s", { q: { type: "boolean", instructions: "x" } }, undefined);
const authed = requests[requests.length - 1];
eq(authed.headers.Authorization, "Bearer tok", "Bearer header sent when apiKey set");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
