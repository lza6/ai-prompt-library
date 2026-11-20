# LLM/AI 安全测试

## 适用场景

- OWASP LLM Top 10 安全测试
- Prompt 注入（直接/间接）
- Agent 劫持
- 系统提示词提取
- 工具滥用

## 测试范围

| OWASP LLM | 测试内容 |
|-----------|----------|
| LLM01 | Prompt 注入 |
| LLM02 | 数据泄露 |
| LLM03 | 供应链攻击 |
| LLM04 | 数据与模型投毒 |
| LLM05 | 不当输出处理 |
| LLM06 | 过度授权 |
| LLM07 | 系统提示词泄露 |
| LLM08 | 向量/嵌入弱点 |
| LLM09 | 错误信息 |
| LLM10 | 无界消费 |

## 参考文档

- `references/owasp-llm-top10.md` — OWASP LLM Top 10 详解
- `references/prompt-injection-methodology.md` — Prompt 注入方法论
- `references/agent-security-testing.md` — Agent 安全测试
- `references/agent-obedience-engineering.md` — Agent 服从性工程
