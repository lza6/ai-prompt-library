# 越狱提示词（Jailbreak Prompts）

> 按目标模型归档的越狱/破甲提示词合集，用于 AI 红队评估、护栏测试与 CTF。内容为第三方开源项目原文，仅限授权安全研究使用。

## 目录结构

| 子目录 | 内容 | 文件数 |
|--------|------|--------|
| [jailbreaks按厂商](jailbreaks按厂商/) | togg53192-cmd/jailbreaks：26+ 个目标模型的完整破甲提示词，按厂商分目录（Anthropic/OpenAI/DeepSeek/智谱/月之暗面/xAI/腾讯/美团/小米/阶跃/阿里/隐身模型等），含 AGENTS.md、Modelfile、persona 锁与工作区策略 | 52 |
| [L1B3RT4S按模型](L1B3RT4S按模型/) | elder-plinius/L1B3RT4S：GODMODE 系列按模型归档（OpenAI/Anthropic/Google/DeepSeek/Grok/Meta/Microsoft/Perplexity/Brave/Cursor/Nous） | 12 |
| [Codex破甲](Codex破甲/) | Codex CLI (GPT-5.x) 破甲：xsser UNFILTERED MODE 基座提示词 + 1837620622 codex-red-team 无障碍覆盖提示词 | 2 |

## 各厂商索引（jailbreaks按厂商）

- **0x8D合集**（8）: BigPickle-opencode.md、chatgpt-free-tier.md、gemini-chat.md、gpt-new.md、grok-fast-v2.md、grok-fast.md、kimi-standard.md、mistral-small-4 (duck.ai).md

- **Anthropic**（4）: Sonnet v2.md、opus v1.md、opus v2.md、sonnet v1.md

- **DarkyHArry合集**（1）: Jaibreak Master.md

- **DeepSeek**（4）: deepseek v3.md、deepseek v4.md、deepseek-4-1.md、deepseekv4.1 and v4.1-1017.md

- **Google**（3）: Gemini-4-Argon.md、Gemini-4-Carbon.md、gemma4.md

- **Meta**（5）: Muse spark 1.3.md、Muse-spark-1-3-v2.md、Muse-wonder.md、muse-ai-AGENTS.md、muse-ember.md

- **Mistral**（1）: Mistral-Large-4.md

- **modemnakata**（1）: nemotron-3-ultra.md

- **OpenAI**（1）: gpt-oss-20b.md

- **raghavraut**（1）: gemini-3.1-pro.md

- **xAI**（2）: Grok build.md、grok-4.7.md

- **小米**（1）: mimo-2.6-agents.md

- **智谱AI**（6）: glm-5-3-flash.md、glm-5.2.md、glm-zcode-5.2.md、glm-zcode-5.3-AGENTS.md、glm-zcode-5.3.md、glm5-3opencode.md

- **月之暗面**（3）: kimi-k2.md、kimi-k3-agents.md、kimik3.1.md

- **美团**（1）: longcat-agents.md

- **腾讯**（1）: hy4-agents.md

- **阶跃星辰**（1）: Step-5-preview.md

- **阿里巴巴**（3）: qwen-3.7.md、qwen-3.8.md、qwen-preferences.md

- **隐身模型**（4）: Beam.md、Unified.md、crouton-alpha.md、spacebunny-agents.md

## L1B3RT4S 按模型索引

- [L1B3RT4S_ANTHROPIC](L1B3RT4S按模型/L1B3RT4S_ANTHROPIC.md)
- [L1B3RT4S_BRAVE](L1B3RT4S按模型/L1B3RT4S_BRAVE.md)
- [L1B3RT4S_CHATGPT](L1B3RT4S按模型/L1B3RT4S_CHATGPT.md)
- [L1B3RT4S_CURSOR](L1B3RT4S按模型/L1B3RT4S_CURSOR.md)
- [L1B3RT4S_DEEPSEEK](L1B3RT4S按模型/L1B3RT4S_DEEPSEEK.md)
- [L1B3RT4S_GOOGLE](L1B3RT4S按模型/L1B3RT4S_GOOGLE.md)
- [L1B3RT4S_GROK_MEGA](L1B3RT4S按模型/L1B3RT4S_GROK_MEGA.md)
- [L1B3RT4S_META](L1B3RT4S按模型/L1B3RT4S_META.md)
- [L1B3RT4S_MICROSOFT](L1B3RT4S按模型/L1B3RT4S_MICROSOFT.md)
- [L1B3RT4S_NOUS](L1B3RT4S按模型/L1B3RT4S_NOUS.md)
- [L1B3RT4S_OPENAI](L1B3RT4S按模型/L1B3RT4S_OPENAI.md)
- [L1B3RT4S_PERPLEXITY](L1B3RT4S按模型/L1B3RT4S_PERPLEXITY.md)

## Codex 破甲索引

- [codex-red-team_system-prompt](Codex破甲/codex-red-team_system-prompt.md)
- [xsser_codex-base-prompt](Codex破甲/xsser_codex-base-prompt.md)

## 来源与许可

| 上游项目 | 许可 |
|----------|------|
| [togg53192-cmd/jailbreaks](https://github.com/togg53192-cmd/jailbreaks) | MIT |
| [elder-plinius/L1B3RT4S](https://github.com/elder-plinius/L1B3RT4S)（经 lingbol088-spec/jailbreak-prompts 精选） | MIT |
| [xsser/codex-jailbreak-guide](https://github.com/xsser/codex-jailbreak-guide) | MIT |
| [1837620622/codex-red-team-prompt](https://github.com/1837620622/codex-red-team-prompt) | MIT |

> **使用声明**：仅供授权安全研究、红队评估、护栏测试与 CTF 竞赛使用；对未授权目标使用这些内容违规且违法。