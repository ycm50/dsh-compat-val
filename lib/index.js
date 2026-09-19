/**
 * dsh-compact-threshold host half.
 *
 * DSH ships one compaction threshold (0.8) inside every agent preset's
 * `compaction-basic` row, so changing it means editing a preset's composition —
 * and shipped presets live in a read-only root that the roster's
 * first-root-wins discovery cannot shadow. The practical way to give every mode
 * a different threshold is therefore to author a preset COPY per mode with the
 * row rewritten, which is exactly what this plugin does, driven by one setting.
 *
 * Pipeline per source preset:
 *   readDocument(id).content -> rewrite the compaction-basic row's
 *   thresholdRatio -> write `<id>-compact-<ratio>` into the writable user root.
 *
 * A preset's composition is read at session creation and never re-read, so a
 * threshold change applies to NEW sessions; running ones keep their composition.
 */
import z from "@deepseek-ai/schemastery";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const name = "dsh-compact-threshold";
/** Settings namespace this plugin owns (must match the browser half). */
const CONCISE_NS = "dsh-compact-threshold";
/**
 * Services this plugin reads. `agentPresets` is required — it is the roster the
 * authored copies are written through; a context that reads a service it never
 * declared is refused by the runtime, which is how a missing declaration shows
 * up as "cannot get property X without inject". The settings service is
 * optional and reached through `ctx.inject`, so it is deliberately absent here.
 */
const inject = ["agentPresets"];
/** The row the threshold lives in, inside a preset composition. */
const ROW_ID = "compaction-basic";
/** How many source presets the browser half opens with. */
const DEFAULT_SOURCES = ["standard", "minimal", "ptc", "cordis"];
/** Upstream default, kept as the schema default only if a user wants 0.8. */
const DEFAULT_THRESHOLD = 0.4;
/** Settings namespace schema, also the shape the browser card edits. */
const Config = z.object({
	enabled: z.boolean().default(true),
	thresholdRatio: z.number().default(DEFAULT_THRESHOLD),
	retainRatio: z.number().default(0.16),
	sourcePresets: z.array(z.string()).default(DEFAULT_SOURCES),
	managedPresets: z.array(z.string()).default([]),
	skippedPresets: z.array(z.string()).default([])
});

/**
 * The suffix one threshold maps to. Preset ids admit only lowercase letters,
 * digits and hyphens (`/^[a-z0-9][a-z0-9-]*$/`), so the decimal point is
 * dropped: 0.4 -> `4`, 0.75 -> `75`.
 * @param ratio - a threshold ratio in (0, 1).
 * @returns the id-safe form of that ratio.
 */
function ratioTag(ratio) {
	return String(ratio).replace(/^0\./, "").replace(/\./g, "");
}

/**
 * The preset id this plugin authors for one source preset and ratio.
 * @param source - the source preset id.
 * @param ratio - the threshold ratio.
 * @returns the managed preset id.
 */
function managedId(source, ratio) {
	return `${source}-compact-${ratioTag(ratio)}`;
}

/**
 * Rewrite the compaction-basic row's `thresholdRatio` inside a composition.
 *
 * The row may sit at any depth (the shipped `standard`/`ptc` presets nest it
 * inside their `compaction` group), may already carry a `config:` block, and may
 * put its `name:` on the same line as its id. Only that one row is touched —
 * every other byte of the composition is preserved, because a preset is a file
 * a user may have authored by hand.
 * @param text - the composition YAML.
 * @param ratio - the threshold ratio to write.
 * @returns the rewritten text and whether a compaction-basic row was found.
 */
