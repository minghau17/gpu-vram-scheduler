# GPU 调度管理器 2.0 — 后端桥（gpu-bridge）

纯 Node（CommonJS，不 `require('electron')`），实现 `docs/SPEC.md`「后端契约」的全部方法。
所有测量都来自本机真实计数器，不是估算。

```
electron\bridge\
  index.js        ← 唯一入口（单例）：init / startPolling / collectOnce / tick / 全部契约方法
  counters.js     ← 常驻 PowerShell 采集器（PDH + DXGI），单行 JSON/次，含 spawn 兜底
  adapters.js     ← LUID → 适配器（名称/厂商/kind/总量/用量），nvidia-smi 校准
  apps.js         ← 逐进程按 exe 聚合、中文分类、推荐策略（规则表在文件顶部）
  prefs.js        ← HKCU\Software\Microsoft\DirectX\UserGpuPreferences 读写（保留其它 token）
  savings.js      ← 释放量化状态机 + 证据字段 + state.json 持久化
  history.js      ← 内存环形缓冲（仪表盘曲线）
  catalog.js      ← listInstalledApps（卸载注册表 + 开始菜单快捷方式）
  icons.js        ← exe 图标批量抽取/缓存（data\icons\<sha1>.png，96×96 带 alpha）
  ps.js / store.js← PowerShell 调用与原子 JSON 持久化的内部工具
  ps\*.ps1        ← 运行时脚本模板（初始化时复制到 <dataDir>\ps\ 并加 UTF-8 BOM）
  test.js         ← `node test.js` 一次性自检（58 项断言表格）
  README.md
```

运行自检（本机 Node 路径，项目 package.json 未加 script，避免动 Lead 的文件）：

```bat
E:\GPU修改器\nodejs\node.exe E:\GPU修改器\gpu-scheduler\electron\bridge\test.js
```

---

## 1. LUID → 适配器映射（实测结论，不是猜的）

方法：PowerShell 里编译一小段 C#，用 **DXGI**（`CreateDXGIFactory1` → `IDXGIFactory1::EnumAdapters1`
→ `IDXGIAdapter1::GetDesc1`）拿到每个适配器的 `LUID / Description / VendorId / DedicatedVideoMemory /
SharedSystemMemory / Flags`；再与 PDH 计数器 `\GPU Adapter Memory(*)` 的 luid 实例名、
`nvidia-smi` 的 total/used 交叉验证。另用 `QueryDisplayConfig` + `GET_ADAPTER_NAME` 打印适配器
设备路径（`\\?\PCI#VEN_10DE&DEV_2520&...`）作为独立佐证。

本机实测结果：

| LUID（计数器原文） | 适配器 | 厂商 | kind | DedicatedVideo | SharedSystem budget | 说明 |
|---|---|---|---|---|---|---|
| `0x00000000_0x0001548b` | NVIDIA GeForce RTX 3060 Laptop GPU | nvidia (0x10DE, DEV_2520) | **dgpu 独显** | 5 994 MiB（DXGI）/ **6 144 MiB**（nvidia-smi） | 8 011 MiB | 与 `nvidia-smi memory.used` 误差 3~10MB |
| `0x00000000_0x0001504f` | Intel(R) UHD Graphics | intel (0x8086, DEV_9A60) | **igpu 核显** | 128 MiB | 8 011 MiB | 只出现在 Shared Usage 上（dedicated 恒 0） |
| `0x00000000_0x000153f9` | Microsoft Basic Render Driver | —（WARP，`Flags & 2`） | **virtual** | 0 | — | 软件渲染，占用仅几 KB |
| `0x00000000_0x0001f6f2` | Intel(R) UHD Graphics（同型号第二次枚举） | intel | igpu | 128 MiB | — | **无任何显存计数器**：DXGI 会把同一块 Intel 核显枚举两次，代码只保留有计数器数据的那个，避免 UI 出现两块核显 |

**MuMu Virtual Display Adapter（`ROOT\DISPLAY\0000`）不会出现在 `snapshot.adapters` 里。**
它是 Indirect Display Driver（纯显示器，不参与 GPU 渲染），既不是 DXGI 适配器，也没有
`\GPU Adapter Memory` / `\GPU Process Memory` 计数器实例。UI 不需要为它上色/留位置。

### 供应商 → kind 的判定顺序（写死，UI 直接按 kind 上色）

1. `DXGI_ADAPTER_FLAG_SOFTWARE (flags & 2)` 或 `VendorId=0x1414`（Microsoft） → `virtual`
2. `0x10DE` NVIDIA → `dgpu`
3. `0x8086` Intel / `0x1002|0x1022` AMD → `igpu`（AMD APU 也算核显，本机无 AMD）
4. 其它厂商：`DedicatedVideoMemory ≥ 1.5GB` → `dgpu`，否则 `igpu`

