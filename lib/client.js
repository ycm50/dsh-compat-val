/**
 * dsh-compact-threshold browser half: one settings card under
 * Settings -> Plugins, keyed by the same namespace the host registers.
 *
 * It edits the compaction threshold, the retention floor, and which preset
 * modes get a generated `<mode>-compact-<ratio>` copy. Saving writes the
 * settings namespace; the host half authors the presets from what it reads.
 */
window.__ModuleLoader__.load({
	id: "dsh-compact-threshold",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		var react = require("react");
		var react_jsx_runtime = require("react/jsx-runtime");
		/** Settings namespace this card edits (must match the host half). */
		var NS = "dsh-compact-threshold";
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

			/** Write the edited section through the scope. */
			function save() {
				// One ATOMIC mutate, not four sequential set() calls.
				//
				// The Host fences every write against the revision it last served
				// (dsh-settings `write()` throws SettingsConflictError when
				// expectedRevision !== registration.revision), while this plugin's
				// HOST half bumps that revision whenever managedPresets changes.
				// A four-write sequence therefore races the fence and the writes
				// that lose are dropped. A single mutation is fenced once and is
				// validated as a whole, so threshold/retain never cross an
				// intermediate invalid state.
				var ops = [
					{ op: "set", path: ["enabled"], value: enabled },
					{ op: "set", path: ["thresholdRatio"], value: Number(threshold) },
					{ op: "set", path: ["retainRatio"], value: Number(retain) },
					{ op: "set", path: ["sourcePresets"], value: sources },
					{ op: "set", path: ["adoptDefault"], value: adopt }
				];
				return scope.mutate(ops)
					.then(function () {
						// SettingsScopeController.mutate() RESOLVES even when the Host
						// refused the write (it reloads the mirror instead of
						// rejecting), so the promise alone proves nothing. Confirm
						// against the snapshot before claiming success.
						var applied = sectionOf(scope);
						var ok = applied.thresholdRatio === Number(threshold) &&
							applied.retainRatio === Number(retain) &&
							applied.enabled === enabled &&
							applied.adoptDefault === adopt &&
							JSON.stringify(applied.sourcePresets) === JSON.stringify(sources);
						setDirty(!ok);
						// Report what was OBSERVED, never a guessed cause: `ok === false`
						// only proves the write did not land. The Host refuses for two
						// different reasons (settings/rejected = schema validation,
						// settings/conflict = stale revision fence) and this layer cannot
						// tell them apart, so print both sides and let the numbers speak.
						var snap = scope.getSnapshot();
						setStatus(ok
							? "已保存 ✓ 新会话生效"
							: "保存未生效。提交：阈值 " + Number(threshold) + " / 保留 " + Number(retain)
								+ "；Host 现值：阈值 " + applied.thresholdRatio + " / 保留 " + applied.retainRatio
								+ "（revision " + (snap && snap.revision) + "）"
								+ "。约束 0 < 保留 < 阈值 < 1");
					})
					.catch(function (error) {
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
		 * Client plugin body: register the settings card for this namespace.
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			var scope = ctx.settingsScope.bind({ namespace: NS });
			ctx.slots.inject("settings.plugin.item", function () {
				return ctx.slots.register({
					name: "settings.plugin.item",
					key: NS,
					inject: function () {
						return { scope };
					}
				}, CompactThresholdCard);
			});
		}
		exports.apply = apply;
		exports.inject = ["settingsScope", "slots"];
		return module.exports;
	}
});
