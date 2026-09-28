# dsh-compact-value

**一个设置项，把压缩阈值铺到所有 Agent 模式。** · One setting that gives every DSH agent mode its own compaction threshold.

DSH 把压缩阈值（`compaction-basic.thresholdRatio`，上游默认 **0.8**）写在**每个 Agent 预设自己的 composition** 里。内置预设是部署自带的声明，用户改不动它们，于是"给所有模式都上 0.4"就变成了手工复制 4 份 composition。

本插件把这件事自动化，并收进一个设置栏目：

```
设置 → 压缩阈值
```

参考宿主：**DSH 0.2.0-rc.1**（同时保留 0.1.5-rc.x / 0.1.7+ 两代旧宿主的分支）。

## 它做什么

对每个勾选的源模式：

1. 从**装载器条目**读取源模式的组合。预设声明行就是 `{ id: 'preset-<name>', name: '@deepseek-ai/dsh-agent-preset', config: { id, order, plugins } }`，行插件把 `config` 原样交给 `agentPresets.register()`，所以它就是权威来源；
2. 只改动含 `compaction-basic` 的那一行的 `thresholdRatio`（该行在 `standard` / `ptc` / `cordis` 里嵌在 `compaction` group 内，插件按结构递归改写；**其余字段原样保留**，源组合永不被就地修改）；
3. 把改写后的组合 `agentPresets.register(definition)` 成**一个新预设**，id 为 `<源id>-compact-<阈值>`，并保留 `register()` 返回的注销函数。

阈值或勾选项改变时重新注册；取消勾选或关闭总开关时**通过注销函数回收**旧副本。命名遵循预设 ID 语法 `^[a-z0-9][a-z0-9-]*$`（不允许小数点），所以 `standard` + 0.4 → **`standard-compact-4`**。

然后把这个副本**设为默认模式**（`agent-preset-registry` 条目的 volatile `selectedDefault`）——否则副本生成了也没人用：

4. 多个副本同时存在时按 **标准 > 创造 > 极简 > ptc** 取优（即 `standard` > `cordis` > `minimal` > `ptc`；表外的自定义源排在四者之后，同档按 id 稳定排序）；
5. 由于只有生成的副本才带**显式** `thresholdRatio`，任何副本都优先于未设置阈值的模式——你手选的默认会被下一次保存覆盖，这正是"压缩模式优先"的含义（不要这样就在卡片里关掉「保存后设为默认模式」）；
6. 没有任何副本可用时（全被跳过、或全部取消勾选）不动默认模式；关闭总开关或本项时把默认模式**恢复成接管前的值**。

## 设置项

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关闭并保存会回收本插件生成的全部副本 |
| `thresholdRatio` | `0.4` | 上下文占用达到窗口的这个比例即触发自动压缩；必须 ∈ (0, 1) |
| `retainRatio` | `0.16` | 压缩后保留的最近上下文比例；必须小于 `thresholdRatio` |
| `sourcePresets` | `standard, minimal, ptc, cordis` | 要扩展哪些模式 |
| `adoptDefault` | `true` | 保存后把默认模式切到生成的压缩模式（见下节） |

**这五字段就是全部。** 早期版本还有 `managedPresets` / `skippedPresets` / `defaultPreset` / `previousDefault` 四个"插件写回"字段，0.4.0 起已删除——那些状态留在插件内存里，见下节。

`retainRatio` 与阈值一起校验：不满足 `0 < retainRatio < thresholdRatio` 时**拒绝对设置的写入**，不会留下半生成状态。

## 状态放在哪里

profile（`cordis.patch.yml`）里与本插件有关的写入**只有一处**：`agent-preset-registry` 的 `selectedDefault`，也就是"新会话默认用哪个副本"这一个指针。

其余全部留在插件自己的内存里（`lib/index.js` 的 `runtime`）：生成了哪些副本、哪些源被跳过及原因、接管前的默认模式是什么。理由很直接——副本是**内存里的声明**，只在本插件实例活着的时候存在；把"我生成了 standard-compact-4"写进 profile，重启后就是一条无法解析的陈述。

代价：进程重启会忘掉**接管前的默认模式**。指针本身仍可按形状认领（见下），但"释放时恢复成用户原来的选择"在重启后会退化成 `unset`（回落到部署默认）。

