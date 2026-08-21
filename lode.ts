#!/usr/bin/env bun
/**
 * lode — mechanical acceleration for project lodes.
 *
 * A directory of Markdown files with optional YAML frontmatter. Content
 * commands inspect and index without modifying project files; use read/edit for
 * direct access. Mail commands separately mutate state under ~/.lode/.
 *
 * Frontmatter schema (all optional, but summary + keywords are recommended):
 *   type:      domain | external
 *   tags:      [tag1, tag2]
 *   keywords:  word1, word2, word3
 *   summary:   one-line description for the map
 *   sublodes:  project-relative lode directory paths owned by this root
 *   sources:   project-relative source files documented by this lode file
 *   status:    plan lifecycle state (plans only)
 *   line-budget: `exempt` — opt out of the 250-line limit, for a file whose role
 *              is append-only record rather than a topic read on purpose
 *
 * Term blocks in the body:
 *   ## Terms
 *   - **Name** — definition
 *
 * Usage:
 *   lode startup [--path=.]           dump entrypoint files for session start
 *   lode search <query> [--content] [--under=PATH] [--path=.]
 *   lode list [--type=T] [--tag=T] [--path=.]
 *   lode walk <file>                  resolve internal links, show linked summaries
 *   lode map [--path=.]               print index from frontmatter
 *   lode terms [--path=.]             aggregate term blocks into glossary
 *   lode tags [--path=.]              tag counts
 *   lode check [--path=.]             lint frontmatter, links, terms, line count, orphans
 *   lode precommit [--path=.]         report staged sources linked from lode files
 *   lode recent [N] [--path=.]        show recent committed lode patches
 *   lode plans [--status=S] [--path=.] list and filter plans by lifecycle
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { spawnSync } from "node:child_process";

// ─── types ──────────────────────────────────────────────────────────────

interface Frontmatter {
	type?: string;
	tags?: string[];
	keywords?: string[];
	summary?: string;
	sublodes?: string[];
	sources?: string[];
	status?: string;
	lineBudget?: string;
	_raw?: Record<string, unknown>;
}

interface LodeFile {
	relPath: string;       // relative to lode root
	absPath: string;
	frontmatter: Frontmatter;
	body: string;
	bodyLineOffset: number;
	lines: number;
	terms: TermEntry[];
	links: string[];       // resolved relative paths this file links to
	backlinks: string[];   // files that link to this file
}

interface TermEntry {
	name: string;
	def: string;
	source: string;       // file that defines it
}

// ─── frontmatter parsing ────────────────────────────────────────────────
//
// Hand-rolled subset of YAML. Handles flat scalar fields and inline or block
// lists:
//   key: value
//   key: [a, b, c]
//   key:
//     - a
//     - b
//
// Does NOT handle nested mappings, multi-line strings, anchors, or references.
// Keep the parser aligned with the actual frontmatter schema; use a real YAML
// parser if the schema later requires general YAML semantics.

function parseFrontmatter(content: string): { fm: Frontmatter; body: string; bodyLineOffset: number } {
	const fm: Frontmatter = { _raw: {} };
	if (!content.startsWith("---")) return { fm, body: content, bodyLineOffset: 0 };
	const end = content.indexOf("\n---", 3);
	if (end === -1) return { fm, body: content, bodyLineOffset: 0 };
	const block = content.slice(3, end).trim();
	let bodyStart = end + 4;
	if (content[bodyStart] === "\n") bodyStart++;
	const body = content.slice(bodyStart);
	const bodyLineOffset = content.slice(0, bodyStart).split("\n").length - 1;
	const lines = block.split("\n");

	for (let i = 0; i < lines.length; i++) {
		const trimmed = lines[i].trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const colonIdx = trimmed.indexOf(":");
		if (colonIdx === -1) continue;
		const key = trimmed.slice(0, colonIdx).trim();
		const scalar = trimmed.slice(colonIdx + 1).trim();
		let value: string | string[] = scalar;

		if (!scalar) {
			const items: string[] = [];
			let next = i + 1;
			while (next < lines.length) {
				const nextLine = lines[next].trim();
				if (!nextLine || nextLine.startsWith("#")) {
					next++;
					continue;
				}
				const match = lines[next].match(/^\s+-\s+(.+?)\s*$/);
				if (!match) break;
				items.push(unquoteListItem(match[1]));
				next++;
			}
			if (items.length > 0) {
				value = items;
				i = next - 1;
			}
		}

		if (key === "type" && typeof value === "string") {
			fm.type = value;
		} else if (key === "summary" && typeof value === "string") {
			fm.summary = value;
		} else if (key === "status" && typeof value === "string") {
			fm.status = value;
		} else if (key === "line-budget" && typeof value === "string") {
			fm.lineBudget = value;
		} else if (key === "tags") {
			fm.tags = Array.isArray(value) ? value : parseList(value);
		} else if (key === "keywords") {
			fm.keywords = Array.isArray(value) ? value : parseList(value);
		} else if (key === "sublodes") {
			fm.sublodes = Array.isArray(value) ? value : parseList(value);
		} else if (key === "sources") {
			fm.sources = Array.isArray(value) ? value : parseList(value);
		}
		(fm._raw as Record<string, unknown>)[key] = value;
	}
	return { fm, body, bodyLineOffset };
}

function unquoteListItem(value: string): string {
	return value.trim().replace(/^["']|["']$/g, "");
}

function parseList(value: string): string[] {
	const v = value.trim();
	if (v.startsWith("[")) {
		return v.slice(1, v.endsWith("]") ? -1 : undefined)
			.split(",")
			.map(unquoteListItem)
			.filter(Boolean);
	}
	return v.split(",").map(unquoteListItem).filter(Boolean);
}

// ─── term block parsing ─────────────────────────────────────────────────

const TERM_BULLET = /^\s*[-*]\s*\*\*(.+?)\*\*\s*[—–-]\s*(.+)$/;

function parseTerms(body: string): TermEntry[] {
	const terms: TermEntry[] = [];
	const lines = body.split("\n");
	let inTermsBlock = false;
	for (const line of lines) {
		if (/^##\s+Terms\s*$/i.test(line)) {
			inTermsBlock = true;
			continue;
		}
		if (inTermsBlock) {
			if (/^##\s/.test(line)) break; // next heading ends the block
			const m = line.match(TERM_BULLET);
			if (m) {
				terms.push({ name: m[1].trim(), def: m[2].trim(), source: "" });
			}
		}
	}
	return terms;
}

/**
 * Blank code regions (fenced blocks and inline code) so link extraction never
 * counts a reference inside a code fence or inline code as a real link. Line
 * numbers are preserved by blanking, not deleting.
 */
function stripCode(text: string): string {
	const lines = text.split(/\r?\n/);
	const out: string[] = [];
	let fence: string | null = null;
	for (const line of lines) {
		const fenceMatch = line.match(/^\s*(```+|~~~+)/);
		if (fenceMatch) {
			out.push("");
			fence = fence === null ? fenceMatch[1]![0]!.repeat(3) : null;
			continue;
		}
		if (fence !== null) {
			out.push("");
			continue;
		}
		out.push(line.replace(/`[^`\n]*`/g, (m) => " ".repeat(m.length)));
	}
	return out.join("\n");
}

// ─── link extraction ────────────────────────────────────────────────────

const MD_LINK = /\[([^\]]*)\]\(([^)]+)\)/g;
const WIKI_LINK = /\[\[([^\]]+)\]\]/g;
function extractLinks(body: string, fromPath: string, root: string): string[] {
	const stripped = stripCode(body);
	const links: string[] = [];
	const dir = path.dirname(fromPath);

	let m: RegExpExecArray | null;
	MD_LINK.lastIndex = 0;
	while ((m = MD_LINK.exec(stripped)) !== null) {
		const target = m[2];
		if (target.startsWith("http") || target.startsWith("#") || target.startsWith("mailto:")) continue;
		const resolved = normalizePath(path.join(dir, target), root);
		if (resolved) links.push(resolved);
	}

	WIKI_LINK.lastIndex = 0;
	while ((m = WIKI_LINK.exec(stripped)) !== null) {
		const target = m[1].split("|")[0].split("#")[0].trim();
		// wiki links resolve against root by filename
		const found = findByFilename(target, root);
		if (found) links.push(found);
	}

	return [...new Set(links)];
}

