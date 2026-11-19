# 提示词库（Prompt Library）

个人 AI 工作流提示词与 SOP 知识库：覆盖全栈开发、代码审查、项目管理、交付验收、UI/UX、逆向工程方法论等场景。所有内容均为可复用的提示词模板与经验总结，按中文分类目录组织，可在本页索引中快速定位。

## 目录结构

```
提示词库/
├── 全栈语言系列/    # 各语言与专项技术提示词
├── UI设计/          # 前端界面、视觉与体验设计（含设计风格库）
├── 渗透测试/        # 安全测试与自动化渗透（含技能包/验证码对抗/威胁建模）
├── 文档生成/        # PRD 与技术文档
├── 工作流与执行/    # 任务执行、断点续作、元提示词
├── SaaS交付与质量/  # SaaS 全栈交付与项目质量
├── 代码审查/        # 代码审查与安全审计
├── 架构与专项/      # 后端架构、数据库、容器
├── Agent技能库/     # 可整包复用的 Agent 技能（SKILL.md 体系）
├── 元提示词/        # 系统提示词库与提示词模式研究
├── 文案创作/        # 去 AI 味、人味写作技能
├── 营销与电商/      # 营销技能与电商视觉文案
├── 产品经理/        # 产品方法论技能
├── 视频创作/        # 视频生成与发布预检技能
└── 逆向方法论/      # APK/JS 逆向与网关对接通用方法论
```

## 目录索引

### 全栈语言系列（`全栈语言系列/`）

| 文件 | 说明 |
|------|------|
| [AI 智能体架构师——15 步设计可用于生产的智能体](全栈语言系列/AI%20智能体架构师——15%20步设计可用于生产的智能体.txt) | 15 步设计生产级 AI Agent 的架构师提示词 |
| [创建完整的自动化 CICD 流水线](全栈语言系列/创建完整的自动化%20CICD%20流水线.txt) | CI/CD 流水线设计（GitHub Actions / GitLab CI / Jenkins 等） |
| [编写端到端测试](全栈语言系列/编写端到端测试.txt) | Playwright E2E 测试套件生成 |
| [构建高性能、可扩展的 Redis 缓存系统](全栈语言系列/构建高性能、可扩展的%20Redis%20缓存系统.txt) | Redis 缓存架构设计与性能优化 |
| [优化 React 应用性能](全栈语言系列/优化%20React%20应用性能.txt) | React Core Web Vitals 性能优化 |
| [全面的 Go 代码库审查](全栈语言系列/全面的%20Go%20代码库审查.txt) | Go 代码库深度审查 |
| [全面的 Python 代码库审查](全栈语言系列/全面的%20Python%20代码库审查.txt) | Python 代码库深度审查 |
| [终极 TypeScript 代码审查](全栈语言系列/终极%20TypeScript%20代码审查.txt) | TypeScript 代码库深度审查 |
| [死代码外科医生](全栈语言系列/死代码外科医生.txt) | 死代码扫描、分诊与清除流程 |
| [黑客防护员和病毒工程师](全栈语言系列/黑客防护员和病毒工程师.txt) | 安全防护与传播工程复合角色 |
| [需求引导](全栈语言系列/需求引导.txt) | 需求澄清与系统提示词生成 |

### UI设计（`UI设计/`）

