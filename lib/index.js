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
 *
 * A copy is only worth authoring if sessions actually mount it, so the plugin
 * also adopts one copy as the default Agent preset through the `agent-presets`
 * settings namespace: 标准 > 创造 > 极简 > PTC, and every copy beats a mode that
 * carries no explicit threshold. That is this plugin's one cross-namespace
 * write; the pre-takeover default is recorded first, so turning the plugin off
 * puts the user's own choice back instead of stranding a deleted copy.
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
/**
 * The settings namespace `@deepseek-ai/dsh-agent-presets` registers. Its
 * `default` field is the preset a session mounts when the caller names none,
 * re-read at every session creation — which is what makes it "the default mode"
 * this plugin adopts into. The literal is deliberate: this plugin talks to that
 * namespace through the settings service rather than depending on the presets
 * package, so a deployment without it degrades to "leave the default alone".
 */
const PRESET_NS = "agent-presets";
/**
 * Which source mode wins when several copies exist, highest first. The names are
 * the shipped presets' display names in order: 标准 (standard), 创造 (cordis),
 * 极简 (minimal), PTC 模式 (ptc). A source outside this table ranks below every
 * listed one, and since only a generated copy carries an explicit
 * `thresholdRatio`, every copy already outranks a mode without one.
 */
const ADOPT_PRIORITY = ["standard", "cordis", "minimal", "ptc"];
/** Settings namespace schema, also the shape the browser card edits. */
const Config = z.object({
	enabled: z.boolean().default(true),
	thresholdRatio: z.number().default(DEFAULT_THRESHOLD),
	retainRatio: z.number().default(0.16),
	sourcePresets: z.array(z.string()).default(DEFAULT_SOURCES),
	/** Whether saving also points the default Agent mode at a generated copy. */
	adoptDefault: z.boolean().default(true),
	managedPresets: z.array(z.string()).default([]),
	skippedPresets: z.array(z.string()).default([]),
	/** Written back: the default mode this plugin last adopted (`""` = none). */
	defaultPreset: z.string().default(""),
	/**
	 * Written back: what to restore when this plugin releases the default. `""`
	 * means the pre-takeover value was inherited from the deployment's own
	 * config, so releasing UNSETS the field to let that default show through
	 * rather than freezing today's value into the user layer.
	 */
	previousDefault: z.string().default("")
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
 * Whether an id has the shape of a copy this plugin authors for one of these
 * sources (`<source>-compact-<ratioTag>`). The same predicate both retires stale
 * copies and recognizes a default this plugin may have set, because a source the
 * user has since unchecked no longer appears in the managed list that would
 * otherwise prove ownership.
 * @param id - the preset id to test (may be undefined).
 * @param sources - the source modes currently configured.
 * @returns true when the id looks like a copy of one of those sources.
 */
function isOwnedId(id, sources) {
	const list = Array.isArray(sources) ? sources : [];
	return typeof id === "string" && list.some((source) => id.startsWith(`${source}-compact-`));
}

/**
 * The copy to adopt as the default mode, or undefined when there is none.
 *
 * Every candidate is a copy whose composition now carries an explicit
 * `thresholdRatio`, so "has a threshold" is already baked into candidacy — this
 * function only orders them: `standard` over `cordis` over `minimal` over `ptc`,
 * an unlisted source below all four, and the id as a stable tie-break so two
 * runs on the same state pick the same winner.
 * @param candidates - `{ id, source }` per copy authored by the current run.
 * @returns the winning id, or undefined for an empty candidate list.
 */
function pickDefault(candidates) {
	const list = (Array.isArray(candidates) ? candidates : [])
		.filter((candidate) => typeof candidate?.id === "string" && candidate.id !== "");
	if (list.length === 0) return undefined;
	/** Position in the priority table; an unlisted source ranks after all of it. */
	const rank = (candidate) => {
		const index = ADOPT_PRIORITY.indexOf(candidate.source);
		return index < 0 ? ADOPT_PRIORITY.length : index;
	};
	list.sort((left, right) => rank(left) - rank(right) || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
	return list[0].id;
}

/**
 * Decide what `agent-presets.default` should become, as a pure function so the
 * takeover, its idempotence, and its undo are testable without a host.
 *
 * Three outcomes:
 * - `set` — adopt `candidate`. The first takeover records the restore point;
 *   later saves keep the recorded one, because by then the current default is
 *   this plugin's own id and recording it would replace the user's choice with
 *   a pointer to a copy the plugin will delete when it is turned off.
 * - `restore` / `unset` — the feature is off (or no copy survived) and the
 *   default is one this plugin set, so the recorded default goes back; when
 *   there was none in the user layer, the field is UNSET so the deployment's own
 *   default shows through again.
 * - `none` — nothing to do. Notably this covers "the user hand-picked a mode and
 *   no copy exists": a default this plugin never set is never rewritten.
 * @param state - current defaults, the candidate, and what this plugin recorded.
 * @returns the action and the bookkeeping patch for this plugin's own section.
 */
function planDefault(state) {
	const { enabled, adoptDefault, candidate, current, userDefault, sources, managed, defaultPreset, previousDefault } = state;
	const sourceList = Array.isArray(sources) ? sources : [];
	const owned = Array.isArray(managed) ? managed : [];
	const recorded = typeof defaultPreset === "string" ? defaultPreset : "";
	const restoreTo = typeof previousDefault === "string" ? previousDefault : "";
	/** Whether the default standing now is one this plugin put there. */
	const ours = (typeof current === "string" && current !== "" && current === recorded)
		|| owned.includes(current)
		|| isOwnedId(current, sourceList);
	const wanted = enabled && adoptDefault && typeof candidate === "string" && candidate !== "" ? candidate : undefined;
	// A pre-takeover default that is itself a copy cannot be restored — the copy
	// is retired along with the feature — so it degrades to "inherit".
	const snapshot = typeof userDefault === "string" && !isOwnedId(userDefault, sourceList) ? userDefault : "";

	if (wanted !== undefined && current !== wanted) {
		return {
			kind: "set",
			value: wanted,
			patch: { defaultPreset: wanted, previousDefault: recorded === "" ? snapshot : restoreTo }
		};
	}
	if (wanted !== undefined) {
		// Already the default: no write to the presets namespace, but a missing
		// record still has to be laid down so a later release knows it owns this.
		return recorded !== "" ? { kind: "none", value: undefined, patch: {} } : { kind: "none", value: undefined, patch: { defaultPreset: wanted, previousDefault: snapshot } };
	}
	if (ours) {
		return {
			kind: restoreTo === "" ? "unset" : "restore",
			value: restoreTo,
			patch: { defaultPreset: "", previousDefault: "" }
		};
	}
	return { kind: "none", value: undefined, patch: {} };
}

/**
 * Read the default mode off the `agent-presets` namespace.
 *
 * `describe()` is the one read that exposes BOTH the resolved value and the raw
 * user layer, and the difference is exactly what {@link planDefault} needs:
 * "the user chose this" restores a value, "the deployment's config set it"
 * unsets the field. Reading only `get()` would conflate the two.
 * @param settings - the settings provider.
 * @returns the resolved default and the user-layer default, or undefined when
 *   this deployment registered no `agent-presets` namespace at all.
 */
function readDefaultMode(settings) {
	const descriptor = settings.describe().find((entry) => entry.ns === PRESET_NS);
	if (descriptor === undefined) return undefined;
	/** Read one string field off a section that may be absent or malformed. */
	const field = (section, key) => (section !== null && typeof section === "object" && typeof section[key] === "string" ? section[key] : undefined);
	return { current: field(descriptor.value, "default"), userDefault: field(descriptor.user, "default") };
}

/**
 * Apply a plan to the presets namespace. Failures are logged and swallowed: the
 * copies this plugin authors are its main job, and a deployment that refuses the
 * cross-namespace write (read-only provider, unregistered namespace) must still
 * get them.
 * @param ctx - host context, for the logger.
 * @param settings - the settings provider.
 * @param plan - the outcome of {@link planDefault}.
 */
async function applyDefault(ctx, settings, plan) {
	try {
		if (plan.kind === "set" || plan.kind === "restore") await settings.update(PRESET_NS, { default: plan.value });
		else if (plan.kind === "unset") await settings.mutate(PRESET_NS, [{ op: "unset", path: ["default"] }]);
	} catch (error) {
		ctx.logger.warn(`compact-threshold: could not set the default mode: ${String(error?.message ?? error)}`);
	}
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
 * @returns the ids now managed, one line per source that could not be used, and
 *   the `{ id, source }` of every copy fully written by this run (the only ids
 *   safe to adopt as the default).
 */
async function reconcile(ctx, value) {
	const presets = ctx.agentPresets;
	const previous = Array.isArray(value.managedPresets) ? value.managedPresets : [];
	const wanted = [];
	const skipped = [];
	const candidates = [];
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
			// Only a copy whose files all landed is adoptable: a half-written preset
			// would mount whatever partial composition the reader finds on disk.
			candidates.push({ id, source });
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
		if (isOwnedId(id, sources)) await dropManaged(presets, id);
	}

	if (skipped.length > 0) ctx.logger.warn(`compact-threshold: skipped ${skipped.join("; ")}`);
	ctx.logger.info(
		`compact-threshold: thresholdRatio=${value.thresholdRatio} managed=${wanted.join(",") || "(none)"}`
	);
	return { managed: wanted, skipped, candidates };
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
	/** Whether the missing-`agent-presets` warning was already logged. */
	let warnedNoPresetNs = false;

	/**
	 * Plan the default-mode takeover for one sync.
	 * @param value - the resolved settings section.
	 * @param candidates - the copies this run fully wrote.
	 * @returns the plan, or a no-op plan when this deployment has no roster.
	 */
	const plan = (value, candidates) => {
		try {
			const read = readDefaultMode(settings);
			if (read === undefined) {
				// A deployment that composes no preset roster registers no such
				// namespace; the copies are still authored, the default is not ours.
				if (!warnedNoPresetNs) {
					warnedNoPresetNs = true;
					ctx.logger.warn("compact-threshold: no `agent-presets` settings namespace; the default mode is left as it is");
				}
				return { kind: "none", value: undefined, patch: {} };
			}
			return planDefault({
				enabled: value.enabled !== false,
				adoptDefault: value.adoptDefault !== false,
				candidate: pickDefault(candidates),
				current: read.current,
				userDefault: read.userDefault,
				sources: value.sourcePresets,
				managed: value.managedPresets,
				defaultPreset: value.defaultPreset,
				previousDefault: value.previousDefault
			});
		} catch (error) {
			ctx.logger.warn(`compact-threshold: could not read the default mode: ${String(error?.message ?? error)}`);
			return { kind: "none", value: undefined, patch: {} };
		}
	};

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
			const { managed, skipped, candidates } = await reconcile(ctx, value);
			if (settings === undefined) return;
			// Remember what we own so the next change can retire exactly that set, and
			// publish the skip reasons so the card can show why a mode has no generated
			// copy. The write goes through the settings-scoped context: the plugin's
			// own context never declared `settings`, and reading an undeclared service
			// is refused at runtime.
			const taken = plan(value, candidates);
			const patch = {};
			if (JSON.stringify(managed) !== JSON.stringify(value.managedPresets ?? [])) patch.managedPresets = managed;
			if (JSON.stringify(skipped) !== JSON.stringify(value.skippedPresets ?? [])) patch.skippedPresets = skipped;
			// The bookkeeping goes FIRST and the takeover second: a crash between the
			// two writes can then lose only an adoption, never the record of what to
			// restore when this plugin is turned off.
			for (const key of Object.keys(taken.patch)) {
				if (taken.patch[key] !== value[key]) patch[key] = taken.patch[key];
			}
			if (Object.keys(patch).length > 0) await settings.update(CONCISE_NS, patch);
			await applyDefault(ctx, settings, taken);
			if (taken.kind !== "none") {
				ctx.logger.info(`compact-threshold: default mode ${taken.kind} ${taken.value || "(inherited)"}`);
			}
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

export { apply, Config, inject, isOwnedId, managedId, pickDefault, planDefault, ratioTag, rewriteThreshold };