function normalizePath(p: string, root: string): string | null {
	const normalized = path.normalize(p);
	if (!normalized.endsWith(".md")) return null;
	// must be within root
	const abs = path.resolve(root, normalized);
	if (!abs.startsWith(path.resolve(root))) return null;
	return path.relative(root, abs).split(path.sep).join("/");
}

// Cache for wiki-link filename resolution
let fileIndex: Map<string, string> | null = null;

function findByFilename(filename: string, root: string): string | null {
	if (!fileIndex) {
		fileIndex = new Map();
		for (const f of walkMd(root)) {
			const base = path.basename(f, ".md");
			fileIndex.set(base.toLowerCase(), f);
		}
	}
	return fileIndex.get(filename.toLowerCase().replace(/\.md$/, "")) ?? null;
}

/**
 * Case-exact existence check. Node's existsSync is only as exact as the
 * underlying filesystem (case-insensitive on Windows/macOS), so a link that
 * would 404 on a case-sensitive checkout can look resolvable here. Walking
 * each component through readdir gives the portable answer.
 */
function existsCaseExact(absPath: string): boolean {
	const { root: vol } = path.parse(absPath);
	if (!vol) return false;
	let cur = vol;
	for (const part of absPath.slice(vol.length).split(/[\\/]+/).filter(Boolean)) {
		let entries: string[];
		try {
			entries = fs.readdirSync(cur);
		} catch {
			return false;
		}
		if (!entries.includes(part)) return false;
		cur = path.join(cur, part);
	}
	return true;
}

// ─── file walking ───────────────────────────────────────────────────────

function* walkMd(dir: string, base = dir): Generator<string> {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			// skip tmp, .git, node_modules
			if (entry.name === "tmp" || entry.name === ".git" || entry.name === "node_modules") continue;
			yield* walkMd(full, base);
		} else if (entry.name.endsWith(".md")) {
		yield path.relative(base, full).split(path.sep).join("/");
		}
	}
}

// ─── sublode ownership ──────────────────────────────────────────────────

interface SublodeConfig {
	paths: string[];
	issues: string[];
}

function isInsidePath(parent: string, candidate: string): boolean {
	const rel = path.relative(parent, candidate);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/**
 * Read the complete sublode ownership list from the root summary. Sublode
 * paths are relative to the project root (the parent of the root lode).
 * Invalid declarations are reported and excluded rather than widening scope.
 */
function readSublodeConfig(lodeRoot: string): SublodeConfig {
	const projectRoot = path.resolve(path.dirname(lodeRoot));
	const lodeRootAbs = path.resolve(lodeRoot);
	const paths: string[] = [];
	const issues: string[] = [];
	const accepted: Array<{ rel: string; full: string; real: string }> = [];
	let declared: string[] = [];
	let realProjectRoot: string;
	let realLodeRoot: string;

	try {
		realProjectRoot = fs.realpathSync(projectRoot);
		realLodeRoot = fs.realpathSync(lodeRootAbs);
		const content = fs.readFileSync(path.join(lodeRoot, "summary.md"), "utf8");
		declared = parseFrontmatter(content).fm.sublodes ?? [];
	} catch {
		return { paths, issues };
	}

	for (const raw of declared) {
		if (path.isAbsolute(raw)) {
			issues.push(`invalid sublode '${raw}': absolute paths are not allowed`);
			continue;
		}

		const full = path.resolve(projectRoot, raw);
		const rel = path.relative(projectRoot, full).split(path.sep).join("/");
		if (!isInsidePath(projectRoot, full)) {
			issues.push(`invalid sublode '${raw}': path escapes the project root`);
			continue;
		}
		if (full === lodeRootAbs) {
			issues.push(`invalid sublode '${raw}': path refers to the root lode`);
			continue;
		}
		if (isInsidePath(lodeRootAbs, full) || isInsidePath(full, lodeRootAbs)) {
			issues.push(`invalid sublode '${raw}': path overlaps the root lode`);
			continue;
		}

		let stat: fs.Stats;
		try {
			stat = fs.statSync(full);
		} catch {
			issues.push(`invalid sublode '${raw}': directory does not exist`);
			continue;
		}
		if (!stat.isDirectory()) {
			issues.push(`invalid sublode '${raw}': path is not a directory`);
			continue;
		}

		let realFull: string;
		try {
			realFull = fs.realpathSync(full);
		} catch {
			issues.push(`invalid sublode '${raw}': path cannot be resolved`);
			continue;
		}
		if (!isInsidePath(realProjectRoot, realFull)) {
			issues.push(`invalid sublode '${raw}': resolved path escapes the project root`);
			continue;
		}
		if (realFull === realLodeRoot) {
			issues.push(`invalid sublode '${raw}': path resolves to the root lode`);
			continue;
		}
		if (isInsidePath(realLodeRoot, realFull) || isInsidePath(realFull, realLodeRoot)) {
			issues.push(`invalid sublode '${raw}': resolved path overlaps the root lode`);
			continue;
		}
		const duplicate = accepted.find(entry => entry.full === full || entry.real === realFull);
		if (duplicate) {
			issues.push(`duplicate sublode '${raw}': same directory as '${duplicate.rel}'`);
			continue;
		}
		const overlap = accepted.find(entry =>
			isInsidePath(entry.real, realFull) || isInsidePath(realFull, entry.real)
		);
		if (overlap) {
			issues.push(`invalid sublode '${raw}': overlaps '${overlap.rel}'`);
			continue;
		}

		const summaryPath = path.join(full, "summary.md");
		try {
			if (!fs.statSync(summaryPath).isFile()) throw new Error("not a file");
		} catch {
			issues.push(`invalid sublode '${raw}': summary.md is missing`);
			continue;
		}

		accepted.push({ rel, full, real: realFull });
		paths.push(rel);
	}

	return { paths: paths.sort(), issues };
}

function loadFile(relPath: string, root: string): LodeFile {
	const absPath = path.join(root, relPath);
	const content = fs.readFileSync(absPath, "utf8");
	const { fm, body, bodyLineOffset } = parseFrontmatter(content);
	const terms = parseTerms(body).map(t => ({ ...t, source: relPath }));
	const links = extractLinks(body, relPath, root);
	return {
		relPath,
		absPath,
		frontmatter: fm,
		body,
		bodyLineOffset,
		lines: content.split("\n").length,
		terms,
		links,
		backlinks: [],
	};
}

function loadAll(root: string, include?: (relPath: string) => boolean): LodeFile[] {
	const projectRoot = path.dirname(root);
	const files: LodeFile[] = [];

	// root lode files — paths relative to project root (e.g. "lode/summary.md")
	for (const rel of walkMd(root, projectRoot)) {
		if (include && !include(rel)) continue;
		try {
			files.push(loadFile(rel, projectRoot));
		} catch { /* skip unreadable */ }
	}

	// sublode files — merge by default, paths relative to project root
	for (const sub of readSublodeConfig(root).paths) {
		const subRoot = path.join(projectRoot, sub);
		for (const rel of walkMd(subRoot, projectRoot)) {
			if (include && !include(rel)) continue;
			try {
				files.push(loadFile(rel, projectRoot));
			} catch { /* skip unreadable */ }
		}
	}

	// build wiki-link cache with all files
	fileIndex = new Map();
	for (const f of files) {
		fileIndex.set(path.basename(f.relPath, ".md").toLowerCase(), f.relPath);
	}
	// compute backlinks by inverting the link graph
	const byPath = new Map(files.map(f => [f.relPath, f]));
	for (const f of files) {
		for (const link of f.links) {
			const target = byPath.get(link);
			if (target) target.backlinks.push(f.relPath);
		}
	}

	return files;
}

// ─── path resolution ────────────────────────────────────────────────────

function findLodeRoot(start?: string): string {
	const cwd = start ?? process.cwd();
	// if cwd has a lode/ subdirectory, use that
	const lodeDir = path.join(cwd, "lode");
	if (fs.existsSync(lodeDir) && fs.statSync(lodeDir).isDirectory()) return lodeDir;
	// if cwd itself looks like a lode (has lode-map.md or summary.md)
	if (fs.existsSync(path.join(cwd, "lode-map.md")) || fs.existsSync(path.join(cwd, "summary.md"))) return cwd;
	// walk up
	let dir = cwd;
	while (dir !== path.dirname(dir)) {
		const candidate = path.join(dir, "lode");
		if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return candidate;
		dir = path.dirname(dir);
	}
	return cwd;
}

function parseFilterArgs(args: string[]): { type?: string; tag?: string; rest: string[] } {
	const result: { type?: string; tag?: string; rest: string[] } = { rest: [] };
	for (const arg of args) {
		if (arg.startsWith("--type=")) result.type = arg.slice("--type=".length);
		else if (arg.startsWith("--tag=")) result.tag = arg.slice("--tag=".length);
		else result.rest.push(arg);
	}
	return result;
}

interface GitCommandResult {
	status: number;
	stdout: string;
	stderr: string;
}

function runGit(cwd: string, args: string[]): GitCommandResult {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
	});
	return {
		status: result.status ?? 1,
		stdout: result.stdout ?? "",
		stderr: result.stderr || result.error?.message || "",
	};
}

