import type { JabbuConfig } from "../config";
import { landModeOf } from "../lanes/manager-pr-land";
import { defaultPrTools, type ProcRunner, type PrTools } from "../lanes/pr";
import { failureOf } from "../lanes/pr-land-steps";
import type { LanePrLand } from "../lanes/pr-land-types";
import { defaultGit, type GitRunner } from "../lanes/verify";
import { redact } from "../redact";
import { baseBranchOf, isAncestor, precondition, rejudge, type TaskLandDeps } from "./land";
import { landModeOfRow, type Prepared, type RemoteLandEnv, remoteIntegrityBase } from "./land-remote";
import { bunRunner, refreshTlaCovered } from "./land-tla-covered";
import type { TaskRow } from "./ledger";
import type { TaskLandRecord } from "./ledger-schema";

/** Steered into a worker sent back to work: it stacks new commits on the same branch. */
export const reworkPrompt = (branch: string, reason: string, notice: string): string =>
	[
		`[jabbu] PR 착지를 마치지 못했습니다: ${reason}. TASK를 다시 working으로 돌렸습니다.`,
		notice,
		`- 같은 브랜치 \`${branch}\`에 새 커밋을 쌓으세요. rebase·amend·force push는 하지 마세요(이미 올라간 커밋을 고쳐 쓰면 push가 거절됩니다).`,
		"- push·머지는 코어가 합니다. 끝나면 PROGRESS.md를 갱신하고 평소대로 Outcome을 선언하세요. 코어가 재판정과 누출 검사를 다시 돌린 뒤 같은 PR에 올립니다.",
	].join("\n");

/** The PR body's source: the acceptance criteria and that the re-judgement passed them (no outcome.md, no worktree file). */
export const summaryOf = (row: TaskRow): string =>
	redact(
		[
			`수락기준 ${row.acceptance.length}/${row.acceptance.length} 재판정 통과`,
			...row.acceptance.map((item) => `- ${item.id} ${item.text}`),
		].join("\n"),
	);

/** Whether the task's repository lands through a PR (`lanes.land` pr; for a task of a `dispatchHosts` host, the entry that names its path there). */
export async function landsViaPr(
	config: Pick<JabbuConfig, "lanes" | "recordsRepo" | "dispatchHosts">,
	row: TaskRow,
): Promise<boolean> {
	return (await landModeOfRow(config, row))?.config.mode === "pr";
}

/** The URL of the PR an `active` landing already opened for the task branch's current tip (`undefined`: land again). Another card's button on it runs and tells nothing again: the CI poll owns it. */
export async function openPrAtTip(
	row: TaskRow,
	record: TaskLandRecord | undefined,
	git: GitRunner,
): Promise<string | undefined> {
	const open = record?.state === "active" ? record.prLand : undefined;
	if (open?.url === undefined) return undefined;
	const tip = (await git(["-C", row.repo, "rev-parse", "--verify", "-q", `refs/heads/${row.branch}^{commit}`])).stdout;
	const known = open.pushedSha ?? record?.sha;
	return known !== undefined && tip.trim() === known ? open.url : undefined;
}

/**
 * The first half of a local task's landing: the base branch fetched and merged into the task branch in its worktree
 * (never a rebase; a conflict goes back to the worker), then the fixed tip judged again with the diff base of the merge.
 */
