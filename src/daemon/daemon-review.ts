import { basename, join } from "node:path";
import { sessionDirFor } from "../core/origin";
import { parseChatOrigin } from "../core/origin-key";
import type { OmpSessionDriver } from "../omp/driver";
import { resolveCandidates, runCandidateProposals } from "../review/candidates";
import {
	installSkill,
	readSessionDigest,
	runSkillReview,
	SKILL_REVIEW_ORIGIN,
	savePendingProposals,
	skillDirOf,
} from "../review/skills";
import type { Store } from "../store/db";
import { DEFAULT_GATE_SWEEP_MS, DEFAULT_SKILL_REVIEW_TURNS } from "./daemon-constants";
import { adapterOfConversation, approvalOf, type DaemonContext } from "./daemon-context";

/** The background skill review (periodic and `!distill`) and the improvement-candidate pass of the sweep. */
export class DaemonSkillReview {
	readonly #ctx: DaemonContext;
	readonly #makeDriver: (originKey: string, sessionDir: string) => OmpSessionDriver;
	#stopped = false; // set at shutdown: no new review or candidate pass starts
	#reviewPromise: Promise<unknown> | undefined;
	readonly #reviewedTurns = new Map<string, number>();
	/** A candidate pass (and so its approval cards) is running. */
	#candidatePromise: Promise<unknown> | undefined;
	#lastCandidatePassAt = 0;

	constructor(ctx: DaemonContext, makeDriver: (originKey: string, sessionDir: string) => OmpSessionDriver) {
		this.#ctx = ctx;
		this.#makeDriver = makeDriver;
	}

	/** A skill review is running (a restart drain counts it as a turn): the promise itself is the flag. */
	get reviewing(): boolean {
		return this.#reviewPromise !== undefined;
	}

	/** Shutdown: no new review or candidate pass starts; `idle()` waits out a running review only. */
	stop(): void {
		this.#stopped = true;
	}

	idle(): Promise<void> {
		return this.#reviewPromise === undefined ? Promise.resolve() : this.#reviewPromise.then(() => undefined);
	}