function findGitRoot(start: string): string | null {
	const result = runGit(start, ["rev-parse", "--show-toplevel"]);
	if (result.status !== 0 || !result.stdout.trim()) return null;
	try {
		return fs.realpathSync(result.stdout.trim());
	} catch {
		return path.resolve(result.stdout.trim());
	}
}

function canonicalProjectRoot(lodeRoot: string): string {
	try {
		return path.dirname(fs.realpathSync(lodeRoot));
	} catch {
		return path.resolve(path.dirname(lodeRoot));
	}
}

function toGitPath(value: string): string {
	return value.split(path.sep).join("/");
}

function gitPathKey(value: string): string {
	const normalized = toGitPath(value);
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function resolveProjectRelativePath(projectRoot: string, declared: string): { abs?: string; issue?: string } {
	if (path.isAbsolute(declared)) return { issue: "absolute paths are not allowed" };
	const abs = path.resolve(projectRoot, declared);
	if (!isInsidePath(projectRoot, abs)) return { issue: "path escapes the project root" };
	return { abs };
}

function ownedLodePathspecs(root: string, gitRoot: string): { paths: string[]; skipped: string[] } {
	const projectRoot = path.dirname(root);
	const ownedRoots = [
		path.resolve(root),
		...readSublodeConfig(root).paths.map(sub => path.resolve(projectRoot, sub)),
	];
	const paths = new Set<string>();
	const skipped: string[] = [];

	for (const ownedRoot of ownedRoots) {
		let realRoot: string;
		try {
			realRoot = fs.realpathSync(ownedRoot);
		} catch {
			skipped.push(ownedRoot);
			continue;
		}
		if (!isInsidePath(gitRoot, realRoot)) {
			skipped.push(ownedRoot);
			continue;
		}
		const rel = path.relative(gitRoot, realRoot);
		if (!rel) {
			paths.add(".");
			continue;
		}
		paths.add(toGitPath(rel));
	}

	return { paths: paths.has(".") ? ["."] : [...paths].sort(), skipped };
}

// ─── commands ───────────────────────────────────────────────────────────

const STARTUP_FILES = ["summary.md", "terminology.md", "lode-map.md", "tmp/active.md"];
const BUDGET = 40000;

function cmdStartup(root: string, _args: string[]): void {
	// Verify this is a real lode, not a cwd fallback. If no lode exists,
	// exit silently with zero — the hook calls this unconditionally.
	const hasLode = fs.existsSync(path.join(root, "summary.md"))
		|| fs.existsSync(path.join(root, "lode-map.md"))
		|| fs.existsSync(path.join(root, "terminology.md"));
	if (!hasLode) return;

	const sections: string[] = [];
	let used = 0;
	const omitted: string[] = [];

	for (const rel of STARTUP_FILES) {
		const full = path.join(root, rel);
		try {
			const body = fs.readFileSync(full, "utf8");
			const chars = Buffer.byteLength(body, "utf8");
			if (used + chars <= BUDGET) {
				used += chars;
				sections.push(`=== ${rel} ===\n${body}`);
			} else {
				omitted.push(`${rel} (${chars} chars)`);
			}
		} catch { /* skip missing */ }
	}

	// Sublode summaries — one paragraph each, within budget
	const sublodes = readSublodeConfig(root).paths;
	const projectRoot = path.dirname(root);
	const subSummaries: string[] = [];
	for (const sub of sublodes) {
		const subSummaryPath = path.join(projectRoot, sub, "summary.md");
		try {
			const body = fs.readFileSync(subSummaryPath, "utf8");
			const chars = Buffer.byteLength(body, "utf8");
			if (used + chars <= BUDGET) {
				used += chars;
				subSummaries.push(`=== ${sub}/summary.md ===\n${body}`);
			} else {
				omitted.push(`${sub}/summary.md (${chars} chars)`);
			}
		} catch { /* sublode has no summary.md — check will flag it */ }
	}

	if (sections.length === 0) {
		console.error("No entrypoint files found.");
		process.exit(1);
	}
	console.log(sections.join("\n"));
	if (subSummaries.length > 0) {
		console.log("\n" + subSummaries.join("\n"));
	}
	// A pointer, not an inventory. Injecting the generated index would duplicate
	// the curated map's routing in flat form, and the pair drifts unnoticed; naming
	// the command that prints it costs one line and demonstrates the tool in place.
	// The real count is here so a session can judge whether the inventory is worth
	// a call at this lode's size.
	console.log(
		`\n=== lode map ===\n${loadAll(root).length} files in this lode. \`lode map\` prints the one-line inventory; \`lode search <query>\` finds one.`,
	);
	if (omitted.length > 0) {
		console.log(`\n=== over the ${BUDGET}-char budget, NOT loaded — read these ===`);
		console.log(omitted.map(o => `- ${o}`).join("\n"));
	}
	console.log("\n" + TOOL_HELP);
}

const TOOL_HELP = `=== lode-cli ===
The \`lode\` tool is available for searching and navigating this lode:

  lode search <query>       metadata search; add --content and optional --under=PATH for full text
  lode list [--type=T] [--tag=T]   list files, optionally filtered
  lode walk <file-or-dir>   follow internal links, show linked summaries
  lode map                  print directory index from frontmatter
  lode terms                aggregate term blocks across the lode
  lode tags                 show tag frequency counts
  lode check                lint frontmatter, links, terms, line count, map routing
  lode precommit            report staged source changes linked from lode files
  lode recent [N]           show patches for recent lode-touching commits
  lode plans [--status=S]  list and filter plans by lifecycle status
  lode mail send <project> <subject>   send inter-project mail (body on stdin)
  lode mail read                        show and mark unread mail for current project
  lode mail unread                      print count of unread mail

Use these instead of manually grepping the lode directory. The files are still
plain markdown — read and edit them directly when you know which file you need.`;

function cmdSearch(root: string, args: string[]): void {
	const contentMode = args.includes("--content");
	const jsonMode = args.includes("--json");
	const limitArg = args.find(arg => arg.startsWith("--limit="));
	const underArg = args.find(arg => arg.startsWith("--under="));
	const queryArg = args.find(arg => arg.startsWith("--query="));
	const limit = limitArg ? Number.parseInt(limitArg.slice("--limit=".length), 10) : 20;
	if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
		console.error("lode search: --limit must be an integer from 1 to 100");
		process.exit(2);
	}

	let under: string | undefined;
	if (underArg) {
		const raw = underArg.slice("--under=".length);
		if (!raw || path.isAbsolute(raw)) {
			console.error("lode search: --under must be a non-empty project-relative path");
			process.exit(2);
		}
		under = path.normalize(raw).split(path.sep).join("/");
		if (under === ".." || under.startsWith("../")) {
			console.error("lode search: --under may not escape the project root");
			process.exit(2);
		}
		if (under === ".") under = undefined;
	}

	const positional = args.filter(arg =>
		arg !== "--content" &&
		arg !== "--json" &&
		!arg.startsWith("--limit=") &&
		!arg.startsWith("--under=") &&
		!arg.startsWith("--query=")
	);
	if (queryArg && positional.length > 0) {
		console.error("lode search: use either positional query text or --query, not both");
		process.exit(2);
	}
	const query = (queryArg ? queryArg.slice("--query=".length) : positional.join(" ")).trim().toLowerCase();
	if (!query) {
		console.error("Usage: lode search <query> [--content] [--under=PATH] [--json] [--limit=N]");
		process.exit(2);
	}
	const terms = query.split(/\s+/).filter(Boolean);
	const include = under
		? (relPath: string) => relPath === under || relPath.startsWith(`${under}/`)
		: undefined;
	const files = loadAll(root, include);

	if (contentMode) {
		const results: Array<{
			path: string;
			score: number;
			summary: string | null;
			matches: Array<{ line: number; text: string }>;
		}> = [];
		for (const file of files) {
			const folded = file.body.toLowerCase();
			if (!terms.every(term => folded.includes(term))) continue;
			let score = 0;
			for (const term of terms) score += folded.split(term).length - 1;
			const matches: Array<{ line: number; text: string }> = [];
			const lines = file.body.split("\n");
			for (let index = 0; index < lines.length && matches.length < 3; index++) {
				const foldedLine = lines[index].toLowerCase();
				if (!terms.some(term => foldedLine.includes(term))) continue;
				const text = lines[index].trim().replace(/\s+/g, " ");
				matches.push({
					line: index + 1 + file.bodyLineOffset,
					text: text.length > 240 ? `${text.slice(0, 237)}...` : text,
				});
			}
			results.push({
				path: file.relPath.split(path.sep).join("/"),
				score,
				summary: file.frontmatter.summary ?? null,
				matches,
			});
		}
		results.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
		const bounded = results.slice(0, limit);
		if (jsonMode) {
			console.log(JSON.stringify({ query, scope: "content", under: under ?? null, total: results.length, results: bounded }, null, 2));
			return;
		}
		for (const result of bounded) {
			for (const match of result.matches) console.log(`${result.path}:${match.line}: ${match.text}`);
		}
		if (bounded.length === 0) console.log("No matches.");
		else if (results.length > bounded.length) console.log(`... ${results.length - bounded.length} more matching files`);
		return;
	}

	const results: Array<{ file: LodeFile; score: number }> = [];
	for (const file of files) {
		const haystacks = [
			...(file.frontmatter.keywords ?? []).map(k => k.toLowerCase()),
			...(file.frontmatter.tags ?? []).map(t => t.toLowerCase()),
			(file.frontmatter.summary ?? "").toLowerCase(),
			(file.frontmatter.type ?? "").toLowerCase(),
			(file.frontmatter.status ?? "").toLowerCase(),
			path.basename(file.relPath, ".md").toLowerCase(),
		];
		let score = 0;
		for (const term of terms) {
			for (const haystack of haystacks) {
				if (haystack.includes(term)) score += 1;
			}
		}
		if (score > 0) results.push({ file, score });
	}

	results.sort((a, b) => b.score - a.score || a.file.relPath.localeCompare(b.file.relPath));
	const bounded = results.slice(0, limit);
	if (jsonMode) {
		console.log(JSON.stringify({
			query,
			scope: "metadata",
			under: under ?? null,
			total: results.length,
			results: bounded.map(({ file, score }) => ({
				path: file.relPath.split(path.sep).join("/"),
				score,
				summary: file.frontmatter.summary ?? null,
				tags: file.frontmatter.tags ?? [],
			})),
		}, null, 2));
		return;
	}
	for (const { file, score } of bounded) {
		const summary = file.frontmatter.summary ?? "(no summary)";
		const tags = file.frontmatter.tags?.length ? ` [${file.frontmatter.tags.join(", ")}]` : "";
		console.log(`${file.relPath} (${score}) — ${summary}${tags}`);
	}
	if (bounded.length === 0) console.log("No matches.");
	else if (results.length > bounded.length) console.log(`... ${results.length - bounded.length} more matching files`);
}

