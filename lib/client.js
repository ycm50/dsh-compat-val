/**
 * dsh-compact-threshold browser half: one settings card for the compaction
 * threshold, mounted under whichever settings vocabulary the host speaks —
 * Settings → Plugins on 0.1.5-rc.x (a scope bound to this plugin's settings
 * namespace), or its own Settings page on 0.1.7+ (the live form of this plugin's
 * profile entry, whose fields the host half marks volatile for exactly this).
 *
 * It edits the compaction threshold, the retention floor, and which preset
 * modes get a generated `<mode>-compact-<ratio>` copy. Saving writes the
 * settings section; the host half authors the presets from what it reads.
 */
window.__ModuleLoader__.load({
	id: "dsh-compact-threshold",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		var react = require("react");
		var react_jsx_runtime = require("react/jsx-runtime");
		/** Settings namespace this card edits on 0.1.5-rc.x (must match the host half). */
		var NS = "dsh-compact-threshold";
		/**
		 * Profile entry id this card edits on 0.1.7+ (must match the host half):
		 * that generation keys one settings form per profile entry and exposes
		 * the entry's volatile fields, so the card reads and writes through
		 * `configForms.get(ENTRY_ID)` instead of a plugin-owned namespace.
		 */
		var ENTRY_ID = "compact-threshold";
		/** Shipped modes a user can extend; unknown ones can still be typed in. */
		var KNOWN_MODES = ["standard", "minimal", "ptc", "cordis"];
		/** Style for a text input inside the card. */
		var INPUT = {
			border: "1px solid var(--dsw-alias-border-l2)",
			background: "var(--dsw-alias-bg-layer-1)",
			color: "var(--dsw-alias-label-primary)",
			borderRadius: "8px",
			padding: "6px 10px",
			fontSize: "13px",
			lineHeight: "1.5",
			fontFamily: "inherit",
			boxSizing: "border-box"
		};
		/** One labelled row of the card. */
		function Row({ title, hint, children }) {
			return react_jsx_runtime.jsxs("div", {
				style: { padding: "12px 16px", display: "flex", flexDirection: "column", gap: "6px" },
				children: [
					react_jsx_runtime.jsx("div", { style: { fontSize: "14px", fontWeight: 600 }, children: title }),
					react_jsx_runtime.jsx("div", { style: { fontSize: "12px", color: "var(--dsw-alias-label-tertiary)", lineHeight: "1.5" }, children: hint }),
					children
				]
			});
		}
		/**
		 * Read a snapshot of the namespace section.
		 * @param scope - the bound settings scope.
		 * @returns the section object, or an empty object while unavailable.
		 */
		function sectionOf(scope) {
			try {
				var snap = scope.getSnapshot();
				var value = snap !== null && typeof snap === "object" && snap.value !== void 0 ? snap.value : snap;
				return value !== null && typeof value === "object" ? value : {};
			} catch (_error) {
				return {};
			}
		}
		/**
		 * The settings card itself.
		 * @param props - composed slot props with the bound scope.
		 */
		function CompactThresholdCard({ scope }) {
			var state = react.useState(function () {
				return sectionOf(scope);
			});
			var section = state[0];
			var setSection = state[1];
			var dirtyState = react.useState(false);
			var dirty = dirtyState[0];
			var setDirty = dirtyState[1];
			var statusState = react.useState("");
			var status = statusState[0];
			var setStatus = statusState[1];

			react.useEffect(function () {
				return scope.subscribe(function () {
					setSection(sectionOf(scope));
					setDirty(false);
				});
			}, [scope]);

			var enabled = section.enabled !== false;
			var threshold = section.thresholdRatio === void 0 ? 0.4 : section.thresholdRatio;
			var retain = section.retainRatio === void 0 ? 0.16 : section.retainRatio;
			var sources = Array.isArray(section.sourcePresets) ? section.sourcePresets : KNOWN_MODES;
			var managed = Array.isArray(section.managedPresets) ? section.managedPresets : [];
			var adopt = section.adoptDefault !== false;
			/** The default mode the host half reports having adopted, if any. */
			var defaultPreset = typeof section.defaultPreset === "string" ? section.defaultPreset : "";

			/** Merge one edit into local state and mark the card dirty. */
			function edit(patch) {
				setSection(function (previous) {
					var next = {};
					for (var key in previous) next[key] = previous[key];
					for (var patchKey in patch) next[patchKey] = patch[patchKey];
					return next;
				});
				setDirty(true);
				setStatus("");
			}

			/**
			 * Toggle one source mode.
			 * @param mode - the preset id.
			 */
			function toggleMode(mode) {
				var next = sources.indexOf(mode) >= 0 ? sources.filter(function (id) { return id !== mode; }) : sources.concat([mode]);
				edit({ sourcePresets: next });
			}

			/** Write the edited section through the scope, outlasting a lost revision fence. */
			function save() {
				// One ATOMIC mutate, not four sequential set() calls: the Host fences
				// every write against the revision it last served (settings `write()`
				// refuses when expectedRevision !== the registration's revision), so a
				// four-write sequence would race that fence three extra times, and a
				// half-applied save could cross an invalid threshold/retain pair.
				//
				// One write is still not immune: this plugin's HOST half writes its own
				// bookkeeping (managedPresets / skippedPresets / defaultPreset) into the
				// SAME section whenever the authored copies change — which is exactly
				// what a save causes. The click fences against the revision the mirror
				// held, the host half bumps it while re-authoring, and the write is
				// refused. That refusal reloads the mirror before the call settles, so a
				// retry is not guesswork: the next attempt fences against the revision
				// the Host just reported.
				var ops = [
					{ op: "set", path: ["enabled"], value: enabled },
					{ op: "set", path: ["thresholdRatio"], value: Number(threshold) },
					{ op: "set", path: ["retainRatio"], value: Number(retain) },
					{ op: "set", path: ["sourcePresets"], value: sources },
					{ op: "set", path: ["adoptDefault"], value: adopt }
				];
				var attempts = 0;
				var receipt = "";
				/** Let the Host re-apply the entry and the mirror re-read before judging again. */
				function pause() {
					return new Promise(function (resolve) {
						setTimeout(resolve, 250);
					});
				}
				/** Confirm one write from the snapshot, retrying while the Host refuses. */
				function attempt() {
					attempts += 1;
					return scope.mutate(ops)
						.then(function (accepted) {
							// The controller RESOLVES even when the Host refused the write
							// (it reloads the mirror instead of rejecting), so the promise
							// alone proves nothing: confirm against the snapshot. Newer
							// controllers also report the acknowledgement, which is the one
							// piece of evidence this layer cannot derive itself.
							receipt = typeof accepted === "boolean" ? (accepted ? "已接受" : "拒绝") : "未回报";
							var applied = sectionOf(scope);
							var landed = applied.thresholdRatio === Number(threshold) &&
								applied.retainRatio === Number(retain) &&
								applied.enabled === enabled &&
								applied.adoptDefault === adopt &&
								JSON.stringify(applied.sourcePresets) === JSON.stringify(sources);
							if (landed) {
								setDirty(false);
								setStatus("已保存 ✓ 新会话生效");
								return;
							}
							if (attempts < 4) return pause().then(attempt);
							setDirty(true);
							// Report what was OBSERVED, never a guessed cause: the framed
							// values, the mirrored values, the revision fenced against, and
							// whether the Host acknowledged the write at all.
							var snap = scope.getSnapshot();
							setStatus("保存未生效（已试 " + attempts + " 次，Host 回执：" + receipt
								+ "）。提交：阈值 " + Number(threshold) + " / 保留 " + Number(retain)
								+ "；Host 现值：阈值 " + applied.thresholdRatio + " / 保留 " + applied.retainRatio
								+ "（revision " + (snap && snap.revision) + "）"
								+ "。约束 0 < 保留 < 阈值 < 1");
						});
				}
				return attempt().catch(function (error) {
					setStatus("保存失败：" + String(error && error.message ? error.message : error));
				});
			}

			var saveDisabled = !dirty;
			return react_jsx_runtime.jsxs("div", {
				style: { border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-layer-3)", borderRadius: "12px", overflow: "hidden" },
				children: [
					react_jsx_runtime.jsxs("div", {
						style: { padding: "14px 16px 10px", display: "flex", flexDirection: "column", gap: "4px" },
						children: [
							react_jsx_runtime.jsx("div", { style: { fontSize: "15px", fontWeight: 600, lineHeight: "1.4" }, children: "压缩阈值（全模式）" }),
							react_jsx_runtime.jsx("div", {
								style: { fontSize: "13px", lineHeight: "1.5", color: "var(--dsw-alias-label-tertiary)" },
								children: "为每个勾选的模式生成一个 <模式>-compact-<阈值> 预设，把 compaction-basic.thresholdRatio 统一改成下面这个值（DSH 默认 0.8）。改动对新建会话生效，正在运行的会话保持原样；保存后默认模式也会切到生成的副本（见下方开关）。"
							})
						]
					}),
					react_jsx_runtime.jsx("div", { style: { borderTop: "1px solid var(--dsw-alias-border-l2)" } }),
					react_jsx_runtime.jsxs(Row, {
						title: "阈值 / Threshold ratio",
						hint: "上下文占模型窗口的比例，达到即触发自动压缩。必须大于 retainRatio、小于 1。",
						children: [
							react_jsx_runtime.jsxs("div", {
								style: { display: "flex", alignItems: "center", gap: "10px" },
								children: [
									react_jsx_runtime.jsx("input", {
										type: "number",
										step: "0.05",
										min: "0.05",
										max: "0.99",
										value: threshold,
										style: Object.assign({}, INPUT, { width: "120px" }),
										onChange: function (event) { edit({ thresholdRatio: event.target.value === "" ? "" : Number(event.target.value) }); }
									}),
									react_jsx_runtime.jsx("span", { style: { fontSize: "12px", color: "var(--dsw-alias-label-tertiary)" }, children: "0.4 = 用到窗口 40% 就压缩（更早、更省 token）" })
								]
							})
						]
					}),
					react_jsx_runtime.jsxs(Row, {
						title: "保留比例 / Retain ratio",
						hint: "压缩后保留的最近上下文占窗口比例（DSH 默认 0.16）。必须小于阈值。",
						children: [
							react_jsx_runtime.jsx("input", {
								type: "number",
								step: "0.02",
								min: "0.02",
								max: "0.9",
								value: retain,
								style: Object.assign({}, INPUT, { width: "120px" }),
								onChange: function (event) { edit({ retainRatio: event.target.value === "" ? "" : Number(event.target.value) }); }
							})
						]
					}),
					react_jsx_runtime.jsxs(Row, {
						title: "扩展哪些模式 / Source modes",
						hint: "勾选即生成对应副本；取消勾选会在保存后删除该副本。",
						children: [
							react_jsx_runtime.jsx("div", {
								style: { display: "flex", flexWrap: "wrap", gap: "8px" },
								children: KNOWN_MODES.map(function (mode) {
									var on = sources.indexOf(mode) >= 0;
									return react_jsx_runtime.jsx("button", {
										type: "button",
										onClick: function () { toggleMode(mode); },
										style: {
											border: "1px solid var(--dsw-alias-border-l2)",
											background: on ? "var(--dsw-alias-bg-module-platform)" : "transparent",
											color: "var(--dsw-alias-label-primary)",
											borderRadius: "8px",
											padding: "5px 12px",
											fontSize: "13px",
											cursor: "pointer",
											opacity: on ? "1" : "0.6"
										},
										children: (on ? "✓ " : "") + mode
									}, mode);
								})
							})
						]
					}),
					react_jsx_runtime.jsxs(Row, {
						title: "启用 / Enabled",
						hint: "关闭后保存会删除本插件生成的全部预设副本。",
						children: [
							react_jsx_runtime.jsx("input", {
								type: "checkbox",
								checked: enabled,
								onChange: function (event) { edit({ enabled: event.target.checked }); }
							})
						]
					}),
					react_jsx_runtime.jsxs(Row, {
						title: "保存后设为默认模式",
						hint: "保存后把默认模式切到生成的压缩模式，优先级：标准 > 创造 > 极简 > ptc，且只要存在压缩副本就优先于未设置阈值的模式。只影响新建会话，运行中的会话保持原样；关掉总开关或本项时会恢复接管前的默认。极简模式本身没有压缩栈、不会生成副本，因此实际不会中标。",
						children: [
							react_jsx_runtime.jsx("input", {
								type: "checkbox",
								checked: adopt,
								onChange: function (event) { edit({ adoptDefault: event.target.checked }); }
							})
						]
					}),
					react_jsx_runtime.jsxs("div", {
						style: { borderTop: "1px solid var(--dsw-alias-border-l2)", padding: "10px 16px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: "10px" },
						children: [
							react_jsx_runtime.jsxs("span", {
								style: { fontSize: "12px", color: "var(--dsw-alias-label-tertiary)", lineHeight: "1.5" },
								children: [
									status !== "" ? status : dirty ? "未保存的更改" : "",
									managed.length > 0 ? "　已生成：" + managed.join("、") : "",
									defaultPreset !== "" ? "　默认模式：" + defaultPreset : ""
								]
							}),
							react_jsx_runtime.jsx("button", {
								type: "button",
								disabled: saveDisabled,
								onClick: save,
								style: {
									border: "1px solid var(--dsw-alias-border-l2)",
									background: "var(--dsw-alias-bg-module-platform)",
									color: "var(--dsw-alias-label-primary)",
									borderRadius: "8px",
									padding: "5px 14px",
									fontSize: "13px",
									lineHeight: "1.5",
									cursor: saveDisabled ? "default" : "pointer",
									opacity: saveDisabled ? "0.5" : "1",
									flexShrink: 0
								},
								children: "保存"
							})
						]
					})
				]
			});
		}
		/**
		 * Client plugin body: register the settings card for whichever settings
		 * vocabulary this host speaks.
		 *
		 * The declaration below names only `slots`, because the card's settings
		 * service is generation-specific: 0.1.5-rc.x binds one scope per plugin
		 * namespace (`settingsScope`), while 0.1.7+ hands out one live form per
		 * profile entry (`configForms`). Declaring either name statically would
		 * leave this entry waiting forever for a service the other generation
		 * never provides — which is exactly how it hung pending on 0.1.7+ — so
		 * each is reached through its own optional `ctx.inject`.
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			// 0.1.7+: one form per profile entry, and the card is a settings page of
			// its own. `ConfigForm` carries the same read/write surface the card
			// already uses (`getSnapshot` / `subscribe` / `mutate`).
			ctx.inject(["configForms"], function (modernCtx) {
				var form = modernCtx.configForms.get(ENTRY_ID);
				modernCtx.slots.inject("settings.section", function () {
					return modernCtx.slots.register({
						name: "settings.section",
						id: ENTRY_ID,
						order: 0,
						label: function () {
							return "压缩阈值";
						},
						inject: function () {
							return { scope: form };
						}
					}, CompactThresholdCard);
				});
			});
			// 0.1.5-rc.x: one scope bound to the plugin's own settings namespace,
			// rendered under Settings → Plugins.
			ctx.inject(["settingsScope"], function (legacyCtx) {
				var scope = legacyCtx.settingsScope.bind({ namespace: NS });
				legacyCtx.slots.inject("settings.plugin.item", function () {
					return legacyCtx.slots.register({
						name: "settings.plugin.item",
						key: NS,
						inject: function () {
							return { scope: scope };
						}
					}, CompactThresholdCard);
				});
			});
		}
		exports.apply = apply;
		exports.inject = ["slots"];
		return module.exports;
	}
});
