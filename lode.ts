#!/usr/bin/env bun
/**
 * lode — mechanical acceleration for project lodes.
 *
 * A directory of markdown files with optional YAML frontmatter. This tool
 * indexes, searches, maps, and lints them. It is an acceleration layer, not
 * a gate: read/edit/grep work directly on the files at all times.
 *
 * Frontmatter schema (all optional, but summary + keywords are recommended):
 *   type:     domain | external
 *   tags:     [tag1, tag2]
 *   keywords: word1, word2, word3
 *   summary:  one-line description for the map
 *
 * Term blocks in the body:
 *   ## Terms
 *   - **Name** — definition
 *
 * Usage:
 *   lode startup [--path=.]           dump entrypoint files for session start
 *   lode search <query> [--path=.]    match keywords, tags, type, summary, filename
 *   lode list [--type=T] [--tag=T] [--path=.]
 *   lode walk <file>                  resolve internal links, show linked summaries
 *   lode map [--path=.]               generate index from frontmatter
 *   lode terms [--path=.]             aggregate term blocks into glossary
 *   lode tags [--path=.]              tag counts
 *   lode check [--path=.]             lint frontmatter, links, terms, line count, orphans
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";

// ─── types ──────────────────────────────────────────────────────────────

interface Frontmatter {
	type?: string;
	tags?: string[];
	keywords?: string[];
	summary?: string;
	_raw?: Record<string, unknown>;
}

interface LodeFile {
	relPath: string;       // relative to lode root
	absPath: string;
	frontmatter: Frontmatter;
	body: string;
	lines: number;
	terms: TermEntry[];
	links: string[];       // resolved relative paths this file links to
}

interface TermEntry {
	name: string;
	def: string;
	source: string;       // file that defines it
}

// ─── frontmatter parsing ────────────────────────────────────────────────
//
// Hand-rolled subset of YAML. Handles flat key-value pairs only:
//   key: value
//   key: [a, b, c]
//   key: word1, word2, word3
//
// Does NOT handle:
//   - nested mappings (key: { inner: value })
//   - block lists (key:\n  - item\n  - item)
//   - multi-line strings, anchors, references
//
// The schema deliberately uses only flat fields, so this is sufficient.
// If the schema grows to need nested values, replace this parser with a
// real YAML library — do not extend this hand-rolled one.

function parseFrontmatter(content: string): { fm: Frontmatter; body: string } {
	const fm: Frontmatter = { _raw: {} };
	if (!content.startsWith("---")) return { fm, body: content };
	const end = content.indexOf("\n---", 3);
	if (end === -1) return { fm, body: content };
	const block = content.slice(3, end).trim();
	const body = content.slice(end + 4).replace(/^\n/, "");
	for (const line of block.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const colonIdx = trimmed.indexOf(":");
		if (colonIdx === -1) continue;
		const key = trimmed.slice(0, colonIdx).trim();
		const value = trimmed.slice(colonIdx + 1).trim();

		if (key === "type") {
			fm.type = value;
		} else if (key === "summary") {
			fm.summary = value;
		} else if (key === "tags") {
			fm.tags = parseList(value);
		} else if (key === "keywords") {
			// keywords can be comma-separated or YAML list
			if (value.startsWith("[")) {
				fm.keywords = parseList(value);
			} else {
				fm.keywords = value.split(",").map(s => s.trim()).filter(Boolean);
			}
		}
		(fm._raw as Record<string, unknown>)[key] = value;
	}
	return { fm, body };
}

function parseList(value: string): string[] {
	const v = value.trim();
	if (v.startsWith("[")) {
		return v.slice(1, v.endsWith("]") ? -1 : undefined)
			.split(",")
			.map(s => s.trim().replace(/^["']|["']$/g, ""))
			.filter(Boolean);
	}
	// YAML block list: check next lines — but we're parsing single lines here,
	// so handle inline only. Block lists would need multi-line parsing.
	return v.split(",").map(s => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
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

// ─── link extraction ────────────────────────────────────────────────────

const MD_LINK = /\[([^\]]*)\]\(([^)]+)\)/g;
const WIKI_LINK = /\[\[([^\]]+)\]\]/g;

function extractLinks(body: string, fromPath: string, root: string): string[] {
	const links: string[] = [];
	const dir = path.dirname(fromPath);

	let m: RegExpExecArray | null;
	MD_LINK.lastIndex = 0;
	while ((m = MD_LINK.exec(body)) !== null) {
		const target = m[2];
		if (target.startsWith("http") || target.startsWith("#") || target.startsWith("mailto:")) continue;
		const resolved = normalizePath(path.join(dir, target), root);
		if (resolved) links.push(resolved);
	}

	WIKI_LINK.lastIndex = 0;
	while ((m = WIKI_LINK.exec(body)) !== null) {
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
	return path.relative(root, abs);
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
			yield path.relative(base, full);
		}
	}
}

// ─── sublode detection ──────────────────────────────────────────────────

/**
 * Find all lode/ directories nested within the project tree, relative to the
 * lode root. A sublode is a `lode/` directory that is NOT the root itself and
 * is NOT nested inside another sublode's tree.
 * Returns paths relative to the project root (parent of the lode root).
 */