function cmdList(root: string, args: string[]): void {
	const { type, tag } = parseFilterArgs(args);
	let files = loadAll(root);
	if (type) files = files.filter(f => f.frontmatter.type === type);
	if (tag) files = files.filter(f => f.frontmatter.tags?.includes(tag));

	for (const file of files) {
		const t = file.frontmatter.type ?? "?";
		const summary = file.frontmatter.summary ?? "(no summary)";
		console.log(`[${t}] ${file.relPath} — ${summary}`);
	}
	if (files.length === 0) console.log("No files match.");
}

function cmdWalk(root: string, args: string[]): void {
	const target = args[0];
	if (!target) {
		console.error("Usage: lode walk <file-or-dir>");
		process.exit(2);
	}
	const all = loadAll(root);
	const byPath = new Map(all.map(f => [f.relPath, f]));

	// `relPath` keys are project-relative ("lode/foo.md"), so a lode-relative
	// target has to be normalized before lookup. Accept both forms: the shape a
	// session types ("foo.md") and the shape every other command prints
	// ("lode/foo.md").
	const relBase = path.dirname(root);
	const insideLode = path.resolve(root, target);
	const absTarget = fs.existsSync(insideLode) ? insideLode : path.resolve(relBase, target);
	const rel = path.relative(relBase, absTarget).split(path.sep).join("/");
	let isDir = false;
	try {
		isDir = fs.statSync(absTarget).isDirectory();
	} catch {
		console.error(`Not found: ${target}`);
		process.exit(1);
	}
	const startFiles = isDir
		? all.filter(f => f.relPath.startsWith(rel + "/"))
		: [byPath.get(rel)].filter(Boolean) as LodeFile[];

	if (startFiles.length === 0) {
		console.error(`No files found at: ${target}`);
		process.exit(1);
	}

	for (const file of startFiles) {
		console.log(`\n${file.relPath}`);
		const summary = file.frontmatter.summary ?? "(no summary)";
		console.log(`  summary: ${summary}`);
		if (file.links.length === 0) {
			console.log("  links: (none)");
		} else {
			console.log("  links:");
			const seen = new Set<string>();
			for (const link of file.links) {
				if (seen.has(link)) continue;
				seen.add(link);
				const linked = byPath.get(link);
				if (linked) {
					const lsum = linked.frontmatter.summary ?? "(no summary)";
					console.log(`    → ${link} — ${lsum}`);
				} else {
					console.log(`    → ${link} — (BROKEN)`);
				}
			}
		}
		if (file.backlinks.length > 0) {
			console.log("  backlinks:");
			for (const bl of file.backlinks) {
				const linked = byPath.get(bl);
				const lsum = linked?.frontmatter.summary ?? "(no summary)";
				console.log(`    ← ${bl} — ${lsum}`);
			}
		}
	}
}

