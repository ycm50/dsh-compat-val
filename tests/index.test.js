/**
 * Unit tests for the pure parts of dsh-compact-value: the ratio tag that
 * preset ids admit, the managed id derived from it, the composition rewrite that
 * injects or replaces the compaction threshold, the unfolding of the live
 * references a volatile schema resolves to, and the default-mode takeover (which
 * copy wins, and when it is adopted, kept, or released).
 *
 * The last block drives `reconcile` against a DECLARATION-ONLY roster, the kind
 * 0.2.0-rc.1 ships: `register` returns the disposer that retires a copy and
 * there is no `remove` at all.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { apply, Config, declaredDefinitions, isOwnedId, managedId, ownedPointer, pickDefault, plainSection, planDefault, presetTarget, ratioTag, reconcile, release, rewriteComposition, rewriteThreshold, runtime } from "../lib/index.js";

const COMPOSITION = fileURLToPath(new URL("../fixtures/standard-like.cordis.yml", import.meta.url));

test("ratioTag keeps the id grammar (letters, digits, hyphens only)", () => {
	assert.equal(ratioTag(0.4), "4");
	assert.equal(ratioTag(0.75), "75");
	assert.equal(ratioTag(0.8), "8");
	assert.equal(ratioTag(0.385), "385");
	assert.equal(ratioTag(0.4), ratioTag(0.40), "equal ratios must map to one id");
	for (const ratio of [0.4, 0.75, 0.385]) {
		assert.match(managedId("standard", ratio), /^[a-z0-9][a-z0-9-]*$/);
	}
});

test("managedId appends the tagged ratio to the source id", () => {
	assert.equal(managedId("standard", 0.4), "standard-compact-4");
	assert.equal(managedId("ptc", 0.6), "ptc-compact-6");
});

test("rewriteThreshold replaces a threshold the row already has", () => {
	const text = ["- id: compaction-basic", "  name: x", "  config:", "    thresholdRatio: 0.8", ""].join("\n");
	const result = rewriteThreshold(text, 0.4);
	assert.equal(result.found, true);
	assert.match(result.text, /thresholdRatio: 0\.4/);
	assert.doesNotMatch(result.text, /0\.8/);
	assert.equal(result.text.split("\n").filter((line) => line.includes("thresholdRatio")).length, 1);
});

test("rewriteThreshold inserts a config block when the row has none", () => {
	const text = ["- id: compaction-basic", "  name: x", "- id: command-compact", "  name: y", ""].join("\n");
	const result = rewriteThreshold(text, 0.4);
	assert.equal(result.found, true);
	// The block is appended to the row's own keys, so the next row still starts
	// at column 0 with its own `- id:` marker.
	assert.match(result.text, /- id: compaction-basic\n {2}name: x\n {2}config:\n {4}thresholdRatio: 0\.4\n- id: command-compact/);
});

test("rewriteThreshold inserts before an unindented sibling key too", () => {
	const text = ["- id: compaction-basic", "  name: x", "# a comment", "- id: next", ""].join("\n");
	const result = rewriteThreshold(text, 0.4);
	assert.match(result.text, /- id: compaction-basic\n {2}name: x\n# a comment\n {2}config:\n {4}thresholdRatio: 0\.4\n- id: next/);
});

test("rewriteThreshold leaves other rows untouched", () => {
	const text = ["- id: compaction-basic-extra", "  name: x", "  config:", "    thresholdRatio: 0.9", ""].join("\n");
	const result = rewriteThreshold(text, 0.4);
	assert.equal(result.found, false);
	assert.equal(result.text, text);
});

test("rewriteThreshold handles the real shipped composition", async () => {
	const original = await readFile(COMPOSITION, "utf8");
	const result = rewriteThreshold(original, 0.4);
	assert.equal(result.found, true);
	assert.match(result.text, /thresholdRatio: 0\.4/);
	// Everything outside the inserted lines must survive verbatim.
	const before = original.split("\n");
	const after = result.text.split("\n");
	assert.equal(after.length, before.length + 2);
	assert.equal(after[0], before[0]);
	assert.equal(after[after.length - 1], before[before.length - 1]);
});

test("isOwnedId recognizes a copy of a configured source, and nothing else", () => {
	assert.equal(isOwnedId("standard-compact-4", ["standard", "ptc"]), true);
	assert.equal(isOwnedId("ptc-compact-75", ["standard", "ptc"]), true);
	// A source the user unchecked no longer proves ownership: the managed list is
	// the only other witness, which is why the record is written back.
	assert.equal(isOwnedId("standard-compact-4", ["minimal"]), false);
	assert.equal(isOwnedId("standard", ["standard"]), false);
	assert.equal(isOwnedId("standard-compact", ["standard"]), false);
	assert.equal(isOwnedId(undefined, ["standard"]), false);
});

test("pickDefault prefers 标准 > 创造 > 极简 > ptc", () => {
	const candidates = [
		{ id: "ptc-compact-4", source: "ptc" },
		{ id: "minimal-compact-4", source: "minimal" },
		{ id: "cordis-compact-4", source: "cordis" },
		{ id: "standard-compact-4", source: "standard" }
	];
	assert.equal(pickDefault(candidates), "standard-compact-4");
	assert.equal(pickDefault(candidates.slice(0, 3)), "cordis-compact-4");
	assert.equal(pickDefault(candidates.slice(0, 2)), "minimal-compact-4");
	assert.equal(pickDefault(candidates.slice(0, 1)), "ptc-compact-4");
	// Input order must not decide: the table does.
	assert.equal(pickDefault([...candidates].reverse()), "standard-compact-4");
});

test("pickDefault ranks an unlisted source below every listed one, stably", () => {
	const candidates = [
		{ id: "house-style-compact-4", source: "house-style" },
		{ id: "ptc-compact-4", source: "ptc" },
		{ id: "zeta-compact-4", source: "zeta" }
	];
	assert.equal(pickDefault(candidates), "ptc-compact-4", "any listed source beats an unlisted one");
	assert.equal(
		pickDefault([{ id: "b-compact-4", source: "b" }, { id: "a-compact-4", source: "a" }]),
		"a-compact-4",
		"same rank falls back to the id so the winner is stable across runs"
	);
});

test("pickDefault returns undefined when nothing was authored", () => {
	assert.equal(pickDefault([]), undefined);
	assert.equal(pickDefault(undefined), undefined);
	assert.equal(pickDefault([{ id: "", source: "standard" }]), undefined);
});

/** The state every takeover test starts from: no copy adopted yet. */
const FRESH = {
	enabled: true,
	adoptDefault: true,
	candidate: "standard-compact-4",
	current: "standard",
	userDefault: undefined,
	sources: ["standard"],
	managed: [],
	known: new Set(["standard", "minimal", "cordis", "standard-compact-4"]),
	adopted: "",
	previous: "",
	recorded: false
};