	/** The owner's live DM origin on the platform of `ownerHome()`; undefined before the owner has a home. */
	#ownerDmOrigin(store: Store): string | undefined {
		const platform = store.ownerHome()?.platform;
		return platform === undefined ? undefined : store.ownerDmOrigin(platform);
	}

	/**
	 * Background skill review: every `skillReviewTurns` answered owner DM turns a
	 * separate child reads the recent digest and proposes skills; only an explicit owner click installs them.
	 */
	maybeReviewSkills(): void {
		const every = this.#ctx.options.config.skillReviewTurns ?? DEFAULT_SKILL_REVIEW_TURNS;
		if (every <= 0 || this.#stopped || this.reviewing || this.#ctx.router?.draining === true) return;
		const store = this.#ctx.store;
		if (store === undefined || this.#ctx.adapters.size === 0) return;
		// Same latest-updated_at rule as the escalation/gate notices' ownerChannel(): a stale duplicate DM origin row
		// must not make the answered count (and so the review cadence) follow a dead conversation. The DM is on the
		// platform owner notices go to.
		const dmOrigin = this.#ownerDmOrigin(store);
		const channel = dmOrigin === undefined ? undefined : parseChatOrigin(dmOrigin)?.conversationId;
		if (dmOrigin === undefined || channel === undefined) return;
		const answered = store.countAnswered(dmOrigin);
		const seen = this.#reviewedTurns.get(dmOrigin);
		// First look at this DM since boot: its count is the baseline, so the cadence counts turns from here on.
		if (seen === undefined) this.#reviewedTurns.set(dmOrigin, answered);
		if (seen === undefined || answered - seen < every) return;
		this.#reviewedTurns.set(dmOrigin, answered);
		// Frozen: no autonomous omp turn. This due review is skipped (not queued); the next one follows `every` turns.
		if (this.#ctx.frozen() !== undefined) {
			this.#ctx.log.info("skill_review_skipped_frozen", { origin: dmOrigin, answered });
			return;
		}
		this.#startSkillReview(dmOrigin, channel);
	}

	/**
	 * Improvement-candidate pass (`src/review/candidates.ts`): every `DEFAULT_GATE_SWEEP_MS` folds
	 * `<workspace>/candidates.jsonl` and raises due candidates as a #log line or owner approval cards. Skipped while
	 * frozen, draining or a previous pass (its cards) is still running. The daemon never edits rules or persona here.
	 */
	maybeProposeCandidates(): void {
		const config = this.#ctx.options.config;
		const settings = resolveCandidates(config.candidates);
		const gate = {
			frozen: this.#ctx.frozen() !== undefined,
			draining: this.#ctx.router?.draining === true,
			openCards: this.#candidatePromise !== undefined ? 1 : 0,
		};
		if (!settings.enabled || this.#stopped || gate.frozen || gate.draining || gate.openCards > 0) return;
		if (this.#ctx.clock.now() - this.#lastCandidatePassAt < DEFAULT_GATE_SWEEP_MS) return;
		this.#lastCandidatePassAt = this.#ctx.clock.now();
		const dmOrigin = this.#ctx.store === undefined ? undefined : this.#ownerDmOrigin(this.#ctx.store);
		const ownerChannel = dmOrigin === undefined ? undefined : parseChatOrigin(dmOrigin)?.conversationId;
		const logChannel = config.channels.discord?.logChannelId;
		const approvable = ownerChannel !== undefined && adapterOfConversation(this.#ctx, ownerChannel) !== undefined;
		const dest = approvable ? ownerChannel : undefined;
		this.#candidatePromise = runCandidateProposals(
			{
				ledgerPath: join(config.workspaceDir, "candidates.jsonl"),
				experimentsPath: join(config.workspaceDir, "experiments.md"),
				settings,
				timezone: config.timezone,
				now: () => this.#ctx.clock.now(),
				postLog: async (text) => {
					const adapter = logChannel === undefined ? undefined : adapterOfConversation(this.#ctx, logChannel);
					if (logChannel === undefined || adapter === undefined)
						return void this.#ctx.log.info("candidate_note", { text });
					await adapter.postNotice(logChannel, text);
				},
				requestApproval: dest === undefined ? undefined : (summary) => approvalOf(this.#ctx).request(dest, summary),
				log: this.#ctx.log,
			},
			gate,
		)
			.catch((error) => this.#ctx.log.warn("candidate_pass_failed", { error: String(error) }))
			.finally(() => {
				this.#candidatePromise = undefined;
			});
	}

	/**
	 * `!distill`: an immediate skill review of this conversation's session, the same function, approval card and
	 * `skills-pending` storage as the periodic review (whose turn baseline stays untouched). Returns the command's
	 * answer; the review itself runs in the background (its approval can wait for the owner's click).
	 */
	async distill(originKey: string): Promise<string> {
		const channel = parseChatOrigin(originKey)?.conversationId;
		const adapter = channel === undefined ? undefined : adapterOfConversation(this.#ctx, channel);
		if (this.#ctx.store === undefined || channel === undefined || adapter === undefined) {
			return "이 대화에서는 스킬 리뷰를 시작할 수 없습니다.";
		}
		if (this.reviewing) return "이미 리뷰 중입니다. 끝나면 결과를 알려 드립니다.";
		if (this.#ctx.frozen() !== undefined) {
			this.#ctx.log.info("skill_review_skipped_frozen", { origin: originKey, trigger: "distill" });
			return "동결 중이라 하지 않았습니다.";
		}
		// A channel top-level `!distill` stays on the channel origin, whose session holds none of the thread talks:
		// refuse an empty digest instead of paying a model turn to review nothing.
		const sessionDir = this.#ctx.store.getOrigin(originKey)?.sessionDir;
		const digest = sessionDir === undefined ? "" : await readSessionDigest(sessionDir);
		if (digest.trim() === "") {
			return "이 대화방에는 리뷰할 세션 내용이 없습니다. 대화한 스레드 안에서 `!distill`을 보내 주세요.";
		}
		if (this.#stopped) return "종료 중이라 스킬 리뷰를 시작할 수 없습니다.";
		if (this.reviewing) return "이미 리뷰 중입니다. 끝나면 결과를 알려 드립니다.";
		// !distill is an explicit ask: a no-proposal ending must still reach the thread, not just the log.
		this.#startSkillReview(originKey, channel, true);
		return "스킬 리뷰를 시작했습니다. 제안이 있으면 승인 카드로 알립니다.";
	}

	/** Background review of `sourceOrigin`'s session digest; the caller has checked `#reviewing` and the freeze. */
	#startSkillReview(sourceOrigin: string, channel: string, announceEmpty = false): void {
		const store = this.#ctx.store;
		const adapter = adapterOfConversation(this.#ctx, channel);
		if (store === undefined || adapter === undefined) return;
		const origin = store.getOrigin(sourceOrigin);
		this.#reviewPromise = runSkillReview(
			{
				makeDriver: (reviewOrigin, sessionDir) => this.#makeDriver(reviewOrigin, sessionDir),
				readDigest: async () => (origin?.sessionDir === undefined ? "" : await readSessionDigest(origin.sessionDir)),
				savePending: (proposals) => savePendingProposals(this.#ctx.options.config.homeDir, proposals, Date.now()),
				install: async (proposal) => {
					const revision = installSkill(skillDirOf(proposal.name), proposal, Date.now());
					if (revision !== undefined)
						this.#ctx.log.info("skill_revision_saved", { name: proposal.name, revision: basename(revision) });
				},
				profileSyncPending: this.#ctx.options.config.ompProfile !== undefined,
				requestApproval: (summary) => approvalOf(this.#ctx).request(channel, summary),
				notify: async (text) => void (await adapter.postNotice(channel, text)),
				log: this.#ctx.log,
				now: () => Date.now(),
			},
			{
				sessionDir: sessionDirFor(join(this.#ctx.options.config.homeDir, "sessions"), SKILL_REVIEW_ORIGIN, 1),
				announceEmpty,
			},
		)
			.catch((error) => this.#ctx.log.warn("skill_review_failed", { error: String(error) }))
			.finally(() => {
				this.#reviewPromise = undefined;
			});
	}
}