### 关于「Dedicated Limit」计数器

SPEC / 任务里提到 `\GPU Adapter Memory(*)\Dedicated Limit`，但**本机 Win11 26100 上没有这个计数器**
（`GPU Adapter Memory` 只有 Shared Usage / Dedicated Usage / Total Committed 三个计数器，实测
`Get-Counter` 报 "specified counter could not be found"）。因此：

- 独显 `totalMB` 取 `nvidia-smi --query-gpu=memory.total`（6144，与任务管理器一致），`source='nvidia-smi'`；
- 核显 `totalMB` 取 DXGI 的 `SharedSystemMemory`（本机 8011MB，Windows 给核显的共享显存上限），
  `source='counter'`；`usedMB` 取核显的 Shared Usage（核显 dedicated 恒 0）；
- `usedMB` 的实时值统一取自 PDH 适配器计数器（比每 2s 调 nvidia-smi 快得多，误差 <10MB）。

---

## 2. 计数器语义 / 一个必须知道的口径：dwm 虚高

逐进程数据源（全部真实有数）：`\GPU Process Memory(*)\Dedicated Usage|Shared Usage|Non Local Usage|Local Usage|Total Committed`，
逐适配器 `\GPU Adapter Memory(*)` 同系列，逐引擎 `\GPU Engine(*)\Utilization Percentage`。

**逐进程 Dedicated Usage 求和会明显大于 nvidia-smi 的 used**，原因是桌面窗口管理器 dwm 的
逐进程计数器把 DWM 合成的共享表面重复计入（Windows 已知问题，任务管理器上的 DWM 显存数字同样虚高）。
本机实测样例（2026-11）：

```
逐进程 Dedicated Usage 原始和        = 2846 MB
其中 dwm 一项                        = 1948 MB   ← 虚高
排除 dwm 后                          =  898 MB
nvidia-smi memory.used               = 1110 MB   （差 212MB < 512MB）
适配器级 \GPU Adapter Memory dedicated = 1117 MB   （与 nvidia-smi 差 7MB）
```

结论：
- 适配器级数字直接与 nvidia-smi 对得上（±32MB 内，实测 3~10MB），仪表盘/环形图用这个；
- 「某个应用占多少显存」用该 app 的逐进程 Dedicated Usage 是可信的（dwm 只影响 dwm 自己）；
- 「全机逐进程求和」必须排除 dwm 才能对账 —— `test.js` 里就是按这个口径断言的。

`apps` 列表里 dwm/csrss/System 等受保护进程照样会出现（category=`系统`，`recommended` 恒为 0），
但它们**不会**进入 `smartOptimize()` 的建议列表。

---

## 3. 采集性能（实测）

| 指标 | 实测 | 说明 |
|---|---|---|
| 常驻 worker 启动 + 握手 | **约 0.7~1.1 s**（一次） | PowerShell 5.1 启动 + Add-Type 编译 C# 助手 + PDH 首次采样 |
| 单次采样（常驻） | **19~45 ms**（p50 ≈ 23ms，p95 ≈ 26ms） | Node 写 `tick\n`，worker 回一行 JSON（11 个计数器、900+ 实例、约 7~22KB） |
| `collectOnce()` 往返 | 20~55 ms | 含 JSON 解析、app 聚合、分类 |
| spawn 兜底模式 | ≈ 810 ms/次 | 每次新进程（含 PowerShell 启动），有 8s 超时 + 1 次重试；**只在常驻模式失败时启用** |
| 常驻 worker 资源 | WorkingSet ≈ 97MB / Private ≈ 78MB，累计 CPU ≈ 1.2s（6 次采样） | 2s 一次采样时 CPU 增长可忽略 |

常驻方案不是「PowerShell 里 sleep 循环」，而是 **stdin 驱动**：Node 每次写 `tick\n` 才采一次。
好处：`collectOnce()` 不用等下一个 2s 窗口；没有采样漂移/重入；**父进程退出时管道关闭，worker 读到
EOF 自行退出**，不会留孤儿 powershell.exe（另有 `process.on('exit')`/`SIGINT`/`SIGTERM` 清理）。

可靠性措施：握手超时 20s、单次 tick 超时 4s、连续失败 2 次自动 kill 并重拉、重拉失败退化为
spawn 兜底、`collectOnce` 并发调用共享同一次采集（防重入）。

---

## 4. 释放量化（核心）

`setPreference(exe, 1)` 时：

