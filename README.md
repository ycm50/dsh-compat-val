# dsh-compact-threshold

**一个设置项，把压缩阈值铺到所有 Agent 模式。** · One setting that gives every DSH agent mode its own compaction threshold.

DSH 把压缩阈值（`compaction-basic.thresholdRatio`，上游默认 **0.8**）写在**每个 Agent 预设自己的 composition** 里。内置预设位于只读的 system 根，而预设发现是"先到先得"（system 根在前），所以用户根**无法覆盖** `standard` 这类内置模式 —— 想改阈值只能另建一个预设。于是"给所有模式都上 0.4"就变成了手工复制 4 份 YAML。

本插件把这件事自动化，并收进一个设置栏目：

```
设置 → 插件 → 压缩阈值（全模式）
```

## 它做什么

对每个勾选的源模式：

1. 通过官方预设服务 `ctx.agentPresets.readDocument(id)` 读取 composition 原文；
2. 只改动 `compaction-basic` 那一行的 `thresholdRatio`（该行在 `standard` / `ptc` / `cordis` 里嵌在 `compaction` group 内，插件按实际缩进处理；**其余字节原样保留**）；
3. 写入用户可写根 `~/.dsh/.agent-presets/<源id>-compact-<阈值>/`，并生成 `preset.yml` 显示名。

阈值或勾选项改变时重写；取消勾选或关闭总开关时删除对应副本。命名遵循预设 ID 语法 `^[a-z0-9][a-z0-9-]*$`（不允许小数点），所以 `standard` + 0.4 → **`standard-compact-4`**。

## 设置项

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关闭并保存会删除本插件生成的全部副本 |
| `thresholdRatio` | `0.4` | 上下文占用达到窗口的这个比例即触发自动压缩；必须 ∈ (0, 1) |
| `retainRatio` | `0.16` | 压缩后保留的最近上下文比例；必须小于 `thresholdRatio` |
| `sourcePresets` | `standard, minimal, ptc, cordis` | 要扩展哪些模式 |
| `managedPresets` | 自动 | 由插件写回：当前生成的副本 ID 列表 |
| `skippedPresets` | 自动 | 由插件写回：跳过哪些源、以及原因 |

`retainRatio` 与阈值一起校验：不满足 `0 < retainRatio < thresholdRatio` 时**拒绝对设置的写入**，不会留下半生成状态。

## 它不做什么

- **不劫持内置预设**：内置模式的 ID 依然原样可用，插件生成的是**追加的新模式**。
- **不改运行中的会话**：预设 composition 在会话创建时读取、之后不再重读，所以阈值变更**对新建会话生效**，已在跑的会话保持原样 —— 这是 DSH 预设挂载的既有语义，也是官方建议的行为。
- **不给没有压缩栈的模式硬造压缩**：内置 `minimal`（极简模式）composition 里根本没有 `compaction-basic` 行（它只提供持久 shell 单工具 Agent），插件会**跳过**并把原因写进 `skippedPresets`，而不是凭空塞一套压缩栈进去。

## 安装

```bash
dsh plugin --profile web add github:ycm50/dsh-compact-threshold
```

装完**重启** `dsh web`（新增插件需要重启才生效），然后在 `设置 → 插件` 里打开卡片。

## 验证

`node --test`（7 个用例）覆盖纯函数：ratio 到 ID 的映射、行内已有 `thresholdRatio` 的替换、无 `config:` 块时的插入、缩进内层行的插入、前后边界不被改动、以及**对内置 `standard` composition 的真实改写**（只多两行、首尾字节不变）。

真机验证记录：在隔离 profile 中启动后，`~/.dsh/.agent-presets` 出现
`standard-compact-4` / `ptc-compact-4` / `cordis-compact-4`，其中 `standard-compact-4/agent.cordis.yml:149` 为 `thresholdRatio: 0.4`，`preset.yml` 显示名为「标准模式 · 压缩阈值 0.4」；`settings.yaml` 中 `managedPresets` 3 项、`skippedPresets` 记录了 `minimal` 的原因。

## 边界与前置条件

- 需要 `ctx.agentPresets`（DSH 0.1.5-rc.1 起为宿主服务）；没有预设roster的部署无法使用。
- 需要一个 settings provider（`@deepseek-ai/dsh-settings-file` 之类）才能持久化；没有时插件静默不生成任何东西，宿主照常启动。
- 需要用户可写预设根；没有时插件会明确报错而不静默失败。

## 结构

```
lib/index.js   # 宿主端：设置命名空间 + 预设生成/回收
lib/client.js  # 浏览器端：设置卡片
tests/         # node --test 单测
fixtures/      # 真实 composition 快照，供改写测试
```

## 许可证 / License

MIT