| 文件 | 说明 |
|------|------|
| [专业UI设计](UI设计/专业UI设计.txt) | 专业 UI 设计提示词 |
| [打造具有流行动态和 3D 效果的惊艳 UIUX 设计](UI设计/打造具有流行动态和%203D%20效果的惊艳%20UIUX%20设计.txt) | 动效与 3D 视觉设计 |
| [改进已创建应用程序的 UIUX](UI设计/改进已创建应用程序的%20UIUX.txt) | 已有应用 UI/UX 改进 |
| [架构与用户界面用户体验审核](UI设计/架构与用户界面用户体验审核.txt) | 架构 + UI/UX 联合审核 |
| [引人入胜、视觉效果出色的落地页](UI设计/引人入胜、视觉效果出色的落地页.txt) | 高转化落地页设计 |
| [优化您的 Web 应用程序前端性能](UI设计/优化您的%20Web%20应用程序前端性能.txt) | 前端性能优化 |
| [优化重构前端UI](UI设计/优化重构前端UI.txt) | 前端 UI 重构 |
| [前端开发代理角色](UI设计/前端开发代理角色.txt) | 前端开发角色定义 |
| [UI 架构师代理角色](UI设计/UI%20架构师代理角色.txt) | UI 架构师角色定义 |
| [React  Next.js 前端架构师](UI设计/React%20%20Next.js%20前端架构师.txt) | React / Next.js 架构师 |
| [React 开发助手](UI设计/React%20开发助手.txt) | React 日常开发助手 |
| [TypeScript 专家](UI设计/TypeScript%20专家.txt) | TypeScript 专家角色 |
| [SEO 优化代理角色](UI设计/SEO%20优化代理角色.txt) | SEO 优化角色 |
| [SaaS 分析仪表盘 - 基于知识的前端提示](UI设计/SaaS%20分析仪表盘%20-%20基于知识的前端提示.txt) | SaaS 数据仪表盘前端 |
| [SaaS 落地页构建器](UI设计/SaaS%20落地页构建器.txt) | SaaS 落地页构建 |
| [saasUI优化师](UI设计/saasUI优化师.txt) | SaaS UI 优化师 |

### 渗透测试（`渗透测试/`）

| 文件 | 说明 |
|------|------|
| [自动化渗透测试](渗透测试/自动化渗透测试.txt) | CI/CD 集成自动化安全测试方案（DAST / 注入测试 / 报告） |

#### 技能包（`渗透测试/` 下子目录）

| 目录 | 说明 | 许可 |
|------|------|------|
| [Anthropic安全技能库818](渗透测试/Anthropic安全技能库818/) | Anthropic 开源网络安全技能库：818 个技能覆盖侦察/漏扫/利用/提权/后渗透/横向移动/持久化/报告/移动安全/云与容器安全 | Apache-2.0 |
| [Obsius中文攻防知识库](渗透测试/Obsius中文攻防知识库/) | AI 安全研究工作台：24 个中文攻防技能（外网打点/内网/提权/横向/逆向/取证/EDR 对抗等） | Apache-2.0 |
| [cloudflare安全审计技能](渗透测试/cloudflare安全审计技能/) | Cloudflare 官方安全审计 skill，把 Agent 变成安全审计员 | MIT |
| [验证码对抗/腾讯TCaptcha滑块求解](渗透测试/验证码对抗/腾讯TCaptcha滑块求解/) | 腾讯 TCaptcha 滑块拼图自动求解（CDP + 精灵图裁剪 + 拟人拖动） | MIT |
| [验证码对抗/阿里云滑块求解](渗透测试/验证码对抗/阿里云滑块求解/) | 阿里云滑块验证码机制分析与求解 | MIT |
| [威胁建模/grim-prompter威胁建模](渗透测试/威胁建模/grim-prompter威胁建模/) | 36 个架构视角的 AI 威胁建模提示词（API/云/容器/身份/供应链等，quick + deep 两档） | MIT |

### 文档生成（`文档生成/`）

| 文件 | 说明 |
|------|------|
| [产品和技术文档生成器](文档生成/产品和技术文档生成器.txt) | PRD 与技术文档生成 skill |

### 工作流与执行（`工作流与执行/`）