function cmdMap(root: string, _args: string[]): void {
	const files = loadAll(root);
	const planRoots = ownedPlanRoots(root);

	// group by directory
	const byDir = new Map<string, LodeFile[]>();
	for (const file of files) {
		const dir = path.dirname(file.relPath);
		if (!byDir.has(dir)) byDir.set(dir, []);
		byDir.get(dir)!.push(file);
	}

	const dirs = [...byDir.keys()].sort();
	for (const dir of dirs) {
		const entries = byDir.get(dir)!.sort((a, b) => a.relPath.localeCompare(b.relPath));
		if (dir !== ".") console.log(`\n${dir}/`);

		// Plans are summarized, not enumerated. Their load-bearing field is
		// lifecycle status, which this inventory drops — a `done` plan awaiting
		// deletion reads as live work here. `lode plans` is their view. The count
		// still prints, so a session reading only the map cannot conclude that a
		// lode with plans has none.
		if (entries.every(file => isPlanFile(file, planRoots))) {
			const byStatus = PLAN_STATUSES.map(status => ({
				status,
				count: entries.filter(file => file.frontmatter.status === status).length,
			})).filter(entry => entry.count > 0);
			const unknown = entries.length - byStatus.reduce((sum, entry) => sum + entry.count, 0);
			if (unknown > 0) byStatus.push({ status: "no status", count: unknown });
			const breakdown = byStatus.map(entry => `${entry.count} ${entry.status}`).join(", ");
			console.log(`  ${entries.length} plan(s) — ${breakdown} — see \`lode plans\``);
			continue;
		}

		for (const file of entries) {
			const summary = file.frontmatter.summary ?? path.basename(file.relPath);
			console.log(`  ${path.basename(file.relPath)} — ${summary}`);
		}
	}
}

function cmdTerms(root: string, _args: string[]): void {
	const files = loadAll(root);
	const allTerms = new Map<string, TermEntry[]>();

	for (const file of files) {
		for (const term of file.terms) {
			if (!allTerms.has(term.name)) allTerms.set(term.name, []);
			allTerms.get(term.name)!.push(term);
		}
	}

	const names = [...allTerms.keys()].sort();
	for (const name of names) {
		const entries = allTerms.get(name)!;
		if (entries.length === 1) {
			console.log(`- **${entries[0].name}** — ${entries[0].def} (${entries[0].source})`);
		} else {
			console.log(`- **${name}** — CONFLICT:`);
			for (const e of entries) {
				console.log(`    ${e.source}: ${e.def}`);
			}
		}
	}
	if (names.length === 0) console.log("No terms found.");
}

function cmdTags(root: string, _args: string[]): void {
	const files = loadAll(root);
	const counts = new Map<string, number>();

	for (const file of files) {
		for (const tag of file.frontmatter.tags ?? []) {
			counts.set(tag, (counts.get(tag) ?? 0) + 1);
		}
	}

	const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
	for (const [tag, count] of sorted) {
		console.log(`${count}\t${tag}`);
	}
	if (sorted.length === 0) console.log("No tags found.");
}

function cmdPrecommit(root: string, args: string[]): void {
	if (args.length > 0) {
		console.error("Usage: lode precommit");
		process.exit(2);
	}

	const gitRoot = findGitRoot(root);
	if (!gitRoot) {
		console.error("Cannot run precommit: the selected lode is not inside a Git repository.");
		process.exit(1);
	}

	const stagedResult = runGit(gitRoot, [
		"diff",
		"--cached",
		"--name-only",
		"--no-renames",
		"-z",
		"--",
	]);
	if (stagedResult.status !== 0) {
		console.error(`Cannot read staged files: ${stagedResult.stderr.trim() || "git diff failed"}`);
		process.exit(1);
	}

	const staged = new Map<string, string>();
	for (const file of stagedResult.stdout.split("\0").filter(Boolean)) {
		staged.set(gitPathKey(file), file);
	}
	if (staged.size === 0) {
		console.log("No staged files.");
		return;
	}

	const projectRoot = canonicalProjectRoot(root);
	const owned = ownedLodePathspecs(root, gitRoot);
	for (const skipped of owned.skipped) {
		console.error(`[WARN] owned lode is outside this Git repository and was skipped: ${skipped}`);
	}
	const affected: Array<{ file: string; sources: string[] }> = [];
	for (const file of loadAll(root)) {
		let realFile: string;
		try {
			realFile = fs.realpathSync(file.absPath);
		} catch {
			continue;
		}
		if (!isInsidePath(gitRoot, realFile)) continue;
		const matches = new Set<string>();
		for (const declared of file.frontmatter.sources ?? []) {
			const resolved = resolveProjectRelativePath(projectRoot, declared);
			if (!resolved.abs) {
				console.error(`[WARN] ${file.relPath}: invalid source '${declared}': ${resolved.issue}`);
				continue;
			}
			if (!isInsidePath(gitRoot, resolved.abs)) {
				console.error(`[WARN] ${file.relPath}: source '${declared}' is outside the Git repository`);
				continue;
			}
			const gitPath = gitPathKey(path.relative(gitRoot, resolved.abs));
			const stagedPath = staged.get(gitPath);
			if (stagedPath) matches.add(stagedPath);
		}
		if (matches.size > 0) {
			affected.push({ file: file.relPath, sources: [...matches].sort() });
		}
	}

	if (affected.length === 0) {
		console.log("No source-linked lode files affected.");
		return;
	}
	for (const match of affected.sort((a, b) => a.file.localeCompare(b.file))) {
		console.log(`[INFO] ${match.file}: staged source changed → ${match.sources.join(", ")}`);
	}
}

function cmdRecent(root: string, args: string[]): void {
	const countArg = args[0] ?? "5";
	if (args.length > 1 || !/^[1-9]\d*$/.test(countArg)) {
		console.error("Usage: lode recent [positive-commit-count]");
		process.exit(2);
	}

	const gitRoot = findGitRoot(root);
	if (!gitRoot) {
		console.error("Cannot show recent changes: the selected lode is not inside a Git repository.");
		process.exit(1);
	}
	const owned = ownedLodePathspecs(root, gitRoot);
	for (const skipped of owned.skipped) {
		console.error(`[WARN] owned lode is outside this Git repository and was skipped: ${skipped}`);
	}
	if (owned.paths.length === 0) {
		console.error("Cannot show recent changes: no owned lodes are tracked by this Git repository.");
		process.exit(1);
	}

	const head = runGit(gitRoot, ["rev-parse", "--verify", "HEAD"]);
	if (head.status !== 0) {
		console.log("No committed lode changes.");
		return;
	}

	const result = runGit(gitRoot, [
		"--literal-pathspecs",
		"log",
		"-n",
		countArg,
		"--no-color",
		"--no-ext-diff",
		"--find-renames",
		"--date=iso-strict",
		"--format=commit %H%nAuthor: %an <%ae>%nDate:   %ad%n%n    %s%n",
		"--patch",
		"--",
		...owned.paths,
	]);
	if (result.status !== 0) {
		console.error(`Cannot read lode history: ${result.stderr.trim() || "git log failed"}`);
		process.exit(1);
	}
	if (!result.stdout.trim()) {
		console.log("No committed lode changes.");
		return;
	}
	process.stdout.write(result.stdout);
	if (!result.stdout.endsWith("\n")) process.stdout.write("\n");
}