## 保存后接管默认模式

`agent-preset-registry` 的 `selectedDefault` 就是"新会话用哪个模式"（`defaultId` 每次创建会话现读）。本插件按上面的优先级把它指向自己的副本，读的是该条目的 `value`（当前默认）与 `user`（用户层是否覆盖过）两份数据——这个区别决定了释放时是**写回**一个值还是 **`unset`** 让部署默认重新透出：

| 情况 | 动作 |
|---|---|
| 有副本、当前默认不是它 | `update({ selectedDefault: 副本id })`；首次接管先把接管前的值记进 `runtime.previous` |
| 当前默认已是该副本 | 不写（幂等），必要时补记 |
| 无副本（全跳过/全取消）且当前默认是本插件设的 | `previous` 非空就写回，否则 `unset` |
| 无副本、且当前默认不是本插件设的 | 不动 —— 手选的模式不会被改写 |
| 指针指向的预设**不在 roster 里** | 撤销（`unset` 或写回 `previous`）——见下节 |
| 部署没注册该命名空间 | 只警告一次，副本照常生成，默认模式不动 |

改动只影响**新建会话**（`defaultId` 每次创建会话现读设置），运行中的会话仍停在它当初组装的那个 preset 上。

## 卸载 / 异常时撤销指针

副本随插件实例消失，而 `selectedDefault` 是持久化的：插件卸载后指针若还指着 `standard-compact-4`，新会话会去解析一个不存在的预设并**直接失败**。所以：

| 时机 | 行为 |
|---|---|
| 插件被禁用 / 卸载（fiber 销毁） | 撤销：写回接管前的值，没有记录则 `unset` |
| 授权副本时抛异常（`sync` 失败） | 同上——此时副本状态未知，指针更不能留 |
| 0.1.5-rc.x 宿主 | **不动**：那一代的副本是磁盘文件，插件卸载后依然可解析 |
| 指针指向的预设已不在 roster 里 | 撤销。这条**不看内存记录**，靠 id 形状（`<x>-compact-<数字>`）认领，因此进程重启后也能修 |

cordis 在销毁 fiber 时会 `await` effect 返回的异步 disposer（`Fiber._unload` 里 `await Promise.all(...runDisposable...)`），所以撤销写入发生在同一 fiber 的卸载过程中，并且先于任何新挂载实例的接管写入。若是重挂载，旧实例撤销、新实例随即重新接管。

## 两代宿主（0.1.5-rc.x / 0.1.7+ / 0.2.0-rc.1）

DSH 在这两代之间换了设置模型，本插件**两边都支持**，靠运行时探测而不是版本号：

| | 0.1.5-rc.x | 0.1.7+ / 0.2.0-rc.1 |
|---|---|---|
| 本插件设置的位置 | 插件自有命名空间 `dsh-compact-value` | profile 条目 id `dsh-compact-value`（即 `cordis.patch.yml` 里的 `id`） |
| 注册方式 | `settings.installSection()` 注册的栏目 | 条目自己的 `Config`，表单由宿主从 schema 生成 |
| 哪些字段能改 | 全部 | 只有 **volatile** 字段：宿主只为 volatile 字段生成表单、也只接受对它们的写入 |
| 卡片挂载点 | `settings.plugin.item` + `settingsScope` | `settings.section` + `configForms.get('dsh-compact-value')` |
| 默认模式写在哪 | `agent-presets` 命名空间的 `default` | `agent-preset-registry` 条目的 volatile `selectedDefault`（那里普通的 `default` 是**部署**默认，插件不该移动它） |
| 副本是什么 | 磁盘目录 `~/.dsh/.agent-presets/<id>/` | 内存声明；`register()` 返回注销函数，没有 `remove()` |
| 何时重算 | 写入后由 `installSection` 的 `setSource` 回调触发 | volatile 写入**不重挂载**，靠 `settings/document-updated` 事件触发；普通字段改动会重挂载并重跑 `apply` |

判定方式（都不看版本号）：

