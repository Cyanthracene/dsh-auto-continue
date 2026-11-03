# dsh-auto-continue

**输出撞到上限时，自动往会话里追发一条「继续」，让模型接着把话说完。**

DSH 的一轮回答撞上最大输出 token 时会在中途停住，等你敲一句「继续」。这个插件把这句话替你发了：
`turn/end` 的结束原因是 `max-tokens` 时，往当前会话排一条续写提示，模型自己接着写下去，
不用手点、不用重开一轮。

- 追发的那句话**不是气泡**，是会话里一条「自动续写」的上下文行——一眼能看出不是你说的，模型读到的仍是原文
- 撞一次上限续一次，**每轮最多 5 次**（可改），你一发消息额度就重新开始
- 命中的是 DSH 自己的判据：`turn/end { reason: { kind: 'max-tokens' } }`。和界面右下角那条
  「已达到输出 token 上限」提示同源，所以**任何 provider、任何模型**都一样生效
- 在设置 → 插件里能改，改完不用重启

## 装

三条路，选一条。装完**刷新一次页面**（改动 `cordis.patch.yml` 的插件，DSH 多数情况会热加载；
桌面版若没反应就重启一次 DSH）。

### 路 A：脚本（推荐，Windows）

```powershell
powershell -ExecutionPolicy Bypass -File tools\install-profile.ps1
```

它只做两件事，都不碰 `package.json`、不跑 pnpm：

1. 在 `<profile>\node_modules\dsh-auto-continue` 建一个目录链接指向本目录
2. 往 `<profile>\cordis.patch.yml` 追加三行 `- insert:` 行

装之前自动备份 `cordis.patch.yml` 到 `<DSH_HOME>\.dsh-rollback-dsh-auto-continue-<时间戳>\`，
写回时按 UTF-8 无 BOM 原样读写（PowerShell 5.1 的 `-Encoding utf8` 会写 BOM，无 BOM 读又会按
系统 ANSI 解码，那会把你 profile 里的中文写坏）。

默认装进 `desktop`（桌面版）。装别处加 `-ProfileName web`，DSH 不在默认位置加 `-DshHome <dir>`。

### 路 B：手工

```powershell
# 1. 链接（cmd 的 mklink，PowerShell 用 New-Item -ItemType Junction）
New-Item -ItemType Junction `
  -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-auto-continue" `
  -Target "<这个目录>"

