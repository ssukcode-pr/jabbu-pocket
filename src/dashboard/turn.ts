import { redact } from "../redact";
import { digest, type TaskJudgement } from "../tasks/checker";
import type { TaskRow } from "../tasks/ledger";
import type { TaskLandRecord } from "../tasks/ledger-schema";
import type { InboxEntry } from "./inbox";

/**
 * The inbox groups, one judgement for every view: `mine` (내 차례 — the owner answers or decides), `working` (진행 중 —
 * a worker or the machine has the turn), `read` (읽을 것 — reported done and not opened in this browser), `done`
 * (확인함). An entry's stored `col` is never `read`: read marks live in the browser and only {@link turnOf} adds them.
 */
export type TurnGroup = "mine" | "working" | "read" | "done";
type TurnMark = "!" | "spin" | "dot" | "ring";

/** What a row draws: its group, the mark at its left, one state word, its first line and one reason line. */
export interface Turn {
	group: TurnGroup;
	/** `!`, `spin`, `dot` or `ring` (spelled through the type so the Discord reaction scan of `mark:` literals skips it). */
	mark: TurnMark;
	word: string;
	line: string;
	reason: string;
}

/** The TASK fields {@link turnOf} reads beyond the TASK row's own: set by the snapshot from the ledger row. */
export interface TaskTurnFields {
	/** The repository's last path segment. */
	repo?: string;
	/** PROGRESS.md `question` of the owner decision; only when written. */
	decision?: { question: string };
	/** The task's own PR landing (`tasks.land_json`). */
	land?: TaskLandRecord["state"];
	/** `running`: a gate review/QA start is newer than its receipt. */
	gate?: "running";
	workerModel?: string;
	/**
	 * Where the sweep's judgement of a `working` TASK stands: `pending` — the documents meet every condition the page
	 * can read, so the sweep's `[check: …]` run (`pendingChecks`) or next pass decides; `diff` — its last unmet nudge
	 * was the branch diff over the read cap (`diff too large`); `nudgecap` — the nudges ran out (`nudgecap:` notice).
	 */
	judge?: "pending" | "diff" | "nudgecap";
}

/**
 * The one state judgement of an inbox entry ({@link TurnGroup}). `unread` only moves a pane that reported done from
 * 확인함 to 읽을 것; a 내 차례 entry stays there read or not (the owner answers on Discord, not by opening it).
 * The reason line never carries the judge's own wording (`diff too large`). Self-contained (shipped to the page).
 */
