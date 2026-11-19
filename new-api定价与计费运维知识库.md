# new-api 定价与计费运维知识库

> 来源：2026-11-17 P0 定价事故全链路处置。配套技能：`~/.claude/skills/new-api-billing-ops/`。
> 本文档是面向人的完整版（含事故叙事与决策依据）；技能是面向执行的速查版。

## 一、事故全记录（2026-11-17）

### 1.1 时间线（UTC）

| 时间 | 事件 |
|---|---|
| 00:00 前 | ModelRatio 表缺 137 个在售模型（unc-\*/kilo-\*/nex/onesearch/zro/IFM/HMS 等），全部落入 GetModelRatio 兜底 37.5（=¥75/M） |
| 08:57–09:34 | 37.5 兜底窗口：58 笔请求按天价展示计费（xin_dong 4944 万、管理员 2141 万展示额度） |
| 09:38–10:03 | 处置中误补 0.4 倍率（¥0.8/M），又错 720+ 笔 |
| 10:04 | v1.3.511 上线：兜底 37.5→0.1 + max_tokens clamp |
| 10:10–13:00 | jack001 的视频模型请求被预扣费 403 拒 20 笔（钱包 ¥0.37 不足预扣，但 2币 充足） |
| 13:04 | v1.3.513 上线：修复 isTwoAPIBillingChannel 对 nil ChannelMeta 的 panic（512 的回退逻辑因此从未生效） |
| 13:06 后 | jack001 成功 1 笔，403 清零；全站三类目标错误清零 |

### 1.2 根因链

1. **直接根因**：新渠道上线只配了 abilities（路由），没配 ModelRatio/ModelPrice（计费）。
2. **放大根因**：GetModelRatio 兜底 37.5 而不是报错/近零。
3. **二次事故**：处置时先补了 0.4 倍率（按 token 思路），与"本站按次计费"的产品口径冲突。
4. **三次隐患**：2币 预扣回退代码解引用了 nil 的嵌入指针 ChannelMeta，panic 被 gin recovery 吞成 500，回退从未生效——发版后要盯的不仅是"新功能是否工作"，还有"它依赖的路径是否真的走到"。

### 1.3 赔付台账（审计日志 model_name='refund-p0-*' 永久在案）

- 第一轮 refund-p0-pricing：11 用户，2.238 亿钱包额度（xin_dong 1.774 亿、管理员 4187 万）。
- 第二轮 refund-p0-coin：7 用户，2589 万 2币 折算（管理员 2519 万）。
- 第三轮（nex/zro 0.4 窗口）：核实 cost_quota=0 未真扣，无款可退，仅展示污染，随定价修正自然消失。

## 二、计费架构速记

```
请求 → GetAndValidateTextRequest（clamp max_tokens）
     → ModelPriceHelper（tiered_expr 优先 → ModelPrice 按次 → ModelRatio 按量）
     → PreConsumeBilling（钱包预扣；2币 渠道钱包不足时回退 TwoAPICoinFunding）
     → SettleBilling（2币 渠道 walletQuota=0，chargeTwoAPICoins 按实扣 2币）
     → logs（quota=展示折算值；cost_quota=钱包真扣；other.coin_cost=2币真扣）
```

- 2币 渠道清单：`constant/twoapi_channel.go` 的 TwoAPIChannelTypes（62-84、89、91-95）。挂在 `2api` 分组的普通渠道也算（ChannelGroupHasTwoAPI）。
- 汇率显示：`USDExchangeRate=1` 且 `quotaDisplayType=CNY` 时，前端 ¥ = ratio×2（1 ratio = $2/1M tokens）。
- 能力目录 clamp：`controller/model_caps_catalog.go` 声明 MaxOutputTokens 的模型自动 clamp 三协议输出上限。

## 三、运维守则（下次照做）

1. **新增渠道检查单**（缺一不可）：渠道行 + abilities 展开（unnest string_to_array）+ ModelPrice/ModelRatio 定价 + models 元数据（描述/标签/端点）+ 上线后 1h 错误巡检。
2. **改 options 表**：UPDATE 后必须重启容器；检查 docker inspect 的 env 确认新值进入；.env 变更必须重建容器（restart 不重读）。
3. **赔付**：以 cost_quota / 2币 微元流水为准，展示值仅供参考；事务内操作 + refund-p0-* 审计日志；永不改写原始扣费记录。
4. **发版**：走 scripts/gates.mjs → staging verify → backup-prod -Verify → deploy-zero-downtime.sh，禁手工 docker run/restart 生产。
5. **巡检口径**：错误分类先看是上游侧（CF 5xx/429/402 额度）、用户侧（端点用错/参数超限）、还是网关侧（panic/误路由/定价）——只有网关侧需要改代码。

## 四、相关资产

- 技能：`~/.claude/skills/new-api-billing-ops/`（速查）、`~/.claude/skills/new-api-release-forensics/`（发版取证）
- 渠道文档：`Desktop/编码规则/APK逆向知识库/` 各渠道对接指南
- 生产审计：logs 表 model_name IN ('refund-p0-pricing','refund-p0-coin')
