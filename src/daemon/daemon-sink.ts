import { randomBytes } from "node:crypto";
import { errorFields } from "../channel/text";
import type { CoreSink, DeliveryItem, DeliverySource } from "../channel/types";
import { type JabbuConfig, primaryOwnerUserId } from "../config";
import { parseThreadRef, TOP_LEVEL_TS, threadRefOf } from "../core/normalize";
import { sessionDirFor } from "../core/origin";
import { type ChatPlatform, parseChatOrigin } from "../core/origin-key";
import { COMMAND_TEXT, parseCommand } from "../core/types";
import { borrowThreadOf, chatStartReplyFor } from "../lanes/borrow-thread";
import { type LaneAction, parseLaneActionId } from "../lanes/card";
import { classifyLaneControl } from "../lanes/control";
import type { LaneManager } from "../lanes/manager";
import { LaneInputError } from "../lanes/manager-constants";
import { parseReservationActionId, type ReservationAction } from "../lanes/reservations";
import { isLaneOrigin, isTaskOrigin, type LaneRow, taskOriginKey } from "../lanes/status";
import {
	buildClosedLaneQuestion,
	DISCORD_LANE_CHANNEL_MISSING,
	isOwnerAcceptText,
	type LaneTrigger,
	parsePrCommand,
	parsePrWatchCommand,
} from "../lanes/trigger";
import { assertNoSpacedPath } from "../lanes/trigger-format";
import { triggerWorkflow } from "../lanes/workflow";
import { MONITOR_ORIGIN_PREFIX } from "../monitors/ledger";
import { parseOpsPanelActionId } from "../ops/ops-panel";
import { parsePickerActionId } from "../ops/picker";
import { parseApprovalRetryActionId } from "../safety/approval";
import { AMBIGUOUS_NOTICE_OP_PREFIX, INTERIM_INFIX, LOG_COPY_SUFFIX, PEER_SILENCE_OP_PREFIX } from "../store/db";
import type { DeliveryRow, InboundRow } from "../store/db-rows";
import type { TaskRow } from "../tasks/ledger";
import type { CrashPoint } from "./crash";
import {
	DRAIN_DEFERRED_COMMAND_TEXT,
	LANE_DRAIN_REFUSED_TEXT,
	PEER_HOP_NOTICE_CURSOR,
	PEER_HOP_RESET_CURSOR,
} from "./daemon-constants";
import { approvalOf, type DaemonContext, dispatchPending, postThreadNotices, startedStore } from "./daemon-context";
import type { DaemonOpsPanel } from "./daemon-ops-panel";
import type { DaemonCommandPicker } from "./daemon-picker";
import type { DaemonStore } from "./daemon-store";
import type { PendingDispatchSweep } from "./daemon-sweeps";
import type { DaemonTaskLanding } from "./daemon-task-land";
import { taskMailboxPort, taskRuntimeOf } from "./daemon-task-resume";
import { withControlSource } from "./daemon-task-web";
import { type LaneTriggerLine, laneInbound, laneTriggerLine } from "./lane-sibling";
import { isSideOpRef } from "./restart";
import { inlineBorrowThreadRef, laneChannelOf, WEB_LANE_REFUSED } from "./thread-target";

/** What the core sink needs beyond the daemon context: the boot's ledger and the state other daemon parts share. */
export interface CoreSinkDeps {
	store: DaemonStore;
	sessionsRoot: string;
	/** Threads told "재시작 뒤에 처리" for an owner message held by the current drain: once per thread per drain. */
	drainDeferNoticed: Set<string>;
	pending: PendingDispatchSweep;
	landing: DaemonTaskLanding;
	opsPanel?: DaemonOpsPanel;
	picker?: DaemonCommandPicker;
	statusText: (originKey: string) => Promise<string>;
}

/** Inbound side of the daemon: core sink and lane/[TASK] commands settled without an omp session. */
export class DaemonInbound {
	readonly #ctx: DaemonContext;

	constructor(ctx: DaemonContext) {
		this.#ctx = ctx;
	}

