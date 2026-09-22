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
/** Settings namespace this plugin owns on 0.1.5-rc.x (must match the browser half). */
const CONCISE_NS = "dsh-compact-threshold";
/**
 * The key this plugin's own settings live under on 0.1.7+. That generation has no
 * per-plugin settings namespace: the settings UI is derived from the profile
 * entry's own Config, so the key is this plugin's entry id, declared in
 * `cordis.patch.yml` (must match the browser half).
 */
const ENTRY_ID = "compact-threshold";
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
 * The settings namespace `@deepseek-ai/dsh-agent-presets` registers on
 * 0.1.5-rc.x. Its `default` field is the preset a session mounts when the caller
 * names none, re-read at every session creation — which is what makes it "the
 * default mode" this plugin adopts into. The literal is deliberate: this plugin
 * talks to that key through the settings service rather than depending on the
 * presets package, so a deployment without it degrades to "leave the default
 * alone".
 */
const PRESET_NS = "agent-presets";
/**
 * The same thing on 0.1.7+, where the presets registry became an ordinary profile
 * entry: `agent-preset-registry` keeps the deployment default in its plain
 * `default` field and the live user choice in the volatile `selectedDefault`,
 * which is the layer this plugin adopts into (the 0.1.7+ settings form exposes
 * volatile fields only, and moving the deployment default is not the user's to
 * do).
 */
const PRESET_NS_CURRENT = "agent-preset-registry";
/** The field holding the adopted default, per generation. */
const PRESET_FIELD = { legacy: "default", current: "selectedDefault" };

/**
 * The settings key and field pair one host generation keeps the default in.
 * @param legacy - whether the host still exposes the 0.1.5-rc.x settings service.
 * @returns the settings key and the field name to read and write.
 */
function presetTarget(legacy) {
	return legacy
		? { ns: PRESET_NS, field: PRESET_FIELD.legacy }
		: { ns: PRESET_NS_CURRENT, field: PRESET_FIELD.current };
}
/**
 * Which source mode wins when several copies exist, highest first. The names are
 * the shipped presets' display names in order: 标准 (standard), 创造 (cordis),
 * 极简 (minimal), PTC 模式 (ptc). A source outside this table ranks below every
 * listed one, and since only a generated copy carries an explicit
 * `thresholdRatio`, every copy already outranks a mode without one.
 */
const ADOPT_PRIORITY = ["standard", "cordis", "minimal", "ptc"];
/**
 * Mark a field live-editable, whatever schemastery this plugin resolved.
 *
 * 0.1.7+ derives its settings forms from *volatile* fields only, and its settings
 * service refuses to write any other path — so the fields a card edits must carry
 * that flag there. `volatile()` is just `extra('volatile', true)`, i.e. the flag
 * itself; the method only guards against double-wrapping.
 *
 * The method is not always reachable: the host runs schemastery 3.18.3, but an
 * installed plugin imports whatever the PROFILE placed next to it (3.18.2 today),
 * whose Schema has no `volatile()` — while `meta` and `toJSON()` handle the key
 * fine. Depending on the method alone silently left every field ordinary, the
 * host found no volatile field, dropped this entry from `describe()`, and refused
 * every card write ("Host 现值 undefined"), which is why the flag is set directly
 * when the method is missing.
 * @param field - the schemastery field.
 * @returns the same field, marked volatile.
 */
function live(field) {
	if (typeof field?.volatile === "function") return field.volatile();
	if (field?.meta !== undefined && field.meta.volatile !== true) field.meta.volatile = true;
	return field;
}

