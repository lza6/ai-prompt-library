# 贡献说明

## 上游与覆盖核对

1. 每轮先执行 git fetch --all --prune，核对：
   - upstream-asgeirtj/main（asgeirtj/system_prompts_leaks）
   - upstream-x1xhlol/main（x1xhlol/system-prompts-and-models-of-ai-tools）
2. 以实际 Git tree 和文件内容比对覆盖情况；README 的“最近更新”只用于发现候选，不能替代文件级比对。
3. 只纳入提示词正文、工具定义与直接解释模型行为的文档。图片、构建产物、第三方 SDK、示例组件、包管理文件及纯目录索引不进入提示词语料库。
4. 本地已有同一版本的稳定中文映射时，更新该文件，不创建英文路径的重复副本。

## 中文目录映射

| 上游路径 | 本地目录 |
| --- | --- |
| Anthropic/ | Anthropic（Claude）/ |
| OpenAI/ | OpenAI（ChatGPT、Codex）/ |
| OpenAI/Codex/ | OpenAI（ChatGPT、Codex）/Codex/ |
| Google/ | Google（Gemini、Jules）/，按 Gemini/、Antigravity/、Jules/ 分组 |
| xAI/ | Grok（xAI）/，核心模型放入 Core_Models/ |
| Microsoft/ | Microsoft（Copilot）/；VS Code Copilot 专用内容放入 GitHub Copilot（VSCode）/ |
| Perplexity/ | Perplexity（搜索AI）/ |
| Meta/ | Meta（Llama）/ |
| Misc/amp-code.md | Sourcegraph（Amp）/amp-code.md |
| Kimi/ | 月之暗面（Moonshot AI）/ |
| Qwen/ | 阿里巴巴（通义千问、Qoder）/ |

无法映射的产品应先建立“厂商（产品）”目录，并在 PR 描述中写明理由；不要新增 Misc/ 的同义目录。

## 翻译与来源要求

- 正文使用简体中文；标题层级、代码块、命令、JSON 键名、XML 标签、链接、引用、占位符与版本号保持原样。
- 每个新增文件开头标注来源 URL、上游路径与适用版本/日期；不把推测性说明写成事实。
- 超长文件必须分批翻译，并在本地 task.md 记录完成边界；未完成文件不得标记为“完整翻译”。
- 同一版本的纯格式调整不重复创建文件；有实质版本差异时使用版本化文件名保留历史。

## 文档与提交

- README.md 只维护稳定项目说明、目录规则和最近更新时间，不承诺固定覆盖率。
- 根目录 task.md 是本地维护日志，记录每轮同步、映射判断与待翻译批次；该文件不应包含敏感信息。
- 每个逻辑批次使用中文 Git 提交信息。涉及多 Agent 或批量同步时，在独立分支提交并通过 PR 合并。
- PR 描述必须注明来源、目录映射、已验证项和未完成项，并附身份标识，例如【CodeX-GPT】。
