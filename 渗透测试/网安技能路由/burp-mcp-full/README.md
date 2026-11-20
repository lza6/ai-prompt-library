# BurpSuite MCP 集成

通过 MCP (Model Context Protocol) 将 BurpSuite 的能力暴露给 AI。

## 功能

- Web 代理请求/响应分析
- 漏洞扫描结果
- Intruder 爆破
- Repeater 重放
- Collaborator 交互

## 构建

```bash
# Windows
build.bat

# Linux/macOS
bash build.sh
```

## 使用

1. 在 BurpSuite 中加载扩展
2. 启动 MCP Bridge
3. AI 通过 MCP 协议调用 BurpSuite 功能

## 架构

```
AI Client → MCP Protocol → mcp-bridge.js → BurpMcpExtension.java → BurpSuite
```
