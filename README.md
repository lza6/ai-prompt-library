# 提示词库（Prompt Library）

个人 AI 工作流提示词与技能知识库：覆盖全栈开发、代码审查、项目管理、交付验收、UI/UX、安全测试、逆向工程、文案、营销、视频、产品等全领域。每个技能一个目录、一篇与目录同名的中文提示词主文件（含英文原版 frontmatter 与正文，附属 references/scripts 资料保留在同目录）。

## 目录结构与技能规模

| 分类 | 技能数 | 内容 |
|------|--------|------|
| [渗透测试](渗透测试/README.md) | 847 | Anthropic 安全技能 818 个按 18 个子类归档（Web与API渗透/云安全/网络与侦察/威胁情报与检测/恶意软件分析/容器与基础设施/取证与应急/身份与域渗透/漏洞利用/社工与钓鱼/合规与治理/移动安全/IoT与工控/AI安全/逆向分析/网络安全防护/综合与流程/安全审计）+ Obsius 中文攻防 25 + 验证码对抗 + 威胁建模 37 + 越狱提示词 66（jailbreaks 按厂商 54 / L1B3RT4S 12 / Codex 破甲 2） |
| [工作流与执行](工作流与执行/README.md) | 320 | Superpowers 方法论 15、MattPocock 工程技能 39、T3 工作流 9、复合工程 CE 36、产品工程 44、ljg 思维模型 26、多 Agent 辩论、舆情检索、ClaudeCode 提示词模式、Codex 子代理 136 等 |
| [逆向方法论](逆向方法论/README.md) | 123 | 网页 JS 逆向 + 通用逆向 122 技 + APK 2API 方法论 |
| [UI设计](UI设计/README.md) | 87 | 设计风格 68 式、Emil 动效 19 技、去 AI 味设计 |
| [营销与电商](营销与电商/README.md) | 53 | 营销 53 技（A/B测试/广告/SEO/漏斗/留存/冷邮件/定价等） |
| [视频创作](视频创作/README.md) | 31 | Seedance 2.0 视频生成 29 技 + FFmpeg 音视频 + 发布过审预检 |
| [产品经理](产品经理/README.md) | 16 | 女娲造人 + 15 个人物思维视角（Karpathy/费曼/芒格等） |
| [文案创作](文案创作/README.md) | 15 | 去 AI 味写作三系（avoid-ai-writing / humanize / sepia） |
| [全栈语言系列](全栈语言系列/) | — | 各语言与专项技术提示词 |
| [SaaS交付与质量](SaaS交付与质量/) | — | SaaS 全栈交付与项目质量 |
| [代码审查](代码审查/) | — | 代码审查与安全审计 |
| [架构与专项](架构与专项/) | — | 后端架构、数据库、容器 |
| [文档生成](文档生成/) | — | PRD 与技术文档 |

技能总计 1492 个；另有单文件提示词若干（`.txt` / `.md`）。

## 使用说明

- 技能：进入 `分类/技能目录/技能名.md` 即该技能的完整提示词，可直接粘贴给任意 LLM / Agent 使用；同目录 `references/`、`scripts/` 为其附属资料。
- 单文件提示词：`.txt` / `.md` 直接复制使用。
- 同名多版本（1.0 / 2.0 / 3.0）为迭代关系，优先使用最新版本。
- 部分提示词为英文或法文原文，使用时保持原文即可。

## 来源与许可（SOURCES）

技能内容来自以下第三方开源项目（原文保留，许可均允许再分发）：

| 上游项目 | 许可 | 技能数 |
|----------|------|--------|
| Anthropic-Cybersecurity-Skills | Apache-2.0 | 818 |
| VoltAgent/awesome-codex-subagents | MIT | 136 |
| EveryInc/compound-engineering-plugin | MIT | 36 |
| dslsdzc/rev-skills | Apache-2.0 | 122 |
| phuryn/product-engineering | MIT | 44 |
| mattpocock/skills | MIT | 39 |
| jmanico/grim-prompter | MIT | 37 |
| ILOVCTRY/Obsius-AI | Apache-2.0 | 25 |
| baoyu-skills | MIT | 22 |
| lijigang/ljg-skills | MIT | 26 |
| emilkowalski/skills | MIT | 19 |
| nuwa-skill | MIT | 16 |
| obra/superpowers | MIT | 15 |
| coreyhaines31/marketingskills | MIT | 53 |
| awesome-design-skills | MIT | 68 |
| seedance-2.0 | MIT | 29 |
| ffmpeg-skill | MIT | 13 |
| t3dotgg/tstack | MIT | 9 |
| claude-code-prompts | MIT | 3 |
| togg53192-cmd/jailbreaks | MIT | 54 |
| elder-plinius/L1B3RT4S（jailbreak-prompts 精选） | MIT | 12 |
| xsser/codex-jailbreak-guide + 1837620622/codex-red-team-prompt | MIT | 2 |
| sepia | MIT | 6 |
| humanize | MIT | 2 |
| onevcat/argue | MIT | 2 |
| heydamir/unslop | CC-BY-4.0 | 1 |
| cloudflare/security-audit-skill | MIT | 1 |
| Jasper-Lian/tcaptcha-solver | MIT | 1 |
| black-mouse-sha/aliyun-slider-solve | MIT | 1 |
| feichanggege/ecommerce-visual-copywriting-skill | MIT | 1 |
| huangbai-AI/guoshen | MIT | 1 |
| js-reverse-skill | MIT | 1 |
| mvanhorn/last30days-skill | MIT | 1 |
| fixing-smartass-opus-5 | MIT | 1 |
| HERO-Anti-OverDefense | MIT | 1 |
| awesome-system-prompts | Apache-2.0 | — |
| system-prompts-and-models-of-ai-tools 中文翻译项目 | MIT | — |
| Fabric | MIT | — |
