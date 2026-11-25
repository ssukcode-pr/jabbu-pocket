// 메일박스 TLA+ 모델 검사: 고정한 TLC(tla2tools.jar)로 spec/tla/mailbox의 cfg를 모두 돌린다.
// Mailbox.cfg는 위반 없이 끝나야 하고, broken-*.cfg·finding-*.cfg는 머리의 `\* expect: <규칙>`이 위반돼야 한다.
// Java가 없으면 로컬은 skip(0), `CI` 환경변수나 `--strict`이면 실패(1)다.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/** 불변 정식 릴리스 태그의 jar. 롤링 프리릴리스(v1.8.0)는 쓰지 않는다. README.md에 같은 값을 적는다. */
export const TLC = {
	tag: "v1.7.4",
	url: "https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar",
	sha256: "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88",
} as const;

/** 통과 모델이 넘을 수 없는 고유 상태 수. */
export const MAX_DISTINCT_STATES = 1_000_000;

export const MODEL_DIR = join("spec", "tla", "mailbox");
const PASS_CFG = "Mailbox.cfg";

/** CI(ci.yml의 actions/cache)와 로컬이 같이 쓰는 jar 경로. `JABBU_TLA_JAR`가 있으면 그 경로다. */
export function jarPath(env: Record<string, string | undefined> = process.env): string {
	if (env.JABBU_TLA_JAR) return env.JABBU_TLA_JAR;
	const cache = env.XDG_CACHE_HOME || join(homedir(), ".cache");
	return join(cache, "jabbu-pocket", `tla2tools-${TLC.tag}.jar`);
}

export type JavaGate = { kind: "run"; java: string } | { kind: "skip" | "fail"; message: string };

/** Java 유무와 엄격 모드로 실행·skip·실패를 정한다. 엄격 = `--strict` 또는 `CI` 환경변수가 있음. */
export function javaGate(java: string | null, strict: boolean): JavaGate {
	if (java !== null) return { kind: "run", java };
	return strict
		? { kind: "fail", message: "fail: java 없음 — CI/--strict에서는 TLA+ 검사를 건너뛸 수 없습니다" }
		: { kind: "skip", message: "skip: java 없음 (TLA+ 모델 검사를 건너뜁니다)" };
}

/** cfg 머리의 `\* expect: <규칙>`; 통과 모델(Mailbox.cfg)은 undefined. */
export function expectedViolation(cfgText: string): string | undefined {
	return /^\\\*\s*expect:\s*(\w+)\s*$/m.exec(cfgText)?.[1];
}

/** cfg의 PROPERTIES 절에 있는 이름들(시간 속성: TLC가 이름 대신 "Temporal properties were violated"로 알린다). */
export function temporalNames(cfgText: string): string[] {
	const names: string[] = [];
	let inProps = false;
	for (const raw of cfgText.split("\n")) {
		const line = raw.replace(/\\\*.*$/, "").trim();
		if (line === "") continue;
		if (/^[A-Z_]+$/.test(line)) {
			inProps = line === "PROPERTIES" || line === "PROPERTY";
			continue;
		}
		if (inProps) names.push(...line.split(/\s+/));
	}
	return names;
}

export interface TlcRun {
	exitCode: number;
	output: string;
}

/** 고유 상태 수 (`N distinct states found`의 마지막 값). */
export function distinctStates(output: string): number | undefined {
	const all = [...output.matchAll(/([\d,]+) distinct states found/g)];
	const last = all.at(-1)?.[1];
	return last === undefined ? undefined : Number(last.replaceAll(",", ""));
}

