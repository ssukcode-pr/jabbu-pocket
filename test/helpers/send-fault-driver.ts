import { OmpDriverError } from "../../src/omp/driver";
import { FakeOmpDriver } from "../../src/omp/fake-driver";

/**
 * FakeOmpDriver with send faults around a real (fake) delivery, for the mailbox's `sending` write-ahead:
 * - `timeoutAfterDelivery`: the next prompt reaches the child (a `prompt:` call, its turn runs) and then rejects with
 *   `request_timeout`, like an RPC answer that came too late.
 * - `notStartedNext`: the next prompt rejects with `not_started` before the child sees it.
 * - `cutAfterDelivery`: the next prompt or steer reaches the child and never answers — the process is cut there
 *   (an apply drain cut, OOM, kill -9) while the mailbox awaits it.
 * - `cutBeforeSend`: the next `leafId` (the cursor read before the write-ahead) never answers: cut while pending.
 * `onCut` runs when a cut starts, so a test awaits exactly that point.
 */
export class SendFaultDriver extends FakeOmpDriver {
	timeoutAfterDelivery = false;
	notStartedNext = false;
	cutAfterDelivery = false;
	cutBeforeSend = false;
	onCut: () => void = () => undefined;

	#cut(): Promise<never> {
		this.onCut();
		return new Promise<never>(() => undefined);
	}

	override async prompt(text: string): Promise<string> {
		if (this.notStartedNext) {
			this.notStartedNext = false;
			throw new OmpDriverError("not_started", "driver not started");
		}
		const opRef = await super.prompt(text);
		if (this.timeoutAfterDelivery) {
			this.timeoutAfterDelivery = false;
			throw new OmpDriverError("request_timeout", "prompt: no response within the request timeout");
		}
		if (this.cutAfterDelivery) return this.#cut();
		return opRef;
	}

	override async steer(text: string): Promise<void> {
		await super.steer(text);
		if (this.cutAfterDelivery) return this.#cut();
	}

	override async leafId(): Promise<string | null> {
		if (this.cutBeforeSend) {
			this.cutBeforeSend = false;
			return this.#cut();
		}
		return super.leafId();
	}
}
