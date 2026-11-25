// CI 강화 계약: 워크플로가 조용히 느슨해지지 않게 YAML을 직접 읽어 확인한다.
// 러너에서 실제로 돌려 보는 대신, 고정·권한·경로 필터·설치 경로가 문서한 그대로인지 본다.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { TLC } from "../scripts/tla-check";

type Step = {
	uses?: string;
	run?: string;
	name?: string;
	shell?: string;
	env?: Record<string, string>;
	with?: Record<string, string>;
};
const JOB_IDS = ["test", "test-arm64", "e2e-omp-mock"] as const;
type JobId = (typeof JOB_IDS)[number];
type Job = { name?: string; "runs-on": string; "timeout-minutes": number; steps: Step[] };
type Workflow = {
	on: Record<string, unknown>;
	permissions: Record<string, string>;
	concurrency: { group: string; "cancel-in-progress": string | boolean };
	jobs: Record<JobId, Job>;
};
type OmpLatest = {
	on: { schedule: { cron: string }[]; workflow_dispatch: unknown; pull_request: { paths: string[] } };
	permissions: Record<string, string>;
	jobs: Record<string, Job>;
};

const root = join(import.meta.dir, "..");
const readYaml = (path: string): unknown => Bun.YAML.parse(readFileSync(join(root, path), "utf8"));
const workflow = readYaml(".github/workflows/ci.yml") as Workflow;
const ompLatest = readYaml(".github/workflows/omp-latest.yml") as OmpLatest;
const dependabot = readYaml(".github/dependabot.yml") as {
	version: number;
	updates: {
		"package-ecosystem": string;
		directory: string;
		schedule: { interval: string; day?: string };
		ignore?: { "dependency-name": string; "update-types": string[] }[];
		labels?: string[];
		"open-pull-requests-limit"?: number;
	}[];
};
const setup = readYaml(".github/actions/setup/action.yml") as {
	name: string;
	description: string;
	runs: { using: string; steps: Step[] };
};
const bunPin = (
	JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
		packageManager: string;
		engines: { bun: string };
	}
).packageManager.replace(/^bun@/, "");
/** 40자 커밋 고정 + 같은 줄 버전 주석(`@<sha> # v1.2.3`). */
const PINNED = /^[^@\s]+@[0-9a-f]{40}$/;

