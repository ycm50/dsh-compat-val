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

然后把这个副本**设为默认模式**（`agent-presets` 设置命名空间的 `default`）——否则副本生成了也没人用：

4. 多个副本同时存在时按 **标准 > 创造 > 极简 > ptc** 取优（即 `standard` > `cordis` > `minimal` > `ptc`；表外的自定义源排在四者之后，同档按 id 稳定排序）；
5. 由于只有生成的副本才带**显式** `thresholdRatio`，任何副本都优先于未设置阈值的模式——你手选的默认会被下一次保存覆盖，这正是"压缩模式优先"的含义（不要这样就在卡片里关掉「保存后设为默认模式」）；
6. 没有任何副本可用时（全被跳过、或全部取消勾选）不动默认模式；关闭总开关或本项时把默认模式**恢复成接管前的值**。

## 设置项

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关闭并保存会删除本插件生成的全部副本 |
| `thresholdRatio` | `0.4` | 上下文占用达到窗口的这个比例即触发自动压缩；必须 ∈ (0, 1) |
| `retainRatio` | `0.16` | 压缩后保留的最近上下文比例；必须小于 `thresholdRatio` |
| `sourcePresets` | `standard, minimal, ptc, cordis` | 要扩展哪些模式 |
| `adoptDefault` | `true` | 保存后把默认模式切到生成的压缩模式（见下节） |
| `managedPresets` | 自动 | 由插件写回：当前生成的副本 ID 列表 |
| `skippedPresets` | 自动 | 由插件写回：跳过哪些源、以及原因 |
| `defaultPreset` | 自动 | 由插件写回：本插件当前设成的默认模式（空 = 未接管） |
| `previousDefault` | 自动 | 由插件写回：接管前的默认模式；空表示接管前是**继承部署默认**，释放时走 `unset` 而不是写死一个值 |

`retainRatio` 与阈值一起校验：不满足 `0 < retainRatio < thresholdRatio` 时**拒绝对设置的写入**，不会留下半生成状态。

## 保存后接管默认模式

`agent-presets` 设置命名空间的 `default` 就是"新会话用哪个模式"。本插件按上面的优先级把它指向自己的副本，读的是该命名空间的 `value`（当前默认）与 `user`（用户层是否覆盖过）两份数据——这个区别决定了释放时是**写回**一个值还是 **`unset`** 让部署默认重新透出：

| 情况 | 动作 |
|---|---|
| 有副本、当前默认不是它 | `update({ default: 副本id })`；首次接管先把接管前的值记进 `previousDefault` |
| 当前默认已是该副本 | 不写（幂等），必要时补记 `defaultPreset` |
| 无副本（全跳过/全取消）且当前默认是本插件设的 | `previousDefault` 非空就写回，否则 `unset` |
| 无副本、且当前默认不是本插件设的 | 不动 —— 手选的模式不会被改写 |
| 部署没注册 `agent-presets` 命名空间 | 只警告一次，副本照常生成，默认模式不动 |

两个写次序是刻意的：**先记 `previousDefault`，再改默认**——中间崩溃最多丢掉一次接管，绝不会留下"改了默认却不知道原来是什么"的状态。

改动只影响**新建会话**（`defaultId` 每次创建会话现读设置），运行中的会话仍停在它当初组装的那个 preset 上。

## 两代宿主（0.1.5-rc.x / 0.1.7+）

DSH 在这两代之间换了设置模型，本插件**两边都支持**，且靠运行时探测而不是版本号：

| | 0.1.5-rc.x | 0.1.7+ |
|---|---|---|
| 本插件设置的位置 | 插件自有命名空间 `dsh-compact-threshold` | profile 条目 id `compact-threshold`（即 `cordis.patch.yml` 里的 `id`） |
| 注册方式 | `settings.installSection()` 注册的栏目 | 条目自己的 `Config`，表单由宿主从 schema 生成 |
| 哪些字段能改 | 全部 | 只有 **volatile** 字段：宿主只为 volatile 字段生成表单、也只接受对它们的写入 |
| 卡片挂载点 | `settings.plugin.item` + `settingsScope` | `settings.section` + `configForms.get('compact-threshold')` |
| 默认模式写在哪 | `agent-presets` 命名空间的 `default` | `agent-preset-registry` 条目的 volatile `selectedDefault`（那里普通的 `default` 是**部署**默认，插件不该移动它） |
| 何时重算 | 写入后由 `installSection` 的 `setSource` 回调触发 | volatile 写入**不重挂载**，靠 `settings/document-updated` 事件触发；普通字段改动会重挂载并重跑 `apply` |

判定方式（都不看版本号）：

