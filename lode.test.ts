import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

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