# 2. 往 cordis.patch.yml 末尾追加（注意保持 UTF-8 无 BOM）
# - insert:
#     - id: auto-continue
#       name: dsh-auto-continue
```

`id: auto-continue` 是**承重的**：设置页保存的值会以同一个 id 追加一条只有 `config:` 的行，
两者靠这个 id 对齐，改名会让已保存的设置静默失效。

### 路 C：桌面版 profile 的特殊情况

桌面版的 profile 被应用独占，`dsh plugin --profile desktop ...` 会直接拒绝：

```
error: profile "desktop" is managed exclusively by the Electron application
```

所以桌面版走路 A 或路 B。`dsh web` 那个 profile 可以用官方命令：

```sh
dsh plugin --profile web add <这个目录>
```

## 设置

设置 → 插件 → 「自动续写」。四个都存到 profile 的 patch 层里，改完下一次续写就按新值走。

| 项 | 默认 | 说明 |
|---|---|---|
| 达到输出上限时自动续写 | 开 | 总开关。关掉后行为回到原生 |
| 自动追发的内容 | 见下 | 追发的那句话。留空会退回默认 |
| 每轮最多自动续写几次 | 5 | `0` = 不限制。按「你发消息」为一轮重新计数 |
| 追发前等待的毫秒数 | 0 | `0` = 同一拍里立刻排队。设大值可留出插话的余地 |

默认追发的内容：

> 继续。上一次输出因为达到长度上限被截断，请从断点处直接接着写，不要重复已经输出过的内容，不要重新开头或重列提纲。

后两句是刻意加的：裸的「继续」最常见的失败是模型另起一份文档，重开标题、重列提纲。

## 关掉 / 卸掉

| 想要 | 怎么做 |
|---|---|
| 暂时不要 | 设置里关掉「达到输出上限时自动续写」 |
| 整个摘掉 | `powershell -ExecutionPolicy Bypass -File tools\uninstall-profile.ps1` |
| 完全删掉 | 先摘掉，再删掉这个目录 |

卸载只摘掉安装时加的那两样东西。设置页写过的那条 `config:` 行**故意留着**——那里面是你的设置，
它自己挂不上任何东西，下次装回来还在。链接用 `rmdir` 摘，只删链接，不会跟着删插件目录。

## 它是怎么做到的

### 判据

模型适配器把 provider 的 `finish_reason: 'length'`（或 `'max_tokens'`）归一成闭集
`FinishReasonMap` 里的 `'max-tokens'`，agent loop 把它作为这一轮的结束原因留下来，在自己的
`finally` 里 append 一条 `turn/end`。所以一个 durable 事件覆盖所有 provider，不用解析流、
不用数字数。

### 为什么是 `followup()` 而不是 `steer()`

`turn/end` 是在这一轮**内部**、在 loop 决定要不要开下一轮之前 append 的。`followup()` 把消息
放进 `next-turn` 收件箱，loop 自己那句 `if (!this.inbox.hasPending) return false` 就会看到它，
当场开下一轮——续写不额外走一个来回，也没有空档。

`steer()` 在这里是错的：它面向**当前这一步**，而此刻这一步已经结束了。

### 为什么必须等 driver 停下来（曾经的「延迟一分钟」就是这个 bug）

`turn/end` 是在这一轮**内部** append 的，此时 driver 还在跑。而内核那句

```js
if (this.phase.kind !== "idle") {
  if (… phase.kind === "maintenance" …) this.phase.wakeRequested = true
  return                       // ← 不是 idle，唤醒直接被丢掉
}
```

说明：**不是在 idle 时发出的唤醒会被丢掉**，而且只有 maintenance 阶段才会被记成
`wakeRequested` 等着回放。原来的实现用 microtask 排队，正好落在这个窗口里：

1. `session.append()` 是**同步**派发 `session/event` 的，所以 handler 在 append 里就跑完了；
2. loop 紧接着在**同一段同步代码**里问 `if (!this.inbox.hasPending) return false`，
   此时续写还在 microtask 里没进队列，于是它回答「没活干」；
3. driver 开始收尾（`finally` 里才置 idle），microtask 这才跑、才唤醒——太晚了，被丢掉。

实测过的一条会话：续写在结束事件后 **13 ms** 就进了收件箱（`agent/inbox/spliced`），
可下一条 `turn/start` 在 **74 s** 之后才出现——而且和你自己那条消息**同一毫秒**。
那「一分钟」纯粹是你打字的耗时：续写一直躺在收件箱里，等一条无关的消息把它捎进去。

所以现在不抢这一拍：handler 只登记「这一轮欠一条续写」，由每 20 ms 一次的轻量轮询等到
`agent.status === 'idle'` 再调 `followup()`。**idle 时发出的唤醒一定会开出下一轮**——
这正是 `wakeDriver()` 自己的注释写明的契约（"a wake sent while idle always opens its turn
boundary, even when its message was cleared"）。`status` 和 `inbox.nextTurn` 都是公开的
`Agent` 契约，不需要碰内核内部，也绝不会去戳一个正在忙的 agent。

同一拍里「你抢在前面」仍然算你赢：handler 会记住「这条结束之后有人说过话」，
轮询开到之前如果发现这条，就把这次续写作废。

### 一次停靠窗口可以覆盖多条结束

续写轮自己也可能撞上限，于是**在 driver 再次停下来之前会有第二条结束**。所以待办是一个
**列表**而不是一个槽位——早期实现只留一个槽位，第二条结束会把第一条覆盖掉，
链子就在半路停住了（离线驱动模型里表现为「该发三条，实际只发了一条」）。

### 唤醒只在「确实发出去了」的时候才销账

一条待办的销账判据是 `sent` 标志，而且**只有真的发出去了才置位**。这里有两个都踩过的坑：

**坑一：消息必须是同一个对象。** 待办里存的那条消息，要原样交给 `followup()`；如果
`continueTurn` 自己再造一条，那么「这条消息还在收件箱里吗」这个判据（按**对象身份**比对）
永远会答「不在」。实测过：`isQueued()` 返回假，而收件箱里明明躺着那条消息。

**坑二：不能把「没成功」也当成「已发出」。** `continueTurn` 会把 `followup()` 自己的异常
吞掉（transcript 侧的失败绝不能把这一轮带下去），所以它必须**把结果告诉调用方**。
早先的写法在调用之后无条件 `wake.sent = true`，于是一次失败的发送看起来像成功，
唯一能让这一轮继续下去的那次重试就被丢掉了。

所以现在的顺序是：

1. 先问「这条消息已经在收件箱里了吗」——在，说明上一次是**插进去之后**才失败的，
   那就什么都不做（**绝不重发**，否则同一轮会多出一条续写）；
2. 不在，才调 `continueTurn`，并且**只有它报告成功**才置 `sent`；
3. 没置位的待办会被保留，下一次轮询重试。

这条路径在离线自检里有两条正反相对的检查：发送失败于插入**之前**的必须重试，
失败于插入**之后**的必须不重发。

### 收件箱读不出来时，答「不在」

`isQueued()` 在 `agent.inbox` 读不到（抛异常或某个列表不是数组）时返回**假**。

这个方向是刻意选的，因为两个方向的代价不对等：

- 答「不在」最坏只是多调一次 `followup()`。真实顺序是 `send()` **先** `inbox.splice`
  （重复 id 在这里抛错）**再** `wakeDriver()`，所以对一条已经在队列里的消息，重发只会得到
  一个被 `continueTurn` 捕获并记日志的抛错，不会插入第二份、也不会多出一条提示；
- 答「在」则会让插件以为已经发出去了，于是**在从未发送的情况下销账**，
  那条续写就真的丢了。

### 判据是 `id`，不是对象身份

`isQueued()` 和"一条结束只arm一条续写"的去重都按消息 `id` 比较，**不能**用 `===`。

内核在 `session.append` 里通过 `snapshotJsonValue` 把载荷拷成新对象，收件箱投影又是从那份
拷贝折叠回来的——实测在真实宿主里 `data.inserted[0] === message` 为 **false**。所以按对象身份
比较会永远答"不在"，把这道守卫变成死代码。

### `delayMs`

`delayMs` 现在是**下限**，不是另一条路径：两种配置最后都收敛到「driver 一停就排队」，
因为更早排队恰恰是内核会丢掉的那种。默认 `0` 表示「一停就发」。

注意 `agent.status === 'idle'` 的含义比"driver 已停"更宽：内核的 `status` 对
`maintenance` 阶段同样返回 `'idle'`（`get status()`：只有 `idle` 与 `maintenance` 算 idle）。
插件据此等待的其实是"不是 running"。

### 去重

`turn/end` 是 durable 的：`turn <= state.seen` 这条水位线拦下的是**同一会话内重复出现的轮次号**，
例如请求重试或折叠重放把同一条结束再送一遍。插件按会话记一个**单调的轮次水位线**，被它拦下的
结束一律不处理。水位线由**每一条** `turn/end` 推进，不只是撞上限的那些——一条正常的结束同样是
「会话已经往前走」的证据，必须让旧轮次上还没落地的续写作废。

（resume 本身不会重放事件：`session/event` 只由 `session.append` 发布，而恢复用的是构造种子。）

### 上限与提示

额度用尽时不再追发，并**每个人类轮次只警告一次**（不是每条撞上限的结束都警告一次），
否则一条没人接手的续写链会刷满日志。那一轮仍然有 DSH 自己的「已达到输出 token 上限」提示，
所以不存在「被静默吞掉」的情况——插件只是不再往上加。

### 关于那份 vendored schema

设置卡片靠 `@deepseek-ai/schemastery` 的 `Schema.prototype.volatile`（`3.18.4` 起）：
`dsh-settings` 只为「能投出非空 volatile 形式」的 Config 提供命名空间，投不出卡片就静默消失。

内核那份在 `app.asar` 里——那是**一个文件**，不是目录，链接不过去，而 profile 的
`node_modules` 是 hoisted，对一个没有依赖的插件不会链进 `@deepseek-ai/*`。所以
`node_modules/` 里带了内核自己那份 `schemastery`（`3.18.4`）和 `cosmokit`（`1.8.5`），
共约 67 KiB。

两份副本能互通，靠的是 `Symbol.for('cosmokit.volatile.write')` 走**全局符号注册表**，
不是 `instanceof`。这一点试过：在内核那份 schemastery 面前解析本插件的 Config，
四个字段全部落成 volatile 引用、默认值一致、`volatileForm()` 投影非空。

## 已知边界

- **子代理会话不会自动续写，且这一点没有开关可改**。实测结论：子代理在 `turn/end` 的同一瞬间
  就被 `agent/disposed` 掉，等延后的那一拍跑到时 `isCurrent()` 已经为假，续写会被丢掉。
  所以插件直接跳过子代理会话——不是保守，是唯一正确的做法；早期版本的
  `continueOnSubagent` 开关因此已删除（它只会给人一个「打开了却什么都没发生」的假象）
- **`delayMs > 0` 的作废判据是比较轮次号**。同一轮内、延时窗口里发生了别的事，看的是
  `status === 'idle'` 这一道。想绝对保险就用默认的 `0`
- **`gap-stats` 只看有 `turn/start` 跟在后面的上限**。会话在撞上限那一刻就结束了（或崩溃了），
  就没有下一轮可配对，那一行不会出现——所以它统计的是「续写有没有被驱动起来」，
  不是「上限发生了多少次」。后者用 `inspect-session.mjs` 看
- **续写要等 driver 停稳，所以不是「零延迟」而是「下一拍」**。正常情况下 driver 收尾和轮询
  落在同一毫秒左右（`WAKE_POLL_MS = 20`，idle 时第一次检查就发出），所以肉眼看不到空档；
  但如果 agent 一直不回到 idle（长时间 `runMaintenance`），续写最晚会在 10 s 后放弃等待、
  留在收件箱里等下一条消息捎走
- **改完 `lib/index.js` 要重启 DSH 才生效**。profile 的 `node_modules`/patch 层都是启动时
  解析的，改源码不会热加载；设置页改的是另一条路（volatile 引用），那个是热生效的
- **摘掉插件不会撤回已经排进当前轮的那条续写**。它已经在收件箱里了；要立刻停，在设置里关掉
  总开关或直接发消息（发消息会清掉额度并作废排着的续写）
- **上限按「轮」而不是按会话**。你一条消息之后最多续 `maxContinues` 次
- 只在**输出**上限触发。上下文长度上限（压缩）不在此列
- profile 的 patch 层**不热加载**：改 `cordis.patch.yml` 要重启应用才生效。改设置页是热生效的
  （走 volatile 引用），所以两条路的时效不一样

## 看真实会话有没有触发

会话日志是 `$DSH_HOME/sessions/<slug>/<sessionId>/session.v4.jsonl.zstd`。注意它不是一个普通
zstd 文件：开头一帧是头记录，之后**每条记录一帧**。`zstdDecompressSync(整个文件)` 只会解出第一帧
（实测 1.3 MiB 的日志只返回 251 字节），必须按帧魔数 `28 B5 2F FD` 切开逐帧解。

三个读日志的小工具（只读，不改任何东西）：

```sh
node verify/inspect-session.mjs <会话目录或文件>   # 单个会话：轮数、结束原因、上限次数、续写条数
node verify/scan-sessions.mjs "$DSH_HOME"           # 所有会话的汇总表
node verify/gap-stats.mjs "$DSH_HOME"               # 所有会话：上限→续写的间隔（见下）
node verify/dump-events.mjs <日志> [从seq] [到seq]  # 单个会话的事件时间线
```

`auto-continue` 那一列就是本插件真正发过的续写条数。

### 用 `gap-stats` 判断续写健不健康

它只打印两类行：**撞上限的结束**（插件的触发点）和**拿到续写的结束**。普通轮次有成千上万条，
会把要看的几行淹掉，所以不打印。

```
endReason    turn   arm(end->splice)  queueWait(splice->start)  gap(end->start)  startPos  session
max-tokens      7               13                   74354           74367         0  session-c5d4
max-tokens      8               17                       4              21         1  session-c5d4
max-tokens      7               14                       1              15         0  session-dfd0
max-tokens      8               13                       1              14         0  session-dfd0
```

- **`arm(end->splice)`**：结束事件 → 续写进收件箱。这是插件自己的反应速度；
- **`queueWait(splice->start)`**：续写进箱 → 下一轮真的开始。**这是出过问题的那一列**；
- **`startPos`**：`0` = 插在队首；`1` = 排在一条已有的用户消息后面，也就是「你抢在前面」时插件让路。

判读方式：

| `queueWait` | 含义 |
|---|---|
| 个位数毫秒 | 正常：driver 一停，插件自己开出了下一轮 |
| 几万毫秒 | **就是这个 bug 的形态**：续写一直躺着，等一条无关的消息把它捎进去 |
| `-` | 插件没发续写（子代理 / 关掉了 / 额度用尽 / 你抢在前面） |

第一行 `74354 ms` 是修复前的真实记录，第 3、4 行是修复后同一台机器的实测（都是 **1 ms**）。
末尾还会汇总「`queueWait > 5000 ms`」的条数——不是 0 就说明还有东西在让续写等人。

## 自检

```sh
node verify/verify-host.mjs
```

115 项检查，不联网、不碰真机：用真实模块跑一个模拟 agent loop，覆盖默认值、额度、上限、
子代理、同拍竞态、`turn/end` 重放、定时器路径、发送失败的销账、以及 handler 抛错不外泄。

那套模拟**刻意复刻了内核会丢掉唤醒这件事**：`followup()` 只在 agent 处于 idle 时才启动
driver，`turn/end` 派发时 phase 仍是 running。所以把 `scheduleContinuation()` 换回原来的
microtask 写法，自检会当场红三条（「a wake sent from inside the ending is dropped, not
deferred」等）——这套检查确实抓得住这个 bug，而不是陪跑。

三套自检（`npm test` 会一起跑）：

```sh
npm test                 # 115 项主机检查 + 7 条定时器锁 + 13 项消息形状锁
node verify/probe-defects.mjs        # 唤醒循环的回归锁（删错句柄、异常逃逸、预算用尽后停轮询）
node verify/probe-message-shape.mjs  # 续写消息的形状，用内核真校验器判
```

### 这套自检**抓不住**什么（务必知情）

它验证的是**工厂函数的输出**，不是整条投递链。实测确认过：把
`scheduleContinuation()` 里的 `wake.message` 换成一个等价但缺 `id`/`role` 的对象——
即缺陷写在投递链上而不是 `continuationMessage()` 里——三套自检**全绿**，而同一对象经
`Session.append` + `validateStoredEvents` 会被内核真实拒绝。也就是说：

- **自检绿 ≠ 日志一定能加载**。日志能不能加载，只有 `probe-repaired-logs.mjs`
  与内核真校验器能回答；
- 因此在改动 `scheduleContinuation` / `continueTurn` / `isQueued` 这些投递路径之后，
  除了 `npm test`，还应该跑一次端到端核对：

```sh
node verify/probe-message-shape.mjs   # 工厂输出（含反控制）
npm test                              # 投递路径的行为
# 然后对一个真实会话跑一次，确认新写入的续写行能被加载：
node verify/probe-repaired-logs.mjs "$DSH_HOME/sessions"
```

`probe-message-shape.mjs` 会用内核自己的 `adoptSessionEvent()` 判插件产出的那条消息，
并用修复前的旧形状做**反控制**（必须仍被拒）。`DEEPSEEK_DSH_RUNTIME_PATH` 可指向含
`node_modules/@deepseek-ai` 的目录；内核确实找不到时会**明确打印 SKIP 并说明校验未运行**
（不再静默报绿），而"找到了内核却没有校验器"会直接判失败。

## 消息形状：`id` 和 `role` 不是可选项

这是本插件唯一一个**写坏历史**的缺陷，值得单独记住。

`user/message` 是消息事件，内核在**加载**会话时对每条事件跑 `adoptSessionEvent()`
（`dsh-session-persistence` 的 `validateStoredEvents`），要求：非空 `id`、`role === 'user'`、
非空 `source.kind`、数组 `content`。内核自己注入的行走 `createUserMessage()` 工厂，`id`/`role`
是工厂盖的；插件手搓对象，必须自己盖。

漏掉的后果不是"某轮不续写"，而是**整个会话再也打不开**：

```
stored session "session-…" is corrupt: … failed validation:
Error: session event at seq 68 lacks an identified message
```

而且**写的时候毫无提示**——校验只在重新加载时跑，内存里的会话是好着的。2026-11-03 实测：
三个真实会话（2 + 2 + 12 条续写）全部因此不可 resume。

已写坏的日志可以离线修复（补 `id` + `role:"user"`，逐帧重压，先备份）。

修复工具在 `tools/`（**会被打包发布**，所以从 npm 装到的副本里也有）：

```sh
# 先看要改什么
node tools/repair-sessions.mjs --dry-run "$DSH_HOME/sessions"
# 真改（每份日志先备份到 <工作区>/_dsh-auto-continue-backups/，带时间戳，不覆盖旧备份）
node tools/repair-sessions.mjs "$DSH_HOME/sessions/<项目>/<会话目录>"
```

验收工具在 `verify/`（属于开发检出，不随包发布；`npm test` 也会用到它）：

```sh
node verify/probe-repaired-logs.mjs "$DSH_HOME/sessions"
```

`probe-repaired-logs.mjs` 会把每份日志按加载器的顺序重放一遍：逐帧解压、跳过首帧头记录、
对每条事件调 `adoptSessionEvent()`，最后再交 `validateStoredEvents()` 过一遍产品路径。
它接受的文件就是 DSH 能 resume 的文件。找不到内核运行时会**明确失败**（而不是打印 SKIP 后报绿）；
空目录、非日志文件、有解压失败帧的日志也都不算通过。

## 许可

MIT，见 [LICENSE](LICENSE)。`node_modules/` 里两份 vendored 包不属于本作品，各自保留原许可。