/** Settings section schema, also the shape the browser card edits. */
const Config = z.object({
	enabled: live(z.boolean().default(true)),
	thresholdRatio: live(z.number().default(DEFAULT_THRESHOLD)),
	retainRatio: live(z.number().default(0.16)),
	sourcePresets: live(z.array(z.string()).default(DEFAULT_SOURCES)),
	/** Whether saving also points the default Agent mode at a generated copy. */
	adoptDefault: live(z.boolean().default(true)),
	managedPresets: live(z.array(z.string()).default([])),
	skippedPresets: live(z.array(z.string()).default([])),
	/** Written back: the default mode this plugin last adopted (`""` = none). */
	defaultPreset: live(z.string().default("")),
	/**
	 * Written back: what to restore when this plugin releases the default. `""`
	 * means the pre-takeover value was inherited from the deployment's own
	 * config, so releasing UNSETS the field to let that default show through
	 * rather than freezing today's value into the user layer.
	 */
	previousDefault: live(z.string().default(""))
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
 * Read the default mode off the presets settings key of this generation.
 *
 * `describe()` is the one read that exposes BOTH the resolved value and the raw
 * user layer, and the difference is exactly what {@link planDefault} needs:
 * "the user chose this" restores a value, "the deployment's config set it"
 * unsets the field. Reading only `get()` would conflate the two.
 *
 * 0.1.7+ splits those layers differently: the deployment default lives in a plain
 * field its settings form never exposes (so it cannot appear in `describe()`),
 * and the user's choice lives in the volatile `selectedDefault`. The effective
 * default therefore comes off the roster (`effective`), while the user layer is
 * what decides "restore" versus "unset".
 * @param settings - the settings provider.
 * @param legacy - whether the host speaks the 0.1.5-rc.x settings vocabulary.
 * @param effective - the default the roster resolves right now, if it can be read.
 * @returns the resolved default and the user-layer default, or undefined when
 *   this deployment registered no presets settings key at all.
 */
function readDefaultMode(settings, legacy, effective) {
	const { ns, field } = presetTarget(legacy);
	const descriptor = settings.describe().find((entry) => entry.ns === ns);
	if (descriptor === undefined) return undefined;
	/** Read one string field off a section that may be absent or malformed. */
	const read = (section, key) => (section !== null && typeof section === "object" && typeof section[key] === "string" ? section[key] : undefined);
	const userDefault = read(descriptor.user, field);
	if (!legacy) {
		// The user layer first: after an adoption it is this plugin's own id, and
		// comparing against the effective default alone would re-plan the same
		// takeover forever when the mode-selection switch masks it.
		return { current: userDefault ?? effective, userDefault };
	}
	return { current: read(descriptor.value, field), userDefault };
}

/**
 * Read this plugin's own settings section on 0.1.7+, where the profile entry's
 * Config is the form. Values come back plain (volatile references are unfolded by
 * the settings service), and only the entry's volatile fields are present.
 * @param settings - the settings provider.
 * @returns the resolved section, or undefined while the entry is not yet active.
 */
function readOwnSection(settings) {
	try {
		return settings.describe().find((entry) => entry.ns === ENTRY_ID)?.value;
	} catch {
		return undefined;
	}
}

/** Key of the live-reference protocol cosmokit hands out for volatile config. */
const VOLATILE_WRITE = Symbol.for("cosmokit.volatile.write");

/**
 * Unfold the live references 0.1.7+ resolves volatile fields into. Needed only
 * for the fallback read (the entry config this plugin is mounted with), because
 * an unfolded reference is an object, not the number or string the section says
 * — and `assertUsable` compares thresholds numerically.
 * @param section - a resolved settings section, possibly holding live references.
 * @returns the same section with every live reference replaced by its value.
 */
function plainSection(section) {
	const out = {};
	for (const [key, value] of Object.entries(section ?? {})) {
		out[key] = value !== null && typeof value === "object" && VOLATILE_WRITE in value ? value.get() : value;
	}
	return out;
}

/**
 * Whether 0.1.7+ has the mode-selection switch turned off, which makes the
 * adopted `selectedDefault` ineffective (the registry falls back to the
 * deployment default) — worth one warning, not a write that would override a
 * user's own switch.
 * @param settings - the settings provider.
 * @returns true when the switch is explicitly off.
 */
function selectionDisabled(settings) {
	try {
		return settings.describe().find((entry) => entry.ns === PRESET_NS_CURRENT)?.value?.modeSelectionEnabled === false;
	} catch {
		return false;
	}
}

/**
 * The raw config the profile composition currently hands this plugin, straight
 * off the loader entry.
 *
 * 0.1.7+ applies a config change that only moves volatile fields by writing the
 * new values into the live references of the ALREADY running config (loader
 * `_commitVolatile`) and remounts only when an ordinary value moved — so the
 * entry options are updated while `entry.fiber.config` still holds the pre-save
 * values until something refreshes it. `settings.describe()` serves exactly that
 * running config, which is why a card would report a saved value as unsaved.
 * @param loader - the loader service of this host.
 * @returns the composed raw config, or undefined when it cannot be read.
 */
function readComposedRaw(loader) {
	try {
		const entry = [...loader.entries()].find((row) => row.options?.id === ENTRY_ID);
		const raw = entry?.options?.config;
		return raw === undefined || raw === null || typeof raw !== "object" ? undefined : raw;
	} catch {
		return undefined;
	}
}

/**
 * Resolve a composed config through this plugin's own schema, so callers get the
 * same defaults and types a mount would produce (and unfold live references when
 * the host's schemastery is the one that can make them).
 * @param loader - the loader service of this host.
 * @returns the resolved section, or undefined when it cannot be read.
 */
function readComposedConfig(loader) {
	const raw = readComposedRaw(loader);
	if (raw === undefined) return undefined;
	try {
		return plainSection(Config(raw));
	} catch {
		return undefined;
	}
}

/**
 * Apply a plan to the presets settings key. Failures are logged and swallowed:
 * the copies this plugin authors are its main job, and a deployment that refuses
 * the cross-key write (read-only provider, unregistered key, the volatile-field
 * rule of 0.1.7+) must still get them.
 * @param ctx - host context, for the logger.
 * @param settings - the settings provider.
 * @param plan - the outcome of {@link planDefault}.
 * @param legacy - whether the host speaks the 0.1.5-rc.x settings vocabulary.
 */
async function applyDefault(ctx, settings, plan, legacy) {
	const { ns, field } = presetTarget(legacy);
	try {
		if (plan.kind === "set" || plan.kind === "restore") await settings.update(ns, { [field]: plan.value });
		else if (plan.kind === "unset") await settings.mutate(ns, [{ op: "unset", path: [field] }]);
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

/** The declarative preset row on 0.1.7+: one loader entry per declared preset. */
const PRESET_ROW = "@deepseek-ai/dsh-agent-preset";
/**
 * The settings document moved, and the drain timer below should act on it.
 *
 * `settings/document-updated` is emitted from inside the settings write's own HMR
 * transaction, and HMR tracks "a transaction is open" with an `AsyncLocalStorage`:
 * every async resource created in that context — timers and promises alike —
 * inherits it, and a settings write attempted there is refused with "HMR
 * transactions cannot be nested". Acting on the event inline therefore loses this
 * plugin's bookkeeping and its default-mode takeover, and so does acting on it
 * from a timer created at mount (a re-apply happens inside a transaction of its
 * own). A timer created HERE, when the module is loaded, carries the module's
 * original context instead, so its callbacks are never inside one.
 */
const flushState = { requested: false, handler: undefined };
const flushTimer = setInterval(() => {
	if (!flushState.requested || flushState.handler === undefined) return;
	flushState.requested = false;
	flushState.handler();
}, 250);
flushTimer.unref?.();
/**
 * Disposers for the copies this process registered as declarations. Module-level
 * on purpose: 0.1.7+ offers no way to remove a preset this process did not
 * register, so these are what lets a changed threshold retire its predecessor
 * even though a save re-applies this plugin.
 */
const registeredCopies = new Map();

/**
 * Rewrite the compaction row's threshold inside a DECLARED composition.
 *
 * The structured twin of {@link rewriteThreshold}: 0.1.7+ states a preset as
 * loader plugin rows, so the same target row is edited as data instead of YAML.
 * Group rows nest their children under `config`, which is why the walk descends
 * there as well.
 * @param plugins - the source preset's plugin rows.
 * @param ratio - the threshold ratio to write.
 * @returns a copy with that one row changed, and whether it was found.
 */
function rewriteComposition(plugins, ratio) {
	let found = false;
	const walk = (rows) => {
		if (!Array.isArray(rows)) return rows;
		return rows.map((row) => {
			if (row === null || typeof row !== "object" || Array.isArray(row)) return row;
			const copy = { ...row };
			if (Array.isArray(copy.config)) copy.config = walk(copy.config);
			else if (copy.config !== null && typeof copy.config === "object") copy.config = { ...copy.config };
			if (String(copy.id ?? "").includes(ROW_ID)) {
				copy.config = { ...(copy.config ?? {}), thresholdRatio: ratio };
				found = true;
			}
			return copy;
		});
	};
	return { plugins: walk(plugins), found };
}

/**
 * Every preset this deployment declares, keyed by preset id.
 *
 * 0.1.7+ states a preset as one loader row (`{ id: 'preset-<name>', name:
 * '@deepseek-ai/dsh-agent-preset', config: { id, order, plugins } }`), and no
 * roster reader hands out that composition: `list()` and `resolve()` answer with
 * metadata only, and `compositionInventory()` with activation diagnostics. The
 * loader entry's own config is exactly what that row registered, so it is the
 * source of truth a copy is built from.
 * @param loader - the loader service, when this host has one.
 * @returns declared definitions by preset id.
 */
function declaredDefinitions(loader) {
	const declared = new Map();
	if (loader === undefined) return declared;
	try {
		for (const entry of loader.entries()) {
			const options = entry?.options;
			if (options?.name !== PRESET_ROW) continue;
			const config = options.config;
			if (config === null || typeof config !== "object" || Array.isArray(config)) continue;
			if (typeof config.id !== "string" || !Array.isArray(config.plugins)) continue;
			declared.set(config.id, config);
		}
	} catch {
		// A loader that refuses enumeration degrades to "nothing declared".
	}
	return declared;
}

/**
 * Retire one declared copy by releasing its registration.
 * @param id - the managed preset id.
 */
async function disposeDeclared(id) {
	const disposer = registeredCopies.get(id);
	registeredCopies.delete(id);
	if (disposer === undefined) return;
	try {
		await disposer();
	} catch {
		// The declaration is gone either way.
	}
}

/**
 * Author the copies as declarations, which is what 0.1.7+ presets are.
 *
 * That generation has no writable preset directory and no authoring API beyond
 * `register(definition)`, so a copy is a registration: the source's composition
 * with one row's threshold rewritten, under a new id. A duplicate id means an
 * earlier mount of this plugin already owns it — the desired state, because the
 * id encodes the threshold.
 * @param ctx - host context, for the logger.
 * @param presets - the preset roster.
 * @param loader - the loader service carrying the declared compositions.
 * @param value - the resolved settings section.
 * @param sources - the source preset ids the user selected.
 * @param previous - the ids the last settings document recorded as managed.
 * @param known - the ids the roster currently shows.
 * @param wanted - accumulator of the ids this run wants.
 * @param skipped - accumulator of one line per unusable source.
 * @param candidates - accumulator of the copies safe to adopt as the default.
 * @returns the same shape as the file-backed author, so `sync` keeps one path.
 */
async function reconcileDeclared(ctx, presets, loader, value, sources, previous, known, wanted, skipped, candidates) {
	const declared = declaredDefinitions(loader);
	for (const source of value.enabled ? sources : []) {
		const definition = declared.get(source);
		if (definition === undefined) {
			skipped.push(`${source}（本部署没有声明这个模式的组合）`);
			continue;
		}
		const rewritten = rewriteComposition(definition.plugins, value.thresholdRatio);
		if (!rewritten.found) {
			// A mode that composes no compaction row (the shipped `minimal` preset)
			// has no threshold to change.
			skipped.push(`${source}（该模式没有 ${ROW_ID} 行）`);
			continue;
		}
		const id = managedId(source, value.thresholdRatio);
		wanted.push(id);
		try {
			if (!registeredCopies.has(id)) {
				const disposer = await presets.register({
					...definition,
					id,
					name: `${definition.name ?? source} · 压缩阈值 ${value.thresholdRatio}`,
					description: `由 dsh-compact-threshold 生成：${source} 全量能力，compaction-basic.thresholdRatio = ${value.thresholdRatio}。`,
					plugins: rewritten.plugins
				});
				if (typeof disposer === "function") registeredCopies.set(id, disposer);
			}
			candidates.push({ id, source });
			known.add(id);
		} catch (error) {
			// Already declared: an earlier mount kept the registration, and that copy
			// carries the same id because the id is what encodes the threshold.
			ctx.logger.info(`compact-threshold: preset ${id} is already declared (${String(error?.message ?? error)})`);
			candidates.push({ id, source });
			known.add(id);
		}
	}
	for (const id of new Set([...previous, ...registeredCopies.keys()])) {
		if (!wanted.includes(id)) await disposeDeclared(id);
	}
	for (const id of [...known]) {
		if (wanted.includes(id)) continue;
		if (isOwnedId(id, sources)) await disposeDeclared(id);
	}
	if (skipped.length > 0) ctx.logger.warn(`compact-threshold: skipped ${skipped.join("; ")}`);
	ctx.logger.info(
		`compact-threshold: thresholdRatio=${value.thresholdRatio} managed=${wanted.join(",") || "(none)"}`
	);
	return { managed: wanted, skipped, candidates };
}

/**
 * Author (or refresh / retire) every managed preset for the current settings.
 * @param ctx - host context carrying the preset roster.
 * @param value - the resolved settings section.
 * @param loader - the loader service, used to read declared compositions on 0.1.7+.
 * @returns the ids now managed, one line per source that could not be used, and
 *   the `{ id, source }` of every copy fully written by this run (the only ids
 *   safe to adopt as the default).
 */
async function reconcile(ctx, value, loader) {
	const presets = ctx.agentPresets;
	const previous = Array.isArray(value.managedPresets) ? value.managedPresets : [];
	const wanted = [];
	const skipped = [];
	const candidates = [];
	const sources = Array.isArray(value.sourcePresets) ? value.sourcePresets : [];
	const known = new Set((await presets.list()).map((preset) => preset.id));
	// 0.1.7+ presets are declarations held in memory, not files on disk: that
	// generation's roster has `register` and no writable root at all.
	if (typeof presets.register === "function" && presets.resolvedRoots === undefined) {
		return reconcileDeclared(ctx, presets, loader, value, sources, previous, known, wanted, skipped, candidates);
	}
	const root = (presets.resolvedRoots ?? []).find((candidate) => candidate.trust === "user");
	if (value.enabled && root === undefined) {
		throw new Error("compact-threshold: this deployment configures no user-writable preset root");
	}

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
	/** The loader, used on 0.1.7+ to read the config the composition now carries. */
	let loader;
	/** Whether the host still speaks the 0.1.5-rc.x settings vocabulary. */
	let legacy = true;
	let running = Promise.resolve();
	/** Whether the missing-presets warning was already logged. */
	let warnedNoPresetNs = false;
	/** Whether the "mode selection is off" warning was already logged. */
	let warnedSelectionOff = false;

	/**
	 * The default the presets roster resolves right now. 0.1.7+ folds the
	 * deployment default and the mode-selection switch in here; the 0.1.5-rc.x
	 * settings descriptor already answers that question by itself.
	 * @returns the effective default preset id, or undefined when unreadable.
	 */
	const effectiveDefault = () => {
		try {
			return typeof ctx.agentPresets?.defaultId === "string" ? ctx.agentPresets.defaultId : undefined;
		} catch {
			return undefined;
		}
	};

	/**
	 * Plan the default-mode takeover for one sync.
	 * @param value - the resolved settings section.
	 * @param candidates - the copies this run fully wrote.
	 * @returns the plan, or a no-op plan when this deployment has no roster.
	 */
	const plan = (value, candidates) => {
		try {
			const read = readDefaultMode(settings, legacy, effectiveDefault());
			if (read === undefined) {
				// A deployment that composes no preset roster registers no such
				// settings key; the copies are still authored, the default is not ours.
				if (!warnedNoPresetNs) {
					warnedNoPresetNs = true;
					ctx.logger.warn("compact-threshold: no agent-presets settings key; the default mode is left as it is");
				}
				return { kind: "none", value: undefined, patch: {} };
			}
			if (!legacy && selectionDisabled(settings) && !warnedSelectionOff) {
				warnedSelectionOff = true;
				ctx.logger.warn("compact-threshold: the mode-selection switch is off, so an adopted default stays ineffective until it is enabled");
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
			const { managed, skipped, candidates } = await reconcile(ctx, value, loader);
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
			if (Object.keys(patch).length > 0) {
				// This write is usually triggered by the browser's own save, whose retries
				// hold the profile-patch HMR transaction open; a write attempted inside it
				// is refused ("HMR transactions cannot be nested"). Losing it is not
				// cosmetic — the managed list is what retires stale copies and what the
				// default-mode takeover is recorded against — so keep trying past that
				// window and report a hard failure instead of pretending it landed.
				let failure;
				for (let attempt = 0; attempt < 6; attempt += 1) {
					try {
						await settings.update(legacy ? CONCISE_NS : ENTRY_ID, patch);
						failure = undefined;
						break;
					} catch (error) {
						failure = error;
						await new Promise((resolve) => setTimeout(resolve, 500));
					}
				}
				if (failure !== undefined) {
					ctx.logger.warn(`compact-threshold: could not record the managed presets: ${String(failure?.message ?? failure)}`);
				}
			}
			await applyDefault(ctx, settings, taken, legacy);
			if (taken.kind !== "none") {
				ctx.logger.info(`compact-threshold: default mode ${taken.kind} ${taken.value || "(inherited)"}`);
			}
			// The browser's preset picker holds its roster until something tells it to
			// re-read. 0.1.7+'s `ui-agent-preset` reloads on a
			// `settings/document-updated` for the registry namespace, and the remote
			// layer forwards exactly that event to clients — but authoring copies is not
			// a write to that namespace, so a save that changed them would leave the new
			// modes invisible until a page reload. Announce the roster change ourselves.
			// The 0.1.5-rc.x client has no such subscription, which is why that
			// generation still needs a refresh after a save.
			if (!legacy && (Object.keys(patch).length > 0 || taken.kind !== "none")) {
				try {
					const revision = settings.describe().find((entry) => entry.ns === PRESET_NS_CURRENT)?.revision ?? 0;
					ctx.emit("settings/document-updated", PRESET_NS_CURRENT, revision);
				} catch (error) {
					ctx.logger.warn(`compact-threshold: could not announce the preset roster change: ${String(error?.message ?? error)}`);
				}
			}
		}).catch((error) => {
			ctx.logger.warn(`compact-threshold: ${String(error?.stack ?? error)}`);
		});
		return running;
	};

	// The settings service is optional: `ctx.inject` is the graceful-degradation
	// boundary, so a host without one keeps the composed configuration and authors
	// nothing. Which vocabulary that service speaks decides everything below; the
	// service itself is read (never a removed convenience export), so a missing
	// settings provider cannot fail the whole boot.
	ctx.inject(["settings"], (settingsCtx) => {
		settings = settingsCtx.settings;
		if (typeof settings.installSection === "function") {
			// 0.1.5-rc.x: one plugin-owned namespace, registered imperatively. The
			// service hands the resolved section back on every change, which is what
			// `setSource` follows.
			legacy = true;
			settings.installSection(ctx, CONCISE_NS, Config, config ?? {}, {
				setSource: (source) => {
					// The service hands over a getter, not a value (it also re-hands the
					// entry itself while unloading), so `current` stays callable.
					current = source;
					void sync();
				},
				onChange: () => {
					void sync();
				},
				validate: assertUsable
			});
			return;
		}

		// 0.1.7+: there is no per-plugin namespace and no `installSection`. The
		// entry's own Config is the form, its *volatile* fields (see `live`) are the
		// ones a card may edit live, and this plugin's values are read straight off
		// the composition instead of off the running fiber (see `readComposedConfig`).
		// An ordinary config edit remounts the entry, which re-runs this apply; a
		// volatile-only edit does not, and arrives as a document update.
		legacy = false;
		if (typeof settings.configure === "function") {
			try {
				const off = settings.configure({ auto: false }, ctx.fiber);
				ctx.effect(() => () => off?.());
			} catch (error) {
				ctx.logger.warn(`compact-threshold: could not claim the settings page policy: ${String(error?.message ?? error)}`);
			}
		}
		ctx.inject(["loader"], (loaderCtx) => {
			loader = loaderCtx.loader;
			// The declared compositions this generation authors copies from come off
			// the loader, so the first reconcile may have run before it was reachable;
			// one more pass makes that harmless instead of a missed authoring.
			void sync();
		});
		/**
		 * Re-apply this plugin from the config the composition now carries.
		 *
		 * Needed because this plugin resolves the PROFILE's schemastery, whose
		 * resolved config carries no live references: the loader's volatile-only
		 * fast path finds nothing to write into, keeps the running config — and so
		 * `settings.describe()`, and so the card's idea of the saved value — at the
		 * pre-save numbers. Re-applying from the composed config makes the running
		 * values true again. Guarded by the running values, so it settles after one
		 * pass and never loops with this plugin's own bookkeeping writes.
		 */
		const reapply = () => {
			const raw = loader === undefined ? undefined : readComposedRaw(loader);
			if (raw === undefined) return false;
			if (ctx.fiber === undefined) return false;
			/** Compare only this schema's own fields, in schema order. */
			const shape = (section) => Object.keys(Config.dict ?? {}).map((key) => JSON.stringify(plainSection(section)[key])).join("|");
			let fresh;
			try {
				fresh = Config(raw);
			} catch {
				return false;
			}
			if (shape(fresh) === shape(ctx.fiber.config)) return false;
			try {
				ctx.fiber.update(raw, true);
				return true;
			} catch (error) {
				ctx.logger.warn(`compact-threshold: could not re-apply the saved settings: ${String(error?.message ?? error)}`);
				return false;
			}
		};
		current = () => (loader === undefined ? undefined : readComposedConfig(loader)) ?? readOwnSection(settings) ?? plainSection(config);
		/**
		 * Act on a settings change from the module's own async context: write the
		 * bookkeeping and the takeover first, then re-apply this entry so the running
		 * config `describe()` serves matches the one just saved.
		 */
		const drain = () => {
			void sync().then(
				() => reapply(),
				() => reapply()
			);
		};
		flushState.handler = drain;
		ctx.effect(() => () => {
			if (flushState.handler === drain) {
				flushState.handler = undefined;
				flushState.requested = false;
			}
		});
		ctx.on("settings/document-updated", (ns) => {
			if (ns === ENTRY_ID) flushState.requested = true;
		});
		// `describe()` lists an entry only once its fiber is ACTIVE, which is after
		// this callback returns, so the first reconcile waits for that turn.
		const first = setTimeout(() => {
			void sync();
		}, 0);
		first.unref?.();
		ctx.effect(() => () => clearTimeout(first));
	});
}

export { apply, Config, declaredDefinitions, inject, isOwnedId, managedId, pickDefault, planDefault, presetTarget, ratioTag, rewriteComposition, rewriteThreshold };