- 宿主侧：`typeof settings.installSection === "function"` —— 这是 0.1.7+ 已经删掉的 API。
- schema 侧：`live()` 给每个字段打 volatile 标记 —— 有 `volatile()` 就调它，没有就直接写 `meta.volatile = true`（那个方法本身只是 `extra('volatile', true)`）。**只探测方法是不够的**：宿主跑的是 schemastery 3.18.3，但**安装后的插件 import 的是 profile 里那份 3.18.2**（Node 就近解析），那份没有 `volatile()`；只探测就会让所有字段保持普通字段 → 0.1.7+ 的 `describe()` 直接跳过本条目、写入被拒（表现为卡片上「Host 现值 undefined」、保存不生效）。3.18.2 的 `meta` 与 `toJSON()` 都能正常携带这个键，所以直接写标记在两代都成立（旧世代的 settings 服务完全不读 volatile）。
- 客户端侧：静态 `inject` 只声明 `slots`（两代都有），`configForms` 与 `settingsScope` 各自走一次可选 `ctx.inject`。静态声明任一服务名都会让另一代**永远 pending** —— 这正是旧版在 0.1.7+ 上挂在启动面板上的原因。

0.1.7+ 上还会做两件事：用 `settings.configure({ auto: false })` 关掉宿主自动生成的重复页面（只留本插件自己的卡片）；若检测到「模式选择」开关被关掉，只警告一次说明 `selectedDefault` 当前不生效（不去替用户打开它）。

**保存的 revision 护栏**：两代 `settings` 都以 revision 做闸（写入带的 `expectedRevision` 与注册时的 revision 不一致就整笔拒绝）。本插件的**宿主面会把 `managedPresets` / `skippedPresets` / `defaultPreset` 写回同一节**，而一次保存恰好会让它重写一遍副本——于是点击瞬间读到的 revision 可能已经过期，写入被拒。被拒的写入在返回前会**先重载镜像**，所以卡片 `save()` 最多重试 4 次（每次之间等 250ms 让镜像刷新），每次都重新取 revision 围栏；4 次都没落地时不再猜原因，而是把「提交值 / Host 现值 / revision / Host 回执」原样打在卡片上。

**为什么还要"重新挂载自己"一次**：0.1.7+ 的 loader 对"只动了 volatile 字段"的变更走快路径——把新值写进**运行中 config 的 live 引用**，不重挂载（`vendor/loader/src/config/entry.ts` 的 `_commitVolatile`）。而本插件解析到的是 **profile 里那份 schemastery 3.18.2**，它不会生成任何 live 引用：`volatileEntries(fiber.config)` 为空 → loader 认为"没有要更新的东西"（`if (!refs.length) return true`）→ 运行中的 config 永远停在旧值，而 `settings.describe()`（卡片读的就是它）正是读运行中的 config——所以刚保存的值会被报成"未生效"，只有重启/重挂载才生效。因此本插件在收到自己条目的 `settings/document-updated` 后，从 **loader 条目的组合配置**（`entry.options.config`，那份已经是新值）取新配置并 `fiber.update(raw, true)` 自己重挂一次，让运行值与组合一致。比较是按本 schema 的字段逐个比对，收敛一轮即停，不会和自己的回写互相触发。

**两代宿主的"副本"是两种东西**：0.1.5-rc.x 的预设是**磁盘上的目录**（`~/.dsh/.agent-presets/<id>/`，roster 通过 `resolvedRoots` / `readDocument` / `read` / `remove` 读写），所以本插件写文件；0.1.7+ 的预设是**内存里的声明**——`@deepseek-ai/dsh-agent-preset-registry` 只维护一张 `definitions` 表，唯一的作者接口是 `agentPresets.register(definition)`，而 `list()` / `resolve()` 只回答元数据、`compositionInventory()` 只回答挂载诊断，**都拿不到组合**。因此现代路径从**装载器条目**取源组合（预设声明行就是 `{ id: 'preset-<name>', name: '@deepseek-ai/dsh-agent-preset', config: { id, order, plugins } }`，行插件原样 `register(config)`），把含 `compaction-basic` 的行结构化改写后 `register()` 成 `<mode>-compact-<tag>`，并保留返回的注销函数以便阈值变化时回收旧副本。找不到声明行的模式（`minimal`）按同一理由跳过。

**为什么写入要由"模块加载时创建的定时器"来驱动**：0.1.7+ 的 `settings/document-updated` 是在**那次保存自己的 HMR 事务内部**发出的，而 HMR 用 `AsyncLocalStorage` 记"事务开着"——在那个上下文里创建的任何异步资源（定时器、promise 续体）都会继承它，此时再写设置会被拒（`HMR transactions cannot be nested`），本插件的记账与默认接管就会**静默丢失**（表现：副本已生成、卡片却显示旧值，默认模式还指向已被回收的副本）。所以事件处理只置一个标志，真正的写入由**模块加载时**创建的定时器执行——它带着模块原本的上下文，永远不会落在别人的事务里；写记账与接管之后再用 `fiber.update` 重挂自己，让 `describe()` 服务的运行值跟上。