test("planDefault adopts the winning copy and records a restore point", () => {
	const adopted = planDefault(FRESH);
	assert.equal(adopted.kind, "set");
	assert.equal(adopted.value, "standard-compact-4");
	// Nothing in the user layer before the takeover: releasing UNSETS the field so
	// the deployment's own default shows through again. The record is the PLUGIN's
	// now — it is no longer written into the profile.
	assert.deepEqual(adopted.patch, { adopted: "standard-compact-4", previous: "", recorded: true });

	const userChose = planDefault({ ...FRESH, current: "minimal", userDefault: "minimal" });
	assert.deepEqual(userChose.patch, { adopted: "standard-compact-4", previous: "minimal", recorded: true });
});

test("planDefault keeps the ORIGINAL restore point across later saves", () => {
	const again = planDefault({
		...FRESH,
		current: "ptc-compact-4",
		adopted: "standard-compact-3",
		previous: "minimal",
		recorded: true,
		managed: ["standard-compact-3"]
	});
	assert.equal(again.kind, "set");
	assert.equal(again.value, "standard-compact-4");
	assert.equal(again.patch.previous, "minimal", "a later save must not record this plugin's own id as the thing to restore");
});

test("planDefault is idempotent once the copy is the default", () => {
	const plan = planDefault({ ...FRESH, current: "standard-compact-4", adopted: "standard-compact-4", recorded: true });
	assert.equal(plan.kind, "none");
	assert.deepEqual(plan.patch, {}, "an unchanged default must not write, or every sync would bump the revision");
});

