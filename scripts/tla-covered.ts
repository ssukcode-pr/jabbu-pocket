// 덮인 파일 게이트: 메일박스 TLA+ 모델이 다루는 소스의 git blob id를 spec/tla/mailbox/covered.blobs와 대조한다.
// 하나라도 다르면 실패한다 — 모델을 다시 보고 `--record`로 새로 기록한다. Java 없이 돈다(`bun run check`).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** 모델(Mailbox.tla)이 다루는 파일. 저장소 루트 기준 posix 경로. */
export const COVERED = [
	"src/core/mailbox.ts",
	"src/core/mailbox-active-turn.ts",
	"src/core/mailbox-types.ts",
	"src/core/mailbox-commands.ts",
	"src/core/mailbox-sending.ts",
	"src/store/transitions.ts",
	"src/store/db.ts",
	"src/daemon/recovery.ts",
	"src/channel/pump.ts",
] as const;

export const BLOBS_FILE = "spec/tla/mailbox/covered.blobs";

/** `<blob>  <경로>` 줄들 → 경로별 blob. 빈 줄과 `#` 줄은 건너뛴다. */
export function parseBlobs(text: string): Map<string, string> {
	const blobs = new Map<string, string>();
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (trimmed === "" || trimmed.startsWith("#")) continue;
		const match = /^([0-9a-f]{40,64})\s+(\S+)$/.exec(trimmed);
		if (match?.[1] === undefined || match[2] === undefined) throw new Error(`${BLOBS_FILE}: 읽을 수 없는 줄: ${line}`);
		blobs.set(match[2], match[1]);
	}
	return blobs;
}

export function formatBlobs(blobs: ReadonlyMap<string, string>): string {
	const header = "# bun scripts/tla-covered.ts --record 가 쓴다. 이 파일들이 바뀌면 Mailbox.tla를 다시 본다.\n";
	return header + COVERED.map((path) => `${blobs.get(path)}  ${path}\n`).join("");
}

/** 기록과 다른 파일(바뀜·기록 없음) 경로, COVERED 순서. */
export function changedFiles(recorded: ReadonlyMap<string, string>, current: ReadonlyMap<string, string>): string[] {
	return COVERED.filter((path) => recorded.get(path) !== current.get(path));
}

function git(root: string, args: string[]): string {
	const proc = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
	if (proc.exitCode !== 0) throw new Error(`git ${args[0]} 실패: ${proc.stderr.toString().trim()}`);
	return proc.stdout.toString();
}

/** 작업 트리 파일의 blob id (`git hash-object`). */
function currentBlobs(root: string): Map<string, string> {
	const missing = COVERED.filter((path) => !existsSync(join(root, path)));
	if (missing.length > 0)
		throw new Error(`덮인 파일이 없습니다: ${missing.join(", ")} — COVERED 목록과 모델을 다시 보세요`);
	const ids = git(root, ["hash-object", "--", ...COVERED])
		.trim()
		.split("\n");
	return new Map(COVERED.map((path, i) => [path, ids[i] ?? ""]));
}

function main(): number {
	const root = git(process.cwd(), ["rev-parse", "--show-toplevel"]).trim();
	const file = join(root, BLOBS_FILE);
	const current = currentBlobs(root);
	if (process.argv.includes("--record")) {
		writeFileSync(file, formatBlobs(current));
		console.log(`[tla-covered] ${COVERED.length}개 파일을 ${BLOBS_FILE}에 기록했습니다`);
		return 0;
	}
	const recorded = existsSync(file) ? parseBlobs(readFileSync(file, "utf8")) : new Map<string, string>();
	const changed = changedFiles(recorded, current);
	if (changed.length === 0) {
		console.log(`[tla-covered] 덮인 파일 ${COVERED.length}개가 기록과 같습니다`);
		return 0;
	}
	for (const path of changed) console.error(`바뀜: ${path}`);
	console.error(
		`[tla-covered] 메일박스 TLA+ 모델이 덮는 파일 ${changed.length}개가 바뀌었습니다. ` +
			"spec/tla/mailbox/Mailbox.tla(규칙은 README.md)를 다시 보고 `bun scripts/tla-check.ts`로 확인한 뒤 " +
			"`bun scripts/tla-covered.ts --record`로 다시 기록하세요.",
	);
	return 1;
}

if (import.meta.main) {
	try {
		process.exit(main());
	} catch (error) {
		console.error(`[tla-covered] ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}
}
