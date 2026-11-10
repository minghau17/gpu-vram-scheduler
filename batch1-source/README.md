# GPU 调度管理器 3.0

把不用的程序交给核显，把独显显存留给真正需要它的程序 —— 并且**量出**到底腾出了多少。

> 3.0 在原 2.0 基础上重做了整套界面与交互，新增 A/B 实测、预算规划、自动分流、报告导出。

---

## 一眼看懂三个数

| 指标 | 口径 | 位置 |
|---|---|---|
| 可释放（待重启） | 已设为核显、但进程还在独显上跑的那些程序的提交量之和 | 概览 / 收益实测 |
| 建议迁移预估 | 规则推荐走核显、当前仍在独显的程序占用之和 | 概览 / 建议迁移条 |
| 已实测释放 | 真实采样：切换前后两次独显占用均值之差，按会话累计 | 收益实测 |

**为什么要有「实测」**：注册表只是偏好，程序不重启就不会生效；切换后其他程序也在波动。
所以唯一可信的答案是「切换前后各采一段时间的整卡占用，再看差值」，本工具把它做成了一个可追溯的会话。

---

## 功能

- **概览**：独显占用环、空闲显存、可释放/建议/已实测三个口径、实时双曲线、占用 Top、建议迁移快捷条。
- **应用调度**：搜索、筛选（核显/独显/自动/待生效）、按占用或名称排序、多选批量迁移、单条切换、重启程序以生效、打开位置、添加程序。
- **一键智能优化**：按「后台常驻、核显够用」规则挑出候选，列清单确认后批量写入，按预计释放量排序。
- **收益实测（A/B）**：基线采样 15s → 写入核显偏好 → 提示重启 → 检测到进程重启后再采样 15s → 给出净释放量、目标程序释放量、置信度、可导出的会话记录。
- **显存预算**：输入目标程序需要的显存，算出现在还差多少，并给出「迁哪几个」的贪心方案。
- **自动分流**：新出现的程序若属于勾选分类且推荐核显，自动写偏好（只处理从未手动设置过的程序，系统进程永不处理）。
- **报告导出**：Markdown，含整卡、可释放、实测会话、建议清单、占用 Top10。

## 目录

```
gpu-scheduler-v3/
├─ electron/
│  ├─ main.js            主进程：窗口、IPC、采集循环、自动分流、报告
│  ├─ preload.js         白名单通道
│  ├─ measure.js         A/B 实测状态机（纯逻辑，可单测）
│  └─ bridge/            真实数据层：PDH 计数器 + DXGI + NVML + 注册表读写
├─ renderer/
│  ├─ index.html         外壳（含 SVG 折射滤镜）
│  ├─ css/app.css        液态玻璃设计系统（变量 + 组件 + 页面）
│  └─ js/                app.js（路由/页面/交互）、charts.js（Canvas 图表）
├─ assets/icons/         logo.svg + 全尺寸 png + app.ico
├─ scripts/              make-icons / package / qa-run
└─ dist/                 打包产物
```

## 开发与打包

```bash
# 依赖：本机 Node ≥ 20 + 仓库内 node_modules（electron 45）
npm start                                   # 开发运行
electron scripts/make-icons.js              # 重新渲染 logo → png
python scripts/make-icons.py                # png → 全尺寸 + app.ico
node scripts/package.js                     # 离线打包（不需要联网）
electron . --qa=D:/tmp/qa                   # 交互冒烟 + 逐页截图
```

打包为**离线手动复制**（`scripts/package.js`），因为 `@electron/packager` 会尝试联网拉 electron；
本机已有 `node_modules/electron/dist` 与系统缓存，直接复制更快也更可靠。exe 的图标和版本信息用 `resedit` 写入。

## 液态玻璃是怎么做的

不是单一 `backdrop-filter`，而是五层叠出来的：

1. **极光壁纸层**：5 个大半径径向渐变光斑（薄荷/天蓝/紫罗兰/蜜桃/玫瑰），40px 模糊，40~70s 缓慢漂移；
   再叠一层 SVG fractalNoise 颗粒（`mix-blend-mode: overlay`），避免纯渐变发"塑料光"。
2. **玻璃本体**：`backdrop-filter: blur(34px) saturate(235%) contrast(1.03)`，低透明度白色渐变填充。
3. **棱镜描边**：`border: 1px solid transparent` + 双层 background（`padding-box` 玻璃体 / `border-box` 彩虹渐变），
   让边缘出现粉-白-蓝-紫的色散，这是"玻璃有厚度"的关键。
4. **镜面高光**：`::after` 里一个跟随鼠标的径向高光（CSS 变量 `--mx/--my` 由 pointermove 更新），
   加 `mix-blend-mode: screen`，模拟液体表面的高光流动。
5. **折射**：`index.html` 里的 `#lg-lens`（feTurbulence + feDisplacementMap）用在侧栏与主卡的
   `backdrop-filter: url(#lg-lens) blur(18px)` 上，让面板背后的光斑发生轻微扭曲。

深色主题复用同一套结构，只换壁纸、玻璃透明度和文字色；两套主题都做了对比度检查。

## 数据口径与限制

- 整卡已用/总量来自 **NVML**（`nvidia-smi`），与任务管理器一致；30000ms 刷新一次。
- 逐进程占用来自 **性能计数器** `\GPU Process Memory(*)\Dedicated Usage`，是**提交量**：
  系统进程（dwm 等）会重复计入桌面缓冲，所以各程序相加可能大于整卡已用。
  界面上所有"释放量"一律以实测（整卡口径）为准，逐进程数据只用来排序与指定目标。
- 显卡偏好写在 `HKCU\Software\Microsoft\DirectX\UserGpuPreferences`，值名是 exe 全路径，
  值与 Windows「设置 → 系统 → 屏幕 → 显示卡」是同一份数据；写入时保留 `AppStatus` 等其它 token。
- **改完必须重启目标程序**才生效；界面会标「待重启」，并提供一键重启。
- 读不到 exe 路径的进程（受保护进程）无法调度，已从列表排除。

## 已知限制

- 只有 NVIDIA 卡有 NVML 精确总量；AMD/Intel 独显会退回计数器口径，精度略低。
- 实测依赖进程重启，若目标程序重启后仍有后台 GPU 进程残留，释放量会偏小（置信度会显示为中/低）。
- 没有开机自启与托盘常驻（2.0 有，3.0 暂时去掉，避免和"省显存"的目标冲突）。
