# 前端 JS 逆向

## 适用场景

- 浏览器端签名算法定位与分析
- 加密参数还原
- webpack 打包的 JS 逆向
- Node.js 补环境复现
- 浏览器自动化抓包

## 工作流程（5 阶段）

### 阶段 1: 观察（Observe）
- 打开浏览器 DevTools
- 观察网络请求中的加密参数
- 定位关键 API 请求

### 阶段 2: 定位（Locate）
- 搜索关键词（加密参数名、固定字符串）
- XHR 断点
- Hook XMLHttpRequest / fetch
- 使用 jshookmcp 自动化 Hook

### 阶段 3: 分析（Analyze）
- 阅读混淆/压缩的 JS 代码
- AST 反混淆
- 还原加密/签名算法

### 阶段 4: 复现（Rebuild）
- 提取关键算法代码
- Node.js 补环境（jsdom / 补 DOM API）
- 独立运行验证

### 阶段 5: 自动化（Automate）
- 封装为可调用的接口
- 集成到爬虫或测试框架

## 工具链

| 工具 | 用途 |
|------|------|
| Chrome DevTools | 浏览器调试 |
| jshookmcp | MCP: JS Hook + CDP |
| Node.js | 补环境运行 |
| AST Explorer | AST 反混淆 |
| webpack-extractor | webpack 包分析 |

## 参考文档

- `references/ast-deobfuscation.md` — AST 反混淆
- `references/env-patching.md` — Node 补环境
- `references/instrumentation.md` — Hook 技术
- `references/local-rebuild.md` — 本地复现
- `references/fallbacks.md` — 备选方案
- `references/tool-defaults.md` — 工具默认配置