test("planDefault records ownership when the copy already is the default", () => {
	const plan = planDefault({ ...FRESH, current: "standard-compact-4", userDefault: "standard-compact-4" });
	assert.equal(plan.kind, "none");
	// No write to the presets namespace, but the record still lands — and the
	// pre-takeover value is a copy this plugin will delete, so it degrades to
	// "inherit" rather than restoring a preset that is about to disappear.
	assert.deepEqual(plan.patch, { adopted: "standard-compact-4", previous: "", recorded: true });
});

test("planDefault releases the default when the feature turns off", () => {
	const disabled = planDefault({
		...FRESH,
		enabled: false,
		candidate: undefined,
		current: "standard-compact-4",
		adopted: "standard-compact-4",
		recorded: true
	});
	assert.equal(disabled.kind, "unset");
	assert.equal(disabled.value, "");
	assert.deepEqual(disabled.patch, { adopted: "", previous: "", recorded: false });

	// The per-save switch releases the same way, and a recorded user choice comes
	// back instead of being unset.
	const off = planDefault({
		...FRESH,
		adoptDefault: false,
		current: "standard-compact-4",
		adopted: "standard-compact-4",
		previous: "minimal",
		recorded: true
	});
	assert.equal(off.kind, "restore");
	assert.equal(off.value, "minimal");
	assert.deepEqual(off.patch, { adopted: "", previous: "", recorded: false });
});

test("planDefault releases a stale copy the managed list no longer names", () => {
	// The threshold changed while the takeover was off, so the copy standing as
	// the default was already retired: only the id shape proves it is ours.
	const plan = planDefault({ ...FRESH, candidate: undefined, current: "standard-compact-3", managed: [] });
	assert.equal(plan.kind, "unset");
});

test("planDefault repairs a pointer the roster cannot resolve", () => {
	// A restart forgets `adopted`, and a source the user has since unchecked is no
	// longer in `sources` — the id's own shape is then the only witness that this
	// dangling pointer is ours to withdraw. Leaving it would make every new
	// session fail on an unknown preset.
	const plan = planDefault({
		...FRESH,
		candidate: undefined,
		current: "minimal-compact-8",
		sources: ["standard"]
	});
	assert.equal(plan.kind, "unset", "an unresolvable default is withdrawn, not left to fail session creation");
	assert.deepEqual(plan.patch, { adopted: "", previous: "", recorded: false });
});

test("planDefault never rewrites a default this plugin did not set", () => {
	const handPicked = planDefault({ ...FRESH, candidate: undefined, current: "minimal", userDefault: "minimal" });
	assert.equal(handPicked.kind, "none");
	assert.deepEqual(handPicked.patch, {}, "a mode the user picked by hand stays picked while no copy exists");

	const offAndForeign = planDefault({ ...FRESH, adoptDefault: false, current: "cordis", userDefault: "cordis" });
	assert.equal(offAndForeign.kind, "none");
	assert.deepEqual(offAndForeign.patch, {});
});

test("ownedPointer claims a copy by source list, by record, or by id shape", () => {
	runtime.adopted = "";
	assert.equal(ownedPointer("standard-compact-4", ["standard"]), true);
	assert.equal(ownedPointer("standard-compact-4", ["minimal"]), true, "the id shape survives a source the user unchecked");
	runtime.adopted = "house-style";
	assert.equal(ownedPointer("house-style", []), true, "the recorded takeover claims it");
	runtime.adopted = "";
	assert.equal(ownedPointer("standard", ["standard"]), false);
	assert.equal(ownedPointer("my-compact", ["standard"]), false);
	assert.equal(ownedPointer("", ["standard"]), false);
	assert.equal(ownedPointer(undefined, ["standard"]), false);
});