const PLAN_STATUSES = ["idea", "accepted", "active", "done", "parked"];

function ownedLodeRoots(root: string): string[] {
	const projectRoot = path.dirname(root);
	return [
		path.resolve(root),
		...readSublodeConfig(root).paths.map(sub => path.resolve(projectRoot, sub)),
	];
}

function ownedPlanRoots(root: string): string[] {
	return ownedLodeRoots(root).map(lodeRoot => path.join(lodeRoot, "plans"));
}

/**
 * Reachability is "a path from the map reaches this file", not "some file links
 * it".
 *
 * `lode-map.md` is the curated routing authority: it carries areas, read order,
 * traps, and outward routes to product artifacts that frontmatter cannot imply,
 * while `lode map` prints the mechanical inventory so the map never duplicates
 * it. A prose mention in a domain file is therefore not a route — a file can be
 * named in passing by three files and still sit off every path a session takes.
 *
 * Routing relays only through summaries: the map names areas, and each area's
 * `summary.md` routes its own files. That keeps the map bounded by area count
 * instead of file count, which is what lets it stay an entry file. A domain
 * file's "Related" list is a cross-link between peers, not a route inward.
 *
 * Plans are exempt. They are transient by construction, so a curated map line
 * would be born with a deletion date; `lode plans` is their view and carries the
 * lifecycle status that a flat inventory strips.
 */
function routedFromMap(root: string, files: LodeFile[]): Set<string> {
	const byPath = new Map(files.map(file => [file.relPath, file]));
	const relBase = path.resolve(path.dirname(root));
	const queue = ownedLodeRoots(root).flatMap(dir =>
		["lode-map.md", "summary.md"].map(name => path.relative(relBase, path.join(dir, name)).split(path.sep).join("/")),
	);
	const routed = new Set<string>();
	while (queue.length > 0) {
		const file = byPath.get(queue.pop()!);
		if (!file) continue;
		for (const link of file.links) {
			if (routed.has(link)) continue;
			routed.add(link);
			if (path.basename(link) === "summary.md") queue.push(link);
		}
	}
	return routed;
}

function isPlanFile(file: LodeFile, planRoots: string[]): boolean {
	const absPath = path.resolve(file.absPath);
	return planRoots.some(planRoot => isInsidePath(planRoot, absPath));
}

function cmdPlans(root: string, args: string[]): void {
	let status: string | undefined;
	for (const arg of args) {
		if (arg.startsWith("--status=") && status === undefined) {
			status = arg.slice("--status=".length);
		} else {
			console.error("Usage: lode plans [--status=idea|accepted|active|done|parked]");
			process.exit(2);
		}
	}
	if (status !== undefined && !PLAN_STATUSES.includes(status)) {
		console.error(`Unknown plan status '${status}'. Expected: ${PLAN_STATUSES.join(", ")}`);
		process.exit(2);
	}

	const planRoots = ownedPlanRoots(root);
	let plans = loadAll(root).filter(file => isPlanFile(file, planRoots));
	if (status) plans = plans.filter(file => file.frontmatter.status === status);
	plans.sort((a, b) => {
		const aOrder = PLAN_STATUSES.indexOf(a.frontmatter.status ?? "");
		const bOrder = PLAN_STATUSES.indexOf(b.frontmatter.status ?? "");
		const normalizedA = aOrder === -1 ? PLAN_STATUSES.length : aOrder;
		const normalizedB = bOrder === -1 ? PLAN_STATUSES.length : bOrder;
		return normalizedA - normalizedB || a.relPath.localeCompare(b.relPath);
	});

	for (const file of plans) {
		const planStatus = file.frontmatter.status ?? "?";
		const summary = file.frontmatter.summary ?? "(no summary)";
		console.log(`[${planStatus}] ${file.relPath} — ${summary}`);
	}
	if (plans.length === 0) console.log("No plans match.");
}

// ─── staleness and coverage checks ──────────────────────────────────────

/** Days before an active plan with no recorded blocker is flagged as stale. */
const ACTIVE_PLAN_STALE_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Flag active plans whose last file write (fs mtime) exceeds a threshold. A
 * stale active plan is drift — either the work stalled without recording why, or
 * the plan was abandoned without being moved to parked/done. Warn (never error):
 * the remedy is a judgment call (reconfirm active, pause, or advance).
 */
function checkActivePlanStaleness(files: LodeFile[], planRoots: string[]): Array<{ file: string; issue: string; severity: string }> {
	const now = Date.now();
	const cutoff = now - ACTIVE_PLAN_STALE_DAYS * MS_PER_DAY;
	const issues: Array<{ file: string; issue: string; severity: string }> = [];
	for (const file of files) {
		if (!isPlanFile(file, planRoots)) continue;
		if (file.frontmatter.status !== "active") continue;
		let mtime: number;
		try {
			mtime = fs.statSync(file.absPath).mtimeMs;
		} catch {
			continue;
		}
		if (mtime < cutoff) {
			const days = Math.floor((now - mtime) / MS_PER_DAY);
			issues.push({
				file: file.relPath,
				issue: `active plan untouched for ${days} days (over ${ACTIVE_PLAN_STALE_DAYS}) — reconfirm it's active, pause it, or advance it`,
				severity: "warn",
			});
		}
	}
	return issues;
}

/**
 * Check on-disk top-level lode directories against mentions in lode-map.md. A
 * directory whose name appears nowhere in the map body is drift: either the map
 * is missing an area, or the directory should be named in the map's
 * "Deliberately unmapped" note. Warn (never error): an unmentioned directory
 * blocks no correct operation. `tmp/` is always exempt (session scraps, never
 * routed). `plans/` is exempt (plans have their own view via `lode plans`).
 */