- 宿主侧：`typeof settings.installSection === "function"` —— 这是 0.1.7+ 已经删掉的 API。
- schema 侧：`live()` 给每个字段打 volatile 标记 —— 有 `volatile()` 就调它，没有就直接写 `meta.volatile = true`（那个方法本身只是 `extra('volatile', true)`）。
- 客户端侧：静态 `inject` 只声明 `slots`，`configForms` 与 `settingsScope` 各自走一次可选 `ctx.inject`。静态声明任一服务名都会让另一代**永远 pending**。

### 0.2.0-rc.1 上具体变了什么

- **`agentPresets.remove()` 已删除**。注册表只剩 `register()`（返回注销函数）、`list()`、`resolve()`、`readDocument()`、`select()`、`compositionInventory()`。回收只走注销函数；并且本插件把 **roster（`list()`）** 而不是自己的 map 当作"这个副本还在不在"的判据——旧挂载被 loader 销毁时注销函数会被调用，只看 map 会误判副本仍在、于是不再注册。
- **`modeSelectionEnabled` 已从注册表 schema 删除**。0.1.7-alpha 用它闸住接管是否生效，现在注册表无条件认 `selectedDefault`，插件不再读它、也不再警告。
- **schemastery 3.18.4 的 `volatile()` 会把 volatile 字段解析成 live reference**（`{ get(), [Symbol.for("cosmokit.volatile.write")] }`），不再是普通标量。所以 `Config(raw)` 的结果必须先经 `plainSection()` 展开再比较——否则 `thresholdRatio > 0` 恒为 false，校验会把一个完全正常的阈值判成非法。
- **`settings.section` 的 `id` 是必填**（新 id 加一页，复用内置 id 会顶掉那一页），并且 0.2.0-rc.1 提供 `configForms.whileServed([id], register)`：只在宿主真的服务本条目时才挂载卡片。
- **peer 范围**：DSH 的插件兼容性预检只比对 `peerDependencies` 里 `@deepseek-ai/dsh-*` 的 semver 范围，不满足就**直接拒绝安装**（`incompatible-version`）。旧版只声明到 `^0.1.7-alpha.1`，在 0.2.0-rc.1 上会被拒——现在范围里加了 `^0.2.0-rc.1`。

### 一些仍然成立的设计

**为什么写入要由"模块加载时创建的定时器"来驱动**：`settings/document-updated` 是在**那次保存自己的 HMR 事务内部**发出的，而 HMR 用 `AsyncLocalStorage` 记"事务开着"——在那个上下文里创建的任何异步资源（定时器、promise 续体）都会继承它，此时再写设置会被拒（`HMR transactions cannot be nested`），接管就会**静默丢失**。所以事件处理只置一个标志，真正的写入由**模块加载时**创建的定时器执行；接管写入本身还带 6 次重试跨越浏览器保存的重试窗口。

**为什么还要"重新挂载自己"一次**：loader 对"只动了 volatile 字段"的变更走快路径——把新值写进**运行中 config 的 live 引用**，不重挂载。而本插件解析到的是 profile 里那份 schemastery，它不一定生成 live 引用：`volatileEntries(fiber.config)` 为空 → loader 认为"没有要更新的东西" → 运行中的 config 永远停在旧值，而 `settings.describe()`（卡片读的就是它）正是读运行中的 config。因此本插件在收到自己条目的 `settings/document-updated` 后，从 loader 条目的组合配置取新配置并 `fiber.update(raw, true)` 重挂一次。比较按本 schema 的字段逐个进行，收敛一轮即停。

**模式列表什么时候刷新**：浏览器里的预设选择器只在挂载时（以及它自己写完预设后）拉一次名单。`ui-agent-preset` 订阅 `settings/document-updated` 里 `agent-preset-registry` 这一条（`dsh-api-remotes` 允许该事件转发给浏览器），而注册副本本身不是对该命名空间的写入，所以本插件在 roster 变化或接管发生后**主动补发这个事件**，新模式无需刷新页面即可出现。

## 它不做什么