/** A settings provider whose registry section stands where the test put it.
 * @param pointer - the `selectedDefault` the user layer holds.
 * @returns the stub, with every write it received.
 */
function settingsStub(pointer) {
	const calls = [];
	const user = pointer === undefined ? {} : { selectedDefault: pointer };
	return {
		calls,
		describe: () => [{ ns: "agent-preset-registry", revision: 7, value: { ...user }, user }],
		async update(ns, patch) { calls.push({ op: "update", ns, patch }); },
		async mutate(ns, ops) { calls.push({ op: "mutate", ns, ops }); }
	};
}

/** A host context `release` needs: a logger that keeps the test output clean. */
const SILENT = { logger: { info() {}, warn() {} } };

test("release withdraws the pointer this plugin owns", async () => {
	const settings = settingsStub("standard-compact-4");
	runtime.adopted = "standard-compact-4";
	runtime.sources = ["standard"];
	runtime.previous = "";
	runtime.recorded = true;
	await release(SILENT, settings, false, "test");
	assert.deepEqual(settings.calls, [{ op: "mutate", ns: "agent-preset-registry", ops: [{ op: "unset", path: ["selectedDefault"] }] }]);
	assert.equal(runtime.adopted, "", "the record goes with the pointer");
});

test("release puts a recorded pre-takeover choice back instead of unsetting", async () => {
	const settings = settingsStub("standard-compact-4");
	runtime.adopted = "standard-compact-4";
	runtime.sources = ["standard"];
	runtime.previous = "minimal";
	runtime.recorded = true;
	await release(SILENT, settings, false, "test");
	assert.deepEqual(settings.calls, [{ op: "update", ns: "agent-preset-registry", patch: { selectedDefault: "minimal" } }]);
});

test("release leaves a foreign default and every file-backed copy alone", async () => {
	const foreign = settingsStub("cordis");
	runtime.adopted = "";
	runtime.sources = ["standard"];
	runtime.previous = "";
	runtime.recorded = false;
	await release(SILENT, foreign, false, "test");
	assert.deepEqual(foreign.calls, [], "a hand-picked default is not this plugin's to withdraw");

	// 0.1.5-rc.x copies are files on disk: they outlive this plugin, so the pointer
	// at one stays resolvable and is deliberately not touched.
	const legacy = settingsStub("standard-compact-4");
	runtime.adopted = "standard-compact-4";
	await release(SILENT, legacy, true, "test");
	assert.deepEqual(legacy.calls, []);
});

test("presetTarget names each generation's settings key and field", () => {
	// 0.1.5-rc.x: a plugin-owned settings namespace whose `default` is the mode.
	assert.deepEqual(presetTarget(true), { ns: "agent-presets", field: "default" });
	// 0.1.7+: the presets registry is an ordinary profile entry. Its user layer is
	// the volatile `selectedDefault`; `default` there is the deployment's own and
	// is deliberately not this plugin's to move.
	assert.deepEqual(presetTarget(false), { ns: "agent-preset-registry", field: "selectedDefault" });
});

test("Config keeps its documented defaults", () => {
	// Every field is volatile, so schemastery 3.18.4 — the copy an installed
	// plugin resolves — resolves each one to a LIVE REFERENCE rather than a plain
	// value. `plainSection` is the same unfolding the host half applies before it
	// validates or compares anything.
	const value = plainSection(Config({}));
	assert.equal(value.enabled, true);
	assert.equal(value.thresholdRatio, 0.4);
	assert.equal(value.retainRatio, 0.16);
	assert.deepEqual(value.sourcePresets, ["standard", "minimal", "ptc", "cordis"]);
	assert.equal(value.adoptDefault, true);
	// The section carries the SETTINGS and nothing else: the authored copies and
	// the takeover are the plugin's own `runtime`, so no bookkeeping field is
	// declared any more and none can reach the profile.
	assert.deepEqual(Object.keys(value).sort(), ["adoptDefault", "enabled", "retainRatio", "sourcePresets", "thresholdRatio"]);
	assert.equal(plainSection(Config({ thresholdRatio: 0.5 })).thresholdRatio, 0.5);
});

