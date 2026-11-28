import { writeSync } from "node:fs";
import { join } from "node:path";
import type { ChannelBinding } from "../channel/adapter";
import { errorFields } from "../channel/text";
import { type JabbuConfig, readDiscordToken } from "../config";
import { DiscordBinding } from "../discord/binding";
import { DiscordChannel } from "../discord/channel";
import { DiscordSocketTransport } from "../discord/socket-transport";
import { FileFakeDiscordTransport } from "../discord/test-transport";
import type { DiscordTransport } from "../discord/transport";
import { bootRuntime } from "../lanes/runtime";
import { createLogger, type Logger } from "../log";
import { AgyAccountPool } from "../omp/agy-account-pool";
import { withOmpProfile } from "../omp/env";
import { type AggregatingLogger, createAggregatingLogger, startServiceAlive } from "../ops/log-hygiene";
import { LogDirError, openLogSink } from "../ops/logfile";
import { testHostLoad, testStatfs } from "../ops/test-host-hooks";
import { redact } from "../redact";
import { indexRuntimeSecrets } from "../safety/secret-index";
import { NewerSchemaError, SCHEMA_VERSION } from "../store/schema-version";
import { WebBinding } from "../web/binding";
import { createBotDriverFactory } from "./bot-driver";
import { crashHook } from "./crash";
import { Daemon } from "./daemon";
import { acquireLock, type Lock, LockHeldError } from "./lock";
import { assertOmpRunnable, checkOmpVersion } from "./omp-boot";
import { testFatal, testStartDelayMs, testStartStall } from "./run-test-hooks";
import { createShutdown } from "./shutdown";
import { startWatchdog, watchdogStallMs } from "./watchdog";

/** `provider/model` in config.json becomes the two RpcClient options. */
export function splitModel(model: string | undefined): { provider?: string; model?: string } {
	if (model === undefined) return {};
	const slash = model.indexOf("/");
	return slash === -1 ? { model } : { provider: model.slice(0, slash), model: model.slice(slash + 1) };
}

/**
 * `env` and `baseEnv` of every bot RPC child (chat, lane, monitor and [TASK] worker turns share it). With `ompProfile`
 * the parent env loses `PI_CODING_AGENT_DIR` and gains `OMP_PROFILE`; without it `baseEnv` stays unset, so the driver
 * reads `process.env` as before. `PI_INTENT_TRACING=1`: omp 19 leaves tool-call intents off in RPC sessions unless
 * configured, and the live progress line shows each tool call by its intent. `OMP_HOST_DRIVER=jabbu-pocket`: the
 * owner's rule-guards extension judges only what reaches the chat (answers, notes next to `wait`/`ask`), not other text.
 */
export function botRpcEnv(
	ompProfile: string | undefined,
	base: Record<string, string | undefined> = process.env,
): { env: Record<string, string>; baseEnv?: Record<string, string | undefined> } {
	const env = { OMP_WIKI_NOTE_DISABLE: "1", PI_INTENT_TRACING: "1", OMP_HOST_DRIVER: "jabbu-pocket" };
	return ompProfile === undefined ? { env } : { env, baseEnv: withOmpProfile(base, ompProfile) };
}

/**
 * The Discord binding when `channels.discord` is set: the real gateway, or the file-logging fake for test runs
 * (`JABBU_TEST_DISCORD_TRANSPORT`). A non-retryable gateway close stops Discord alone and is logged.
 */
function discordBindings(config: JabbuConfig, env: Record<string, string | undefined>, log: Logger): ChannelBinding[] {
	const discord = config.channels.discord;
	if (discord === undefined) return [];
	const transport: DiscordTransport =
		env.JABBU_TEST_HOOKS === "1" && env.JABBU_TEST_DISCORD_TRANSPORT
			? new FileFakeDiscordTransport(env.JABBU_TEST_DISCORD_TRANSPORT)
			: new DiscordSocketTransport(
					{ botToken: readDiscordToken(config) },
					{
						...(discord.displayName === undefined ? {} : { displayName: discord.displayName }),
						onLifecycle: (event) => {
							if (event.type === "connected") log.info("discord_gateway_connected", { detail: event.detail });
							if (event.type === "reconnecting") log.warn("discord_gateway_reconnecting", { reason: event.detail });
							if (event.type === "display_name_failed")
								log.warn("discord_display_name_failed", { error: event.detail });
							if (event.type === "error") log.warn("discord_gateway_error", { error: event.detail });
						},
						onFatal: (error) => log.error("discord_gateway_fatal", { code: error.code, ...errorFields(error) }),
					},
				);
	return [
		new DiscordBinding(new DiscordChannel(transport, { ownerUserId: discord.ownerUserId, peerBots: discord.peerBots })),
	];
}