| 文件 | 说明 |
|------|------|
| [强迫AI真实现 1.0](工作流与执行/强迫AI真实现1.0.txt) | 防"伪完成"工作流契约 v1.0 |
| [强迫AI真实现 1.5](工作流与执行/强迫AI真实现1.5.txt) | 防"伪完成"工作流契约 v1.5 |
| [强迫AI真实现 2.0](工作流与执行/强迫AI真实现2.0.txt) | 防"伪完成"工作流契约 v2.0 |
| [强迫AI真实现 2.1](工作流与执行/强迫AI真实现2.1.txt) | 防"伪完成"工作流契约 v2.1（最新） |
| [自动跑通所有](工作流与执行/自动跑通所有.txt) | 主控代理：先规划、后执行、验收并汇总 |
| [继续完成上一步指令](工作流与执行/继续完成上一步指令.txt) | 断点续作指令 |
| [继续完成计划（项目版）](工作流与执行/继续完成计划（项目版）.txt) | 项目级计划续作指令 |
| [继续完成计划（web版）](工作流与执行/继续完成计划（web版）.txt) | Web 项目计划续作指令 |
| [自动合并main分支](工作流与执行/自动合并main分支.txt) | Git 多分支收拢 + 全量闭环审计 + 部署交付 |
| [结合上游的更新进行迭代我们的版本](工作流与执行/结合上游的更新进行迭代我们的版本.txt) | 上游同步 + 逐点验收审计 |
| [下一步改进计划的迭代](工作流与执行/下一步改进计划的迭代.txt) | 计划文档闭环审计与清理 |
| [文档排漏](工作流与执行/文档排漏.txt) | 文档真实验证排查（防文档滞后） |
| [优化提示词的提示词](工作流与执行/优化提示词的提示词.txt) | 元提示词：深度优化任意提示词 |
| [GLM破甲提示词](工作流与执行/GLM破甲提示词.txt) | GLM 模型角色扮演解绑模板 |
| [codex多开子代理](工作流与执行/codex多开子代理.txt) | 多子代理并行编排指令 |

### SaaS交付与质量（`SaaS交付与质量/`）

| 文件 | 说明 |
|------|------|
| [全栈项目质量](SaaS交付与质量/全栈项目质量.txt) | 全栈项目质量保障规范 |
| [全栈项目质量 2.0](SaaS交付与质量/全栈项目质量2.0.txt) | 全栈项目质量保障规范 v2.0 |
| [新saas全栈交付 1.0](SaaS交付与质量/新saas全栈交付1.0.txt) | SaaS 全栈交付流程 v1.0 |
| [新saas全栈交付 2.0](SaaS交付与质量/新saas全栈交付2.0.txt) | SaaS 全栈交付流程 v2.0 |
| [新saas全栈交付 3.0](SaaS交付与质量/新saas全栈交付3.0.txt) | SaaS 全栈交付流程 v3.0（最新） |
| [全栈工程师提示词 2.0](SaaS交付与质量/全栈工程师提示词2.0.txt) | 全栈工程师能力全景提示词 v2.0 |
| [全栈工程师提示词 3.0](SaaS交付与质量/全栈工程师提示词3.0.txt) | 全栈工程师能力全景提示词 v3.0 |
| [GPT5.6全栈规则提示词（codex版）](SaaS交付与质量/GPT5.6全栈规则提示词（codex版）.txt) | GPT-5.6 / Codex 全栈规则 |
| [参考同类项目 1.0](SaaS交付与质量/参考同类项目1.0.txt) | 同类项目对标与差距审计 |
| [参考同类项目 2.0](SaaS交付与质量/参考同类项目2.0.txt) | 同类项目对标与差距审计 v2.0 |
| [优化现有项目 1.0](SaaS交付与质量/优化现有项目1.0.txt) | 现有项目优化工作流 v1.0 |
| [优化现有项目 2.0](SaaS交付与质量/优化现有项目2.0.txt) | 现有项目优化工作流 v2.0 |

### 代码审查（`代码审查/`）

| 文件 | 说明 |
|------|------|
| [代码审查员](代码审查/代码审查员.txt) | 代码审查提示词 v1 |
| [代码审查员 2.0](代码审查/代码审查员2.0.txt) | 代码审查提示词 v2 |
| [代码审查员 3.0](代码审查/代码审查员3.0.txt) | 生产级首席工程师 + 全链路审计 v3.0 |
| [代码修Bug提示词](代码审查/代码修Bug提示词.txt) | Bug 定位与修复提示词 |
| [首席人工智能代码审查员 + 高级软件工程师架构师 Prompt](代码审查/首席人工智能代码审查员%20+%20高级软件工程师架构师%20Prompt.txt) | Principal 级审查 + 架构师规则 |
| [SaaS 安全审计 - OWASP Top 10 和多租户隔离审查](代码审查/SaaS%20安全审计%20-%20OWASP%20Top%2010%20和多租户隔离审查.txt) | OWASP Top 10 + 多租户隔离安全审计 |
| [第一性原理](代码审查/第一性原理.txt) | 第一性原理分析框架 |