export function turnOf(entry: InboxEntry, unread = false): Turn {
	const { task, card } = entry;
	const herdr = task?.herdr;
	const one = (text: string | undefined): string => {
		const flat = (text ?? "")
			.replace(/\s+/g, " ")
			.trim()
			.replace(/diff too large/gi, "diff 상한 초과");
		return flat.length > 120 ? `${flat.slice(0, 119)}…` : flat;
	};
	const turn = (group: TurnGroup, word: string, reason?: string, question?: string): Turn => ({
		group,
		mark: group === "mine" ? "!" : group === "working" ? "spin" : group === "read" ? "dot" : "ring",
		word,
		line: one(question) || one(entry.title),
		reason: one(reason),
	});
	const open = task?.open === true ? task : undefined;
	const pane = herdr?.ok ? herdr.status : undefined;
	// A pane on the board speaks for itself; the TASK's own herdr read only counts for a TASK no card carries.
	const fail =
		open?.error ??
		(card !== undefined
			? card.unknown
				? `알 수 없는 상태 ${card.status || "?"}`
				: undefined
			: herdr !== undefined && !herdr.ok && herdr.error !== "herdr is not configured"
				? herdr.error
				: pane === "gone"
					? "워커 사라짐"
					: undefined);
	if (fail !== undefined) return turn("mine", "확인 필요", fail);
	if (open?.judge === "diff") return turn("mine", "판정 막힘", "변경이 커서 무결성 판정을 못 함 · 커밋 단위 확인 필요");
	if (open?.judge === "nudgecap") return turn("mine", "판정 막힘", "고칠 수 없는 미충족이 반복돼 재촉 한도에 닿음");
	const asked =
		(open?.status === "blocked" ? open.decision?.question : "") || (card?.status === "blocked" ? card.question : "");
	if (asked) return turn("mine", "질문", open?.progress?.blockedReason || "답을 기다림", asked);
	const paneStuck = card === undefined && pane !== undefined && !["working", "idle", "done"].includes(pane);
	if (open?.status === "blocked" || card?.status === "blocked" || (open !== undefined && paneStuck)) {
		const approval = card?.blocked?.startsWith("도구 실행 승인 대기") === true;
		const why = open?.progress?.blockedReason || card?.blocked || "에이전트 입력 대기";
		return turn("mine", approval ? "승인 대기" : "막힘", why);
	}
	// A working TASK whose pane is missing from the live board has lost its agent; a TASK in review needs none.
	if (entry.orphan && open?.status === "working") return turn("mine", "카드 없음", "에이전트 카드 없음");
	if (open?.status === "review") {
		if (open.land === "active") return turn("working", "착지 중", "PR 착지 진행 중");
		if (open.gate === "running") return turn("working", "게이트 진행", "독립 리뷰·실행 QA 진행 중");
		const held = open.land === "blocked" || open.land === "held";
		return turn("mine", "결정 대기", held ? "PR 착지 멈춤 · 오너 확인 필요" : "Outcome 도달 · 머지 결정 대기");
	}
	if (open !== undefined) {
		const busy = card === undefined ? pane === undefined || pane === "working" : card.column === "working";
		if (open.judge === "pending") return turn("working", "판정 대기", "문서 조건 충족 · 판정 기다림");
		return busy
			? turn("working", "진행 중", open.progress?.current)
			: turn("working", "판정 대기", "워커 턴 끝남 · 다음 판정 기다림");
	}
	if (card?.column === "working") return turn("working", "진행 중", `${card.workspaceLabel} · ${card.tabLabel}`);
	if (card?.status === "done" && unread) return turn("read", "완료", card.lastSay);
	return turn("done", card?.status === "done" ? "완료" : "쉬는 중", card?.lastSay);
}

/** The `unmet:` notice of the one problem a judgement has when the branch diff is over the read cap (`checkTask`). */
export const DIFF_TOO_LARGE_UNMET = `unmet:${digest(["diff를 읽지 못해 무결성 검사를 미룹니다: diff too large"])}`;

/** {@link TaskTurnFields} of an open TASK row and the page's own judgement of its documents (none when unreadable). */
export function taskTurnFields(
	row: TaskRow,
	judged: Pick<TaskJudgement, "reached" | "decision"> | undefined,
): TaskTurnFields {
	const fields: TaskTurnFields = {};
	const repo = row.repo
		.split(/[\\/:]/)
		.filter((part) => part !== "")
		.pop();
	if (repo !== undefined) fields.repo = repo;
	if (row.workerModel !== null) fields.workerModel = row.workerModel;
	if (row.land !== null) fields.land = row.land.state;
	const question = judged?.decision.question.trim() ?? "";
	if (question !== "") fields.decision = { question: redact(question) };
	const notices = Object.entries(row.notices);
	if (row.status === "review") {
		const started = notices.some(([key, at]) => {
			const kind = key.startsWith("gate:") ? /:(review|qa):\d+$/.exec(key)?.[1] : undefined;
			if (kind !== "review" && kind !== "qa") return false;
			const receipt = row.gate?.[kind];
			return receipt === undefined || receipt.at < at;
		});
		if (started) fields.gate = "running";
	}
	if (row.status !== "working") return fields;
	// The sweep's nudge base (`nudgeBase` in src/tasks/sweeper.ts): registration or the last resume.
	const resumes = notices.filter(([key]) => key.startsWith("resume:")).map(([key]) => Number(key.slice(7)));
	const base = Math.max(row.createdAt, ...resumes.filter((at) => Number.isFinite(at)));
	const lastUnmet = notices
		.filter(([key, at]) => key.startsWith("unmet:") && at >= base)
		.sort((a, b) => b[1] - a[1])[0]?.[0];
	if (`nudgecap:${base}` in row.notices) fields.judge = "nudgecap";
	else if (lastUnmet === DIFF_TOO_LARGE_UNMET) fields.judge = "diff";
	else if (judged?.reached === true) fields.judge = "pending";
	return fields;
}
