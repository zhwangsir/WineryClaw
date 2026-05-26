# ADR-0003 — Recall@5 GA blocker 诊断与 attack vector 选型

* Status: **Diagnostic 完成,实施待启动**
* 日期: 2026-05-26
* 作者: TiaLynn (合并 sprint 后接手)
* Round: v2.52 candidate

## 背景

ROADMAP V2 §4 验收清单的第 7 项 **`Axis 1 recall@5 ≥ 0.85`** 仍是 open 状态。
合并 Kimi M6b 工作 + 我的 v2.x perf 工作后,memory_benchmark 实测:

| Metric | BASELINE (L1 only) | POST-CONSOLIDATION (L1+L2+L3) | Target |
|---|---:|---:|---:|
| recall@5 | **0.550** | **0.550** (Δ +0.000) | ≥ 0.85 |
| recall@10 | 0.675 | 0.625 (Δ -0.050) | — |
| MRR | 0.484 | 0.445 (Δ -0.039) | ≥ 0.80 |

距离 0.85 目标:**0.30 gap**(20 个 query 中 6 个需补救)。

## 失败模式分析(WORST 10 queries 实测数据)

20 个 query 中 10 个 recall@10 < 1.0。逐个看 query → 期望 target →
top-5 实际命中:

| Query | 期望 fixture | top-5 是否命中 | 失败模式 |
|---|---|---|---|
| 用户住在哪里 | day7-intro-city("住在北京海淀区") | ❌ | **疑问句重述**: "哪里" vs "现在住在" |
| 用户用什么后端技术栈 | day7-intro-tech("后端用 Python") | ❌ | **抽象转具体**: 都有"后端"关键词却 miss |
| 用户喜欢用什么主题 | day6-darkmode("深色模式,白底太刺眼") | ❌ | **同义词**: "主题"↔"深色模式" |
| 用户的作息时间 | day6-bedtime("凌晨 1 点睡") | ❌ | **同义词**: "作息"↔"凌晨...睡" |
| 用户最近在喝什么茶 | day4-tea-mention("最近在学习喝乌龙茶") | ❌ | **直接关键词应中却失** |
| 用户的咖啡偏好 | day6-coffee-1 / day1-coffee-change | ❌ | **抽象框架词稀释**: "偏好" 抢走主题信号 |
| 杭州住哪个酒店 | day3-plan-hotel("湖滨饭店") | ❌ | **同义词**: "酒店"↔"饭店" |
| skill 执行的安全问题 | day1-bug-skill("shell injection") | ⚠️ 排 4 | **语义跨越**: "安全问题"↔"shell injection" |
| 用户对人生意义的看法 | 期 2 中 1(day4-question-life ✅, day4-followup-life ❌) | ⚠️ 部分 | **多目标**部分命中 |
| 用户在做什么项目 | day7-intro-work / tech | ⚠️ 排 2 | 部分命中 |

## 关键诊断实验

直接 query 检验 embedder 在中文上的具体表现:

```python
Q: "用户的咖啡偏好"           → top-5 全是无关条目(人生意义/酒店/部署/姓名)
Q: "咖啡"                  → top-1 = day1-coffee-change ✅(直接关键词中)
Q: "美式咖啡"              → top-1/2/3 都是 coffee 相关 ✅
Q: "用户最近在喝什么茶"       → top-1 是 coffee,茶 entry 没出现 ❌
Q: "茶"                   → top-1 仍是 coffee,而非茶 entry ❌
```

**核心结论**:

1. **单关键词 query("咖啡" / "美式咖啡")vector search 能正常工作**
2. **抽象短语 query("用户的咖啡偏好" / "用户的作息时间")失败 — 抽象框架词
   ("用户的"/"...偏好") 在 384-dim 空间里抢走主题信号**
3. **"茶" 这个单字 query 在 `all-MiniLM-L6-v2` 384-dim 空间里距离
   coffee entry 比 tea entry 更近** — 嵌入模型把 茶/咖啡 当成同义饮料类
4. **同义词("酒店"↔"饭店", "作息"↔"凌晨...睡", "主题"↔"深色模式")
   超出当前嵌入模型的中文语义能力**

## Attack vectors 与 ROI

| 方向 | 工作量 | 预期增益 | 风险 |
|---|---|---|---|
| **A. 换中文专用嵌入模型** (BAAI/bge-small-zh-v1.5,95MB) | 中(下载 + 跑实验) | +0.10~0.25 | 低 — drop-in replace |
| **B. HyDE 启用 + benchmark 集成** | 小 | +0.05~0.15 | 中 — 需 LLM 调用 |
| **C. FTS 中文分词器复查** | 小 | +0.05 | 低 |
| **D. blender 权重 grid 重跑** | 小 | +0.03~0.05 | 极低 |
| **E. cross-encoder 中文微调** | 高 | +0.10~0.20 | 高 — 训练复杂 |
| **F. 扩充 fixture(真实对话)** | 高 | 数据驱动 | 中 |

## 推荐:**A 优先**(BAAI/bge-small-zh-v1.5)

### 理由

1. **诊断证据直接指向 embedder**:`all-MiniLM-L6-v2` 在中文短语 query 上
   彻底失败,换中文优化模型是治根
2. **drop-in replacement**:仅改 `memory/memory_manager.py` 第 215 行
   `SentenceTransformer("all-MiniLM-L6-v2")` → `SentenceTransformer("BAAI/bge-small-zh-v1.5")`,
   维度都是 512(bge-small)或 384(MiniLM)— 需验证向量索引/L1 已有数据兼容
3. **可逆**:用 env knob 控制(`WEBRAIN_EMBEDDER_MODEL`),失败可
   一键退回
4. **预期增益**:bge-small-zh 在中文 STS 基准上比 MiniLM 高 ~0.20。
   推算 recall@5 0.55 → ~0.75-0.80 应可达

### 实施步骤(v2.52)

1. 加 env knob `WEBRAIN_EMBEDDER_MODEL=BAAI/bge-small-zh-v1.5` (默认仍 MiniLM)
2. 验证向量维度兼容(BAAI/bge-small-zh-v1.5 是 512-dim,MiniLM 是 384-dim
   — 需要清空旧向量索引,或加 migration)
3. 跑 benchmark A/B (workers=2 / wired executors / 跟 v2.49 一致环境)
4. 若 recall@5 ≥ 0.80,设为新默认(`WEBRAIN_EMBEDDER_MODEL` 默认值翻转)
5. 不达标 → 试 bge-large-zh-v1.5(1.3GB),性能更强

## 试验提供 fallback

如果 A 测试不达 0.85,Plan B(B+C 组合):

- 启用 HyDE 默认 ON 在 benchmark 中
- 检查 CJK 分词器是否在 "咖啡偏好" 等切词正确
- 重跑 blender 权重 grid

## Triggers for revisiting this ADR

- bge-small-zh A/B 实测后:更新 recall@5 数字
- 若达标(≥ 0.85):本 ADR 状态改为 "Accepted, delivered"
- 若不达标:开 ADR-0004 探索 Plan B 组合

## 参考文件

- `sub-brain/main-brain/memory/memory_manager.py` 第 215-243 行 (embedder lazy load)
- `sub-brain/main-brain/tests/test_memory_benchmark.py` (基准实测)
- `sub-brain/main-brain/tests/fixtures/memory_7day_log.json` (20 query fixture)
- `docs/ROADMAP_V2.md §4` (GA 验收清单)