test("the plugin answers to one name everywhere", async () => {
	// The profile row's `id` IS the settings namespace both halves key off, and
	// its `name` is what the loader imports — a mismatch between any of these
	// leaves the card without a section or the host half without a config.
	const IDENTITY = "dsh-compact-value";
	const root = new URL("../", import.meta.url);
	const manifest = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
	const patch = await readFile(new URL("cordis.patch.yml", root), "utf8");
	const client = await readFile(new URL("lib/client.js", root), "utf8");
	const host = await readFile(new URL("lib/index.js", root), "utf8");
	assert.equal(manifest.name, IDENTITY, "package name");
	assert.equal(manifest.exports["./client"], "./lib/client.js", "the browser half the host advertises");
	assert.equal(manifest.dsh.client.platform, "web");
	const row = patch.split(/\r?\n/).map((line) => line.trim());
	assert.deepEqual(row.filter((line) => line.startsWith("- id:")), [`- id: ${IDENTITY}`], "the profile row's id");
	assert.ok(row.includes(`name: ${IDENTITY}`), "the profile row's name");
	assert.ok(client.includes(`\tid: "${IDENTITY}",`), "the browser module id");
	assert.ok(host.includes(`const ENTRY_ID = "${IDENTITY}";`), "the host's settings key");
	assert.ok(client.includes(`var ENTRY_ID = "${IDENTITY}";`), "the browser's settings key");
	assert.ok(host.includes(`const CONCISE_NS = "${IDENTITY}";`), "the legacy settings namespace");
	assert.ok(client.includes(`var NS = "${IDENTITY}";`), "the legacy browser namespace");
});

test("plainSection unfolds live references, so values compare as plain scalars", () => {
	const VW = Symbol.for("cosmokit.volatile.write");
	const isLive = (value) => value !== null && typeof value === "object" && VW in value;
	const raw = Config({});
	const unfolded = plainSection(raw);
	assert.equal(typeof unfolded.thresholdRatio, "number");
	assert.equal(unfolded.thresholdRatio, 0.4);
	assert.equal(typeof unfolded.enabled, "boolean");
	assert.deepEqual(unfolded.sourcePresets, ["standard", "minimal", "ptc", "cordis"]);
	for (const [key, value] of Object.entries(unfolded)) {
		assert.equal(isLive(value), false, key + " must be unfolded before it is compared or written");
	}
	// The raw shape is the one that would break the sync loop: a live reference is
	// not a number, so `thresholdRatio > 0` is false and `assertUsable` rejects a
	// perfectly good threshold. Only schemastery that supports `volatile()`
	// produces it, which is exactly the host this plugin now targets.
	if (isLive(raw.thresholdRatio)) assert.equal(raw.thresholdRatio > 0, false);
});

test("every Config field is marked volatile, whichever schemastery resolved", () => {
	// 0.1.7+ builds its settings form out of volatile fields and refuses writes to
	// any other path, so a field that loses this flag makes the entry vanish from
	// the form ("Host current value undefined") and rejects every save. The plugin
	// must not depend on `volatile()` existing: an installed copy imports the
	// PROFILE's schemastery (3.18.2 today), which has no such method.
	const fields = Object.entries(Config.dict ?? {});
	assert.ok(fields.length > 0, "Config must expose its fields for the form");
	for (const [key, field] of fields) {
		assert.equal(field.meta?.volatile, true, `${key} must carry the volatile flag`);
	}
});

