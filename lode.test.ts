import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

const CLI = path.join(import.meta.dir, "lode.ts");
const fixtures: string[] = [];

function makeFixture(): { base: string; project: string; lode: string } {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "lode-cli-"));
	fixtures.push(base);
	const project = path.join(base, "project");
	const lode = path.join(project, "lode");
	fs.mkdirSync(lode, { recursive: true });
	return { base, project, lode };
}

function writeFile(file: string, content: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
}

function git(cwd: string, ...args: string[]): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (result.status !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
	}
	return result.stdout;
}

function initRepository(project: string): void {
	git(project, "init", "-q");
	git(project, "config", "user.name", "Lode Test");
	git(project, "config", "user.email", "lode@example.test");
}

function commitAll(project: string, subject: string): void {
	git(project, "add", "-A");
	git(project, "commit", "-q", "-m", subject);
}

async function run(root: string, ...args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const child = Bun.spawn(["bun", CLI, ...args, `--path=${root}`], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { stdout, stderr, exitCode };
}

afterEach(() => {
	for (const fixture of fixtures.splice(0)) {
		fs.rmSync(fixture, { recursive: true, force: true });
	}
});

describe("declared sublode ownership", () => {
	test("loads block-list declarations and excludes undeclared sibling lodes", async () => {
		const { project, lode } = makeFixture();
		writeFile(path.join(lode, "summary.md"), `---
type: domain
tags:
  - root
keywords:
  - ownership
summary: Root summary
sublodes:
  - src/os/lode

  # Blank lines and comments are valid inside YAML block lists.
  - toolchain/lode
---
# Root
`);
		writeFile(path.join(project, "src/os/lode/summary.md"), `---
type: domain
tags:
  - os
keywords: kernel
summary: OS summary
---
# OS
`);
		writeFile(path.join(project, "toolchain/lode/summary.md"), `---
type: domain
tags: [toolchain]
keywords: compiler
summary: Toolchain summary
---
# Toolchain
`);
		writeFile(path.join(project, "sibling/lode/summary.md"), "# Unowned sibling\n");

		const startup = await run(lode, "startup");
		expect(startup.exitCode).toBe(0);
		expect(startup.stdout).toContain("=== src/os/lode/summary.md ===");
		expect(startup.stdout).toContain("=== toolchain/lode/summary.md ===");
		expect(startup.stdout).not.toContain("sibling/lode/summary.md");

		const tagged = await run(lode, "list", "--tag=os");
		expect(tagged.exitCode).toBe(0);
		expect(tagged.stdout).toContain("src/os/lode/summary.md");
		expect(tagged.stdout).not.toContain("toolchain/lode/summary.md");

		const listed = await run(lode, "list");
		expect(listed.stdout).toContain("lode/summary.md");
		expect(listed.stdout).toContain("src/os/lode/summary.md");
		expect(listed.stdout).toContain("toolchain/lode/summary.md");
		expect(listed.stdout).not.toContain("sibling/lode/summary.md");
	});

	test("accepts inline sublode declarations", async () => {
		const { project, lode } = makeFixture();
		writeFile(path.join(lode, "summary.md"), `---
type: domain
keywords: ownership
summary: Root summary
sublodes: [src/os/lode]
---
# Root
`);
		writeFile(path.join(project, "src/os/lode/summary.md"), "# OS\n");

		const startup = await run(lode, "startup");
		expect(startup.exitCode).toBe(0);
		expect(startup.stdout).toContain("=== src/os/lode/summary.md ===");
	});

	test("reports and skips unsafe or invalid declarations", async () => {
		const { base, project, lode } = makeFixture();
		const absolute = path.join(base, "absolute", "lode");
		writeFile(path.join(lode, "summary.md"), `---
type: domain
keywords: ownership
summary: Root summary
sublodes:
  - lode
  - .
  - lode/child/lode
  - root-alias
  - ../outside/lode
  - ${absolute}
  - src/os/lode
  - src/os/./lode
  - os-alias
  - src/os/lode/child/lode
  - missing/lode
  - no-summary/lode
  - not-a-directory
---
# Root
`);
		writeFile(path.join(project, "src/os/lode/summary.md"), "# OS\n");
		writeFile(path.join(project, "src/os/lode/child/lode/summary.md"), "# Nested\n");
		writeFile(path.join(lode, "child/lode/summary.md"), "# Root child\n");
		fs.mkdirSync(path.join(project, "no-summary/lode"), { recursive: true });
		writeFile(path.join(project, "not-a-directory"), "not a directory\n");
		const symlinkType = process.platform === "win32" ? "junction" : "dir";
		fs.symlinkSync(lode, path.join(project, "root-alias"), symlinkType);
		fs.symlinkSync(path.join(project, "src/os/lode"), path.join(project, "os-alias"), symlinkType);

		const checked = await run(lode, "check");
		expect(checked.exitCode).toBe(0);
		expect(checked.stdout).toContain("path refers to the root lode");
		expect(checked.stdout).toContain("path overlaps the root lode");
		expect(checked.stdout).toContain("path resolves to the root lode");
		expect(checked.stdout).toContain("path escapes the project root");
		expect(checked.stdout).toContain("absolute paths are not allowed");
		expect(checked.stdout).toContain("duplicate sublode 'src/os/./lode'");
		expect(checked.stdout).toContain("duplicate sublode 'os-alias'");
		expect(checked.stdout).toContain("overlaps 'src/os/lode'");
		expect(checked.stdout).toContain("directory does not exist");
		expect(checked.stdout).toContain("summary.md is missing");
		expect(checked.stdout).toContain("path is not a directory");

		const listed = await run(lode, "list");
		expect(listed.stdout).toContain("src/os/lode/summary.md");
		expect(listed.stdout).not.toContain("outside/lode/summary.md");
		expect([...listed.stdout.matchAll(/^\[[^\]]+\] lode\/child\/lode\/summary\.md /gm)]).toHaveLength(1);
		expect([...listed.stdout.matchAll(/^\[[^\]]+\] src\/os\/lode\/child\/lode\/summary\.md /gm)]).toHaveLength(1);
	});
});