describe("ci.yml", () => {
	test("main pushes are never cancelled; only a newer PR push replaces a PR run", () => {
		// 워크플로 파일에 적힌 GitHub 표현식 원문을 그대로 단언한다(`${`를 포함한 문자열이 정상이다).
		// biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub 표현식 원문 비교
		const group = "ci-${{ github.event_name }}-${{ github.event.pull_request.number || github.run_id }}";
		// biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub 표현식 원문 비교
		const cancel = "${{ github.event_name == 'pull_request' }}";
		expect(workflow.concurrency.group).toBe(group);
		expect(workflow.concurrency["cancel-in-progress"]).toBe(cancel);
	});

	test("the token is read-only", () => {
		expect(workflow.permissions).toEqual({ contents: "read" });
	});

	test("no path filter: every PR and every main push runs CI", () => {
		for (const trigger of ["push", "pull_request"] as const) {
			const config = workflow.on[trigger] as Record<string, unknown>;
			expect(config).not.toHaveProperty("paths");
			expect(config).not.toHaveProperty("paths-ignore");
		}
	});

	test.each(JOB_IDS)("job %s runs on a pinned runner image with a timeout", (job) => {
		expect(workflow.jobs[job]["runs-on"]).toMatch(/^ubuntu-\d+\.\d+(-arm)?$/);
		expect(workflow.jobs[job]["timeout-minutes"]).toBeGreaterThan(0);
	});

	test.each([".github/workflows/ci.yml", ".github/workflows/omp-latest.yml", ".github/actions/setup/action.yml"])(
		"every action in %s is pinned to a 40-hex commit with its version noted",
		(file) => {
			const text = readFileSync(join(root, file), "utf8");
			const lines = text.split("\n").filter((line) => line.includes("uses: ") && !line.includes("uses: ./"));
			expect(lines.length).toBeGreaterThan(0);
			for (const line of lines) {
				const ref = line
					.replace(/#.*$/, "")
					.trim()
					.replace(/^-\s*uses:\s*|^uses:\s*/, "");
				expect(ref).toMatch(PINNED);
				expect(line).toMatch(/#\s*v[0-9]+\.[0-9]+\.[0-9]+/);
			}
		},
	);

	test("gitleaks comes only from the checksum-verifying installer, never a piped download", () => {
		for (const job of JOB_IDS) {
			const steps = workflow.jobs[job].steps.filter((step) => step.run?.includes("gitleaks"));
			expect(steps.length).toBe(1);
			expect(steps[0]?.run).toContain('bash scripts/ci-install-gitleaks.sh "$RUNNER_TEMP/bin"');
			expect(steps[0]?.run).toContain('echo "JABBU_GITLEAKS=$RUNNER_TEMP/bin/gitleaks" >> "$GITHUB_ENV"');
		}
		for (const job of JOB_IDS)
			for (const step of workflow.jobs[job].steps) expect(step.run ?? "").not.toContain("curl");
	});

	test("test-arm64 runs on the arm64 image and repeats the test job's steps up to the TLA+ check; the required job names stay", () => {
		expect(Object.keys(workflow.jobs)).toEqual(["test", "test-arm64", "e2e-omp-mock"]);
		expect(workflow.jobs["test-arm64"]["runs-on"]).toBe("ubuntu-24.04-arm");
		expect(workflow.jobs.test["runs-on"]).toBe("ubuntu-24.04");
		expect(workflow.jobs["e2e-omp-mock"]["runs-on"]).toBe("ubuntu-24.04");
		expect(workflow.jobs["test-arm64"].steps).toEqual(workflow.jobs.test.steps.slice(0, -3));
		expect(workflow.jobs.test.steps.map((step) => step.run ?? step.uses)).toEqual([
			expect.stringContaining("actions/checkout@"),
			"./.github/actions/setup",
			expect.stringContaining("ci-install-gitleaks.sh"),
			"bun run check",
			"bun run knip",
			"bun test --parallel=3",
			expect.stringContaining("actions/setup-java@"),
			expect.stringContaining("actions/cache@"),
			"bun scripts/tla-check.ts --strict",
		]);
	});

	test("the test job installs temurin 21 and runs the mailbox TLA+ check strictly, caching only the pinned jar", () => {
		const steps = workflow.jobs.test.steps;
		const java = steps.find((step) => step.uses?.startsWith("actions/setup-java@"));
		expect(java?.with).toEqual({ distribution: "temurin", "java-version": "21" });
		const check = steps.findIndex((step) => step.run === "bun scripts/tla-check.ts --strict");
		expect(check).toBeGreaterThan(steps.indexOf(java as Step));
		const cache = steps[check - 1];
		expect(cache?.uses).toContain("actions/cache@");
		expect(cache?.with?.path).toBe(`~/.cache/jabbu-pocket/tla2tools-${TLC.tag}.jar`);
		expect(cache?.with?.key).toBe(`tla2tools-${TLC.tag}-${TLC.sha256}`);
		for (const job of ["test-arm64", "e2e-omp-mock"] as const)
			expect(workflow.jobs[job].steps.some((step) => step.run?.includes("tla-check"))).toBe(false);
	});

	test("the e2e-omp-mock job never sets the expected-version input, so it keeps the fixture pin", () => {
		const text = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
		expect(text).not.toContain("JABBU_OMP_EXPECT_VERSION");
		expect(text).not.toContain("--omp-only");
	});

	test("every job installs dependencies through the shared setup action", () => {
		for (const job of JOB_IDS)
			expect(workflow.jobs[job].steps.some((step) => step.uses === "./.github/actions/setup")).toBe(true);
	});

	test("the e2e-omp-mock job checks its fixtures before running the real omp e2e", () => {
		const runs = workflow.jobs["e2e-omp-mock"].steps.map((step) => step.run ?? "").filter((run) => run !== "");
		const check = runs.findIndex((run) => run.includes("bun src/dev/check-test-fixtures.ts"));
		const e2e = runs.findIndex((run) => run.includes("test/omp-mock.e2e.test.ts"));
		expect(check).toBeGreaterThanOrEqual(0);
		expect(check).toBeLessThan(e2e);
		const e2eStep = workflow.jobs["e2e-omp-mock"].steps.find((step) => step.run?.includes("test/omp-mock.e2e.test.ts"));
		expect(e2eStep?.env).toEqual({ JABBU_E2E_OMP_MOCK: "1" });
	});
});

describe("omp-latest.yml", () => {
	const job = ompLatest.jobs["omp-latest"] as Job;
	const stepRun = (needle: string) => job.steps.find((step) => step.run?.includes(needle));

	test("runs daily, on demand and on PRs touching only its own inputs", () => {
		expect(ompLatest.on.schedule).toEqual([{ cron: "30 18 * * *" }]);
		expect(ompLatest.on).toHaveProperty("workflow_dispatch");
		expect(ompLatest.on.pull_request.paths.sort()).toEqual(
			[
				".github/workflows/omp-latest.yml",
				"src/dev/check-test-fixtures.ts",
				"test/fixtures/omp-host/**",
				"test/omp-mock.e2e.test.ts",
				"test/omp-unanswered-tool-call.test.ts",
			].sort(),
		);
		expect(Object.keys(ompLatest.on).sort()).toEqual(["pull_request", "schedule", "workflow_dispatch"]);
	});

	test("one read-only job on a pinned image with a timeout and the shared setup action", () => {
		expect(ompLatest.permissions).toEqual({ contents: "read" });
		expect(Object.keys(ompLatest.jobs)).toEqual(["omp-latest"]);
		expect(job["runs-on"]).toBe("ubuntu-24.04");
		expect(job["timeout-minutes"]).toBeGreaterThan(0);
		expect(job.steps.some((step) => step.uses === "./.github/actions/setup")).toBe(true);
	});

	test("resolves the npm latest as an exact x.y.z without curl and installs only that version outside the fixture", () => {
		const resolve = stepRun("npm view");
		expect(resolve?.run).toContain("@oh-my-pi/pi-coding-agent");
		expect(resolve?.run).toContain("JABBU_OMP_EXPECT_VERSION");
		expect(resolve?.run).toContain("^[0-9]+\\.[0-9]+\\.[0-9]+$");
		const install = stepRun("JABBU_OMP_EXECUTABLE");
		expect(install?.run).toContain("@oh-my-pi/pi-coding-agent@$JABBU_OMP_EXPECT_VERSION");
		expect(install?.run).toContain("$RUNNER_TEMP");
		expect(install?.run).not.toContain("test/fixtures/omp-host");
		for (const step of job.steps) expect(step.run ?? "").not.toContain("curl");
	});

	test("checks the expected version, then runs exactly the two mock e2e files and fails on any skip", () => {
		const runs = job.steps.map((step) => step.run ?? "");
		const check = runs.findIndex((run) => run.includes("bun src/dev/check-test-fixtures.ts --omp-only"));
		const e2e = runs.findIndex((run) => run.includes("test/omp-mock.e2e.test.ts"));
		expect(check).toBeGreaterThanOrEqual(0);
		expect(check).toBeLessThan(e2e);
		const step = job.steps[e2e];
		expect(step?.env).toEqual({ JABBU_E2E_OMP_MOCK: "1" });
		expect(step?.run).toContain("bun test test/omp-mock.e2e.test.ts test/omp-unanswered-tool-call.test.ts");
		expect(step?.run).not.toContain("omp-rpc.contract");
		expect(step?.run).toContain("set -o pipefail");
		expect(step?.run).toContain("[1-9][0-9]* pass$");
		expect(step?.run).toContain("[0-9]+ skip$");
		expect(runs.some((run) => run.includes("gitleaks"))).toBe(false);
	});
});

describe("dependabot.yml", () => {
	const find = (ecosystem: string, directory: string) =>
		dependabot.updates.find((u) => u["package-ecosystem"] === ecosystem && u.directory === directory);

	test("github-actions and bun directories are all declared weekly on Monday", () => {
		expect(dependabot.version).toBe(2);
		const keys = dependabot.updates.map((u) => `${u["package-ecosystem"]} ${u.directory}`).sort();
		expect(keys).toEqual(
			["bun /", "bun /test/fixtures/omp-host", "github-actions /", "github-actions /.github/actions/setup"].sort(),
		);
		for (const update of dependabot.updates) {
			expect(update.schedule).toEqual({ interval: "weekly", day: "monday" });
			expect(update["open-pull-requests-limit"]).toBe(5);
			expect(update).not.toHaveProperty("labels");
		}
	});

	test("bun updates skip semver-major", () => {
		for (const directory of ["/", "/test/fixtures/omp-host"])
			expect(find("bun", directory)?.ignore).toEqual([
				{ "dependency-name": "*", "update-types": ["version-update:semver-major"] },
			]);
	});
});

describe("setup action", () => {
	test("installs the Bun version package.json declares", () => {
		expect(setup.name.length).toBeGreaterThan(0);
		expect(setup.description.length).toBeGreaterThan(0);
		expect(setup.runs.using).toBe("composite");
		expect(setup.runs.steps[0]?.uses).toContain("setup-bun@");
		expect(setup.runs.steps[0]?.with?.["bun-version"]).toBe(bunPin);
	});

	test("the cache key carries runner.arch so x64 and arm64 native packages never share a cache", () => {
		expect(setup.runs.steps[1]?.with?.key).toContain("runner.arch");
	});

	test("caches the Bun install cache keyed on both lockfiles and installs frozen", () => {
		const cache = setup.runs.steps[1];
		expect(cache?.uses).toContain("actions/cache@");
		expect(cache?.with?.path).toBe("~/.bun/install/cache");
		expect(cache?.with?.key).toContain("hashFiles('bun.lock', 'test/fixtures/omp-host/bun.lock')");
		const last = setup.runs.steps.at(-1);
		expect(last?.run).toBe("bun install --frozen-lockfile");
		expect(last?.shell).toBe("bash");
	});
});

describe("repository paths the CI files point at", () => {
	test("every scripts/, test/, src/ and .github/ path in the workflows, the setup action and the PR template exists", () => {
		const files = [
			".github/workflows/ci.yml",
			".github/workflows/omp-latest.yml",
			".github/actions/setup/action.yml",
			".github/pull_request_template.md",
		];
		const missing: string[] = [];
		for (const file of files) {
			const text = readFileSync(join(root, file), "utf8");
			for (const token of text.match(/(?<![\w./-])(?:scripts|test|src|\.github)\/[\w./-]*[\w-]/g) ?? [])
				if (!existsSync(join(root, token))) missing.push(`${file}: ${token}`);
		}
		expect(missing).toEqual([]);
	});
});