- **不劫持内置预设**：内置模式的 ID 依然原样可用，插件生成的是**追加的新模式**。
- **不改运行中的会话**：预设 composition 在会话创建时读取、之后不再重读，所以阈值变更**对新建会话生效**，已在跑的会话保持原样。
- **不给没有压缩栈的模式硬造压缩**：内置 `minimal`（极简模式）composition 里根本没有 `compaction-basic` 行，插件会**跳过**并打日志，而不是凭空塞一套压缩栈进去。因此**极简模式不会生成副本，也就永远当不上默认模式**。
- **不保护你手选的默认模式**：只要存在任一压缩副本，保存后默认模式就会被改成它。不想被改就关掉 `adoptDefault`。
- **不接管别的部署默认**：接管的是 `selectedDefault`（用户层）；注册表里普通的 `default` 是**部署**默认，原样不动，`previous` 为空时释放即回落到它。
- **不往 profile 写状态**：除了那一个指针，插件不在 profile 里留任何东西。

## 安装

```bash
dsh plugin --profile web add github:ycm50/dsh-compact-value
```

装完**重启** `dsh web`（新增插件需要重启才生效），然后在 `设置` 里打开卡片。

> 仓库/包名统一为 `dsh-compact-value`：`package.json` 的 `name`、`cordis.patch.yml` 的 `id` 与 `name`、浏览器模块 id、以及两代设置命名空间键都是同一个名字。改条目 id 等于换 settings 命名空间，所以从 0.3.x（`compact-threshold`）升级时，旧行由插件管理器在安装时替换。

## 验证

`node --test`（**36 个用例**）覆盖纯函数、适配点，以及一次 **`apply` 级装配**（用 0.2.0 形状的 mock：roster 只有 `register`、settings 有 `describe/update/mutate`）：

- ratio 到 ID 的映射、行内已有 `thresholdRatio` 的替换、无 `config:` 块时的插入、缩进内层行的插入、前后边界不被改动、**对内置 `standard` composition 的真实改写**；
- 默认模式接管：优先级阶梯、表外源与同档 id 的稳定排序、空候选、首次接管记录还原点、后续保存保留**原始**还原点、幂等不重写、无副本时释放（`restore` 与 `unset` 两路）、**不动手选的默认模式**、**修复 roster 解析不了的悬空指针**；
- `ownedPointer` 的三种认领方式（源列表 / 接管记录 / id 形状）；
- `release`：撤销自己设的指针、写回接管前的选择、**不动别人的默认模式**、**不动 0.1.5-rc.x 的文件式副本**；
- **声明式 roster 的整条路径**：`register` 返回注销函数且没有 `remove` 时能生成副本、旧挂载被销毁后能**重新注册**、阈值变化时回收被取代的副本、源没有 `compaction-basic` 行时跳过；
- volatile 解析：`plainSection` 能展开 live reference、每个 `Config` 字段都带 volatile 标记、`Config` 只含这五个设置字段；
- **身份一致性**：包名 / patch 的 `id` 与 `name` / 浏览器模块 id / 两代命名空间键全部等于 `dsh-compact-value`；
- **`apply` 装配**：挂载后副本进入 roster、profile 里**只多出那一个指针**（写第二遍是幂等的）、卸载时指针被撤销、有记录时写回接管前的选择。

本仓库的测试需要一个可解析的 `@deepseek-ai/schemastery`；本地用 profile 里那份（3.18.4）即可：

```powershell
New-Item -ItemType Junction -Path node_modules\@deepseek-ai\schemastery -Target "$env:DSH_PROFILE_DIR\node_modules\@deepseek-ai\schemastery"
node --test tests\index.test.js
```

## 边界与前置条件

- 需要 `ctx.agentPresets`（宿主服务）；没有预设 roster 的部署无法使用。
- 需要一个 settings provider 才能写入那个指针；没有时插件照常注册副本，只是不动默认模式。
- 0.1.5-rc.x 的文件式路径还需要一个用户可写预设根；没有时插件会明确报错而不静默失败。
- 接管默认模式需要 `agent-preset-registry` 条目存在（由 `@deepseek-ai/dsh-agent-preset-registry` 注册）；没有它只影响默认模式，副本生成不受影响。

## 结构

```
lib/index.js   # 宿主端：设置读取 + 预设注册/回收 + 默认模式接管与撤销
lib/client.js  # 浏览器端：设置卡片
tests/         # node --test 单测
fixtures/      # 真实 composition 快照，供改写测试
```

## 许可证 / License

MIT
