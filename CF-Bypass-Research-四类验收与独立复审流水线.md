# 四类验收流水线（CF-Bypass-Research 实战定稿）

> 2026-11-12 完成 13 领域独立代码复审 + 四轨验收全 PASS 后沉淀。
> 配套可复用 skill：`.claude/skills/four-track-acceptance/SKILL.md`（通用版）。
> 本文件保留项目-specific 的数字、文件名与踩坑记录。

## 一、验收编排（`python run.py accept`）

| 轨道 | 命令 | 证据 |
|---|---|---|
| verify（13 步） | `python run.py verify --skip-smoke` | coverage.json、evidence/e2e-local.json |
| UI 截图 | `python run.py ui` | evidence/ui-acceptance.json + plans/证据/ui-*.png |
| 真实调用 | `python run.py realcalls` | evidence/realcalls.json |
| 真实 E2E | `python run.py e2e` | evidence/e2e-local.json |
| 代码复审 | `python run.py review` | evidence/code-review*.md（13 份） |
| 汇总 | scripts/acceptance_report.py | evidence/acceptance.json |

- `verify` 步骤：pytest → coverage-gate → validate-docs → validate-openapi → gates-selftest
  → compileall → go vet/test -race → findings → e2e → smoke → repo-hygiene → research-doctor
  → service-report(golden)。fail-fast。
- `--fast`：只跑 test_runpy，跳过覆盖率产物、coverage-gate、validate-docs。
- `--skip-smoke`：离线环境跳过出网冒烟（记 SKIP，不冒充通过）。
- `accept --skip-browser`：与 UI 轨道冲突 → 写 `ui-acceptance-SKIPPED.json`，继续其余轨道，
  汇总判 partial。`accept --skip-review` 同理写 `code-review-SKIPPED.md`。

## 二、最终验收数字（2026-11-12）

- Python：1229 passed / 8 skipped（1237 收集）；solver 90.55%、captchas 27.20%；68 模块门禁全过。
- Go：vet 无输出，57 个测试 `-race` 绿。
- UI：70/70 断言 + axe 0（light/dark）+ 17 张截图。
- 真实调用：46/46（含 HEAD/OPTIONS/405/keep-alive/chunked）。
- E2E：40/40（真进程 + 真浏览器）。
- 复审：13 领域全 PASS。
- 站点：build/verify 14 路由 / axe 0 / E2E 22/22 / content 12/12；Lighthouse 桌面+移动 100×4。

## 三、复审实战记录（4 轮收敛）

每轮 FAIL → 修复 → 补回归测试 → 重审。真实修掉的问题：

1. detect：url 通配规则是死代码（collector-*.perimeterx.net 只出现在 body）→ 通配 url 规则
   匹配 URL+body；删除过宽的 `seed=` / `var _=[` 信号。
2. cf_fetch SSRF：补 target DNS + proxy URL + 实际 peer IP 三层校验、逐跳校验、跨主机丢
   Cookie、head 20k 上限、spill 截断标记。
3. ratelimit：一次逻辑请求只收一次令牌（`rate_state` 由 Solver.solve 实际扣费后置位）；
   BUSY/准入拒绝退款；`rate=0` 禁用；退款时钟统一 monotonic。
4. service：鉴权 fail-closed（None/bytes token、非 ASCII clientKey 转 bytes）；缓存条目
   `_cache_usable` 三查；直连写缓存也校验产物字段；`remember` 拒绝一次性 token 与 want 错配；
   关闭期排队失败不记代理头。
5. auth：token 锁从 O_EXCL+mtime 换成 OS 文件锁（msvcrt/fcntl），消除 stale-unlink TOCTOU；
   短写循环；追加前补换行；空 token 行跳过。
6. UI：无效 token 徽章/横幅、清除 token 停定时器、prompt 改内联输入、503 横幅、浅色 code
   对比度、`_x` chip 说明。
7. 入口：verify 纳入 validate-docs/openapi/gates-selftest；`run.py` node 路径拆分 bug
   （`['node','scripts','x.mjs']` → node 把目录当模块）。

## 四、复审基建的坑（重要）

1. **全量 diff（~700KB）喂 claude -p 必超时**：按领域拆分 + `--max-bytes` 截断 +
   `--context` 注入调用点与已接受约束。
2. **管道 stdin + capture_output 下 claude 等满超时**：大输入改文件重定向
   （prompt 写 `.prompt` 文件，`stdin=open(...)`），小输入（<12KB）管道没问题。
3. **VERDICT 可能丢**：被截断或后续拼接覆盖时，从 `.raw` 输出文件取最后一个
   `VERDICT:` 匹配补回；仍缺失按 FAIL。
4. **`--tools ""` 必加**：否则模型在 plan 模式输出工具调用语法噪声。
5. **subprocess 显式 `encoding="utf-8"`**：Windows GBK 控制台遇到 emoji 直接
   UnicodeEncodeError。
6. **模型会报假缺陷**：在 context 里给实现证据（helper 位置、测试名）让它复核；
   模型也会漏报——实现者仍需自己做最小复现。
7. **历史发布数字与当前 facts.json 并存是刻意设计**：changelog 保留发布时点的数字，
   benchmarks/facts 是当前值；复审前在 context 声明，否则被反复当缺陷。

## 五、UI 只读双页契约（statuspage.py / console_html.py）

- 鉴权 fail-closed：token 为 None/bytes/非 str → 401；只有显式空串是 `--no-auth`。
- 兼容层 clientKey 转 bytes 再 `compare_digest`（非 ASCII str 会 TypeError→500）。
- token 永不进 DOM `input.value`；保存后清空 input、只改 placeholder；空值保存=清除。
- CSP `script-src 'unsafe-inline'` 无 `unsafe-eval` → Playwright 必须传箭头函数。
- 健康徽章由 refreshHealth 独占；/audit 401 只在审计面板与横幅提示，不抢徽章。
- 503 是当前响应，不标 stale；请求本身失败才 markStale。
- 清除 token：停定时器 + 清面板 + 恢复按钮。
- 浅色主题 inline code 继承 `--ink`（对比度 4.19→≥4.5）。