### 架构与专项（`架构与专项/`）

| 文件 | 说明 |
|------|------|
| [后端架构师代理角色](架构与专项/后端架构师代理角色.txt) | 后端架构师角色（微服务 / API / 数据库 / 安全） |
| [docker容器专家](架构与专项/docker容器专家.txt) | Docker / docker-compose 优化专家 |
| [SQL优化专家](架构与专项/SQL优化专家.txt) | SQL 查询优化专家 |

### 逆向方法论（`逆向方法论/`）

> 只收录通用方法论与工作流，不含具体项目报告。

| 文件 | 说明 |
|------|------|
| [APK逆向2API工作流](逆向方法论/APK逆向2API工作流.txt) | APK 逆向 → 2API 交付通用工作流 |
| [APK逆向2API知识库](逆向方法论/APK逆向2API知识库.md) | APK 逆向 2API 方法论知识库（大而全，含坑位清单） |
| [new-api定价与计费运维知识库](逆向方法论/new-api定价与计费运维知识库.md) | new-api 网关定价 / 计费 / 退款运维 SOP |

#### 技能包（`逆向方法论/` 下子目录）

| 目录 | 说明 | 许可 |
|------|------|------|
| [js-reverse网页逆向技能](逆向方法论/js-reverse网页逆向技能/) | 网页端 JS 加密参数逆向与纯协议还原全流程（JSVMP/WASM/混淆/补环境） | MIT |
| [rev-skills逆向122技](逆向方法论/rev-skills逆向122技/) | 122 个逆向技能：恶意软件/固件/协议/移动/脱壳/反混淆/CTF | Apache-2.0 |

### Agent技能库（`Agent技能库/`）

> 收录可整包复用的 Agent 技能库（SKILL.md 体系），保留原包结构与许可文件。来源与许可见各包内 LICENSE。

| 目录 | 说明 | 许可 |
|------|------|------|
| [superpowers工程方法论](Agent技能库/superpowers工程方法论/) | 完整软件开发方法论技能集：TDD/系统化调试/计划编写/并行派发/代码审查收发/收尾 | MIT |
| [mattpocock工程技能](Agent技能库/mattpocock工程技能/) | Matt Pocock 工程技能 39 个：诊断循环/领域建模/实现规范/架构改进/PR | MIT |
| [tstack工作流技能](Agent技能库/tstack工作流技能/) | T3 工作流技能：council 多模型评审、sol-loop 审查循环、PR 全流程 | MIT |
| [compound-engineering复合工程](Agent技能库/compound-engineering复合工程/) | EveryInc 复合工程插件 36 技能：头脑风暴/计划/调试/评审/打磨/交接 | MIT |
| [产品工程技能包](Agent技能库/产品工程技能包/) | 产品工程 44 技能：AI 交付/发布门禁/测试推导/静态安全审计/SaaS 技术栈/增长 | MIT |
| [ljg思维技能包](Agent技能库/ljg思维技能包/) | 李继刚思维模型 26 个：追本之箭/类比/约束/机制/论文解读/表达 | MIT |
| [baoyu效率技能包](Agent技能库/baoyu效率技能包/) | 宝玉效率技能 22 个：图表/信息图/翻译/转 Markdown/公众号与社交媒体发布 | MIT |
| [argue多智能体辩论](Agent技能库/argue多智能体辩论/) | 结构化多 Agent 辩论引擎：独立分析 → 交叉质询 → 投票收敛 | MIT |
| [awesome-codex-subagents子代理](Agent技能库/awesome-codex-subagents子代理/) | 136+ 个 Codex 子代理定义（10 大类：核心开发/语言/基础设施/质量安全/数据AI/商业产品等） | MIT |
| [last30days舆情检索](Agent技能库/last30days舆情检索/) | 检索近 30 天 Reddit/X/YouTube/HN/GitHub 等平台真实讨论 | MIT |
| [ffmpeg多媒体处理](Agent技能库/ffmpeg多媒体处理/) | 本地 FFmpeg 多媒体处理技能（无云、无密钥） | MIT |