function rewriteThreshold(text, ratio) {
	const lines = text.split("\n");
	const out = [];
	/** Name of the row whose block is open, or null. */
	let openRow = null;
	/** Indentation of the open row's `- id:` marker, as a string. */
	let openIndent = "";
	/** Whether the open row already declares a `config:` key. */
	let openHasConfig = false;
	/** Whether the threshold was written for the open row. */
	let openWrote = false;
	let found = false;

	/** Insert a fresh config block under the open row when it needs one. */
	const closeBlock = () => {
		if (openRow === ROW_ID && !openWrote) {
			// The threshold sits two levels below the marker: the `config:` key at
			// marker+2, its value at marker+4, matching the child key indentation
			// of a `- id:` marker (dash plus space).
			out.push(`${openIndent}  config:`, `${openIndent}    thresholdRatio: ${ratio}`);
			openWrote = true;
		}
		openRow = null;
		openHasConfig = false;
		openWrote = false;
	};

	for (const line of lines) {
		// A row starts at `- id: <name>`; the name may share the line with other
		// keys (the shipped compositions put `name:` on the next line), so the
		// id ends at whitespace rather than at the end of the line.
		const rowMatch = /^(\s*)-\s+id:\s*([^\s#]+)/.exec(line);
		if (rowMatch !== null) {
			closeBlock();
			openRow = rowMatch[2];
			openIndent = rowMatch[1];
			if (openRow === ROW_ID) found = true;
			out.push(line);
			continue;
		}
		if (openRow === null) {
			out.push(line);
			continue;
		}
		// Blank lines and comments belong to the open row's block; a plain key at
		// or above the marker's indentation ends it.
		const indentMatch = /^(\s*)\S/.exec(line);
		if (indentMatch !== null && line.trim() !== "" && !line.trim().startsWith("#") && indentMatch[1].length <= openIndent.length) {
			closeBlock();
			out.push(line);
			continue;
		}
		if (openRow !== ROW_ID) {
			out.push(line);
			continue;
		}
		if (/^\s*config:\s*$/.test(line)) {
			openHasConfig = true;
			out.push(line);
			continue;
		}
		if (/^\s*thresholdRatio:\s*\S+/.test(line)) {
			out.push(line.replace(/thresholdRatio:\s*\S+/, `thresholdRatio: ${ratio}`));
			openWrote = true;
			continue;
		}
		out.push(line);
	}
	closeBlock();
	return { text: out.join("\n"), found };
}

/**
 * Validate the settings before anything is written, so a bad value surfaces as
 * a rejected settings write rather than as a pile of unusable presets.
 * @param value - the resolved settings section.
 */
function assertUsable(value) {
	const { thresholdRatio, retainRatio } = value;
	if (!(thresholdRatio > 0) || thresholdRatio >= 1) {
		throw new TypeError(`compact-threshold: thresholdRatio must be in (0, 1), got ${String(thresholdRatio)}`);
	}
	if (!(retainRatio > 0) || retainRatio >= thresholdRatio) {
		throw new TypeError(
			`compact-threshold: retainRatio must be in (0, ${String(thresholdRatio)}), got ${String(retainRatio)}`
		);
	}
}

/**
 * Delete a preset this plugin authored. A copy a user already deleted is not an
 * error — the desired end state is simply "absent" — so failures are swallowed
 * here and reported by the caller's own outcome instead.
 * @param presets - the agent-preset roster.
 * @param id - the managed preset id.
 */
async function dropManaged(presets, id) {
	try {
		await presets.remove(id);
	} catch {
		// Already gone, or never written: the caller retires it either way.
	}
}

/**
 * Author (or refresh / retire) every managed preset for the current settings.
 * @param ctx - host context carrying the preset roster.
 * @param value - the resolved settings section.
 * @returns the ids now managed, and one line per source that could not be used.
 */
async function reconcile(ctx, value) {
	const presets = ctx.agentPresets;
	const previous = Array.isArray(value.managedPresets) ? value.managedPresets : [];
	const wanted = [];
	const skipped = [];
	const sources = Array.isArray(value.sourcePresets) ? value.sourcePresets : [];
	const root = (presets.resolvedRoots ?? []).find((candidate) => candidate.trust === "user");
	if (value.enabled && root === undefined) {
		throw new Error("compact-threshold: this deployment configures no user-writable preset root");
	}
	const known = new Set((await presets.list()).map((preset) => preset.id));

	for (const source of value.enabled ? sources : []) {
		const id = managedId(source, value.thresholdRatio);
		try {
			const document = await presets.readDocument(source);
			const original = typeof document.content === "string" ? document.content : await presets.read(source);
			const rewritten = rewriteThreshold(original, value.thresholdRatio);
			if (!rewritten.found) {
				// A mode that composes no compaction row (the shipped `minimal`
				// preset) has no threshold to change; authoring a copy would mean
				// inventing a compaction stack the mode deliberately omits.
				skipped.push(`${source}（该模式没有 ${ROW_ID} 行）`);
				continue;
			}
			wanted.push(id);
			const directory = join(root.path, id);
			await mkdir(directory, { recursive: true });
			await writeFile(join(directory, "agent.cordis.yml"), rewritten.text, "utf8");
			const label = `${document.name ?? source} · 压缩阈值 ${value.thresholdRatio}`;
			await writeFile(
				join(directory, "preset.yml"),
				`name: ${label}\ndescription: 由 dsh-compact-threshold 生成：${source} 的全量能力，compaction-basic.thresholdRatio = ${value.thresholdRatio}。\n`,
				"utf8"
			);
			known.add(id);
		} catch (error) {
			skipped.push(`${source}（${String(error?.message ?? error)}）`);
		}
	}

	for (const id of previous) {
		if (wanted.includes(id)) continue;
		await dropManaged(presets, id);
		known.delete(id);
	}
	// Copies from a previous threshold survive a settings document that predates
	// the managed list, so retire every stale id the roster still shows.
	for (const id of [...known]) {
		if (wanted.includes(id)) continue;
		if (sources.some((source) => id.startsWith(`${source}-compact-`))) await dropManaged(presets, id);
	}

	if (skipped.length > 0) ctx.logger.warn(`compact-threshold: skipped ${skipped.join("; ")}`);
	ctx.logger.info(
		`compact-threshold: thresholdRatio=${value.thresholdRatio} managed=${wanted.join(",") || "(none)"}`
	);
	return { managed: wanted, skipped };
}

/**
 * Mount the plugin: register the settings namespace, then keep the authored
 * presets in sync with whatever that namespace resolves to.
 * @param ctx - host context (optionally carrying a settings service).
 * @param config - the composition entry, used as the settings base layer.
 */
function apply(ctx, config) {
	let current = () => config ?? {};
	/** The settings service, held for the writes this plugin makes itself. */
	let settings;
	let running = Promise.resolve();
	/** Serialized so two settings writes can never interleave their writes. */
	const sync = () => {
		running = running.then(async () => {
			const value = current() ?? {};
			try {
				assertUsable(value);
			} catch (error) {
				ctx.logger.warn(`compact-threshold: ${String(error?.message ?? error)}`);
				return;
			}
			const { managed, skipped } = await reconcile(ctx, value);
			// Remember what we own so the next change can retire exactly that set,
			// and publish the skip reasons so the card can show why a mode has no
			// generated copy. The write goes through the settings-scoped context:
			// the plugin's own context never declared `settings`, and reading an
			// undeclared service is refused at runtime.
			if (settings === undefined) return;
			const patch = {};
			if (JSON.stringify(managed) !== JSON.stringify(value.managedPresets ?? [])) patch.managedPresets = managed;
			if (JSON.stringify(skipped) !== JSON.stringify(value.skippedPresets ?? [])) patch.skippedPresets = skipped;
			if (Object.keys(patch).length > 0) await settings.update(CONCISE_NS, patch);
		}).catch((error) => {
			ctx.logger.warn(`compact-threshold: ${String(error?.stack ?? error)}`);
		});
		return running;
	};

	// The settings service is optional: `ctx.inject` is the graceful-degradation
	// boundary, so a host without one keeps the composed configuration and
	// authors nothing. Reading the service (never a removed convenience export)
	// is what keeps a missing settings provider from failing the whole boot.
	ctx.inject(["settings"], (settingsCtx) => {
		settings = settingsCtx.settings;
		settingsCtx.settings.installSection(ctx, CONCISE_NS, Config, config ?? {}, {
			setSource: (source) => {
				current = source;
				void sync();
			},
			onChange: () => {
				void sync();
			},
			validate: assertUsable
		});
	});
}

export { apply, Config, inject, managedId, ratioTag, rewriteThreshold };
