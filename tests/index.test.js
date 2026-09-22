/**
 * Unit tests for the pure parts of dsh-compact-threshold: the ratio tag that
 * preset ids admit, the managed id derived from it, the composition rewrite that
 * injects or replaces the compaction threshold, and the default-mode takeover
 * (which copy wins, and when it is adopted, kept, or released).
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { isOwnedId, managedId, pickDefault, planDefault, ratioTag, rewriteThreshold } from "../lib/index.js";

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
	defaultPreset: "",
	previousDefault: ""
};

test("planDefault adopts the winning copy and records a restore point", () => {
	const adopted = planDefault(FRESH);
	assert.equal(adopted.kind, "set");
	assert.equal(adopted.value, "standard-compact-4");
	// Nothing in the user layer before the takeover: releasing UNSETS the field so
	// the deployment's own default shows through again.
	assert.deepEqual(adopted.patch, { defaultPreset: "standard-compact-4", previousDefault: "" });

	const userChose = planDefault({ ...FRESH, current: "minimal", userDefault: "minimal" });
	assert.deepEqual(userChose.patch, { defaultPreset: "standard-compact-4", previousDefault: "minimal" });
});

test("planDefault keeps the ORIGINAL restore point across later saves", () => {
	const again = planDefault({
		...FRESH,
		current: "ptc-compact-4",
		defaultPreset: "standard-compact-3",
		previousDefault: "minimal",
		managed: ["standard-compact-3"]
	});
	assert.equal(again.kind, "set");
	assert.equal(again.value, "standard-compact-4");
	assert.equal(again.patch.previousDefault, "minimal", "a later save must not record this plugin's own id as the thing to restore");
});

test("planDefault is idempotent once the copy is the default", () => {
	const plan = planDefault({ ...FRESH, current: "standard-compact-4", defaultPreset: "standard-compact-4" });
	assert.equal(plan.kind, "none");
	assert.deepEqual(plan.patch, {}, "an unchanged default must not write, or every sync would bump the revision");
});

test("planDefault records ownership when the copy already is the default", () => {
	const plan = planDefault({ ...FRESH, current: "standard-compact-4", userDefault: "standard-compact-4" });
	assert.equal(plan.kind, "none");
	// No write to the presets namespace, but the record still lands — and the
	// pre-takeover value is a copy this plugin will delete, so it degrades to
	// "inherit" rather than restoring a preset that is about to disappear.
	assert.deepEqual(plan.patch, { defaultPreset: "standard-compact-4", previousDefault: "" });
});

test("planDefault releases the default when the feature turns off", () => {
	const disabled = planDefault({
		...FRESH,
		enabled: false,
		candidate: undefined,
		current: "standard-compact-4",
		defaultPreset: "standard-compact-4"
	});
	assert.equal(disabled.kind, "unset");
	assert.equal(disabled.value, "");
	assert.deepEqual(disabled.patch, { defaultPreset: "", previousDefault: "" });

	// The per-save switch releases the same way, and a recorded user choice comes
	// back instead of being unset.
	const off = planDefault({
		...FRESH,
		adoptDefault: false,
		current: "standard-compact-4",
		defaultPreset: "standard-compact-4",
		previousDefault: "minimal"
	});
	assert.equal(off.kind, "restore");
	assert.equal(off.value, "minimal");
	assert.deepEqual(off.patch, { defaultPreset: "", previousDefault: "" });
});

test("planDefault releases a stale copy the managed list no longer names", () => {
	// The threshold changed while the takeover was off, so the copy standing as
	// the default was already retired: only the id shape proves it is ours.
	const plan = planDefault({ ...FRESH, candidate: undefined, current: "standard-compact-3", managed: [] });
	assert.equal(plan.kind, "unset");
});

test("planDefault never rewrites a default this plugin did not set", () => {
	const handPicked = planDefault({ ...FRESH, candidate: undefined, current: "minimal", userDefault: "minimal" });
	assert.equal(handPicked.kind, "none");
	assert.deepEqual(handPicked.patch, {}, "a mode the user picked by hand stays picked while no copy exists");

	const offAndForeign = planDefault({ ...FRESH, adoptDefault: false, current: "cordis", userDefault: "cordis" });
	assert.equal(offAndForeign.kind, "none");
	assert.deepEqual(offAndForeign.patch, {});
});