### 元提示词（`元提示词/`）

> 系统提示词原文库与提示词工程模式研究，适合研究优秀产品的提示词设计。

| 目录 | 说明 | 许可 |
|------|------|------|
| [claude-code-prompts模式库](元提示词/claude-code-prompts模式库/) | 独立撰写的 Claude Code 风格提示词模板：系统提示词架构/行为规则/工具指令/子代理/记忆/验证 | MIT |
| [awesome-system-prompts](元提示词/awesome-system-prompts/) | 知名 AI 产品系统提示词合集（Cursor/Manus/Devin/Lovable/Claude Code 等） | Apache-2.0 |
| [AI工具系统提示词中文库](元提示词/AI工具系统提示词中文库/) | 主流 AI 工具系统提示词中文翻译库（68 家产品） | MIT |
| [Fabric模式库256](元提示词/Fabric模式库256/) | Fabric 256 个提示词模式（分析/提取/总结/创作/安全等） | MIT |
| [opus5精确工程伙伴提示词](元提示词/opus5精确工程伙伴提示词/) | 单文件系统提示词：把啰嗦模型调成精确资深工程伙伴 | MIT |
| [HERO反过度防御](元提示词/HERO反过度防御/) | 防"堡垒式过度建设"的规则集：哈希/边界情况/评分表/过度建设四大反模式 | MIT |

### 文案创作（`文案创作/`）

| 目录 | 说明 | 许可 |
|------|------|------|
| [avoid-ai-writing去AI味](文案创作/avoid-ai-writing去AI味/) | 审计并改写内容，去除 AI 写作痕迹 | MIT |
| [humanize人味写作](文案创作/humanize人味写作/) | 基于 50+ 同行评审研究的"人味"改写技能（含 AI 检测对照） | MIT |
| [sepia去AI味写作](文案创作/sepia去AI味写作/) | 从话语层去除 AI 味的写作技能族（写/改/评/重构/复刻） | MIT |

### 营销与电商（`营销与电商/`）

| 目录 | 说明 | 许可 |
|------|------|------|
| [marketingskills营销53技](营销与电商/marketingskills营销53技/) | 营销技能 53 个：广告/SEO/ASO/漏斗/留存/冷邮件/联投/分析 | MIT |
| [电商视觉文案策划](营销与电商/电商视觉文案策划/) | 电商主图与详情页视觉策划 SOP：Storyboard 确认门 + 分品类合规边界 | MIT |

### 产品经理（`产品经理/`）

| 目录 | 说明 | 许可 |
|------|------|------|
| [nuwa女娲造人技能](产品经理/nuwa女娲造人技能/) | 输入人名/主题自动调研 → 提炼思维框架 → 生成可运行的人物视角 Skill | MIT |

### 视频创作（`视频创作/`）

| 目录 | 说明 | 许可 |
|------|------|------|
| [seedance-2.0视频技能](视频创作/seedance-2.0视频技能/) | Seedance 2.0 视频生成全渠道操作循环：提示词/首尾帧/对口型/IP 安全改写 | MIT |
| [guoshen视频过审预检](视频创作/guoshen视频过审预检/) | 小红书/抖音/B站/视频号发布前风险预检：语音/字幕/画面联合检查 | MIT |

### UI设计 · 设计风格库（`UI设计/设计风格库/`）

| 目录 | 说明 | 许可 |
|------|------|------|
| [awesome-design-68风格](UI设计/设计风格库/awesome-design-68风格/) | 68 种设计风格 Skill（brutalism/claymorphism/bento/editorial 等即用型设计系统指南） | MIT |
| [emilkowalski动效技能](UI设计/设计风格库/emilkowalski动效技能/) | Emil Kowalski 动效技能 19 个：动画构建/编排/性能/评审 | MIT |
| [unslop去AI味设计](UI设计/设计风格库/unslop去AI味设计/) | 把"AI 味 UI"改成有产品个性的设计：间距/颜色/图标/文案/排版逐层修 | CC-BY-4.0 |

## 使用说明

