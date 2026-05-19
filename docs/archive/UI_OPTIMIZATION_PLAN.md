# WeBrain 前端 UI 优化方案

> 基于对话页面重构经验，推导全站 UI 优化路径。

---

## 一、设计系统重构

### 1.1 色彩体系（已在对对话页验证）

放弃紫色调（`#4f46e5` / `#6366f1`），全面转向**纯黑白灰 + 红绿状态色**。

| 用途 | Light | Dark |
|------|-------|------|
| 页面背景 | `#ffffff` | `#0a0a0a` |
| 卡片/面板 | `#fafafa` | `#141414` |
| 悬浮/悬停 | `#f5f5f5` | `#1f1f1f` |
| 主文字 | `#000000` | `#f5f5f5` |
| 次要文字 | `#666666` | `#a1a1aa` |
| 弱化文字 | `#999999` | `#71717a` |
| 边框 | `#e5e5e5` | `#27272a` |
| **成功/在线/开启** | `#16a34a` | `#22c55e` |
| **错误/删除/离线** | `#dc2626` | `#ef4444` |
| 警告 | `#ca8a04` | `#eab308` |

**关键决策**：
- 主按钮用 **纯黑底白字**（`#000000` + `#ffffff`），hover 时 `#333333`
- 状态指示只用 **红绿**，不再使用彩色圆点
- 彻底移除所有 `--c-accent` 紫色引用

### 1.2 字体与排版

```
字体栈: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif
字号阶梯:
  28px — 页面大标题（Dashboard 数字等）
  20px — 模块标题
  16px — 卡片标题 / 表单标签
  14px — 正文 / 按钮 / 列表项
  13px — 辅助说明 / 标签
  11px — 时间戳 / 微标

字重:
  600 — 标题、按钮、选中态
  500 — 列表项标题、导航
  400 — 正文
  300 — 弱化提示、空状态
```

### 1.3 间距系统

采用 4px 基网格：

```
xs: 4px   sm: 8px   md: 16px   lg: 24px   xl: 32px   xxl: 48px
```

页面边距统一为 `24px`，卡片内边距 `24px` 或 `32px`。

### 1.4 圆角系统

大幅收紧圆角，走**锐利编辑风格**：

```
按钮 / 标签 / 输入框: 6px  ~ 8px
卡片 / 面板:          8px  ~ 10px
弹窗 / 下拉菜单:       10px ~ 12px
头像 / 状态点:         50%（纯圆）
```

---

## 二、全局 CSS 迁移清单

### 文件: `src/styles/global.css`

当前有 `--c-accent` 等紫色变量贯穿全局，需按以下顺序替换：

| 优先级 | 变量/规则 | 处理方式 |
|--------|----------|---------|
| P0 | `--c-accent`, `--c-accent-hover`, `--c-accent-active`, `--c-accent-soft` | **删除**，替换为 `#000000` 或对应灰阶 |
| P0 | `.ant-btn-primary` 背景色 | `#000000`（Light）/ `#f5f5f5`（Dark） |
| P0 | `.ant-menu-item-selected` 颜色 | `#000000`（Light）/ `#ffffff`（Dark） |
| P0 | `.ant-input:focus` 边框色 | `#000000` |
| P0 | `.ant-tabs-ink-bar` | `#000000` |
| P1 | `--c-status-on` / `--c-status-off` | 引入红绿语义：`#16a34a`（on）, `#dc2626`（error）, `#999999`（off） |
| P1 | `--c-success` / `--c-success-bg` | 修正为绿色系 |
| P2 | `.ant-switch-checked` | `#000000`（取代紫色） |
| P2 | `.ant-tag` / `.ant-select-item-option-selected` | 去紫色，改用黑/灰 |

### 文件: `src/styles/theme.ts`

Ant Design `ThemeConfig` 中：

```typescript
// 替换前
colorPrimary: C.accent,   // ← 紫色

// 替换后
colorPrimary: isDark ? "#f5f5f5" : "#000000",
```

所有 `colorInfo` / `colorSuccess` / `colorError` / `colorWarning` 也需映射到新的红绿色系。

---

## 三、逐页面优化建议

### 3.1 Dashboard（首页）

**当前问题**：卡片堆砌，信息密度低，Ant Design Statistic 视觉过重。

**优化方向**：
- 用**数字大字体**（28px / weight 600）替代 `ant-statistic`，上下结构排列
- 状态卡片用**边框线**（1px `#e5e5e5`）而非阴影区分层级
- 模块标题用 `text-transform: uppercase; letter-spacing: 0.5px; font-size: 11px; color: #999`
- 图表区域加细边框，去除阴影

### 3.2 Agents 页面

**当前问题**：表格视觉杂乱，操作按钮分散。

**优化方向**：
- 改用**卡片网格布局**（每行 3~4 张卡片），每张卡片：
  - 顶部：Agent 名称（16px / 600）+ 状态点（绿/红）
  - 中部：描述（13px / 400 / `#666`）
  - 底部：工具标签（小型 monochrome tag）+ 开关
- 开关（Switch）checked 态改为黑色
- 删除操作统一为红色文字按钮，hover 加深

### 3.3 Tools 页面

**当前问题**：与 Agents 类似，列表感强。

**优化方向**：
- 分类折叠面板（Collapse），每类一个面板
- 工具项用行内布局：图标 + 名称 + 描述 + 开关
- 开关开启 = 绿色，关闭 = 灰色

### 3.4 Memory / Wiki / KG 页面

**当前问题**：页面间视觉差异小，表格为主。

**优化方向**：
- **Memory**：时间线（Timeline）形式展示，左为时间戳，右为内容块
- **Wiki**：笔记卡片网格，hover 显示编辑/删除
- **Knowledge Graph**：图可视化容器加细边框，控制面板浮于右侧（白色底+1px边框，无阴影）