	get #lanes(): LaneManager | undefined {
		return this.#ctx.lanes;
	}

	/** The core side of every chat adapter: owner and peer messages, slash commands, card replies and buttons. */
	coreSink(deps: CoreSinkDeps): CoreSink {
		const ctx = this.#ctx;
		const store = deps.store;
		const log = ctx.log;
		const sessionsRoot = deps.sessionsRoot;
		const core: CoreSink = {
			onInbound: (message) => {
				// Route lane-thread messages to the lane origin; closed-lane questions carry the answer-only prefix. A `작업:`
				// line in a lane's thread is neither: it opens a sibling lane of that one, settled here with the start's answer.
				const { lane, closedAs, sibling } = laneInbound(store.getLaneByThread(message.threadRef), message.text);
				const originKey = lane?.originKey ?? message.originKey;
				store.ensureOrigin(originKey, lane?.sessionDir ?? sessionDirFor(sessionsRoot, originKey, 1));
				const { inserted, row } = store.recordInbound({
					originKey,
					platformMessageId: message.platformMessageId,
					textRef: closedAs === "question" ? buildClosedLaneQuestion(message.text) : message.text,
					threadRef: message.threadRef,
					injected: message.injected === true,
				});
				if (!inserted) return { duplicate: true };
				// An owner message lets a peer-capped thread continue: the cap counts peer rows after this moment.
				if (store.countPeerInboundSince(message.threadRef, 0) > 0) {
					store.setCursor(`${PEER_HOP_RESET_CURSOR}${message.threadRef}`, String(ctx.clock.now()));
				}
				if (parseCommand(message.text)?.kind === "restart") {
					// Ahead of every lane, task and drain branch: the mailbox answers `!restart` at once, mid-drain too (held
					// for the next process it would restart again), without a turn or a driver.
					dispatchPending(ctx, originKey);
					return {};
				}
				// `!prwatch off <레인>` stops a published PR's tracking; the core settles it wherever the owner writes it,
				// and the lane's omp session never sees it (the lane is named, so no position in a thread implies it).
				const prWatch = parsePrWatchCommand(message.text);
				if (prWatch !== undefined) {
					void this.#settleLaneCommand(
						row,
						"problem" in prWatch ? "-" : prWatch.lane,
						"problem" in prWatch
							? { kind: "refused", text: prWatch.problem }
							: { kind: "prwatch-off", lane: prWatch.lane },
					);
					return {};
				}
				if (lane) {
					// A `작업:` line opens a sibling of this lane: answered here, the lane session never sees it.
					if (sibling !== undefined) {
						this.#settleLaneTrigger(row, sibling);
						return {};
					}
					// `멈춰`/`계속` (the whole message) are the lane's hold and release: the core settles them itself,
					// before any closed-lane reading — a closed lane's pause holds only its auto-merge.
					const control = classifyLaneControl(message.text);
					// A resume phrase settles only when a hold exists (paused lane or closed auto-merge); in a working lane it reaches omp.
					if (control !== undefined && (control === "pause" || lane.status === "paused" || closedAs !== undefined)) {
						void this.#settleLaneControl(row, lane.name, control);
						return {};
					}
					if (lane.status === "paused") this.#heldLaneNotice(lane);
					// The core settles these itself; they never reach the lane's omp session.
					const refusal = closedAs === "reopen" ? ctx.lanes?.reopenRefusal(lane) : undefined;
					if (closedAs === "land" || closedAs === "discard") {
						void this.#settleLaneCommand(row, lane.name, { kind: closedAs });
						return {};
					}
					// `!pr …` marks the closed lane's work as a GitHub PR; the lane session never sees it.
					const prCommand = closedAs === "pr" ? parsePrCommand(message.text) : undefined;
					if (prCommand !== undefined) {
						void this.#settleLaneCommand(
							row,
							lane.name,
							"problem" in prCommand ? { kind: "refused", text: prCommand.problem } : { kind: "pr", ...prCommand },
						);
						return {};
					}
					if (lane.status === "not-done" && isOwnerAcceptText(message.text)) {
						void this.#settleLaneCommand(row, lane.name, { kind: "accept" });
						return {};
					}
					if (refusal !== undefined) {
						void this.#settleLaneCommand(row, lane.name, { kind: "refused", text: refusal });
						return {};
					}
					ctx.lanes?.onOwnerMessage(lane, message.text);
				} else {
					// `멈춰`/`계속` (the whole message) in a [TASK] thread hold or release that thread's one active task; the
					// core settles it like a lane control. A thread without an active task keeps the message as it is.
					const control = store.tasks.isTaskRoot(message.threadRef) ? classifyLaneControl(message.text) : undefined;
					if (control !== undefined && this.#activeTasksOf(message.threadRef).length > 0) {
						void this.#settleTaskControl(row, control);
						return {};
					}
					const own = laneTriggerLine(message.text);
					if (own !== undefined) {
						this.#settleLaneTrigger(row, own);
						return {};
					}
				}
				if (ctx.router?.draining === true) {
					// Restart drain: the row stays pending for the next process (or the cancel) to dispatch. The owner hears
					// so once per thread, or a held message looks ignored (independent of `restartNotice`). A slash command
					// answers with the same text itself (onCommand).
					log.info("drain_deferred", { origin: originKey, id: row.platformMessageId });
					if (!row.platformMessageId.startsWith("slash:") && !deps.drainDeferNoticed.has(message.threadRef)) {
						deps.drainDeferNoticed.add(message.threadRef);
						postThreadNotices(ctx, [message.threadRef], DRAIN_DEFERRED_COMMAND_TEXT);
					}
					return {};
				}
				// Recorded durably first; dispatch (which may start omp) must not delay the 👀 acknowledgement.
				dispatchPending(ctx, originKey);
				return {};
			},
			onPeerInbound: (message, hop) => {
				// Never the owner paths: no lane routing, no `!reopen`, no lane trigger, no command. A peer in a work lane's own
				// thread is dropped before any row exists; in a borrowed thread it reaches the conversation, open lane or closed.
				if (store.getInbound(message.platformMessageId) !== undefined) return { duplicate: true };
				const lane = store.getLaneByThread(message.threadRef);
				if (lane !== undefined && lane.meta.borrowedThread !== true) return { dropped: "peer_in_lane_thread" };
				const resetAt = store.getCursor(`${PEER_HOP_RESET_CURSOR}${message.threadRef}`);
				const since = Math.max(ctx.clock.now() - hop.windowMs, resetAt === undefined ? 0 : Number(resetAt) + 1);
				if (store.countPeerInboundSince(message.threadRef, since) >= hop.turns) {
					// One notice per cap episode: the marker is the owner-reset moment it was posted under.
					const marker = resetAt ?? "0";
					const noticeKey = `${PEER_HOP_NOTICE_CURSOR}${message.threadRef}`;
					const notice = store.getCursor(noticeKey) !== marker;
					if (notice) store.setCursor(noticeKey, marker);
					return { dropped: "peer_hop_cap", notice };
				}
				store.ensureOrigin(message.originKey, sessionDirFor(sessionsRoot, message.originKey, 1));
				const { inserted, row } = store.recordInbound({
					originKey: message.originKey,
					platformMessageId: message.platformMessageId,
					textRef: message.text,
					threadRef: message.threadRef,
					peerUserId: message.peer.userId,
				});
				if (!inserted) return { duplicate: true };
				if (ctx.frozen() !== undefined) {
					// Recorded only: the mailbox holds autonomous rows while frozen, the first sweep after the unfreeze runs it.
					log.info("frozen_deferred", { origin: message.originKey, id: row.platformMessageId });
					deps.pending.frozenHeldOrigins.add(message.originKey);
					return { held: "frozen" };
				}
				if (ctx.router?.draining === true) {
					log.info("drain_deferred", { origin: message.originKey, id: row.platformMessageId });
					return {};
				}
				dispatchPending(ctx, message.originKey);
				return {};
			},
			onPeerSeen: (seen) => void store.notePeerSeen(seen),
			onCommand: ({ command, arg, originKey, channel }) => {
				if (command === "status") return deps.statusText(originKey);
				// Slash commands run at the conversation top level with no placeholder root post.
				core.onInbound({
					platformMessageId: `slash:${channel}:${randomBytes(6).toString("hex")}`,
					originKey,
					ownerVerified: true,
					text: arg === "" ? COMMAND_TEXT[command] : `${COMMAND_TEXT[command]} ${arg}`,
					threadRef: threadRefOf(channel, TOP_LEVEL_TS),
				});
				// Commands during drain run after restart except `!restart` (already settled on ledger).
				return ctx.router?.draining === true && command !== "restart" ? DRAIN_DEFERRED_COMMAND_TEXT : undefined;
			},
			knowsThread: (threadRef) => store.getLaneByThread(threadRef) !== undefined || store.hasInboundThread(threadRef),
			hasInbound: (platformMessageId) => store.getInbound(platformMessageId) !== undefined,
			inboundText: (platformMessageId) => store.getInbound(platformMessageId)?.textRef,
			inboundOrigin: (platformMessageId) => store.getInbound(platformMessageId)?.originKey,
			isDraining: () => ctx.router?.draining === true,
			// The thread of an approval card is `<card channel>:<card ts>` — the ledger's approval id.
			onCardReply: ({ threadRef, platformMessageId, text, injected }) => {
				const ts = parseThreadRef(platformMessageId)?.threadTs ?? platformMessageId;
				return approvalOf(ctx).handleCardReply({ approvalId: threadRef, ts, text, injected });
			},
			onAction: ({ actionId, value, values, userId, channel, messageTs, interactionId, replyEphemeral }) => {
				if (approvalOf(ctx).handleAction({ actionId, userId, answerId: interactionId })) return;
				const opsAction = parseOpsPanelActionId(actionId);
				if (opsAction !== undefined) return deps.opsPanel?.handleAction(opsAction, replyEphemeral);
				const pickerAction = parsePickerActionId(actionId);
				if (pickerAction !== undefined)
					return deps.picker?.handleAction(pickerAction, { values, channel, messageTs, replyEphemeral });
				const retry = parseApprovalRetryActionId(actionId);
				if (retry !== undefined)
					return deps.landing.handleApprovalRetry(`${retry.channel}:${retry.ts}`, channel, messageTs);
				const taskAction = deps.landing.handleTaskAction(actionId, value, channel, messageTs);
				if (taskAction !== undefined) return taskAction;
				const reservationAction = parseReservationActionId(actionId);
				if (reservationAction !== undefined)
					return this.#handleReservationButton(reservationAction, channel, messageTs);
				const laneAction = parseLaneActionId(actionId);
				if (laneAction !== undefined) return this.#handleLaneButton(laneAction, channel, messageTs);
				log.info("action_ignored", { action: actionId, user: userId });
			},
		};
		return core;
	}

	/** `작업: <제목> @<경로>`: settled with its own answer (the lane's thread is the real output), never sent to omp. */
	async #startLane(row: InboundRow, trigger: LaneTrigger): Promise<void> {
		await this.#settleOwn("lane", "lane_start", row, async () => {
			const channel = laneChannelOf(this.#ctx, row.originKey, parseThreadRef(row.threadRef)?.channel);
			try {
				const platform = parseChatOrigin(row.originKey)?.platform;
				if (platform === "web") throw new LaneInputError(WEB_LANE_REFUSED);
				if (channel === undefined && platform === "discord") throw new LaneInputError(DISCORD_LANE_CHANNEL_MISSING);
				const lanes = this.#lanes;
				if (!lanes || channel === undefined) throw new Error("lanes unavailable");
				assertNoSpacedPath(trigger.cwd, trigger.brief);
				// Only a workflow call at the very start of the brief is a choice; the call is cut from the brief.
				const called = triggerWorkflow(trigger.brief);
				const lane = await lanes.start({
					...trigger,
					...(called === undefined ? {} : { brief: called.brief, workflow: called.choice }),
					channel,
					parentOrigin: row.originKey,
					reuseOpen: true,
					...borrowThreadOf(row.originKey, inlineBorrowThreadRef(this.#ctx, row.originKey, row.threadRef)),
				});
				return chatStartReplyFor(lane, row.threadRef, () => lanes.threadLink(lane));
			} catch (error) {
				if (error instanceof LaneInputError) return `⚠️ 작업 레인을 시작하지 못했습니다: ${error.message}`;
				this.#ctx.log.error("lane_start_failed", { id: row.platformMessageId, ...errorFields(error) });
				return "⚠️ 작업 레인을 시작하지 못했습니다. 로그를 확인하세요.";
			}
		});
	}

	/**
	 * A `작업:` line, settled with its own answer (never sent to omp): a trigger starts a lane — in a lane's thread a
	 * sibling of it — unless a restart drain is on (no worktree mid-restart, and the row would reach omp after it: refused
	 * with a retry hint); a `~` or relative path is refused with the format notice.
	 */
	#settleLaneTrigger(row: InboundRow, line: LaneTriggerLine): void {
		if (line.kind === "refused") void this.#settleLaneCommand(row, "-", line);
		else if (this.#ctx.router?.draining === true)
			void this.#settleLaneCommand(row, line.trigger.title, { kind: "refused", text: LANE_DRAIN_REFUSED_TEXT });
		else void this.#startLane(row, line.trigger);
	}

	/**
	 * A message the core answers itself (`<kind>:<id>` op ref): settled with the text `answer` makes, never sent to the
	 * conversation's omp session. A throw anywhere settles it as failed (`failedAs`).
	 */
	async #settleOwn(
		kind: "lane" | "task",
		failedAs: string,
		row: InboundRow,
		answer: () => Promise<string>,
	): Promise<void> {
		try {
			const opRef = `${kind}:${row.platformMessageId}`;
			startedStore(this.#ctx).markDispatched(row.platformMessageId, { opRef, entryCursor: null });
			startedStore(this.#ctx).recordAnswer({
				originKey: row.originKey,
				opRef,
				threadRef: row.threadRef,
				parts: [await answer()],
			});
		} catch (error) {
			this.#settleFailed(failedAs, row, error);
		}
	}

	/**
	 * `머지해` / `폐기해` in a closed lane's thread, `닫아` in a `not-done` lane's thread (or a `!reopen` the lane
	 * cannot take: `refusal`): settled with the core's own answer like a lane start — the lane's omp session never
	 * sees it. The answer is recorded once the landing ended; a landing cut off by a restart is finished by the lane
	 * tick and shown on the lane's card.
	 */
	async #settleLaneCommand(
		row: InboundRow,
		name: string,
		command:
			| { kind: "land" | "discard" | "accept" }
			| { kind: "refused"; text: string }
			| { kind: "pr"; repo?: string; prNumber?: number }
			| { kind: "prwatch-off"; lane: string },
	): Promise<void> {
		await this.#settleOwn("lane", "lane_command", row, async () => {
			try {
				const lanes = this.#ctx.lanes;
				if (!lanes) throw new Error("lanes unavailable");
				if (command.kind === "refused") return `⚠️ ${command.text}`;
				if (command.kind === "accept") return (await lanes.acceptByOwner(name)).text;
				if (command.kind === "pr") {
					const { kind: _pr, ...given } = command;
					const outcome = await lanes.attachExternalPr(name, given);
					return outcome.handled ? outcome.text : `⚠️ ${outcome.text}`;
				}
				if (command.kind === "prwatch-off") {
					const outcome = await lanes.stopPrWatch(command.lane);
					return outcome.handled ? outcome.text : `⚠️ ${outcome.text}`;
				}
				return (command.kind === "land" ? await lanes.requestLand(name, "owner") : await lanes.discard(name)).text;
			} catch (error) {
				this.#ctx.log.error("lane_command_failed", { lane: name, command: command.kind, ...errorFields(error) });
				return "⚠️ 처리하지 못했습니다. 로그를 확인하세요.";
			}
		});
	}

	/**
	 * `멈춰` / `계속` in a lane's thread (the whole message, judged by `classifyLaneControl`): settled with the
	 * core's own answer like a lane start — the lane's omp session never sees it. The answer is whatever the
	 * manager re-read after stopping (or resuming) the lane.
	 */
	async #settleLaneControl(row: InboundRow, name: string, control: "pause" | "resume"): Promise<void> {
		await this.#settleOwn("lane", "lane_control", row, async () => {
			try {
				const lanes = this.#ctx.lanes;
				if (!lanes) throw new Error("lanes unavailable");
				return (
					control === "pause" ? await lanes.pause(name, "owner-message") : await lanes.resume(name, "owner-message")
				).text;
			} catch (error) {
				this.#ctx.log.error("lane_control_failed", { lane: name, control, ...errorFields(error) });
				return "⚠️ 처리하지 못했습니다. 로그를 확인하세요.";
			}
		});
	}

	/** A thread's working or blocked [TASK]s: the ones a `멈춰`/`계속` there can act on. */
	#activeTasksOf(threadRef: string): TaskRow[] {
		return startedStore(this.#ctx)
			.tasks.getByThread(threadRef)
			.filter((task) => task.status === "working" || task.status === "blocked");
	}

	/**
	 * `멈춰`/`계속` in a [TASK] thread: settled with the core's own answer (`task:` op ref), never sent to omp. With
	 * more than one active task in the thread nothing is applied and the answer lists their ids.
	 */
	async #settleTaskControl(row: InboundRow, control: "pause" | "resume"): Promise<void> {
		await this.#settleOwn("task", "task_control", row, async () => {
			try {
				const active = this.#activeTasksOf(row.threadRef);
				const only = active.length === 1 ? active[0] : undefined;
				return only === undefined
					? `이 스레드에 활성 TASK가 여럿입니다(${active.map((task) => task.taskId).join(", ")}) — 아무것도 ${control === "pause" ? "멈추지" : "재개하지"} 않았습니다. \`jabbu-pocket tasks ${control} <id>\`로 하나를 고르세요.`
					: (await this.controlTask(only.taskId, control)).text;
			} catch (error) {
				this.#ctx.log.error("task_control_failed", { thread: row.threadRef, control, ...errorFields(error) });
				return "⚠️ 처리하지 못했습니다. 로그를 확인하세요.";
			}
		});
	}

	/**
	 * A core-settled message whose store write threw (its callers fire and forget it): logged, and a row already
	 * marked dispatched is discarded — left dispatched it would trip `inbound_starved` and get the restart's
	 * interrupted notice for a turn that never ran.
	 */
	#settleFailed(kind: string, row: InboundRow, error: unknown): void {
		this.#ctx.log.error("lane_settle_failed", { kind, id: row.platformMessageId, ...errorFields(error) });
		try {
			if (startedStore(this.#ctx).getInbound(row.platformMessageId)?.state === "dispatched") {
				startedStore(this.#ctx).discard(row.platformMessageId);
			}
		} catch (discardError) {
			this.#ctx.log.error("lane_settle_discard_failed", {
				kind,
				id: row.platformMessageId,
				...errorFields(discardError),
			});
		}
	}

	/**
	 * Owner pause/resume of one [TASK] (thread phrase or `jabbu-pocket tasks pause|resume`). A pause marks the ledger first
	 * (the sweep holds its prompts, stale notice and auto-merge from then on), then sends the worker an Esc and reports
	 * only what herdr re-read. A resume lifts the sweep hold only; it never prompts the worker. `ok: false` = nothing
	 * was applied.
	 */
	async controlTask(taskId: string, control: "pause" | "resume"): Promise<{ ok: boolean; text: string }> {
		const tasks = startedStore(this.#ctx).tasks;
		const row = tasks.get(taskId);
		if (row === undefined) return { ok: false, text: `TASK를 찾지 못했습니다: ${taskId}` };
		if (control === "resume") {
			if (!tasks.isPaused(row)) return { ok: true, text: `${taskId}는 멈춘 상태가 아닙니다.` };
			const after = tasks.unpauseTask(taskId);
			if (tasks.isPaused(after)) return { ok: false, text: `⚠️ ${taskId} 재개를 확인하지 못했습니다.` };
			// A headless task's rows the pause held go in now (a herdr task's worker is never prompted here).
			if (row.runtime === "headless") await taskMailboxPort(this.#ctx).resumePending(taskOriginKey(row.agent));
			this.#ctx.log.info("task_resumed", withControlSource({ task: taskId }));
			return {
				ok: true,
				text: `▶ ${taskId} 재개했습니다 — 스윕 재촉·stale 알림·자동 머지 보류를 풀었습니다. 워커에 재개 프롬프트는 보내지 않았습니다(필요하면 jabbu_dispatch로 보냅니다).`,
			};
		}
		if (row.status !== "working" && row.status !== "blocked") {
			return { ok: false, text: `${taskId}는 ${row.status} 상태라 멈추지 않았습니다(working·blocked만 멈춥니다).` };
		}
		const after = tasks.pauseTask(taskId);
		if (!tasks.isPaused(after)) return { ok: false, text: `⚠️ ${taskId} 멈춤을 기록하지 못했습니다.` };
		this.#ctx.log.info("task_paused", withControlSource({ task: taskId }));
		let worker: string;
		let stopped = false;
		if (row.runtime === "herdr" && this.#ctx.options.config.herdr === undefined) {
			worker = "herdr가 꺼져 있어 Esc를 보내지 않았습니다";
		} else {
			const interrupted = await taskRuntimeOf(this.#ctx, row).interrupt(row);
			this.#ctx.log.info(
				"task_interrupt",
				withControlSource({ task: taskId, confirmed: interrupted.confirmed, status: interrupted.status }),
			);
			worker = interrupted.text;
			stopped = interrupted.confirmed;
		}
		// Only a re-read stopped worker leads with "멈췄습니다"; otherwise only the sweep hold is certain.
		const lead = stopped ? `⏸ ${taskId} 멈췄습니다` : `⚠️ ${taskId} 스윕만 멈췄습니다(워커 멈춤 미확인)`;
		return {
			ok: true,
			text: `${lead} — 스윕 재촉·stale 알림·자동 머지를 보류합니다. 워커: ${worker}. 재개는 \`계속\` 또는 \`jabbu-pocket tasks resume ${taskId}\`.`,
		};
	}

	/** One notice per pause (keyed by `pausedAt`) that held thread messages wait: the row stays pending, `계속` delivers it. */
	#heldLaneNotice(lane: LaneRow): void {
		const store = startedStore(this.#ctx);
		// A terminal hand-over says so once per attach; a plain pause once per pause.
		const attach = lane.meta.attach;
		const key =
			attach === undefined
				? `lane_held_notice:${lane.name}:${lane.meta.pausedAt ?? 0}`
				: `lane_attach_notice:${lane.name}:${attach.at}`;
		if (store.getCursor(key) !== undefined) return;
		store.setCursor(key, String(this.#ctx.clock.now()));
		const route = this.#ctx.channels.forThreadRef(lane.threadRef);
		if (route === undefined) return;
		const text =
			attach === undefined
				? "⏸ 멈춘 상태라 전달하지 않았습니다 — `계속`이라고 쓰면 전달합니다."
				: "🖥 오너가 터미널에서 작업 중이라 전달하지 않았습니다 — 터미널 omp를 끝내면 전달합니다.";
		void route.port
			.post(route.target, { text })
			.catch((error: unknown) =>
				this.#ctx.log.warn("lane_held_notice_failed", { lane: lane.name, error: String(error) }),
			);
	}

	/**
	 * A `머지` / `폐기` click on a lane's Outcome card: the core lands or discards the lane and redraws the card with
	 * the result. A lane that is not waiting for it (already landed, discarded, working again, or a click while the
	 * first one still runs) takes nothing; a lane that no longer exists loses the buttons with a note.
	 */
	async #handleLaneButton(
		action: LaneAction,
		channel: string | undefined,
		messageTs: string | undefined,
	): Promise<void> {
		const { kind, name } = action;
		const lanes = this.#ctx.lanes;
		if (lanes === undefined || this.#ctx.store?.getLane(name) === undefined) {
			this.#ctx.log.info(`lane_${kind}_ignored`, { lane: name, reason: "not_found" });
			const port = channel === undefined ? undefined : this.#ctx.channels.forConversation(channel)?.port;
			if (port === undefined || channel === undefined || messageTs === undefined) return;
			await port
				.edit(
					{ platform: port.platform, conversationId: channel, messageId: messageTs },
					{ text: `⚠️ 이 레인을 찾을 수 없음 (${name})`, buttons: [] },
				)
				.catch((error: unknown) => this.#ctx.log.warn("lane_card_edit_failed", { lane: name, error: String(error) }));
			return;
		}
		const outcome =
			action.kind === "session"
				? await lanes.pickSession(name, action.index)
				: kind === "merge"
					? await lanes.requestLand(name, "owner")
					: kind === "discard"
						? await lanes.discard(name)
						: kind === "publish"
							? await lanes.requestPublish(name)
							: kind === "hold"
								? await lanes.hold(name)
								: kind === "pause"
									? await lanes.pause(name, "button")
									: await lanes.resume(name, "button");
		this.#ctx.log.info(outcome.handled ? `lane_${kind}_requested` : `lane_${kind}_ignored`, { lane: name });
		if (kind === "pause" || kind === "resume" || kind === "session") {
			await this.#replyLaneThread(name, outcome.text);
			return;
		}
		if (outcome.handled) return;
		await this.#replyLaneThread(name, `⚠️ ${outcome.text}`);
	}

	async #replyLaneThread(name: string, text: string): Promise<void> {
		const lane = this.#ctx.store?.getLane(name);
		const route = lane === undefined ? undefined : this.#ctx.channels.forThreadRef(lane.threadRef);
		if (route === undefined) return;
		await route.port
			.post(route.target, { text })
			.catch((error: unknown) => this.#ctx.log.warn("lane_button_reply_failed", { lane: name, error: String(error) }));
	}

	/**
	 * A `▶ 시작` / `✖ 취소` click on a lane reservation card (the adapter already refused every user but the owner). The
	 * card is redrawn without buttons once the reservation has left `waiting`/`ready`; a refusal that leaves it standing
	 * is told in its thread.
	 */
	async #handleReservationButton(
		action: ReservationAction,
		channel: string | undefined,
		messageTs: string | undefined,
	): Promise<void> {
		const lanes = this.#ctx.lanes;
		const store = this.#ctx.store;
		if (lanes === undefined || store === undefined) return;
		const outcome =
			action.kind === "start" ? await lanes.startReservation(action.id) : lanes.cancelReservation(action.id);
		this.#ctx.log.info(
			outcome.handled ? `lane_reservation_${action.kind}` : `lane_reservation_${action.kind}_ignored`,
			{
				reservation: action.id,
			},
		);
		const standing = ["waiting", "ready"].includes(store.getLaneReservation(action.id)?.state ?? "");
		const port = channel === undefined ? undefined : this.#ctx.channels.forConversation(channel)?.port;
		if (!standing && port !== undefined && channel !== undefined && messageTs !== undefined) {
			await port
				.edit(
					{ platform: port.platform, conversationId: channel, messageId: messageTs },
					{ text: outcome.handled ? outcome.text : `⚠️ ${outcome.text}`, buttons: [] },
				)
				.catch((error: unknown) =>
					this.#ctx.log.warn("lane_reservation_card_edit_failed", { reservation: action.id, error: String(error) }),
				);
			return;
		}
		if (outcome.handled) return;
		const reservation = store.getLaneReservation(action.id);
		const route = reservation === undefined ? undefined : this.#ctx.channels.forThreadRef(reservation.threadRef);
		if (route === undefined) return;
		await route.port
			.post(route.target, { text: `⚠️ ${outcome.text}` })
			.catch((error: unknown) =>
				this.#ctx.log.warn("lane_reservation_reply_failed", { reservation: action.id, error: String(error) }),
			);
	}
}

/** Each adapter takes only the deliveries whose thread ref is an id of its own platform. */
export function deliverySources(
	store: DaemonStore,
	config: JabbuConfig,
	crash: (point: CrashPoint) => void,
): (platform: ChatPlatform) => DeliverySource {
	const itemOf = (row: DeliveryRow): DeliveryItem => ({
		deliveryId: row.deliveryId,
		originKey: row.originKey,
		threadRef: row.threadRef,
		body: row.body,
		redelivered: row.redelivered,
		finishThreadRefs: store.threadsOfOp(row.originKey, row.opRef),
		// A `queue drop` and a `!stop` re-link their targets (the dropped row; the waiting rows and the stopped
		// turn's rows) to the command op: those threads end 🚫 취소됨, a `/new` keeps finishing its casualties ✅ 완료.
		cancelThreadRefs:
			row.opRef.startsWith("queue:") || row.opRef.startsWith("stop:")
				? store.discardedThreadsOfOp(row.originKey, row.opRef)
				: undefined,
		// A lane's own reports (no owner message behind them) must not stamp ✅ on its thread root, nor may a
		// `!restart` answer or an apply `notify` line (side posts in a thread whose turn may still run).
		finishUntracked:
			!isLaneOrigin(row.originKey) &&
			!isTaskOrigin(row.originKey) &&
			!row.originKey.startsWith(MONITOR_ORIGIN_PREFIX) &&
			!row.opRef.endsWith(LOG_COPY_SUFFIX) &&
			!isSideOpRef(row.opRef),
		// Sent while its turn runs: the thread's ⏳ status and progress go on until the turn-end delivery. A peer
		// silence alert, a `!restart` answer and an apply `notify` line answer no turn, so they never finish the
		// thread's status either.
		keepStatus:
			row.opRef.includes(INTERIM_INFIX) ||
			row.opRef.startsWith(PEER_SILENCE_OP_PREFIX) ||
			row.opRef.startsWith(AMBIGUOUS_NOTICE_OP_PREFIX) ||
			isSideOpRef(row.opRef),
		sentParts: row.sentParts,
		replyTs: row.replyTs,
	});
	return (platform: ChatPlatform): DeliverySource => ({
		claimDue: () => store.claimDue(undefined, platform).map(itemOf),
		repostIsIdempotent: platform === "web",
		takeExpired: () => store.takeExpired(platform).map(itemOf),
		hasHeld: (threadRef, beforeDeliveryId) => store.hasHeldDelivery(threadRef, beforeDeliveryId),
		confirm: (deliveryId) => {
			crash("after_post_before_confirm");
			store.confirmDelivery(deliveryId);
		},
		fail: (deliveryId, error, outcome, sentParts, replyTs) => {
			if (outcome === "ambiguous") {
				// The parts already posted stay on the row: an owner `jabbu-pocket deliveries resend` sends only the rest.
				// Hold and notice commit together: a notice failure leaves the row inflight for boot recovery to retry.
				store.markAmbiguousWithNotice(deliveryId, error, sentParts, replyTs, primaryOwnerUserId(config.channels));
				return true;
			}
			return store.failDelivery(deliveryId, error).state === "expired";
		},
		defer: (deliveryId, error, retry) => void store.deferDelivery(deliveryId, error, retry),
	});
}