test("rewriteComposition edits the declared compaction row and leaves the rest alone", () => {
	// 0.1.7+ presets are loader rows, not composition text: the structured twin of
	// `rewriteThreshold` must find the same row inside nested group rows.
	const plugins = [
		{ id: "persona", name: "@deepseek-ai/dsh-persona" },
		{
			id: "compaction",
			group: true,
			config: [
				{ id: "compaction-basic", name: "@deepseek-ai/dsh-compaction-basic", config: { thresholdRatio: 0.8, retainRatio: 0.16 } },
			],
		},
		{ id: "tools", name: "@deepseek-ai/dsh-tools", config: { verbose: true } },
	];
	const { plugins: rewritten, found } = rewriteComposition(plugins, 0.45);
	assert.equal(found, true);
	assert.equal(rewritten[1].config[0].config.thresholdRatio, 0.45);
	assert.equal(rewritten[1].config[0].config.retainRatio, 0.16, "sibling config keys survive");
	assert.equal(rewritten[2].config.verbose, true, "untouched rows are copied through");
	assert.equal(plugins[1].config[0].config.thresholdRatio, 0.8, "the source composition is never mutated");
	assert.equal(rewriteComposition([{ id: "persona", name: "@deepseek-ai/dsh-persona" }], 0.45).found, false);
});

test("declaredDefinitions reads preset rows off the loader, id-first", () => {
	const definition = { id: "standard", order: 1, plugins: [{ id: "compaction-basic", name: "x" }] };
	const loader = {
		entries: () => [
			{ options: { id: "preset-standard", name: "@deepseek-ai/dsh-agent-preset", config: definition } },
			{ options: { id: "dsh-compact-value", name: "dsh-compact-value", config: { thresholdRatio: 0.4 } } },
			{ options: { id: "preset-broken", name: "@deepseek-ai/dsh-agent-preset", config: { id: "broken" } } },
		],
	};
	const declared = declaredDefinitions(loader);
	assert.deepEqual([...declared.keys()], ["standard"]);
	assert.equal(declared.get("standard"), definition);
	assert.equal(declaredDefinitions(undefined).size, 0, "a host without a loader declares nothing");
});

/** A declaration-only preset roster, shaped like the one 0.2.0-rc.1 ships:
 * `register` resolves to the disposer that retires the copy, `list` reports the
 * live declarations, and there is NO `remove` and no `resolvedRoots` at all.
 * @returns the fake roster with its declarations and handed-out disposers.
 */
function declaredRoster() {
	const disposers = new Map();
	return {
		disposers,
		definitions: new Map(),
		async register(definition) {
			if (this.definitions.has(definition.id)) throw new Error(`Duplicate agent preset: ${definition.id}`);
			this.definitions.set(definition.id, definition);
			const unregister = async () => {
				this.definitions.delete(definition.id);
				disposers.delete(definition.id);
			};
			disposers.set(definition.id, unregister);
			return unregister;
		},
		async list() {
			return [...this.definitions.values()].map((definition) => ({ id: definition.id }));
		},
	};
}

/** A loader exposing one declarative preset row.
 * @param plugins - the preset's composed rows.
 * @returns the fake loader service.
 */
function presetLoader(plugins) {
	return {
		entries: () => [{
			options: {
				id: "preset-standard",
				name: "@deepseek-ai/dsh-agent-preset",
				config: { id: "standard", name: "标准", order: 1, plugins },
			},
		}],
	};
}

/** The host context `reconcile` needs: the roster and a recording logger.
 * @param agentPresets - the fake roster.
 * @returns the fake context.
 */
function hostContext(agentPresets) {
	const lines = [];
	return {
		agentPresets,
		logger: {
			info: (message) => lines.push(`info ${message}`),
			warn: (message) => lines.push(`warn ${message}`),
		},
		lines,
	};
}

/** The shipped `standard` composition, nested the way DSH writes it. */
const COMPOSED = [
	{ id: "persona", name: "@deepseek-ai/dsh-persona" },
	{ id: "compaction", group: true, config: [
		{ id: "compaction-basic", name: "@deepseek-ai/dsh-compaction-basic", config: { thresholdRatio: 0.8 } },
	] },
];

