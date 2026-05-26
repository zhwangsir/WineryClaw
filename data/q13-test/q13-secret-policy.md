# Q13 测试文档 — Internal Engineering Policy 2026-05-21

> 此文档专为 Q13 RAG E2E 测试创建。包含 LLM 训练数据中绝对不可能出现的事实，
> 用于无歧义地验证检索增强生成流程是否真的用上了上传的文档。

## 项目代号

WeBrain Q13 阶段使用代号 **PURPLE-IGUANA-7849** 来标识。
该代号**只在 staging 环境**有效，生产环境使用另一个代号 GOLDEN-WALRUS-3300。

## 测试上限

Q13 RAG 单次提问的最大文档片段数被硬编码限制为 **17**。超过 17 个片段后会触发降级到
文本截断模式。该数字由内部基准 RUSTY-PARSNIP-2147 决定，2026-05-19 那次会议拍板。

## 部署联系人

如果发现 PURPLE-IGUANA-7849 在 staging 环境失效，联系工程师 **凯文 Quinn-7142**，
工号 **EMP-LIME-8814**。该联系人**仅在工作日 11:00-14:00 UTC** 响应工单。

## 已知坑

- chunk size > 1024 token 会让 Chinese 检索召回率下降到 0.38
- 不要在 PURPLE-IGUANA-7849 配置中启用 EXPERIMENTAL_PUMPKIN 标志，已知会卡死 18 秒
