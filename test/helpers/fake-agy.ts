import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

/**
 * Fake `agy acp` for wire tests: JSON-RPC 2.0 over stdio as agy 1.5.16 speaks it. Driven by env plus prompt markers:
 * - FAKE_AGY_LOG: argv, every in/out message and marker events are appended there as JSON lines.
 * - FAKE_AGY_FLASH_LEVELS="low,medium": `gemini-3.8-flash` offers only those `thought_level` values.
 * - FAKE_AGY_UNKNOWN_SESSION=1: `session/load` fails like agy for a session it cannot find; a load that works replays
 *   the conversation as updates (a user chunk, an agent chunk, a tool call, usage 900/1000) before it answers.
 * - "@quota": streams agy's quota retry notice (RESOURCE_EXHAUSTED, code 429) split over two chunks and holds the
 *   prompt until `session/cancel`.
 * - FAKE_AGY_DEAF_CONFIG=1: `session/set_config_option` replies without changing the value.
 * - Session ids are `fake-<uuid>`; only those resume. The orchestrator model offers no `thought_level`.
 * - "@tool": a run_command tool call (in_progress, then completed with output) before the answer; with "@nooutput"
 *   the completion has no output, with "@failtool" it ends `failed`.
 * - "@hold": the prompt stays open until `session/cancel` (replies `cancelled`) or SIGUSR1 (answers HELD-DONE).
 * - "@hold-stdout": a detached bun sleeper holding stdout, then the prompt never answers (cancel is ignored
 *   too): the client's exit must settle on the exit code, not on stdout EOF. A text chunk goes after the spawn,
 *   so a test waiting for it knows the sleeper already exists.
 * - "@holdmsg": emits a text chunk before waiting on SIGUSR1 / `session/cancel` (no tool call).
 * - "@holdtool": a tool call in_progress until SIGUSR1 (completes it, answers HELD-TOOL-DONE) or `session/cancel`.
 * - "@deaf": starts a grandchild that connects to the unix socket FAKE_AGY_GRAND_SOCK and stays, reports a tool call
 *   in_progress, and ignores cancel.
 * - "@ask": sends `session/request_permission` (reject_once, allow_always, allow_once) and answers ASKED once the
 *   client replied; "@askalways" offers only allow_always and reject_once; "@askother" asks `fs/read_text_file`.
 * - initialize offers `promptCapabilities.image` unless FAKE_AGY_NO_IMAGE=1.
 * - "@lost": the prompt fails like agy's lost trajectory; "@lostload" only on a session opened by `session/load`.
 * - FAKE_AGY_HOLD_NEW=1: `session/new` answers only on `session/cancel` or SIGUSR1.
 * - "@refuse": replies `stopReason: "refusal"`. "@die": exits 3 mid-turn. "@longline": writes a 2MiB line with no newline, then holds the prompt (the client's line cap must end it). "@full" / "@half": `usage_update` used
 *   800 / 500 of size 1000 before the reply (otherwise 100). "@no-usage": the reply still carries usage, but no
 *   `usage_update` arrives, so the driver cannot judge rotation.
 * - anything else: answers `REPLY<n>:<last line of the prompt>` in two chunks (n = prompts of this process).
 */

const LOG = process.env.FAKE_AGY_LOG;
const appDataFlag = process.argv.indexOf("--app-data-dir");
const APP_DATA_DIR = appDataFlag !== -1 ? process.argv[appDataFlag + 1] : undefined;
const QUOTA_DIRS = new Set(
	(process.env.FAKE_AGY_QUOTA_DIRS ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s !== ""),
);
const END_QUOTA_DIRS = new Set(
	(process.env.FAKE_AGY_END_QUOTA_DIRS ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s !== ""),
);
const QUOTA_FILE = process.env.FAKE_AGY_QUOTA_FILE;
const isQuotaDir = (): boolean => {
	if (APP_DATA_DIR === undefined) return false;
	if (QUOTA_DIRS.has(APP_DATA_DIR)) return true;
	if (QUOTA_FILE === undefined) return false;
	try {
		return readFileSync(QUOTA_FILE, "utf8")
			.split(/[\s,]+/)
			.includes(APP_DATA_DIR);
	} catch {
		return false;
	}
};
const isEndQuotaDir = (): boolean => APP_DATA_DIR !== undefined && END_QUOTA_DIRS.has(APP_DATA_DIR);
const ECHO_DIR = process.env.FAKE_AGY_ECHO_DIR === "1";
const HOLD_INIT_DIR = process.env.FAKE_AGY_HOLD_INIT_DIR;
const HOLD_INIT_SOCK = process.env.FAKE_AGY_HOLD_INIT_SOCK;
const log = (entry: Record<string, unknown>): void => {
	if (LOG !== undefined) appendFileSync(LOG, `${JSON.stringify(entry)}\n`);
};
const send = (message: Record<string, unknown>): void => {
	log({ dir: "out", message });
	process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
};
log({ dir: "argv", argv: process.argv.slice(2) });