- 文件名即主题，`.txt` / `.md` 均为纯文本提示词，可直接复制到任意 LLM 对话或 Agent 系统中使用。
- 同名多版本（如 1.0 / 2.0 / 3.0）为迭代关系，优先使用最新版本。
- 部分提示词为英文或法文原文，使用时保持原文即可。
- `Agent技能库/`、`元提示词/` 及各分类下的技能包子目录为第三方开源技能包整包收录，保留原目录结构与 LICENSE；使用前请遵循各包许可与原仓库声明。

## 来源与许可（SOURCES）

本仓库在自有原创提示词之外，整包收录了以下第三方开源项目（均保留其原 LICENSE 文件）：

| 本仓库目录 | 上游项目 | 许可 |
|------|----------|------|
| Agent技能库/superpowers工程方法论 | obra/superpowers | MIT |
| Agent技能库/mattpocock工程技能 | mattpocock/skills | MIT |
| Agent技能库/tstack工作流技能 | t3dotgg/tstack | MIT |
| Agent技能库/compound-engineering复合工程 | EveryInc/compound-engineering-plugin | MIT |
| Agent技能库/产品工程技能包 | phuryn/product-engineering | MIT |
| Agent技能库/ljg思维技能包 | lijigang/ljg-skills | MIT |
| Agent技能库/baoyu效率技能包 | baoyu-skills | MIT |
| Agent技能库/argue多智能体辩论 | onevcat/argue | MIT |
| Agent技能库/awesome-codex-subagents子代理 | VoltAgent/awesome-codex-subagents | MIT |
| Agent技能库/last30days舆情检索 | mvanhorn/last30days-skill | MIT |
| Agent技能库/ffmpeg多媒体处理 | ffmpeg-skill | MIT |
| 元提示词/claude-code-prompts模式库 | claude-code-prompts | MIT |
| 元提示词/awesome-system-prompts | awesome-system-prompts | Apache-2.0 |
| 元提示词/AI工具系统提示词中文库 | system-prompts-and-models-of-ai-tools 中文翻译项目 | MIT |
| 元提示词/Fabric模式库256 | Fabric | MIT |
| 元提示词/opus5精确工程伙伴提示词 | fixing-smartass-opus-5 | MIT |
| 元提示词/HERO反过度防御 | HERO-Anti-OverDefense | MIT |
| 渗透测试/Anthropic安全技能库818 | Anthropic-Cybersecurity-Skills | Apache-2.0 |
| 渗透测试/Obsius中文攻防知识库 | ILOVCTRY/Obsius-AI | Apache-2.0 |
| 渗透测试/cloudflare安全审计技能 | cloudflare/security-audit-skill | MIT |
| 渗透测试/验证码对抗/腾讯TCaptcha滑块求解 | Jasper-Lian/tcaptcha-solver | MIT |
| 渗透测试/验证码对抗/阿里云滑块求解 | black-mouse-sha/aliyun-slider-solve | MIT |
| 渗透测试/威胁建模/grim-prompter威胁建模 | jmanico/grim-prompter | MIT |
| 逆向方法论/js-reverse网页逆向技能 | js-reverse-skill | MIT |
| 逆向方法论/rev-skills逆向122技 | dslsdzc/rev-skills | Apache-2.0 |
| UI设计/设计风格库/awesome-design-68风格 | awesome-design-skills | MIT |
| UI设计/设计风格库/emilkowalski动效技能 | emilkowalski/skills | MIT |
| UI设计/设计风格库/unslop去AI味设计 | heydamir/unslop | CC-BY-4.0 |
| 文案创作/avoid-ai-writing去AI味 | avoid-ai-writing | MIT |
| 文案创作/humanize人味写作 | humanize | MIT |
| 文案创作/sepia去AI味写作 | sepia | MIT |
| 营销与电商/marketingskills营销53技 | coreyhaines31/marketingskills | MIT |
| 营销与电商/电商视觉文案策划 | feichanggege/ecommerce-visual-copywriting-skill | MIT |
| 产品经理/nuwa女娲造人技能 | nuwa-skill | MIT |
| 视频创作/seedance-2.0视频技能 | seedance-2.0 | MIT |
| 视频创作/guoshen视频过审预检 | huangbai-AI/guoshen | MIT |