1. 从最近一次快照取该应用 `beforeDgpuMB`（逐进程 Dedicated Usage 之和）、`beforePids`、时间戳；
2. 写注册表（保留 `AppStatus=0;` 等其它 token），session 状态 `pending`，deadline = now + 5 分钟；
3. 每个 tick 观察：该 exe 的 pid 集合相对切换前变化（旧 pid 消失 / 新 pid 出现）视为一次重启；
   重启后再等 1.2s（让新进程的显存数字稳定）观察 `dgpuMB`：
   - 下降 → `applied`，`freedMB = max(0, beforeDgpuMB - afterDgpuMB)`，累计进 `totalFreedMB`；
   - 没下降 → 继续观察到 deadline；
4. 5 分钟内进程没重启（或重启了显存没降）→ `needsRestart`（提示用户重启程序才生效），不计入释放；
5. 用户改回 0/2 或 `restoreDefault` → session `cancelled`，不计入释放。

`getSavings()` 返回的每条 session 都带**证据字段**（UI 直接展示「切换前 486MB → 切换后 0MB（+486MB）」）：

```json
{
  "exePath": "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "name": "Google Chrome",
  "status": "applied",
  "at": 1794223401002,
  "beforeDgpuMB": 486,
  "afterDgpuMB": 0,
  "freedMB": 486,
  "beforeAt": 1794223292885,
  "afterAt": 1794223401002,
  "pidBefore": [10328, 10716],
  "pidAfter": [20788, 21104],
  "restarts": 1,
  "evidence": "切换前 486MB（19:21:32）→ 重启后 0MB（19:23:21），释放 486MB",
  "prefEvidence": { "before": { "raw": "GpuPreference=2;", "pref": 2 }, "after": { "raw": "GpuPreference=1;", "pref": 1 } }
}
```

`at` = 事件时间（applied→完成时间 / needsRestart→判定时间 / cancelled→取消时间 / pending→开始时间），
`beforeAt`/`afterAt` 保留更细的前后时间戳；UI 只依赖 `exePath/name/beforeDgpuMB/afterDgpuMB/freedMB/at/status/pidBefore/pidAfter` 即可。

持久化：`<dataDir>\state.json` → `savings.sessions`（最多 300 条）、`savings.totalFreedMB`（按 applied
session 重新求和，幂等）。写入是 tmp + rename 原子替换，失败不抛异常。

---

## 5. 图标

- 路径：`<dataDir>\icons\<sha1(小写 exe 全路径)>.png`，96×96 PNG，**保留 alpha**；
- 抽取顺序：shell **jumbo 256px** 图像列表（`SHGetImageList(SHIL_JUMBO)` + `ImageList_GetIcon`）
  → WPF `CreateBitmapSourceFromHIcon` 缩到 96px 存 PNG；失败再退 `Icon.ExtractAssociatedIcon`（32px 放大）；
- 批量：缺图标的请求攒 50ms 合成一个 job 文件，一次 PowerShell 处理最多 60 个（实测 4~20ms/个）；
- 失败/不存在的 exe 负缓存 5 分钟，不会反复重试；exe 升级（mtime 变新）会自动重抽；
- 契约里 `bridge.getIcon(exePath)` 返回 **PNG 绝对路径**或 `null`（异步）；为了 UI 列表，`apps[]` 每项
  额外带 `iconUrl`（`file:///` URL，用 Node `pathToFileURL` 生成，中文/空格已正确编码）或 `null`。

---

## 6. 与 SPEC 契约的偏差（逐条，Lead 集成时看这里）

契约要求的方法、快照字段全部在，且**只增不改**。差异/补充如下：

1. **`collectOnce()` 返回 snapshot 本体**（顶层就是 `ts/adapters/apps/totals`），没有 `{ok,data}` 包装；
   每次采样后都会 `emit('tick', snapshot)`（`startPolling` 内部也是走 `collectOnce`，不会重复 emit）。
2. `init()` / `startPolling()` / `collectOnce()` / `setPreference()` / `restoreDefault()` /
   `listInstalledApps()` / `smartOptimize()` / `getIcon()` **都是 async**（内部要起进程/写注册表）。
   `getPreference` / `getSavings` / `getHistory` / `getSettings` / `saveSettings` / `saveWatchList` /
   `getWatchList` 是同步的。
3. `setPreference()` / `restoreDefault()` 返回证据对象而不是 void：
   `{ ok, exePath, pref, before:{existed,raw,pref}, after:{raw,pref} }` / `{ ok, exePath, removed, before, keptRaw }`；
   失败时返回 `{ ok:false, error }`（不抛异常）。成功/失败请按 `ok` 判断。