export async function prepareLocal(
	row: TaskRow,
	deps: TaskLandDeps,
	tools: PrTools,
	remote: string,
	saved: LanePrLand | undefined,
	run: ProcRunner = bunRunner,
): Promise<Prepared> {
	const git = deps.git ?? defaultGit;
	const refused = await precondition(git, row);
	if (refused !== undefined) return { stop: refused };
	const baseBranch = await baseBranchOf(git, row.repo);
	if (baseBranch === undefined) return { stop: "기준 브랜치(origin/HEAD·main·master)가 없음" };
	const tracking = `${remote}/${baseBranch}`;
	const trackingRef = `refs/remotes/${tracking}`;
	const fetched = await tools.git(["-C", row.repo, "fetch", remote, baseBranch], {
		cwd: row.repo,
		signal: new AbortController().signal,
	});
	if (fetched.code !== 0) throw new Error(`git fetch ${remote} ${baseBranch} 실패: ${failureOf(fetched)}`);
	const tipOf = async () =>
		(await git(["-C", row.repo, "rev-parse", "--verify", "-q", `refs/heads/${row.branch}^{commit}`])).stdout.trim();
	let sha = await tipOf();
	// The base branch moved on: merged into the task branch in its worktree (never a rebase); a conflict goes back to the worker.
	if (!(await isAncestor(git, row.repo, trackingRef, sha))) {
		const merged = await git(["-C", row.worktree, "-c", "commit.gpgsign=false", "merge", "--no-edit", tracking]);
		if (merged.code !== 0) {
			const abort = await git(["-C", row.worktree, "merge", "--abort"]);
			if (abort.code !== 0) return { stop: `merge --abort 실패: ${failureOf(abort)}` };
			const prev = saved ?? { branch: row.branch };
			const notice = `\`${tracking}\`와 merge 충돌: 같은 브랜치에서 \`git merge ${tracking}\`로 합치고 충돌을 해소한 뒤(rebase·amend·force push 금지) 다시 완료를 알리세요.`;
			return {
				rework: { reason: `\`${tracking}\` merge 충돌`, notice, prLand: { ...prev, bounces: (prev.bounces ?? 0) + 1 } },
				sha,
				baseBranch,
			};
		}
		// The base's own change to a TLA+-covered file stales the gate record, not the task's work: re-record when the model holds.
		const refreshed = await refreshTlaCovered(row.worktree, git, run);
		if (refreshed.kind === "stop") return { stop: refreshed.reason };
		if (refreshed.kind === "rework") {
			const prev = saved ?? { branch: row.branch };
			return {
				rework: {
					reason: "기준 브랜치 병합 뒤 TLA+ 모델 검사 실패",
					notice: refreshed.notice,
					prLand: { ...prev, bounces: (prev.bounces ?? 0) + 1 },
				},
				sha: await tipOf(),
				baseBranch,
			};
		}
		sha = await tipOf();
	}
	const base = (await git(["-C", row.repo, "merge-base", trackingRef, sha])).stdout.trim();
	const judged = await rejudge(row, sha, deps, tipOf, base === "" ? undefined : base);
	return judged === undefined ? { sha, baseBranch, repo: row.repo } : { stop: judged };
}

/**
 * The commit the integrity read of a task diffs from when the branch carries commits of the base branch (설계 3): the
 * merge-base of the fetched base branch and the branch tip, so the base's own changes are not read as the task's.
 * `undefined` = the task's `baseSha` stands (no pr mode, a branch not built on `baseSha`, nothing of the base in it and
 * no landing yet, or a git that could not answer). Handed to the judgement lazily: one with problems never fetches.
 */
export async function integrityBaseOf(
	config: Pick<JabbuConfig, "lanes" | "recordsRepo" | "dispatchHosts">,
	row: TaskRow,
	tools: PrTools = defaultPrTools,
	address?: RemoteLandEnv["address"],
): Promise<string | undefined> {
	if (row.host !== null) return remoteIntegrityBase({ config, run: undefined, tools, git: defaultGit, address }, row);
	if (row.baseSha === null) return undefined;
	const mode = await landModeOf(config, row.repo);
	const base = mode?.config.mode === "pr" ? await baseBranchOf(defaultGit, row.repo) : undefined;
	if (mode === undefined || base === undefined) return undefined;
	const remote = mode.config.remote ?? "origin";
	const tracking = `refs/remotes/${remote}/${base}`;
	const read = async (...args: string[]) => (await defaultGit(["-C", row.repo, ...args])).stdout.trim();
	const tip = await read("rev-parse", "--verify", "-q", `refs/heads/${row.branch}^{commit}`);
	if (tip === "" || !(await isAncestor(defaultGit, row.repo, row.baseSha, tip).catch(() => false))) return undefined;
	const known = await read("merge-base", tracking, tip);
	if (row.land === null && (known === "" || known === row.baseSha)) return undefined;
	const fetched = await tools.git(["-C", row.repo, "fetch", remote, base], {
		cwd: row.repo,
		signal: new AbortController().signal,
	});
	if (fetched.code !== 0) return undefined;
	return (await read("merge-base", tracking, tip)) || undefined;
}