function checkMapCoverage(root: string, files: LodeFile[]): Array<{ file: string; issue: string; severity: string }> {
	const mapFile = files.find(f => path.basename(f.relPath) === "lode-map.md");
	if (!mapFile) return [];
	const mapBody = mapFile.body.toLowerCase();
	const lodeRoot = path.resolve(root);
	const issues: Array<{ file: string; issue: string; severity: string }> = [];
	const exempt = new Set(["tmp", "plans"]);
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(lodeRoot, { withFileTypes: true });
	} catch {
		return [];
	}
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		if (exempt.has(entry.name)) continue;
		if (entry.name.startsWith(".")) continue;
		const name = entry.name.toLowerCase();
		let mentioned: boolean;
		if (name.length <= 2) {
			mentioned = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\\\]/g, "\\\\$&")}\\b`).test(mapBody);
		} else {
			mentioned = mapBody.includes(name);
		}
		if (!mentioned) {
			issues.push({
				file: "lode-map.md",
				issue: `${entry.name}/ has no mention in lode-map.md — add it to the routing or to a "deliberately unmapped" note`,
				severity: "warn",
			});
		}
	}
	return issues;
}

function cmdCheck(root: string, _args: string[]): void {
	const files = loadAll(root);
	const allPaths = new Set(files.map(f => f.relPath));
	const issues: Array<{ file: string; issue: string; severity: string }> = [];

	const rootSummary = path.relative(path.dirname(root), path.join(root, "summary.md")).split(path.sep).join("/");
	for (const issue of readSublodeConfig(root).issues) {
		issues.push({ file: rootSummary, issue, severity: "error" });
	}
	const projectRoot = canonicalProjectRoot(root);
	const planRoots = ownedPlanRoots(root);

	const routed = routedFromMap(root, files);
	// Entrypoints are exempt by exact path, not by basename: a domain folder's
	// summary.md is ordinary content that the map must route, while an owned
	// sublode's summary.md is its own lode's entrypoint and is injected by
	// `lode startup`. Matching on basename alone exempts every domain summary and
	// lets a whole folder go unreachable without a warning.
	const relBase = path.resolve(path.dirname(root));
	const entrypoints = new Set(
		ownedLodeRoots(root).flatMap(dir =>
		STARTUP_FILES.map(name => path.relative(relBase, path.join(dir, name)).split(path.sep).join("/")),
		),
	);

	for (const file of files) {
		const rel = file.relPath;
		const fm = file.frontmatter;
		const isPlan = isPlanFile(file, planRoots);

		// Missing frontmatter
		if (!fm.type && !fm.tags && !fm.keywords && !fm.summary && !fm.sublodes && !fm.sources && !fm.status && !fm.lineBudget) {
			issues.push({ file: rel, issue: "no frontmatter", severity: "warn" });
		}
		// Missing type
		if (!fm.type) {
			issues.push({ file: rel, issue: "missing type (domain|external)", severity: "warn" });
		} else if (fm.type !== "domain" && fm.type !== "external") {
			issues.push({ file: rel, issue: `unknown type '${fm.type}'`, severity: "warn" });
		}
		// Missing summary
		if (!fm.summary) {
			issues.push({ file: rel, issue: "missing summary", severity: "warn" });
		}
		// Missing keywords
		if (!fm.keywords || fm.keywords.length === 0) {
			issues.push({ file: rel, issue: "missing keywords", severity: "warn" });
		}
		// Plan lifecycle
		if (isPlan && !fm.status) {
			issues.push({
				file: rel,
				issue: `missing plan status (${PLAN_STATUSES.join("|")})`,
				severity: "warn",
			});
		} else if (isPlan && !PLAN_STATUSES.includes(fm.status!)) {
			issues.push({ file: rel, issue: `unknown plan status '${fm.status}'`, severity: "warn" });
		}
		// Invalid or duplicate source relationships
		const seenSources = new Set<string>();
		for (const declared of fm.sources ?? []) {
			const resolved = resolveProjectRelativePath(projectRoot, declared);
			if (!resolved.abs) {
				issues.push({
					file: rel,
					issue: `invalid source '${declared}': ${resolved.issue}`,
					severity: "error",
				});
				continue;
			}
			const normalized = process.platform === "win32" ? resolved.abs.toLowerCase() : resolved.abs;
			if (seenSources.has(normalized)) {
				issues.push({ file: rel, issue: `duplicate source '${declared}'`, severity: "warn" });
				continue;
			}
			seenSources.add(normalized);
		}
		// Over 250 lines. `line-budget: exempt` opts out: the limit budgets a file a
		// reader opens on purpose and decomposes when it grows, which does not
		// describe an append-only record whose whole role is length.
		if (fm.lineBudget !== undefined && fm.lineBudget !== "exempt") {
			issues.push({
				file: rel,
				issue: `unknown line-budget '${fm.lineBudget}' (expected: exempt)`,
				severity: "warn",
			});
		}
		if (file.lines > 250 && fm.lineBudget !== "exempt") {
			issues.push({ file: rel, issue: `${file.lines} lines (over 250)`, severity: "warn" });
		}
		// Broken links. The map and plans deliberately route outward to product
		// artifacts, which are not Lode files, so membership in the lode is not the
		// test — a link is broken only when nothing exists at the path. A typo
		// inside `lode/` still fails, because that path does not exist either.
		for (const link of file.links) {
			if (allPaths.has(link)) continue;
			const abs = path.resolve(relBase, link);
			if (existsCaseExact(abs)) continue;
			if (fs.existsSync(abs)) {
				issues.push({ file: rel, issue: `broken link → ${link} (case mismatch — resolves only case-insensitively, breaks on case-sensitive checkouts)`, severity: "warn" });
			} else {
				issues.push({ file: rel, issue: `broken link → ${link}`, severity: "error" });
			}
		}
		// Unrouted: no path from the map reaches it, directly or through an area
		// summary (entrypoints and transient plans are exempt)
		if (!entrypoints.has(rel) && !isPlan && !routed.has(rel)) {
			issues.push({
				file: rel,
				issue: "unrouted — no path from lode-map.md reaches it",
				severity: "warn",
			});
		}
	}

	// Term conflicts
	const termMap = new Map<string, TermEntry[]>();
	for (const file of files) {
		for (const term of file.terms) {
			if (!termMap.has(term.name)) termMap.set(term.name, []);
			termMap.get(term.name)!.push(term);
		}
	}
	for (const [name, entries] of termMap) {
		if (entries.length > 1) {
			const sources = entries.map(e => e.source).join(", ");
			issues.push({ file: sources, issue: `term conflict: '${name}' defined ${entries.length} times`, severity: "warn" });
		}
	}

	// Active plan staleness and map coverage
	issues.push(...checkActivePlanStaleness(files, planRoots));
	issues.push(...checkMapCoverage(root, files));
	if (issues.length === 0) {
		console.log("All clear.");
		return;
	}

	// Sort by severity then file
	const order: Record<string, number> = { error: 0, warn: 1, info: 2 };
	issues.sort((a, b) => order[a.severity] - order[b.severity] || a.file.localeCompare(b.file));

	for (const { file, issue, severity } of issues) {
		const tag = severity === "error" ? "ERROR" : severity === "warn" ? "WARN" : "INFO";
		console.log(`[${tag}] ${file}: ${issue}`);
	}

	const errors = issues.filter(i => i.severity === "error").length;
	const warns = issues.filter(i => i.severity === "warn").length;
	const infos = issues.filter(i => i.severity === "info").length;
	console.log(`\n${errors} error(s), ${warns} warning(s), ${infos} info`);
}

// ─── mail ───────────────────────────────────────────────────────────────
//
// Inter-project dead-drop mail. Each project has a mailbox at
// ~/.lode/mail/<project>/. Mails are individual JSON files (UUID-named).
// Any mail command registers the calling project in ~/.lode/projects.json.
// (crypto and os imported at top of file)

const LODE_HOME = path.join(os.homedir(), ".lode");
const MAIL_DIR = path.join(LODE_HOME, "mail");
const PROJECTS_FILE = path.join(LODE_HOME, "projects.json");

interface Mail {
	id: string;
	from: string;       // project name of sender
	to: string;          // project name of recipient
	sent: string;        // ISO timestamp
	read: boolean;
	subject: string;
	body: string;
}

/**
 * Resolve a project name to its mailbox directory name.
 * Tries: exact match against known project names, final path segment match,
 * relative path from ~/projects/, full path. Rejects if ambiguous.
 */
function resolveProjectName(input: string): string {
	const projects = readProjects();
	const registeredNames = [...new Set(Object.values(projects))];

	// exact match against a registered mailbox name
	if (registeredNames.includes(input)) return input;

	// final path segment — check for ambiguity
	const basename = path.basename(input.replace(/\/+$/, ""));
	const matches = registeredNames.filter(n => n === basename);
	if (matches.length === 1) return matches[0];
	if (matches.length > 1) {
		const paths = Object.entries(projects)
			.filter(([, n]) => n === basename)
			.map(([p]) => p);
		console.error(`Ambiguous project name '${basename}' matches:\n${paths.map(p => `  ${p}`).join("\n")}\nUse the full path instead.`);
		process.exit(1);
	}

	// relative from ~/projects/
	const fromProjects = path.join(os.homedir(), "projects", input);
	if (projects[fromProjects]) return projects[fromProjects];
	const fromProjectsBasename = path.basename(fromProjects);
	if (registeredNames.includes(fromProjectsBasename)) {
		const fromMatches = Object.entries(projects)
			.filter(([, n]) => n === fromProjectsBasename)
			.map(([p]) => p);
		if (fromMatches.length === 1) return fromProjectsBasename;
		if (fromMatches.length > 1) {
			console.error(`Ambiguous project name '${fromProjectsBasename}' matches:\n${fromMatches.map(p => `  ${p}`).join("\n")}\nUse the full path instead.`);
			process.exit(1);
		}
	}

	// full path
	const resolved = path.resolve(input);
	if (projects[resolved]) return projects[resolved];

	// fallback: unregistered project — use the basename as its mailbox name
	return basename !== "." ? basename : input;
}

/**
 * Read the project registry. Maps project path → mailbox name.
 */
function readProjects(): Record<string, string> {
	try {
		return JSON.parse(fs.readFileSync(PROJECTS_FILE, "utf8"));
	} catch {
		return {};
	}
}

/**
 * Register the current project in the registry. The mailbox name is the
 * final path segment of the project root (parent of the lode directory).
 */
function registerProject(lodeRoot: string): string {
	const projectPath = path.dirname(lodeRoot);
	const name = path.basename(projectPath);
	const projects = readProjects();

	// register if not present
	let dirty = false;
	if (!(projectPath in projects)) {
		projects[projectPath] = name;
		dirty = true;
	}
	// also check for name collision — if another path maps to the same name,
	// keep both but the first one wins for name resolution
	if (dirty) {
		try {
			fs.mkdirSync(LODE_HOME, { recursive: true });
			fs.writeFileSync(PROJECTS_FILE, JSON.stringify(projects, null, 2) + "\n");
		} catch { /* best effort */ }
	}
	return name;
}

function mailboxDir(name: string): string {
	return path.join(MAIL_DIR, name);
}

function readMailbox(name: string): Mail[] {
	const dir = mailboxDir(name);
	try {
		const files = fs.readdirSync(dir).filter(f => f.endsWith(".json"));
		const mails: Mail[] = [];
		for (const f of files) {
			try {
				mails.push(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
			} catch { /* skip corrupt */ }
		}
		return mails.sort((a, b) => a.sent.localeCompare(b.sent));
	} catch {
		return [];
	}
}

function writeMail(to: string, mail: Mail): void {
	const dir = mailboxDir(to);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, mail.id + ".json"), JSON.stringify(mail, null, 2) + "\n");
}

function markRead(name: string, id: string): void {
	const file = path.join(mailboxDir(name), id + ".json");
	try {
		const mail: Mail = JSON.parse(fs.readFileSync(file, "utf8"));
		mail.read = true;
		fs.writeFileSync(file, JSON.stringify(mail, null, 2) + "\n");
	} catch { /* best effort */ }
}

function cmdMailSend(root: string, args: string[]): void {
	const projectName = registerProject(root);
	const toInput = args[0];
	const subject = args[1] ?? "(no subject)";
	if (!toInput) {
		console.error("Usage: lode mail send <project> <subject>  (body on stdin)");
		process.exit(2);
	}
	const to = resolveProjectName(toInput);

	// read body from stdin
	let body = "";
	if (!process.stdin.isTTY) {
		body = fs.readFileSync(0, "utf8").trim();
	}

	const mail: Mail = {
		id: crypto.randomUUID(),
		from: projectName,
		to,
		sent: new Date().toISOString(),
		read: false,
		subject,
		body: body || "(no body)",
	};
	writeMail(to, mail);
	console.log(`Sent to ${to}: ${subject}`);
}

function cmdMailRead(root: string, _args: string[]): void {
	const projectName = registerProject(root);
	const mails = readMailbox(projectName);
	const unread = mails.filter(m => !m.read);

	if (unread.length === 0) {
		console.log("No unread mail.");
		return;
	}

	for (const mail of unread) {
		console.log(`────────────────────────────────────────`);
		console.log(`From: ${mail.from}`);
		console.log(`Sent: ${mail.sent}`);
		console.log(`Subject: ${mail.subject}`);
	console.log(``);
		console.log(mail.body);
		markRead(projectName, mail.id);
	}
	console.log(`────────────────────────────────────────`);
	console.log(`${unread.length} message(s), all marked read.`);
}

function cmdMailList(root: string, _args: string[]): void {
	const projectName = registerProject(root);
	const mails = readMailbox(projectName);

	if (mails.length === 0) {
		console.log("No mail.");
		return;
	}

	for (const mail of mails) {
		const status = mail.read ? " " : "*";
		console.log(`${status} ${mail.sent}  from ${mail.from}  ${mail.subject}`);
	}
	const unread = mails.filter(m => !m.read).length;
	console.log(`\n${mails.length} total, ${unread} unread`);
}

function cmdMailUnread(root: string, _args: string[]): void {
	const projectName = registerProject(root);
	const mails = readMailbox(projectName);
	const unread = mails.filter(m => !m.read).length;
	console.log(unread);
}

function cmdMail(root: string, args: string[]): void {
	const sub = args[0];
	const subArgs = args.slice(1);

	const MAIL_SUBCOMMANDS: Record<string, (root: string, args: string[]) => void> = {
		send: cmdMailSend,
		read: cmdMailRead,
		list: cmdMailList,
		unread: cmdMailUnread,
	};

	const handler = MAIL_SUBCOMMANDS[sub];
	if (!handler) {
		console.error(`Usage: lode mail <send|read|list|unread>

  lode mail send <project> <subject>   body on stdin, registers current project
  lode mail read                        show and mark unread mail for current project
  lode mail list                        all mail for current project
  lode mail unread                      print count of unread mail`);
		process.exit(2);
	}
	handler(root, subArgs);
}

// ─── main ───────────────────────────────────────────────────────────────

const COMMANDS: Record<string, (root: string, args: string[]) => void> = {
	startup: cmdStartup,
	search: cmdSearch,
	list: cmdList,
	walk: cmdWalk,
	map: cmdMap,
	terms: cmdTerms,
	tags: cmdTags,
	check: cmdCheck,
	precommit: cmdPrecommit,
	recent: cmdRecent,
	plans: cmdPlans,
	mail: cmdMail,
};

const USAGE = `Usage: lode <command> [args] [--path=DIR]

