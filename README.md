# Code Map · 代码地图生成技能

> **把代码，讲成一张可以点的图。**

Code Map 是一个代码地图生成引擎：输入工程上下文——一次迭代、一份需求、一个陌生仓库——输出一张**交付级交互式 HTML 地图**。它让复杂系统第一次可以"自己讲自己"：读者沿主线走、看哪里点哪里，全程无需任何环境配置。

![Code Map 实拍](case/screenshots/trial-flow-overview.png)

一张 Code Map 的样子：

- **左栏 · 工程树** — IDEA 风格的类/接口/方法视图，状态徽标 + 搜索过滤，是整个系统的"目录页"
- **中栏 · 三图联动** — 全景模块图 / 运行时序图 / 方法流程图，五色语义标记（核心绿 / 复用灰 / 外部蓝 / 兜底橙 / 错误红）
- **右栏 · 说明卡** — 每个节点的"为什么这样设计、坑在哪里"，按类型过滤
- **三方联动** — 点任意一处，另外两栏定位高亮，SVG 连线贯穿直达
- **主线导览** — 顶部"跟着流程走"站点条，6~10 站走完整个主题，只看导览也能理解全貌
- **零依赖交付** — mermaid 本地打包，单文件 HTML 双击即开：离线可用、可入库存档、可直接发给任何人

而这一切对生成方只有一个约束：**生成 = 换数据，不改引擎。**给 AI Agent 用，也给你自己用。

---

## 你可以用它做出什么

| 场景 | 输入 | 产出 |
|---|---|---|
| **S1 教学章节** | 一章课程 / 一次教学迭代 commit | 串联教程图：装配 → 核心抽象 → 主链路 → 收尾，每站带思考题 |
| **S2 迭代对比** | 两个 git 基线（`extract-diff.sh` 采集） | 变更复盘图：改了什么 / 为什么改 / 影响面，末站含回滚方案 |
| **S3 需求蓝图** | 一份需求描述 + 现有代码 | 开发施工图：目标态类清单 + 导览顺序即开发顺序，末站附整体验收命令 |
| **S4 PR 讲解** | 一个 PR | 评审图：变更子图 + 意图/实现/关注点三问，末站给评审结论 |
| **S5 架构 Onboarding** | 一个陌生仓库 | 新人地图：模块职责 + 一次请求的生命周期 + 环境启动卡 |

一句话：**凡是"跟着流程走才能讲明白"的工程知识，都可以做成一张地图**——写教程、做技术分享、带新人、review、写设计文档，都在射程内。

## 两个真实案例

仓库 `case/` 下有两张完整地图，浏览器直接打开：

**1. `case/xfg-2-1-code-map.html` — 教学场景（S1）**
LLM 适配器章节图：20 个新增文件、+3278 行，8 站从装配走到组装。展示能力：如何把一次"大量新增代码"的迭代压缩为一条叙事线，重点类逐张说明卡，复杂方法（SSE 翻译、错误归一化）单独成站。

**2. `case/group-buy-trial-flow-code-map.html` — 业务功能导读场景（S5 变体）**
拼团营销"试算"功能全览：三张图 + 14 张节点说明卡 + 10 站导览。展示能力：如何给一个**已有功能**做导读——规则树的每个分支、每个异常码、每个异步任务都有落点；绿=核心主干、橙=分支兜底、灰=复用，图例即导航。

实拍截图（真实渲染效果）：

**① 全景图页签** —— trigger 入口 → 规则树节点 → 折扣策略族 → 模型/外部依赖，一张图看清整个模块拓扑：

![全景图](case/screenshots/trial-flow-overview.png)

**② 时序图页签** —— 一次试算从 HTTP 进入到 `TrialBalanceEntity` 收口的完整调用链（含双异步并行加载）：

![时序图](case/screenshots/trial-flow-sequence.png)

**③ 流程图页签** —— 规则树全部分支与异常路径（参数缺失 / 降级 / 切量 / 兜底），错误码红节点即异常出口：

![流程图](case/screenshots/trial-flow-flowchart.png)

两张图风格一致、结构同源，差别只在数据——这正是本技能的设计：**引擎固定，场景靠数据区表达**。

## 快速开始

```bash
# 1. 体验成品：浏览器打开任意案例
open case/group-buy-trial-flow-code-map.html

# 2. 校验一张地图（静态层 0 错误；有 Node 22+ 和 Chrome 再跑渲染验收）
node scripts/validate-map.js <地图.html>
node scripts/render-map.mjs --html <地图.html>

# 3. 从 JSON 数据契约一键生成（示例即契约样例）
node scripts/build-map.mjs --data assets/example-map.json --out /tmp/codemap-demo

# 4. 安装为 WorkBuddy 技能（对话式生成）
cp -r xfg-coding-map-skills ~/.workbuddy/skills/
```