/** The chat bindings for the configured platforms (`channels.discord` and enabled `channels.web`). */
export function channelBindings(
	config: JabbuConfig,
	env: Record<string, string | undefined>,
	log: Logger,
): ChannelBinding[] {
	return [...discordBindings(config, env, log), ...(config.channels.web?.enabled === true ? [new WebBinding()] : [])];
}

/**
 * The crash exit: one synchronous `daemon_fatal` line, then the folded counts (`log_summary`) the hourly flush would
 * have written, then exit 1 — the code Bun itself exits with on an uncaught error or an unhandled rejection.
 */
export function fatalHandler(
	lastWords: Logger,
	log: AggregatingLogger,
	exit: (code: number) => void,
): (kind: string, error: unknown) => void {
	return (kind, error) => {
		lastWords.error("daemon_fatal", {
			kind,
			error: String(error).slice(0, 500),
			stack: error instanceof Error ? error.stack?.split("\n").slice(0, 5).join("\n") : undefined,
		});
		try {
			log.stop();
		} catch {
			// best effort: the fatal line above is already written
		}
		exit(1);
	};
}

/**
 * SIGHUP reload: a throw inside `reloadConfig` (a closed or busy store when the signal lands mid-shutdown,
 * a quota poll hitting the same store) must not become a fatal exit — the IPC `reload` op already answers
 * `{ ok: false }` for the same failure, and `reloadConfig` itself only guards the config load.
 */