### 3.5 Channels 页面

**当前问题**：状态指示依赖彩色圆点。

**优化方向**：
- 状态统一用**文字标签 + 颜色**：
  - `已连接` → 绿色文字 `#16a34a`
  - `已断开` → 灰色文字 `#999999`
  - `错误`   → 红色文字 `#dc2626`
- 卡片布局参考对话页 Sidebar 风格

### 3.6 Cron 页面

**当前问题**：标签颜色过于丰富。

**优化方向**：
- 状态标签 monochrome：
  - `运行中` → 黑底白字
  - `已停止` → 白底黑边框
  - `失败`   → 红底白字
- 表格行 hover 用 `#f5f5f5`

### 3.7 Settings 页面

**当前问题**：表单视觉平淡。

**优化方向**：
- 分区块（Section），每块一个细边框包裹
- 区块标题：11px uppercase `#999`
- 输入框 focus 态黑色边框 + 无 glow
- 保存按钮：黑底白字，全宽或右对齐

---

## 四、组件层标准化

### 4.1 新增/改造公共组件

```
components/ui/
  ├── StatusBadge.tsx      # 文字+颜色状态标签（红/绿/灰）
  ├── StatusDot.tsx        # 纯色圆点（仅用于需要极简指示处）
  ├── MonoButton.tsx       # 黑/白/灰按钮体系
  ├── SectionCard.tsx      # 带 1px 边框的卡片容器
  ├── EmptyState.tsx       # 空状态（Icon + 灰色提示文字）
  └── InlineTag.tsx        # 小型 monochrome 标签
```

### 4.2 StatusBadge 规范

```tsx
// 绿色 — 正常/开启/成功
<StatusBadge status="on" text="运行中" />      // color: #16a34a

// 红色 — 错误/删除/失败
<StatusBadge status="error" text="失败" />      // color: #dc2626

// 灰色 — 关闭/离线/默认
<StatusBadge status="off" text="已停止" />      // color: #999999
```

**禁止**：单独使用绿色/红色圆点作为状态（必须配合文字）。

### 4.3 按钮层级

| 层级 | 样式 | 用途 |
|------|------|------|
| Primary | `#000000` 底 + `#ffffff` 字 | 主要操作（新建、发送、保存） |
| Secondary | `#ffffff` 底 + `#000000` 字 + `1px #000` 边框 | 次要操作（取消、返回） |
| Danger | `#dc2626` 底 + `#ffffff` 字 | 删除、停止、危险操作 |
| Ghost | 透明底 + `#000000` 字 | 导航、工具栏 |
| Text | 透明底 + `#666666` 字 | 辅助链接 |

---

## 五、暗色模式适配

暗色模式不是简单的反色，而是建立独立灰阶：

```css
[data-theme="dark"] {
  --c-page:     #0a0a0a;   /* 非纯黑，留呼吸感 */
  --c-card:     #141414;   /* 面板 */
  --c-hover:    #1f1f1f;   /* 悬停 */
  --c-border:   #27272a;   /* 边框 */
  --c-text:     #f5f5f5;   /* 主文字 */
  --c-text-2:   #a1a1aa;   /* 次要 */
  --c-text-3:   #71717a;   /* 弱化 */
}
```

**暗色下按钮规则**：
- Primary: `#f5f5f5` 底 + `#0a0a0a` 字（反色逻辑）
- Danger: `#ef4444` 底 + `#ffffff` 字

---

## 六、实施优先级

### Phase 1（本周）— 基础层
1. [ ] 重构 `global.css`：删除紫色变量，建立黑白灰+红绿体系
2. [ ] 重构 `theme.ts`：Ant Design token 映射到新色系
3. [ ] 新建 `components/ui/` 基础组件（StatusBadge, MonoButton, SectionCard）

### Phase 2（下周）— 核心页面
4. [ ] Dashboard 页面重构（大数字排版 + 去阴影）
5. [ ] Agents 页面重构（卡片网格 + 状态标签标准化）
6. [ ] Settings 页面重构（区块化表单 + 统一按钮）

### Phase 3（第三周）— 数据页面
7. [ ] Memory / Wiki / KG 页面重构（时间线/卡片网格/图容器）
8. [ ] Channels / Cron 页面重构（状态标签 + 表格优化）
9. [ ] Tools 页面重构（分类折叠 + 行内开关）

### Phase 4（第四周）—  polish
10. [ ] 全局动画统一（统一 easing + duration）
11. [ ] 移动端响应式适配
12. [ ] 无障碍检查（颜色对比度、键盘导航）

---

## 七、对话页已实现的设计范式（可直接复用）

以下模式已在 `ChatPage.tsx` 验证，可直接作为其他页面的参考：

| 模式 | 实现 | 复用建议 |
|------|------|---------|
| 黑白面板 | `#fafafa` sidebar + `#fff` main + `1px #e5e5e5` border | Dashboard 侧边栏、Settings 区块 |
| 黑色主按钮 | `#000000` bg + `#ffffff` text | 全局 Primary 按钮 |
| 红色危险操作 | `#dc2626` 用于删除/停止 | 全局 Danger 按钮 |
| 绿色状态指示 | `#16a34a` 用于 streaming/在线 | 全局 on/success 状态 |
| 编辑风圆角 | 6px ~ 8px，拒绝 12px+ 大圆角 | 全局卡片、按钮、输入框 |
| 极简头像 | 28px 圆形 + 单色图标 | Agents、Channels 列表 |
| 时间格式化 | 相对时间（今天/昨天/N天前） | Memory、Cron、Wiki |
| Popconfirm 删除 | 二次确认 + 红色确认按钮 | 所有删除操作 |