安装后在 WorkBuddy 对话里直接说：

- 「生成这次迭代的代码地图」→ S2
- 「给这个需求出一张开发蓝图导览」→ S3
- 「讲讲这个 PR」→ S4
- 「画一张新人 onboarding 架构图」→ S5

## 生成管线（它如何工作）

```
场景识别 → 素材采集 → 数据构建 → 一致性校验 → 真渲染验收 → 单文件交付
   │           │            │             │              │
 场景表定    extract-diff.sh  JSON 契约或    validate-map.js  render-map.mjs
 口径/动线   或源码精读       手工替换       0 错误才继续     CDP 真渲染+SVG/PNG 导出
                            MAP-DATA 区间
```

- **引擎不动**：`assets/code-map-template.html` 是渲染引擎 + 示例数据，生成时只整体替换 `MAP-DATA` 区间的 7 个数据结构——`MAP_META`（标题/stats/欢迎层/slug 等全部元信息，启动时自动注入 DOM）+ `OVER_SRC / SEQ_SRC / FLOW_SRC`（三张 mermaid 图源）+ `TREE`（工程树）+ `DOCS`（说明卡）+ `TOUR`（导览站）。
- **数据契约化**：数据可写成一份 JSON（示例 `assets/example-map.json`），由 `scripts/build-map.mjs` 自动完成替换、页签裁剪、vendor 拷贝和静态校验——同一份数据派生 HTML/SVG/PNG，迭代不重排编号。
- **联动不断链**：树节点通过 `kw` 关键词锚定图内节点，校验器逐一验证每个 kw 都是某张图源码的子串，防止"点击没反应"。
- **页签可裁剪**：JSON 声明 `tabs` 或删掉对应 tab/wrap/src 元素即可少一张图，引擎自动适配。

## 质量保障（两层验收）

**静态层 validate-map.js**：

- MAP_META 完整性、TREE ↔ DOCS 引用一致性、孤儿说明卡检测、树节点 t/b 与徽标取值合法性
- 全部 kw 均能命中图源码（防联动静默断链）
- TOUR 站点 tab/树节点引用、站数合理性（6-10 站）
- **mermaid 语法红线**：flowchart 嵌套 subgraph / subgraph 未闭合、时序图 actor 标识符 `END` 冲突、alt/loop 块不配对、消息引用未声明参与者——静态拦截，避免"校验 0 错误但浏览器渲染报错"

**渲染层 render-map.mjs**（Node 22+ 内置 WebSocket + Chrome CDP，零外部依赖）：

- 三张图真渲染（占位/报错即失败）、页签切换、三方联动出线、说明卡筛选、树搜索、导览翻站逐项检查
- **滚动跟随**：滚动左树/右栏后连线必须重绘（issue #3 回归检查；监听必须挂在真实滚动容器 `#tree`/`#docs` 上）
- 离线自包含检查（零外部请求）+ 运行时异常检查
- 导出各页签 SVG、三栏全景 PNG、联动预览 PNG 和渲染验证报告 JSON

## 目录结构

```
xfg-coding-map-skills/
├── SKILL.md                      # 技能入口：事实纪律 + 工作流（场景→素材→生成→两层校验→交付）
├── assets/
│   ├── code-map-template.html    # 渲染引擎 + 示例数据（MAP-DATA 区间整体替换）
│   ├── example-map.json          # JSON 数据契约完整示例（build-map.mjs 输入）
│   └── vendor/mermaid.min.js     # 离线 mermaid
├── references/
│   ├── data-spec.md              # 数据契约：MAP_META/TREE/DOCS/TOUR/图源码字段规范、kw 联动规则、mermaid 语法红线
│   └── scenarios.md              # 五种场景的素材来源、badge 语义、TOUR 动线设计
├── scripts/
│   ├── extract-diff.sh           # 采集 git 基线变更（S2/S4 场景素材）
│   ├── build-map.mjs             # JSON 契约 → 生成 HTML（自动校验，--force 才覆盖）
│   ├── render-map.mjs            # CDP 真渲染验收 + SVG/PNG 导出
│   └── validate-map.js           # 生成后一致性校验（0 错误才可交付）
└── case/                         # 两张完整案例图，浏览器直接打开
    ├── xfg-2-1-code-map.html     #   教学场景（S1）：LLM 适配器章节
    ├── group-buy-trial-flow-code-map.html  # 业务导读场景：拼团试算全览
    ├── screenshots/              #   案例实拍截图（README 引用）
    └── vendor/mermaid.min.js
```

---

如果这张地图帮你讲清过一次代码，欢迎 Star；Issue 里聊聊你想用地图讲的下一个主题。