export function reloadOnSighup(daemon: Daemon, log: Logger): void {
	try {
		daemon.reloadConfig("sighup");
	} catch (error) {
		log.warn("config_reload_failed", {
			trigger: "sighup",
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

/**
 * `jabbu-pocket daemon`: holds the single-instance lock, runs until SIGTERM/SIGINT, then stops gracefully.
 * Resolves with the process exit code.
 */
export async function runDaemon(
	config: JabbuConfig,
	env: Record<string, string | undefined> = process.env,
	/** The config.json text read right before `loadConfig` produced `config` (the only text last-good may record). */
	bootConfigText?: string,
): Promise<number> {
	let logFile: (line: string) => void, logPath: string;
	try {
		({ sink: logFile, path: logPath } = openLogSink(config.homeDir));
	} catch (error) {
		if (!(error instanceof LogDirError)) throw error;
		process.stderr.write(`jabbu-pocket daemon: refusing to start: ${error.message}\n`);
		return 1;
	}
	let lock: Lock;
	try {
		lock = acquireLock(join(config.homeDir, "jabbu.lock"));
	} catch (error) {
		if (!(error instanceof LockHeldError)) throw error;
		process.stderr.write(`${error.message}\n`);
		return 1;
	}

	const clock = { now: () => Date.now() };
	let logWriteFailed = false;
	// Routine drops (bot chatter, messages not for the bot) fold into one hourly `log_summary`; warn/error never fold.
	const log = createAggregatingLogger(
		createLogger({
			clock,
			redact,
			sink: (line) => {
				try {
					logFile(line);
				} catch (error) {
					// The file is gone or full: keep the daemon alive on stderr (journal) and say so once.
					if (!logWriteFailed) process.stderr.write(`log_write_failed: ${String(error)}\n`);
					logWriteFailed = true;
				}
				process.stderr.write(`${line}\n`);
			},
		}),
		{ clock },
	);
	// Why the process ended, in jabbu.log too (not only Bun's journal output). Both lines are written synchronously:
	// the process is gone right after them.
	const lastWords = createLogger({
		clock,
		redact,
		sink: (line) => {
			try {
				logFile(line);
			} catch {
				// stderr below still reaches the journal
			}
			try {
				writeSync(2, `${line}\n`);
			} catch {
				// nothing left to report to
			}
		},
	});
	const fatal = fatalHandler(lastWords, log, (code) => process.exit(code));
	process.on("uncaughtException", (error) => fatal("uncaughtException", error));
	process.on("unhandledRejection", (reason) => fatal("unhandledRejection", reason));
	process.on("exit", (code) => lastWords.info("daemon_exit", { code }));

	const model = splitModel(config.model);
	const personaFiles = {
		persona: join(config.homeDir, "workspace", "persona.md"),
		soul: join(config.homeDir, "workspace", "soul.md"),
		owner: join(config.homeDir, "workspace", "owner.md"),
		secrets: { secretsDir: join(config.homeDir, "secrets"), configFile: join(config.homeDir, "config.json") },
	};
	// Seed the known-secret value index before anything can answer: masking sits below the agent.
	indexRuntimeSecrets(config, env, log);
	const exited = Promise.withResolvers<number>();
	const shutdown = createShutdown({ stop: () => daemon.stop(), log, env, exited });
	const hostLoad = testHostLoad(env); // test-only idle host, behind JABBU_TEST_HOOKS=1
	const statfs = testStatfs(env); // test-only roomy disk, behind JABBU_TEST_HOOKS=1
	const ompVersion = await checkOmpVersion(config, log);
	// What every review, QA and check receipt of this run is recorded on: omp, the source checkout commit, OS and arch.
	const runtime = await bootRuntime({ omp: ompVersion, sourceDir: join(import.meta.dir, "..", ".."), log });
	log.info("runtime_booted", { omp: runtime.omp, source: runtime.source });
	const agyPool =
		config.agent === "agy"
			? new AgyAccountPool({
					config: () => daemonOptions.config.agyAccounts,
					statePath: join(config.homeDir, "agy-quota-state.json"),
					now: () => clock.now(),
					log,
				})
			: undefined;
	const daemonOptions: ConstructorParameters<typeof Daemon>[0] = {
		config,
		bootConfigText,
		log,
		clock,
		bootId: lock.info.bootId,
		ompVersion,
		channels: channelBindings(config, env, log),
		crash: crashHook(env),
		...(hostLoad === undefined ? {} : { hostLoad }),
		...(statfs === undefined ? {} : { statfs }),
		sweepMs: env.JABBU_TEST_HOOKS === "1" && env.JABBU_SWEEP_MS ? Number(env.JABBU_SWEEP_MS) : undefined,
		...(agyPool === undefined ? {} : { agyPool, agyStatus: () => agyPool.status(clock.now()) }),
		driverFactory: createBotDriverFactory({
			getConfig: () => daemonOptions.config,
			secretsDir: join(config.homeDir, "secrets"),
			personaFiles,
			onPersonaError: (error: unknown, path: string) => log.warn("persona_unreadable", { path, error: String(error) }),
			clock,
			log,
			agyModel: model.provider === undefined || model.provider === "agy" ? model.model : undefined,
			ompModel: model,
			agyPool,
			cwdFor: (origin) => daemon.cwdFor(origin),
			peerTouched: (origin) => daemon.peerTouched(origin),
			floorsSurfaceFor: (origin) => daemon.floorsSurfaceFor(origin),
			hostToolsFor: (origin) => daemon.hostToolsFor(origin),
			answerDialogsFor: (origin) => daemon.answerDialogsFor(origin),
			rotationContextFor: (origin) => daemon.rotationContextFor(origin),
			botRpcEnv,
			taskDriver: (origin, sessionDir, rpcEnv) => daemon.taskDriver(origin, sessionDir, rpcEnv),
		}),
	};
	const daemon = new Daemon(daemonOptions);
	// The daemon stops its children and settles the ledger before it exits. SIGHUP (and `jabbu-pocket reload`) re-reads config.json.
	for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
		process.removeAllListeners(signal);
		process.on(signal, () => {
			if (signal !== "SIGHUP") return shutdown.handle(signal);
			log.info("signal", { signal });
			reloadOnSighup(daemon, log);
		});
	}
	// Before `start()`: a main thread stuck while booting is killed too.
	const watchdog = startWatchdog({ stallMs: watchdogStallMs(env), logPath });
	testStartStall(env);
	try {
		await testStartDelayMs(env);
		await assertOmpRunnable(config, ompVersion);
		await daemon.start();
	} catch (error) {
		watchdog.stop();
		if (shutdown.stopping) log.info("daemon_start_interrupted", { ...errorFields(error) });
		else if (error instanceof NewerSchemaError) {
			// One line with both versions and the remedy: `apply` only sees IPC readiness, so journalctl is where this shows.
			log.error("daemon_fatal", {
				kind: "newer_schema",
				db_version: error.dbVersion,
				code_version: SCHEMA_VERSION,
				...errorFields(error),
			});
		} else {
			log.error("daemon_start_failed", { ...errorFields(error) });
		}
		await daemon.stop().catch(() => undefined);
		log.stop();
		lock.release();
		return shutdown.stopping ? 0 : 1;
	}
	const stopAlive = startServiceAlive({ log, clock, snapshot: () => daemon.aliveFields() });
	testFatal(env);
	const code = await exited.promise;
	stopAlive();
	watchdog.stop();
	log.stop();
	lock.release();
	return code;
}