const MODELS = ["gemini-4-neon", "gemini-pro-orchestrator-neon", "gemini-3.8-flash"];
const LEVELS = ["low", "medium", "high", "xhigh"];
/** Narrowed `thought_level` set for gemini-3.8-flash (a model offering fewer levels than the persisted one). */
const FLASH_LEVELS = (process.env.FAKE_AGY_FLASH_LEVELS ?? "")
	.split(",")
	.map((s) => s.trim())
	.filter((s) => s !== "");
const levelsFor = (name: string): readonly string[] =>
	name === "gemini-3.8-flash" && FLASH_LEVELS.length > 0 ? FLASH_LEVELS : LEVELS;
let model = "gemini-4-neon";
let level = "high";
let sessionId = "";
/** Whether the current session was opened by `session/load` (what "@lostload" fails on). */
let loaded = false;
let prompts = 0;
let held: { id: unknown; onSignal: () => void; onCancel?: () => void } | undefined;

function configOptions(): Array<Record<string, unknown>> {
	const options: Array<Record<string, unknown>> = [
		{ id: "model", currentValue: model, options: MODELS.map((value) => ({ value, name: value })) },
		{ id: "mode", currentValue: "default", options: [{ value: "default", name: "Default" }] },
	];
	if (!model.includes("orchestrator")) {
		options.splice(1, 0, {
			id: "thought_level",
			currentValue: level,
			options: levelsFor(model).map((value) => ({ value })),
		});
	}
	return options;
}
const update = (body: Record<string, unknown>): void =>
	send({ method: "session/update", params: { sessionId, update: body } });
const usage = { inputTokens: 100, outputTokens: 7, cachedReadTokens: 40, cachedWriteTokens: 2, totalTokens: 149 };
const reply = (id: unknown, stopReason: string): void => send({ id, result: { stopReason, usage } });

