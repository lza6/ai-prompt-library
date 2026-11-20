# IDA Pro 逆向

## 适用场景

- 使用 IDA Pro 进行二进制深度分析
- 通过 MCP 协议让 AI 直接操作 IDA
- 反编译、反汇编、数据流追踪、交叉引用

## IDA MCP 集成

IDA Pro 通过 MCP (Model Context Protocol) 暴露 72 个工具给 AI：

### 核心工具分类

| 类别 | 工具数 | 功能 |
|------|--------|------|
| 反编译 | 8 | 获取伪代码、函数列表、变量 |
| 反汇编 | 6 | 获取汇编代码、指令详情 |
| 数据流 | 10 | 交叉引用、调用链、数据流追踪 |
| 类型系统 | 8 | 结构体、枚举、类型管理 |
| 标注 | 6 | 重命名、注释、书签 |
| 搜索 | 8 | 字符串、立即数、模式搜索 |
| 分段 | 6 | 段信息、内存布局 |
| 调试 | 12 | 断点、单步、内存读写 |
| 项目 | 8 | 文件信息、保存、导出 |

### 启动 MCP 服务

```powershell
# Windows
powershell -NoProfile -ExecutionPolicy Bypass -File "skills/ida-reverse/scripts/start.ps1"
```

### 使用流程

1. 用 IDA 打开目标二进制
2. 启动 MCP 服务
3. AI 通过 MCP 工具进行分析：
   - 获取函数列表 → 识别关键函数
   - 反编译关键函数 → 理解逻辑
   - 追踪数据流 → 理解输入输出
   - 查找交叉引用 → 理解调用关系

## 参考文档

- `references/ida-mcp-cheatsheet.md` — IDA MCP 工具速查表