4. `snapshot` 额外字段：`engineInfo`、`prefsCount`、`watchList`、`interval`、`degraded`
   （契约字段 `ts/adapters/apps/totals` 不变）。采集失败时返回 `degraded:true + error` 的**空快照**，
   adapters/apps 为 `[]`、totals 全 0，而不是 reject。
5. `adapters[]` 额外字段：`dedicatedUsedMB`、`dedicatedVideoMB`、`sharedSystemMB`、`software`；
   `totals` 额外字段：`igpuTotalMB`、`onDefault`。`apps[]` 额外字段：`procName`、`hasWindow`、`iconUrl`。
6. `source` 取值：独显恒为 `'nvidia-smi'`（totalMB 来自 nvidia-smi、usedMB 来自计数器，误差 <10MB）；
   核显/虚拟为 `'counter'`。SPEC 枚举只有这两个值，没有新增。
7. `smartOptimize()` 返回项字段**恰为** `{ exePath, name, estMB, pref }`（按 estMB 降序）；
   `estMB` = 该应用当前在独显上的显存占用（走核显后预计可释放量）；系统类进程一律不出现；
   只建议 `pref=1`（释放显存）和 `pref=2`（游戏类恢复高性能）两种，`pref=0` 不出现在建议里。
8. `getIcon()` 按契约返回 PNG 路径（不是 `file://` URL）；URL 在 `apps[].iconUrl` 里。
9. 额外公开方法：`getSnapshot()`（上一次快照）、`isPolling()`、`stop()`、`destroy()`、
   `getEngineInfo()`、`getIconUrl()`、`refreshPreferences()`、`setLogger()`、
   事件 `'tick' | 'applied' | 'needs-restart' | 'preference' | 'error'`。
10. 采样器多了一个 `\GPU Non Local Adapter Memory`、`\GPU Local Adapter Memory` 计数器（用于判断
    dGPU 是否把内存分页到系统内存）；`apps` 的 `sharedMB` = 该应用在独显上的 Shared Usage。
11. `watchList` 由 `saveWatchList()/getWatchList()` 管理并持久化在 `state.json`；快照也带一份（方便 UI）。
12. 轮询频率改 `saveSettings({interval})` 会自动按新间隔重启轮询。

已知限制：

- 本机没有 `Dedicated Limit` 计数器 → 核显 `totalMB` 用 DXGI 共享显存预算（≈RAM/2）近似，见 §1；
- 无权限的受保护进程拿不到 exe 路径 → 这类条目 `exePath=''`、`key='pid:<pid>'`，其 `preference` 只能是 null；
- 图标对个别只有 16/32px 资源的旧 exe 会放大（jumbo 图列表给的是最近尺寸，可能仍偏糊）；
- 注册表缓存 60s 后台刷新一次；用户刚在 Windows 设置里改完偏好的瞬间可能最多滞后 60s
  （也可主动 `await bridge.refreshPreferences()`）；
- `prefs` 写注册表后**目标程序未重启不生效**（DirectX 在进程启动时读取），正因如此才有释放量化的
  `needsRestart` 状态；
- 只支持 Windows（其他平台 `init` 后采集为 degraded，方法返回空/null）。

---

## 7. 自检结果（最近一次 `node test.js`）

```
PASS 58 ｜ FAIL 0 ｜ SKIP 0
适配器：0x00000000_0x0001548b → RTX 3060 [dgpu] / 0x00000000_0x0001504f → Intel UHD [igpu] /
        0x00000000_0x000153f9 → Microsoft Basic Render Driver [virtual]
适配器级 Dedicated 1089MB vs nvidia-smi 1082MB（差 7MB）
逐进程求和（排除 dwm 虚高）825MB vs nvidia-smi 1082MB（差 257MB ≤512MB）
     原始求和 2857MB，其中 dwm 2032MB（Windows 逐进程计数器已知虚高）
采集：p50=23ms p95=25ms max=25ms；常驻模式 resident；init 1121ms；spawn 兜底 746ms
注册表：0/1/2 写入回读一致，AppStatus 保留，restoreDefault 只删 GpuPreference，测试后 14 条条目不变
状态机：applied 486MB 证据字段齐全 / 5min 未重启 needsRestart / 显存未降 freedMB=0 / 重启后从 state.json 恢复
图标：96×96 PNG（13177B）；catalog 35 项；apps 30 个（其中 22 个带 iconUrl）
```

测试用隔离的临时 dataDir（`data\_selftest_<pid>`，结束即删），注册表只写一个虚构测试路径并在结束时恢复，
不会影响用户已有的 `UserGpuPreferences` 条目。