function prompt(id: unknown, text: string): void {
	prompts += 1;
	const used = text.includes("@full") ? 800 : text.includes("@half") ? 500 : 100;
	const finish = (answer: string, stopReason = "end_turn"): void => {
		if (answer !== "") update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: answer } });
		if (!text.includes("@no-usage")) update({ sessionUpdate: "usage_update", used, size: 1000 });
		reply(id, stopReason);
	};
	update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hmm" } });
	update({ sessionUpdate: "brand_new_kind" });
	if (text.includes("@die")) process.exit(3);
	if (text.includes("@longline-nl")) {
		process.stdout.write(`${"x".repeat(2 * 1024 * 1024)}\n`);
		return;
	}
	if (text.includes("@longline")) {
		process.stdout.write("x".repeat(2 * 1024 * 1024));
		return;
	}
	if (text.includes("@refuse")) {
		finish("", "refusal");
		return;
	}
	const tool = { toolCallId: `call_${prompts}`, name: "run_command", kind: "execute", title: "echo hi" };
	const rawInput = { CommandLine: "echo hi" };
	if (text.includes("@holdtool")) {
		update({ sessionUpdate: "tool_call", ...tool, status: "in_progress", rawInput });
		held = {
			id,
			onSignal: () => {
				update({ sessionUpdate: "tool_call_update", ...tool, status: "completed", rawOutput: { output: "hi\n" } });
				finish("HELD-TOOL-DONE");
			},
			onCancel: () => reply(id, "cancelled"),
		};
		return;
	}
	if (text.includes("@tool-end-quota")) {
		update({ sessionUpdate: "tool_call", ...tool, status: "in_progress", rawInput, args: rawInput });
		update({ sessionUpdate: "tool_call_update", ...tool, status: "completed", rawOutput: { output: "hi\n" } });
		finish(
			"작업 중\n⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 15m59s.\n",
		);
		return;
	}
	if (text.includes("@end-quota") || isEndQuotaDir()) {
		finish("⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 15m59s.\n");
		return;
	}
	if (text.includes("@tool-quota")) {
		update({ sessionUpdate: "tool_call", ...tool, status: "in_progress", rawInput, args: rawInput });
		update({ sessionUpdate: "tool_call_update", ...tool, status: "completed", rawOutput: { output: "hi\n" } });
		held = { id, onSignal: () => finish("never"), onCancel: () => reply(id, "cancelled") };
		update({
			sessionUpdate: "agent_message_chunk",
			content: {
				type: "text",
				text: "Working\n⚠ API error (attempt 1): RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 1h15m",
			},
		});
		return;
	}
	if (text.includes("@quota") || isQuotaDir()) {
		// agy's own quota retry, split across chunks; it only stops on `session/cancel`.
		held = { id, onSignal: () => finish("never"), onCancel: () => reply(id, "cancelled") };
		update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Working\n⚠ API error (att" } });
		const detail = isQuotaDir() ? "Individual quota reached. Resets in 2h30m" : "out";
		update({
			sessionUpdate: "agent_message_chunk",
			content: { type: "text", text: `empt 1): RESOURCE_EXHAUSTED (code 429): ${detail}` },
		});
		return;
	}
	if (text.includes("@lost") && (loaded || !text.includes("@lostload"))) {
		send({ id, error: { code: -32603, message: `Trajectory not found: ${sessionId}` } });
		return;
	}
	if (text.includes("@ask")) {
		held = { id, onSignal: () => finish("ASKED") };
		const always = { optionId: "yes-always", kind: "allow_always" };
		const reject = { optionId: "no", kind: "reject_once" };
		const options = text.includes("@askalways")
			? [always, reject]
			: [reject, always, { optionId: "yes-once", kind: "allow_once" }];
		const toolCall = { toolCallId: "call_perm", title: "run\nrm -rf build" };
		const method = text.includes("@askother") ? "fs/read_text_file" : "session/request_permission";
		send({ id: "perm-1", method, params: { sessionId, toolCall, options } });
		return;
	}
	if (text.includes("@hold-stdout")) {
		// Detached (its own session, out of the driver's process group) and holding stdout: the sleeper is a
		// bun `-e` so no new binary is needed (cf. @deaf). The chunk goes after the spawn, so a test waiting
		// for it knows the sleeper already exists. No onCancel: the cancel goes unanswered, like @deaf, so the
		// driver kills the group and must still settle. SIGUSR2 emits one late JSON-RPC notification then exits.
		// sleep-ok: the sleeper's 30s bound is a safety cap, not a wait; the test kills it in cleanup.
		const sleeper = [
			'process.on("SIGUSR2", () => {',
			'  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { late: true } }) + "\\n");',
			"  process.exit(0);",
			"});",
			"await Bun.sleep(30_000); // sleep-ok: safety cap, test kills sleeper",
		].join("\n");
		const grand = spawn(process.execPath, ["-e", sleeper], {
			detached: true,
			stdio: ["ignore", "inherit", "ignore"],
		});
		grand.unref();
		log({ dir: "grand", pid: grand.pid });
		update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "WAIT\n" } });
		held = { id, onSignal: () => finish("HELD-DONE") };
		return;
	}
	if (text.includes("@holdmsg")) {
		held = { id, onSignal: () => finish("HELD-DONE"), onCancel: () => reply(id, "cancelled") };
		update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "WAIT\n" } });
		return;
	}
	if (text.includes("@hold")) {
		held = { id, onSignal: () => finish("HELD-DONE"), onCancel: () => reply(id, "cancelled") };
		return;
	}
	if (text.includes("@deaf")) {
		// The grandchild holds a connection to the test's socket: its close is the test's proof that it died.
		const grand = spawn(
			process.execPath,
			[
				"-e",
				"Bun.connect({ unix: process.env.FAKE_AGY_GRAND_SOCK, socket: { data() {} } }); setInterval(() => {}, 1e9);",
			],
			{ stdio: "ignore" },
		);
		log({ dir: "grand", pid: grand.pid });
		held = { id, onSignal: () => finish("DEAF-DONE") };
		update({
			sessionUpdate: "tool_call",
			toolCallId: "call_deaf",
			name: "run_command",
			status: "in_progress",
			rawInput: {},
		});
		return;
	}
	if (text.includes("@tool")) {
		update({ sessionUpdate: "tool_call", ...tool, status: "in_progress", rawInput, args: rawInput });
		const status = text.includes("@failtool") ? "failed" : "completed";
		const output = text.includes("@nooutput") ? {} : { rawOutput: { output: "hi\n", exit_code: 0 } };
		update({ sessionUpdate: "tool_call_update", ...tool, status, rawInput, ...output });
	}
	const last = text.split("\n").at(-1) ?? "";
	const tag = ECHO_DIR ? `[${APP_DATA_DIR ?? "default"}] ` : "";
	update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `REPLY${prompts}:${tag}` } });
	finish(last);
}

