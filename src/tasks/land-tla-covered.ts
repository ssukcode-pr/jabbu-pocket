// After the landing merges the base branch into a task branch, the TLA+ covered-file gate (`scripts/tla-covered.ts`)
// fails whenever the base itself changed a covered file: the task's own work did not stale the model. When the model
// still checks against the merged tree (`scripts/tla-check.ts --strict`), the record is rewritten and committed on the
// task branch; when it does not, the task goes back to its worker. A repository without the gate is left alone.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ProcResult, ProcRunner } from "../lanes/pr";
import type { GitRunner } from "../lanes/verify";
import { buildChildEnv } from "../omp/env";

const COVERED = "scripts/tla-covered.ts";
const CHECK = "scripts/tla-check.ts";
/** TLC over every cfg ran about 30 seconds on the 4-core host (11-25); room for a loaded host. */
const TLA_TIMEOUT_MS = 600_000;
const TAIL_CHARS = 600;

export type CoveredRefresh =
	| { kind: "none" } // no gate, or the record still matches
	| { kind: "recorded"; files: string[] } // model checked, record rewritten and committed
	| { kind: "rework"; notice: string } // the merged tree breaks the model: the worker must look
	| { kind: "stop"; reason: string }; // the refresh itself could not run

/** `bun <script>` in `cwd`, killed after `TLA_TIMEOUT_MS`. */
export const bunRunner: ProcRunner = async (argv, { cwd, signal }) => {
	const proc = Bun.spawn([process.execPath, ...argv], {
		cwd,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		env: buildChildEnv({ LC_ALL: "C" }),
	});
	const timer = setTimeout(() => proc.kill("SIGKILL"), TLA_TIMEOUT_MS);
	const onAbort = () => proc.kill("SIGKILL");
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		const [stdout, stderr, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return { code, stdout, stderr };
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", onAbort);
	}
};

const tailOf = (result: ProcResult): string => `${result.stdout}\n${result.stderr}`.trim().slice(-TAIL_CHARS);

/** Re-records the covered-file gate of `worktree` after a base merge when the model still holds; see the file header. */
export async function refreshTlaCovered(
	worktree: string,
	git: GitRunner,
	run: ProcRunner = bunRunner,
): Promise<CoveredRefresh> {
	if (!existsSync(join(worktree, COVERED)) || !existsSync(join(worktree, CHECK))) return { kind: "none" };
	const opts = { cwd: worktree, signal: new AbortController().signal };
	const covered = await run([COVERED], opts);
	if (covered.code === 0) return { kind: "none" };
	if (covered.code !== 1)
		return { kind: "stop", reason: `${COVERED} 실행 실패(exit ${covered.code}): ${tailOf(covered)}` };
	const checked = await run([CHECK, "--strict"], opts);
	if (checked.code !== 0) {
		return {
			kind: "rework",
			notice: `기준 브랜치를 합친 뒤 TLA+ 모델 검사(\`bun ${CHECK} --strict\`)가 실패했습니다. 합쳐진 메일박스 변경에 맞게 모델을 고치고 \`bun ${COVERED} --record\`로 다시 기록하세요.\n${tailOf(checked)}`,
		};
	}
	const recorded = await run([COVERED, "--record"], opts);
	if (recorded.code !== 0) return { kind: "stop", reason: `${COVERED} --record 실패: ${tailOf(recorded)}` };
	const changed = (await git(["-C", worktree, "status", "--porcelain", "--", "spec"])).stdout
		.split("\n")
		.map((line) => line.slice(3).trim())
		.filter((path) => path.endsWith("covered.blobs"));
	if (changed.length === 0)
		return { kind: "stop", reason: `${COVERED}가 바뀜을 알렸지만 --record 뒤 바뀐 covered.blobs가 없음` };
	const added = await git(["-C", worktree, "add", "--", ...changed]);
	if (added.code !== 0) return { kind: "stop", reason: `git add 실패: ${added.stderr.trim()}` };
	const committed = await git([
		"-C",
		worktree,
		"-c",
		"commit.gpgsign=false",
		"commit",
		"-q",
		"-m",
		"covered.blobs 다시 기록: 기준 브랜치 병합으로 덮인 파일이 바뀜, TLA+ 모델 검사 통과",
	]);
	if (committed.code !== 0) return { kind: "stop", reason: `git commit 실패: ${committed.stderr.trim()}` };
	return { kind: "recorded", files: changed };
}