/** cfg 하나의 판정: 통과면 null, 아니면 실패 이유 한 줄. */
export function judgeRun(cfgName: string, cfgText: string, run: TlcRun): string | null {
	const expect = expectedViolation(cfgText);
	if (expect === undefined) {
		if (run.exitCode !== 0 || !run.output.includes("Model checking completed. No error has been found."))
			return `${cfgName}: 위반 없음이어야 하는데 TLC 종료 코드 ${run.exitCode}`;
		const states = distinctStates(run.output);
		if (states === undefined) return `${cfgName}: 고유 상태 수를 읽지 못했습니다`;
		if (states > MAX_DISTINCT_STATES) return `${cfgName}: 고유 상태 ${states}개 > 상한 ${MAX_DISTINCT_STATES}`;
		return null;
	}
	const temporal = temporalNames(cfgText).includes(expect);
	const seen = temporal
		? run.output.includes("Temporal properties were violated")
		: run.output.includes(`Invariant ${expect} is violated`);
	// TLC 1.7.x: 12 = 안전 속성 위반, 13 = 시간 속성 위반. 문법 오류 등 다른 실패를 위반 검출로 세지 않는다.
	const code = temporal ? 13 : 12;
	if (run.exitCode !== code || !seen)
		return `${cfgName}: ${expect} 위반을 검출하지 못했습니다 (종료 코드 ${run.exitCode})`;
	return null;
}

/** 모델 디렉터리의 cfg 목록: Mailbox.cfg가 먼저, 나머지는 이름순. */
export function modelConfigs(dir: string): string[] {
	const cfgs = readdirSync(dir)
		.filter((name) => name.endsWith(".cfg"))
		.sort();
	return [PASS_CFG, ...cfgs.filter((name) => name !== PASS_CFG)];
}

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/** 캐시의 jar가 sha256과 맞으면 그대로, 아니면 받아서 확인한 뒤 원자적으로 둔다. */
async function ensureJar(path: string): Promise<void> {
	if (existsSync(path) && sha256(readFileSync(path)) === TLC.sha256) return;
	const response = await fetch(TLC.url);
	if (!response.ok) throw new Error(`tla2tools.jar 내려받기 실패: HTTP ${response.status}`);
	const bytes = new Uint8Array(await response.arrayBuffer());
	const got = sha256(bytes);
	if (got !== TLC.sha256) throw new Error(`tla2tools.jar sha256 불일치: ${got}`);
	mkdirSync(join(path, ".."), { recursive: true });
	const tmp = `${path}.tmp-${process.pid}`;
	writeFileSync(tmp, bytes);
	renameSync(tmp, path);
}

async function runTlc(java: string, jar: string, dir: string, cfg: string, metaDir: string): Promise<TlcRun> {
	const proc = Bun.spawn(
		[
			java,
			"-XX:+UseParallelGC",
			"-cp",
			jar,
			"tlc2.TLC",
			"-deadlock", // 행이 다 끝난 상태에서 멈추는 것은 정상이다
			"-workers",
			"auto",
			"-cleanup",
			"-metadir",
			join(metaDir, cfg),
			"-config",
			cfg,
			"Mailbox.tla",
		],
		{ cwd: dir, stdout: "pipe", stderr: "pipe" },
	);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { exitCode, output: `${stdout}\n${stderr}` };
}

async function main(): Promise<number> {
	const strict = process.argv.includes("--strict") || Boolean(process.env.CI);
	const gate = javaGate(Bun.which("java"), strict);
	if (gate.kind !== "run") {
		(gate.kind === "fail" ? console.error : console.log)(gate.message);
		return gate.kind === "fail" ? 1 : 0;
	}
	const repo = join(import.meta.dir, "..");
	const dir = join(repo, MODEL_DIR);
	const jar = jarPath();
	await ensureJar(jar);
	const metaDir = join(tmpdir(), `jabbu-tla-${process.pid}`);
	const failures: string[] = [];
	try {
		for (const cfg of modelConfigs(dir)) {
			const started = Date.now();
			const run = await runTlc(gate.java, jar, dir, cfg, metaDir);
			const verdict = judgeRun(cfg, readFileSync(join(dir, cfg), "utf8"), run);
			const took = `${((Date.now() - started) / 1000).toFixed(1)}s`;
			if (verdict === null) {
				console.log(`ok   ${cfg} (${took}, 상태 ${distinctStates(run.output) ?? "?"}개)`);
			} else {
				failures.push(verdict);
				console.error(`FAIL ${verdict}\n${run.output.split("\n").slice(-40).join("\n")}`);
			}
		}
	} finally {
		rmSync(metaDir, { recursive: true, force: true });
	}
	console.log(`[tla-check] TLC ${TLC.tag}: cfg ${modelConfigs(dir).length}개 중 실패 ${failures.length}개`);
	return failures.length === 0 ? 0 : 1;
}

if (import.meta.main) process.exit(await main());