**模式列表什么时候刷新**：浏览器里的预设选择器只在挂载时（以及它自己写完预设后）拉一次名单，宿主直接写目录它并不知道。0.1.7+ 的 `ui-agent-preset` 会订阅 `settings/document-updated` 里 `agent-preset-registry` 这一条（`api/remotes/src/remote-events.ts` 允许该事件转发给浏览器），而写副本本身不是对该命名空间的写入，所以本插件在改动过副本后**主动补发这个事件**，新模式无需刷新页面即可出现；0.1.5-rc.x 的客户端没有这个订阅，那一代保存后需要**刷新页面（F5）**才能看到新模式（目录会被 `list()` 每次重新扫描，副本本身是合规的：id 合法、`agent.cordis.yml` + `preset.yml` 齐全）。

## 它不做什么

- **不劫持内置预设**：内置模式的 ID 依然原样可用，插件生成的是**追加的新模式**。
- **不改运行中的会话**：预设 composition 在会话创建时读取、之后不再重读，所以阈值变更**对新建会话生效**，已在跑的会话保持原样 —— 这是 DSH 预设挂载的既有语义，也是官方建议的行为。
- **不给没有压缩栈的模式硬造压缩**：内置 `minimal`（极简模式）composition 里根本没有 `compaction-basic` 行（它只提供持久 shell 单工具 Agent），插件会**跳过**并把原因写进 `skippedPresets`，而不是凭空塞一套压缩栈进去。因此**极简模式不会生成副本，也就永远当不上默认模式**——优先级表里它那个位置是给"以后真有了压缩栈的极简"预留的。
- **不保护你手选的默认模式**：只要存在任一压缩副本，保存后默认模式就会被改成它（这是"压缩副本一律优先"的直接后果）。不想被改就关掉 `adoptDefault`。
- **不接管别的部署默认**：接管的是 `agent-presets` 设置命名空间的 `default`，改的是**用户层**；部署 composition 里的 `config.default` 原样不动，`previousDefault` 为空时释放即回落到它。

## 安装

```bash
dsh plugin --profile web add github:ycm50/dsh-compact-threshold
```

装完**重启** `dsh web`（新增插件需要重启才生效），然后在 `设置 → 插件` 里打开卡片。

## 验证

`node --test`（21 个用例）覆盖纯函数：ratio 到 ID 的映射、行内已有 `thresholdRatio` 的替换、无 `config:` 块时的插入、缩进内层行的插入、前后边界不被改动、**对内置 `standard` composition 的真实改写**（只多两行、首尾字节不变）、默认模式接管：优先级阶梯（标准 > 创造 > 极简 > ptc）、表外源与同档 id 的稳定排序、空候选、首次接管记录还原点、后续保存保留**原始**还原点、幂等不重写、无副本时释放（`restore` 与 `unset` 两路）、**不动手选的默认模式**，以及两代设置键映射（`presetTarget`）、`Config` 默认值、**每个 `Config` 字段都带 volatile 标记**（0.1.7+ 表单可见性与写入许可全看这个标记）。

真机验证记录：在隔离 profile 中启动后，`~/.dsh/.agent-presets` 出现
`standard-compact-4` / `ptc-compact-4` / `cordis-compact-4`，其中 `standard-compact-4/agent.cordis.yml:149` 为 `thresholdRatio: 0.4`，`preset.yml` 显示名为「标准模式 · 压缩阈值 0.4」；`settings.yaml` 中 `managedPresets` 3 项、`skippedPresets` 记录了 `minimal` 的原因。

接管默认模式的真机验证：保存后 `settings.yaml` 出现 `agent-presets: { default: standard-compact-4 }`，本插件命名空间写回 `defaultPreset: standard-compact-4`；新建会话即挂载该 preset；关掉「保存后设为默认模式」再保存，`agent-presets.default` 被 `unset`（键消失）并重新继承部署默认。

## 边界与前置条件

- 需要 `ctx.agentPresets`（DSH 0.1.5-rc.1 起为宿主服务）；没有预设roster的部署无法使用。
- 需要一个 settings provider（`@deepseek-ai/dsh-settings-file` 之类）才能持久化；没有时插件静默不生成任何东西，宿主照常启动。
- 需要用户可写预设根；没有时插件会明确报错而不静默失败。
- 接管默认模式需要预设的设置键存在：0.1.5-rc.x 是 `agent-presets` 命名空间（由 `@deepseek-ai/dsh-agent-presets` 注册），0.1.7+ 是 `agent-preset-registry` 条目（由 `@deepseek-ai/dsh-agent-preset-registry` 注册）；没有它只影响默认模式，副本生成不受影响。

## 结构

```
lib/index.js   # 宿主端：设置命名空间 + 预设生成/回收 + 默认模式接管
lib/client.js  # 浏览器端：设置卡片
tests/         # node --test 单测
fixtures/      # 真实 composition 快照，供改写测试
```

## 许可证 / License

MIT