function findSublodes(lodeRoot: string): string[] {
	const projectRoot = path.dirname(lodeRoot);
	const sublodes: string[] = [];
	const lodeRootAbs = path.resolve(lodeRoot);

	function* walk(dir: string): Generator<string> {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "tmp") continue;
			const full = path.join(dir, entry.name);
			if (entry.name === "lode") {
				if (path.resolve(full) !== lodeRootAbs) {
					yield path.relative(projectRoot, full);
				}
				// don't recurse into a sublode — it's its own lode
				continue;
			}
			yield* walk(full);
		}
	}

	for (const sub of walk(projectRoot)) {
		sublodes.push(sub);
	}
	return sublodes.sort();
}

function loadFile(relPath: string, root: string): LodeFile {
	const absPath = path.join(root, relPath);
	const content = fs.readFileSync(absPath, "utf8");
	const { fm, body } = parseFrontmatter(content);
	const terms = parseTerms(body).map(t => ({ ...t, source: relPath }));
	const links = extractLinks(body, relPath, root);
	return {
		relPath,
		absPath,
		frontmatter: fm,
		body,
		lines: content.split("\n").length,
		terms,
		links,
	};
}

function loadAll(root: string): LodeFile[] {
	fileIndex = null; // reset wiki-link cache
	const projectRoot = path.dirname(root);
	const files: LodeFile[] = [];

	// root lode files — paths relative to project root (e.g. "lode/summary.md")
	for (const rel of walkMd(root, projectRoot)) {
		try {
			files.push(loadFile(rel, projectRoot));
		} catch { /* skip unreadable */ }
	}

	// sublode files — merge by default, paths relative to project root
	for (const sub of findSublodes(root)) {
		const subRoot = path.join(projectRoot, sub);
		for (const rel of walkMd(subRoot, projectRoot)) {
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

// ─── commands ───────────────────────────────────────────────────────────

const STARTUP_FILES = ["summary.md", "terminology.md", "lode-map.md", "tmp/active.md"];
const BUDGET = 40000;

function cmdStartup(root: string, _args: string[]): void {
	// Verify this is a real lode, not a cwd fallback. If no lode exists,
	// exit silently with zero — the hook calls this unconditionally.
	const hasLode = fs.existsSync(path.join(root, "summary.md"))
		|| fs.existsSync(path.join(root, "lode-map.md"))
		|| fs.existsSync(path.join(root, "terminology.md"));
	if (!hasLode) {
		process.stderr.write("lode: no lode found at " + root + "\n");
		return;
	}

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
	const sublodes = findSublodes(root);
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
	if (omitted.length > 0) {
		console.log(`\n=== over the ${BUDGET}-char budget, NOT loaded — read these ===`);
		console.log(omitted.map(o => `- ${o}`).join("\n"));
	}
	console.log("\n" + TOOL_HELP);
}

const TOOL_HELP = `=== lode-cli ===
The \`lode\` tool is available for searching and navigating this lode:

  lode search <query>       find files by keywords, tags, summary, or filename
  lode list [--type=T] [--tag=T]   list files, optionally filtered
  lode walk <file-or-dir>   follow internal links, show linked summaries
  lode map                  generate directory index from frontmatter
  lode terms                aggregate term blocks across the lode
  lode tags                 show tag frequency counts
  lode check                lint frontmatter, links, terms, line count, orphans
  lode mail send <project> <subject>   send inter-project mail (body on stdin)
  lode mail read                        show and mark unread mail for current project
  lode mail unread                      print count of unread mail

Use these instead of manually grepping the lode directory. The files are still
plain markdown — read and edit them directly when you know which file you need.`;

function cmdSearch(root: string, args: string[]): void {
	const query = args.join(" ").toLowerCase();
	if (!query) {
		console.error("Usage: lode search <query>");
		process.exit(2);
	}
	const terms = query.split(/\s+/).filter(Boolean);
	const files = loadAll(root);

	const results: Array<{ file: LodeFile; score: number }> = [];
	for (const file of files) {
		const haystacks = [
			...(file.frontmatter.keywords ?? []).map(k => k.toLowerCase()),
			...(file.frontmatter.tags ?? []).map(t => t.toLowerCase()),
			(file.frontmatter.summary ?? "").toLowerCase(),
			(file.frontmatter.type ?? "").toLowerCase(),
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

	results.sort((a, b) => b.score - a.score);
	for (const { file, score } of results) {
		const summary = file.frontmatter.summary ?? "(no summary)";
		const tags = file.frontmatter.tags?.length ? ` [${file.frontmatter.tags.join(", ")}]` : "";
		console.log(`${file.relPath} (${score}) — ${summary}${tags}`);
	}
	if (results.length === 0) console.log("No matches.");
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

	const targetPath = path.join(root, target);
	let isDir = false;
	try {
		isDir = fs.statSync(targetPath).isDirectory();
	} catch {
		console.error(`Not found: ${target}`);
		process.exit(1);
	}
	const startFiles = isDir
		? all.filter(f => f.relPath.startsWith(target + "/") || f.relPath.startsWith(target + path.sep))
		: [byPath.get(target)].filter(Boolean) as LodeFile[];

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
			continue;
		}
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
}

function cmdMap(root: string, _args: string[]): void {
	const files = loadAll(root);

	// group by directory
	const byDir = new Map<string, LodeFile[]>();
	for (const file of files) {
		const dir = path.dirname(file.relPath);
		if (!byDir.has(dir)) byDir.set(dir, []);
		byDir.get(dir)!.push(file);
	}

	const dirs = [...byDir.keys()].sort();
	for (const dir of dirs) {
		if (dir !== ".") console.log(`\n${dir}/`);
		for (const file of byDir.get(dir)!) {
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

function cmdCheck(root: string, _args: string[]): void {
	const files = loadAll(root);
	const allPaths = new Set(files.map(f => f.relPath));
	const issues: Array<{ file: string; issue: string; severity: string }> = [];

	// Build incoming link map for orphan detection
	const incoming = new Map<string, Set<string>>();
	for (const file of files) {
		for (const link of file.links) {
			if (!incoming.has(link)) incoming.set(link, new Set());
			incoming.get(link)!.add(file.relPath);
		}
	}

	for (const file of files) {
		const rel = file.relPath;
		const fm = file.frontmatter;

		// Missing frontmatter
		if (!fm.type && !fm.tags && !fm.keywords && !fm.summary) {
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
		// Over 250 lines
		if (file.lines > 250) {
			issues.push({ file: rel, issue: `${file.lines} lines (over 250)`, severity: "warn" });
		}
		// Broken links
		for (const link of file.links) {
			if (!allPaths.has(link)) {
				issues.push({ file: rel, issue: `broken link → ${link}`, severity: "error" });
			}
		}
		// Orphan (no incoming links, not an entrypoint or sublode summary)
		const basename = path.basename(rel);
		const isEntrypoint = STARTUP_FILES.includes(basename) && rel.startsWith("lode/");
		const isSublodeSummary = basename === "summary.md" && rel.includes("/lode/") && !rel.startsWith("lode/");
		if (!isEntrypoint && !isSublodeSummary && (!incoming.has(rel) || incoming.get(rel)!.size === 0)) {
			issues.push({ file: rel, issue: "orphan — no incoming links", severity: "info" });
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
	mail: cmdMail,
};

const USAGE = `Usage: lode <command> [args] [--path=DIR]

Commands:
  startup              dump entrypoint files for session start
  search <query>       match keywords, tags, type, summary, filename
  list [--type=T] [--tag=T]   list files, optionally filtered
  walk <file-or-dir>   resolve internal links, show linked summaries
  map                  generate index from frontmatter
  terms                aggregate term blocks into glossary
  tags                 tag counts
  check                lint frontmatter, links, terms, line count, orphans
  mail send <project> <subject>   send mail (body on stdin)
  mail read                        show and mark unread mail
  mail list                        all mail for current project
  mail unread                      print count of unread mail

Options:
  --path=DIR           lode root directory (auto-detected if omitted)`;

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