describe("Git workflow commands", () => {
	test("precommit reports staged files linked by root and sublode sources", async () => {
		const { project, lode } = makeFixture();
		initRepository(project);
		writeFile(path.join(lode, "summary.md"), `---
type: domain
keywords: workflow
summary: Root
sublodes: [module/lode]
---
# Root
`);
		writeFile(path.join(lode, "api.md"), `---
type: domain
keywords: api
summary: API contract
sources:
  - src/api.ts

  # Deleted sources must still match the staged deletion.
  - src/deleted.ts
  - src/renamed.ts
  - src/type-change.ts
---
# API
`);
		writeFile(path.join(project, "module/lode/summary.md"), "# Module\n");
		writeFile(path.join(project, "module/lode/shared.md"), `---
sources: [src/shared.ts]
---
# Shared
`);
		writeFile(path.join(lode, "unlinked.md"), "# Unlinked\n");
		writeFile(path.join(project, "src/api.ts"), "export const api = 1;\n");
		writeFile(path.join(project, "src/deleted.ts"), "delete me\n");
		writeFile(path.join(project, "src/shared.ts"), "export const shared = 1;\n");
		writeFile(path.join(project, "src/unrelated.ts"), "export const unrelated = 1;\n");
		writeFile(path.join(project, "src/renamed.ts"), "rename me\n");
		writeFile(path.join(project, "src/type-change.ts"), "regular file\n");
		commitAll(project, "baseline");

		writeFile(path.join(project, "src/api.ts"), "export const api = 2;\n");
		fs.rmSync(path.join(project, "src/deleted.ts"));
		writeFile(path.join(project, "src/shared.ts"), "export const shared = 2;\n");
		writeFile(path.join(project, "src/unrelated.ts"), "export const unrelated = 2;\n");
		git(project, "mv", "src/renamed.ts", "src/new-name.ts");
		if (process.platform !== "win32") {
			fs.rmSync(path.join(project, "src/type-change.ts"));
			fs.symlinkSync("api.ts", path.join(project, "src/type-change.ts"));
		}
		git(project, "add", "-A");

		const precommit = await run(lode, "precommit");
		expect(precommit.exitCode).toBe(0);
		expect(precommit.stderr).toBe("");
		expect(precommit.stdout).toContain("lode/api.md");
		expect(precommit.stdout).toContain("src/api.ts");
		expect(precommit.stdout).toContain("src/deleted.ts");
		expect(precommit.stdout).toContain("src/renamed.ts");
		if (process.platform !== "win32") {
			expect(precommit.stdout).toContain("src/type-change.ts");
		}
		expect(precommit.stdout).toContain("module/lode/shared.md");
		expect(precommit.stdout).toContain("src/shared.ts");
		expect(precommit.stdout).not.toContain("src/unrelated.ts");
		expect(precommit.stdout).not.toContain("unlinked.md");

		git(project, "reset", "-q");
		const empty = await run(lode, "precommit");
		expect(empty.stdout).toBe("No staged files.\n");

		const invalid = await run(lode, "precommit", "extra");
		expect(invalid.exitCode).toBe(2);
		expect(invalid.stderr).toContain("Usage: lode precommit");
	});

	test("check validates source declarations without requiring targets to exist", async () => {
		const { project, lode } = makeFixture();
		const absolute = path.resolve(project, "..", "absolute-source.ts");
		writeFile(path.join(lode, "summary.md"), "# Root\n");
		writeFile(path.join(lode, "sources.md"), `---
sources:
  - ${absolute}
  - ../escape.ts
  - src/missing.ts
  - src/./missing.ts
---
# Sources
`);

		const checked = await run(lode, "check");
		expect(checked.stdout).toContain("invalid source");
		expect(checked.stdout).toContain("absolute paths are not allowed");
		expect(checked.stdout).toContain("path escapes the project root");
		expect(checked.stdout).toContain("duplicate source 'src/./missing.ts'");
		expect(checked.stdout).not.toContain("source 'src/missing.ts': path does not exist");
	});

	test("recent shows patches for the newest owned lode commits", async () => {
		const { project, lode } = makeFixture();
		initRepository(project);
		writeFile(path.join(lode, "summary.md"), `---
sublodes: [module/lode]
---
# Root
`);
		writeFile(path.join(project, "module/lode/summary.md"), "# Module\n");
		writeFile(path.join(project, "src/app.ts"), "export const app = 1;\n");
		commitAll(project, "initial lode");

		writeFile(path.join(project, "src/app.ts"), "export const app = 2;\n");
		commitAll(project, "source only");

		writeFile(path.join(lode, "first.md"), "# First\n");
		commitAll(project, "first knowledge");

		writeFile(path.join(project, "sibling/lode/hidden.md"), "# Unowned\n");
		commitAll(project, "unowned knowledge");

		writeFile(path.join(lode, "mixed.md"), "# Mixed\n");
		writeFile(path.join(project, "src/app.ts"), "export const app = 3;\n");
		commitAll(project, "mixed knowledge");

		writeFile(path.join(project, "module/lode/module.md"), "# Module knowledge\n");
		commitAll(project, "module knowledge");

		writeFile(path.join(lode, "latest.md"), "# Latest\n");
		commitAll(project, "latest knowledge");

		const recent = await run(lode, "recent", "3");
		expect(recent.exitCode).toBe(0);
		expect(recent.stderr).toBe("");
		expect([...recent.stdout.matchAll(/^commit [0-9a-f]{40}$/gm)]).toHaveLength(3);
		expect(recent.stdout).toContain("latest knowledge");
		expect(recent.stdout).toContain("module knowledge");
		expect(recent.stdout).toContain("mixed knowledge");
		expect(recent.stdout).not.toContain("first knowledge");
		expect(recent.stdout).not.toContain("source only");
		expect(recent.stdout).not.toContain("unowned knowledge");
		expect(recent.stdout).toContain("module/lode/module.md");
		expect(recent.stdout).not.toContain("diff --git a/src/app.ts");
		expect(recent.stdout).not.toContain("sibling/lode/hidden.md");
	});

	test("precommit resolves project sources through a symlinked checkout path", async () => {
		const { base, project, lode } = makeFixture();
		initRepository(project);
		writeFile(path.join(lode, "summary.md"), "# Root\n");
		writeFile(path.join(lode, "api.md"), `---
sources: [src/api.ts]
---
# API
`);
		writeFile(path.join(project, "src/api.ts"), "export const api = 1;\n");
		commitAll(project, "baseline");

		const alias = path.join(base, "project-alias");
		const symlinkType = process.platform === "win32" ? "junction" : "dir";
		fs.symlinkSync(project, alias, symlinkType);
		writeFile(path.join(project, "src/api.ts"), "export const api = 2;\n");
		git(project, "add", "-A");

		const precommit = await run(path.join(alias, "lode"), "precommit");
		expect(precommit.exitCode).toBe(0);
		expect(precommit.stderr).toBe("");
		expect(precommit.stdout).toContain("lode/api.md");
		expect(precommit.stdout).toContain("src/api.ts");
	});

	test("Git commands warn and skip owned lodes outside the root repository", async () => {
		const { project, lode } = makeFixture();
		initRepository(lode);
		writeFile(path.join(lode, "summary.md"), `---
sublodes: [external/lode]
---
# Root
`);
		writeFile(path.join(lode, "src/app.ts"), "export const app = 1;\n");
		writeFile(path.join(project, "external/lode/summary.md"), "# External\n");
		writeFile(path.join(project, "external/lode/app.md"), `---
sources: [lode/src/app.ts]
---
# External app
`);
		commitAll(lode, "root baseline");

		writeFile(path.join(lode, "src/app.ts"), "export const app = 2;\n");
		git(lode, "add", "-A");

		const precommit = await run(lode, "precommit");
		expect(precommit.exitCode).toBe(0);
		expect(precommit.stderr).toContain("owned lode is outside this Git repository");
		expect(precommit.stdout).toBe("No source-linked lode files affected.\n");
		expect(precommit.stdout).not.toContain("external/lode/app.md");

		const recent = await run(lode, "recent", "1");
		expect(recent.exitCode).toBe(0);
		expect(recent.stderr).toContain("owned lode is outside this Git repository");
		expect(recent.stdout).toContain("root baseline");
	});

	test("recent rejects invalid counts and lodes outside Git", async () => {
		const { lode } = makeFixture();
		writeFile(path.join(lode, "summary.md"), "# Root\n");

		const invalid = await run(lode, "recent", "0");
		expect(invalid.exitCode).toBe(2);
		expect(invalid.stderr).toContain("Usage: lode recent");

		const outsideGit = await run(lode, "recent", "1");
		expect(outsideGit.exitCode).toBe(1);
		expect(outsideGit.stderr).toContain("not inside a Git repository");

		const { project: emptyProject, lode: emptyLode } = makeFixture();
		initRepository(emptyProject);
		writeFile(path.join(emptyLode, "summary.md"), "# Root\n");
		const noHistory = await run(emptyLode, "recent");
		expect(noHistory.exitCode).toBe(0);
		expect(noHistory.stdout).toBe("No committed lode changes.\n");
	});
});
