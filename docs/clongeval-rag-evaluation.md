# CLongEval 中文小说 RAG 评测（P0）

## 数据

从 CLongEval 官方 Hugging Face 仓库下载 `1-1_long_story_qa` 下的文件：

- `small.jsonl`：首次完整基线；
- `medium.jsonl`：参数冻结后的验证；
- `large.jsonl`：最终测试。

数据无需复制进小说工作区。通过文件选择器从任意本地位置读取即可，题目、答案和
`refered_chunk` 不会进入用户的正常 RAG 索引。

## 运行

1. 打开任意本地工作区（评测缓存和报告需要工作区存储位置）。
2. 在 AI Writer 中启用 RAG，配置独立 Embedding API Key、Base URL 和模型。
3. 从命令面板执行 `AI Writer: 运行 CLongEval 中文小说 RAG 评测`。
4. 选择 `small.jsonl`。
5. 首轮保留默认题数，运行全部 small 样本。

不要求先构建用户工作区的 RAG 索引。评测为每个去重故事建立独立索引，缓存位于：

```text
.aiwriter/benchmark-cache/clongeval/
```

缓存键包含 Embedding 和切片配置；配置不变时，停止后再次运行不会重复向量化已完成的故事。

报告位于：

```text
.aiwriter/evaluations/clongeval-small-*.json
.aiwriter/evaluations/clongeval-small-*.md
```

## P0 固定基线

- 使用插件当前 `chunkSize` 和 `chunkOverlap`；
- 原始 query；
- 不使用 Query Transformation；
- 不使用 HyDE；
- BM25 + Vector + RRF；
- Top-5；
- 不调用回答模型；
- 不调用 Web 搜索；
- 每个故事独立检索，不允许其他故事成为干扰项。

## P0 指标

切片：Evidence 定位率、单块完整容纳率、边界切断率、平均覆盖块数、Evidence 覆盖率、
上下文浪费率。

检索：HitRate@5、MRR、Evidence Recall@5、P50/P95 延迟，并按 small/medium/large 和
evidence 的前部/中部/后部分层。

报告只保存题目、哈希、位置、指标和最多 200 字的召回预览，不保存完整 context 或完整
gold evidence。数据文本与隔离索引均位于 `.aiwriter`，不会进入正常索引，也不应提交到仓库。