test("reconcile authors copies on a roster with register but no remove", async () => {
	const roster = declaredRoster();
	const ctx = hostContext(roster);
	runtime.managed = [];
	assert.equal(typeof roster.remove, "undefined", "0.2.0-rc.1 dropped remove; the declared path must not need it");
	const value = { enabled: true, thresholdRatio: 0.45, sourcePresets: ["standard"] };
	const result = await reconcile(ctx, value, presetLoader(COMPOSED));
	assert.deepEqual(result.managed, ["standard-compact-45"]);
	assert.deepEqual(result.candidates, [{ id: "standard-compact-45", source: "standard" }]);
	// The live roster travels back with the result: the default-mode plan needs it
	// to tell a pointer DSH can still resolve from one that dangles. (A real
	// deployment also lists the SOURCE presets here — their own `dsh-agent-preset`
	// rows register them — which this fake roster does not simulate.)
	assert.equal(result.known.has("standard-compact-45"), true);
	const definition = roster.definitions.get("standard-compact-45");
	assert.equal(definition.plugins[1].config[0].config.thresholdRatio, 0.45, "the copy carries the rewritten threshold");
	assert.equal(definition.plugins[1].config[0].config.retainRatio, undefined, "only the threshold is added");
	assert.equal(COMPOSED[1].config[0].config.thresholdRatio, 0.8, "the source composition is never mutated");
	assert.equal(typeof roster.disposers.get("standard-compact-45"), "function", "register returned the retiring disposer");
});

test("reconcile re-registers a copy the loader disposed with an earlier mount", async () => {
	const roster = declaredRoster();
	const ctx = hostContext(roster);
	runtime.managed = [];
	const value = { enabled: true, thresholdRatio: 0.45, sourcePresets: ["standard"] };
	await reconcile(ctx, value, presetLoader(COMPOSED));
	assert.deepEqual([...roster.definitions.keys()], ["standard-compact-45"]);
	// The loader disposes an earlier mount of this plugin, which runs the disposer
	// `register` returned. The module-level map still holds that dead disposer, so
	// only the ROSTER can tell the copy is gone.
	await roster.disposers.get("standard-compact-45")();
	assert.deepEqual(await roster.list(), []);
	const again = await reconcile(ctx, value, presetLoader(COMPOSED));
	assert.deepEqual(again.managed, ["standard-compact-45"]);
	assert.deepEqual([...roster.definitions.keys()], ["standard-compact-45"], "the copy is re-registered, never assumed");
});

test("reconcile retires the superseded copy when the threshold moves", async () => {
	const roster = declaredRoster();
	const ctx = hostContext(roster);
	runtime.managed = [];
	const first = await reconcile(ctx, { enabled: true, thresholdRatio: 0.45, sourcePresets: ["standard"] }, presetLoader(COMPOSED));
	// `sync` records the authored roster in the plugin; retiring the superseded set
	// is driven by that record, not by anything the profile holds.
	runtime.managed = first.managed;
	const second = await reconcile(ctx, { enabled: true, thresholdRatio: 0.6, sourcePresets: ["standard"] }, presetLoader(COMPOSED));
	assert.deepEqual(second.managed, ["standard-compact-6"]);
	assert.deepEqual([...roster.definitions.keys()], ["standard-compact-6"], "the old copy is retired through its disposer");
});

test("reconcile skips a source whose composition carries no compaction row", async () => {
	const roster = declaredRoster();
	const ctx = hostContext(roster);
	runtime.managed = [];
	const result = await reconcile(ctx, { enabled: true, thresholdRatio: 0.45, sourcePresets: ["standard"] }, presetLoader([{ id: "persona", name: "@deepseek-ai/dsh-persona" }]));
	assert.deepEqual(result.managed, []);
	assert.deepEqual(result.candidates, []);
	assert.equal(result.skipped.length, 1);
	assert.match(result.skipped[0], /compaction-basic/);
});