process.on("SIGUSR1", () => {
	const current = held;
	held = undefined;
	current?.onSignal();
});

createInterface({ input: process.stdin }).on("line", (line) => {
	if (line.trim() === "") return;
	const message = JSON.parse(line) as { id?: unknown; method?: string; params?: Record<string, unknown> };
	log({ dir: "in", message });
	const params = message.params ?? {};
	if (message.method === undefined) {
		// The client's answer to `@ask`: the held prompt answers once it arrived.
		const current = held;
		held = undefined;
		return current?.onSignal();
	}
	switch (message.method) {
		case "initialize": {
			const replyInit = () =>
				send({
					id: message.id,
					result: {
						protocolVersion: 1,
						agentCapabilities: {
							loadSession: true,
							...(process.env.FAKE_AGY_NO_IMAGE === "1" ? {} : { promptCapabilities: { image: true } }),
						},
					},
				});
			if (HOLD_INIT_DIR !== undefined && HOLD_INIT_SOCK !== undefined && APP_DATA_DIR === HOLD_INIT_DIR) {
				let released = false;
				const release = () => {
					if (released) return;
					released = true;
					replyInit();
				};
				void Bun.connect({
					unix: HOLD_INIT_SOCK,
					socket: {
						data() {
							release();
						},
						close() {
							release();
						},
						error() {
							release();
						},
					},
				}).catch(() => release());
				return;
			}
			return replyInit();
		}
		case "session/new": {
			const open = (): void => {
				sessionId = `fake-${randomUUID()}`;
				loaded = false;
				send({ id: message.id, result: { sessionId, configOptions: configOptions() } });
			};
			if (process.env.FAKE_AGY_HOLD_NEW !== "1") return open();
			held = { id: message.id, onSignal: open, onCancel: open };
			return;
		}
		case "session/load": {
			const wanted = String(params.sessionId);
			if (!wanted.startsWith("fake-") || process.env.FAKE_AGY_UNKNOWN_SESSION === "1") {
				return send({ id: message.id, error: { code: -32602, message: `Session not found: ${wanted}` } });
			}
			sessionId = wanted;
			loaded = true;
			// Like agy, load replays the conversation as updates before it answers.
			update({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "old question" } });
			update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "REPLAYED" } });
			update({ sessionUpdate: "tool_call", toolCallId: "call_old", name: "run_command", status: "completed" });
			update({ sessionUpdate: "usage_update", used: 900, size: 1000 });
			return send({ id: message.id, result: { configOptions: configOptions() } });
		}
		case "session/set_config_option": {
			const value = String(params.value);
			if (process.env.FAKE_AGY_DEAF_CONFIG !== "1") {
				if (params.configId === "model") {
					if (!MODELS.includes(value)) {
						return send({ id: message.id, error: { code: -32602, message: `Unknown model ID ${value}` } });
					}
					model = value;
				} else if (params.configId === "thought_level") {
					if (model.includes("orchestrator") || !levelsFor(model).includes(value)) {
						return send({
							id: message.id,
							error: { code: -32602, message: `Thinking level "${value}" is not offered` },
						});
					}
					level = value;
				}
			}
			update({ sessionUpdate: "config_option_update", configOptions: configOptions() });
			return send({ id: message.id, result: { configOptions: configOptions() } });
		}
		case "session/prompt": {
			const blocks = Array.isArray(params.prompt) ? (params.prompt as Array<{ text?: string }>) : [];
			return prompt(message.id, blocks.map((block) => block.text ?? "").join(""));
		}
		case "session/cancel": {
			const current = held;
			if (current?.onCancel === undefined) return;
			held = undefined;
			return current.onCancel();
		}
		default:
			if (message.id !== undefined) send({ id: message.id, error: { code: -32601, message: "method not found" } });
	}
});