Commands:
  startup              dump entrypoint files for session start
  search <query>       metadata search; --content enables full text, --under=PATH scopes reads
  list [--type=T] [--tag=T]   list files, optionally filtered
  walk <file-or-dir>   resolve internal links, show linked summaries
  map                  print index from frontmatter
  terms                aggregate term blocks into glossary
  tags                 tag counts
  check                lint frontmatter, links, terms, line count, orphans
  precommit            report staged sources linked from lode files
  recent [N]           show patches for recent lode-touching commits
  plans [--status=S]   list and filter plans by lifecycle status
  mail send <project> <subject>   send mail (body on stdin)
  mail read                        show and mark unread mail
  mail list                        all mail for current project
  mail unread                      print count of unread mail

Options:
  --path=DIR           lode root directory (auto-detected if omitted)
  --query=TEXT         pass exact machine-generated query text without positional flag ambiguity
  --content            search Markdown bodies instead of metadata
  --under=PATH         restrict search to a reported project-relative file or directory
  --limit=N            return at most N files (1-100, default 20)
  --json               emit bounded machine-readable search results`;

const [cmd, ...rest] = process.argv.slice(2);
if (!cmd || cmd === "--help" || cmd === "-h") {
	console.log(USAGE);
	process.exit(0);
}

const handler = COMMANDS[cmd];
if (!handler) {
	console.error(`Unknown command: ${cmd}\n\n${USAGE}`);
	process.exit(2);
}

// --path overrides the lode root; otherwise auto-detect
const pathArg = rest.find(a => a.startsWith("--path="));
const root = pathArg ? path.resolve(pathArg.slice("--path=".length)) : findLodeRoot();
const cleanArgs = rest.filter(a => !a.startsWith("--path="));
handler(root, cleanArgs);