/** A settings provider shaped like 0.2.0-rc.1: one descriptor per live entry. */
function settingsProvider() {
	const calls = [];
	let selected;
	return {
		calls,
		configure: () => () => {},
		describe: () => [
			{ ns: "dsh-compact-value", revision: 1, value: {}, user: {} },
			{
				ns: "agent-preset-registry",
				revision: 2,
				value: selected === undefined ? {} : { selectedDefault: selected },
				user: selected === undefined ? {} : { selectedDefault: selected }
			}
		],
		async update(ns, patch) {
			calls.push({ op: "update", ns, patch });
			if (ns === "agent-preset-registry") selected = patch.selectedDefault;
		},
		async mutate(ns, ops) {
			calls.push({ op: "mutate", ns, ops });
			if (ns === "agent-preset-registry") selected = undefined;
		}
	};
}

/** A loader carrying this plugin's own row plus the source preset's declaration. */
function configLoader(config) {
	return {
		entries: () => [
			{ options: { id: "dsh-compact-value", name: "dsh-compact-value", config } },
			{ options: { id: "preset-standard", name: "@deepseek-ai/dsh-agent-preset", config: { id: "standard", name: "标准", order: 1, plugins: COMPOSED } } }
		]
	};
}

/** A host context good enough for `apply`: inject is synchronous and effects are recorded. */
function hostCtx(agentPresets, settings, loader) {
	const effects = [];
	return {
		effects,
		logger: { info() {}, warn() {}, error() {} },
		agentPresets,
		fiber: { config: {}, update() {} },
		inject: (deps, callback) => {
			if (deps.includes("settings")) callback({ settings });
			if (deps.includes("loader")) callback({ loader });
		},
		effect: (fn) => {
			const dispose = fn();
			effects.push(dispose);
			return dispose;
		},
		on: () => () => {},
		emit: () => {}
	};
}

test("apply registers copies and writes nothing but the pointer", async () => {
	runtime.managed = [];
	runtime.adopted = "";
	runtime.previous = "";
	runtime.recorded = false;
	const roster = declaredRoster();
	const settings = settingsProvider();
	const ctx = hostCtx(roster, settings, configLoader({ thresholdRatio: 0.45, sourcePresets: ["standard"] }));
	apply(ctx, { thresholdRatio: 0.45, sourcePresets: ["standard"] });
	// The mount reconciles on the loader pass and again on the first-turn timer;
	// the second pass is idempotent, which the single write below proves.
	await new Promise((resolve) => setTimeout(resolve, 40));
	assert.deepEqual([...roster.definitions.keys()], ["standard-compact-45"]);
	assert.deepEqual(settings.calls, [
		{ op: "update", ns: "agent-preset-registry", patch: { selectedDefault: "standard-compact-45" } }
	], "the pointer is the only thing this plugin puts in the profile");
	assert.equal(runtime.adopted, "standard-compact-45");
	assert.equal(runtime.managed.length, 1);

	// Unloading the plugin runs every effect disposer, and the release write lands
	// before the fiber is considered gone (cordis awaits them).
	for (const dispose of ctx.effects) if (typeof dispose === "function") await dispose();
	assert.deepEqual(settings.calls.slice(1), [
		{ op: "mutate", ns: "agent-preset-registry", ops: [{ op: "unset", path: ["selectedDefault"] }] }
	], "an unloaded plugin must not leave a pointer at a copy that no longer exists");
});

test("apply restores a recorded pre-takeover choice when it unloads", async () => {
	runtime.managed = [];
	runtime.adopted = "";
	runtime.previous = "";
	runtime.recorded = false;
	const roster = declaredRoster();
	const settings = settingsProvider();
	const ctx = hostCtx(roster, settings, configLoader({ thresholdRatio: 0.45, sourcePresets: ["standard"] }));
	apply(ctx, { thresholdRatio: 0.45, sourcePresets: ["standard"] });
	await new Promise((resolve) => setTimeout(resolve, 40));
	// A hand-picked default standing before the takeover is what goes back.
	runtime.previous = "cordis";
	runtime.recorded = true;
	for (const dispose of ctx.effects) if (typeof dispose === "function") await dispose();
	assert.deepEqual(settings.calls.slice(1), [
		{ op: "update", ns: "agent-preset-registry", patch: { selectedDefault: "cordis" } }
	]);
});
