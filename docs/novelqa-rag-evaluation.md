# NovelQA RAG 评测指南

本评测只测试“问题能否检索到官方 evidence”，不调用回答模型，也不调用网络搜索。
这样可以避免模型预训练记忆、答案猜测和 Web 搜索污染本地 RAG 指标。

## 数据准备

NovelQA 是 gated dataset。先在官方 Hugging Face 页面登录、同意访问条件并下载数据。
数据仅用于内部评测，不要把原文、QA 或评测报告提交到仓库。

首次测试建议使用 `Demonstration/B30.txt` 和 `Demonstration/B30.json`：

1. 新建一个只用于评测的 VS Code 工作区。
2. 把 `B30.txt` 放在工作区根目录。
3. 把 `B30.json` 放在工作区的 `.aiwriter/benchmark/` 下。
   `.aiwriter` 不参与索引，可以防止题目和 evidence 泄漏进检索库。
4. 在 AI Writer 中启用 RAG，确认独立 Embedding 配置有效。
5. 执行 `AI Writer: 构建 RAG 索引（长篇小说检索）`。
6. 确认索引状态为 `READY`，且索引文件数符合预期。

不要把整个 NovelQA 数据目录直接作为工作区后一次性建立索引。按小说逐本评测，才能定位问题，
也不会把其他小说变成无意义的干扰项或产生不必要的 Embedding 成本。

## 运行

1. 从命令面板执行 `AI Writer: 运行 NovelQA RAG 评测`。
2. 选择对应小说的 JSON 标注文件。
3. 首次运行分层抽样 50 题；确认流程正常后再运行该书全部带 evidence 的题。
4. 报告保存在 `.aiwriter/evaluations/novelqa-*.json`，并在完成后自动打开。

当前命令固定使用以下可复现基线：

- 原始 Question，不使用 Query Transformation；
- 不使用 HyDE；
- 混合检索（BM25 + vector + RRF）；
- Top-K = 5；
- 不经过回答模型，不经过 Web 搜索。

## 指标解释

- `HitRate@5`：前五个片段中至少有一个覆盖 gold evidence 的问题比例。
- `MRR`：第一个相关片段越靠前，得分越高。
- `Recall@5`：一个问题存在多条 evidence 时，前五个片段覆盖了多少。
- `slices`：按 NovelQA 的 `aspect` 和 `complexity` 分组统计。
- `results`：逐题排名、来源通道、片段预览和失败明细。

优先检查 `results` 中的失败题。区分以下原因：

1. evidence 被切块边界截断；
2. BM25 没有命中专名或原文措辞；
3. 向量检索没有识别语义改写；
4. multi-hop 题只召回了部分 evidence；
5. 标注 evidence 是推理说明而非原文摘录，不能直接作为检索 gold passage。

第 5 类应从检索指标中单独标记或人工复核，不能当成检索失败。

## 建议的评测顺序

1. Demonstration 冒烟测试：验证导入、索引和报告链路。
2. 选择 3 本公共领域小说，每本运行全部可评测题。
3. 固定同一批题，比较后续检索方案；每次只改变一个变量。
4. 最后再单独评估 Query Transformation、HyDE 和回答正确率。

不要使用公开 test 输入计算检索准确率：公开 test 不包含 gold answer/evidence。完整标注需要按
NovelQA 官方说明申请，并遵守其防泄漏要求。
