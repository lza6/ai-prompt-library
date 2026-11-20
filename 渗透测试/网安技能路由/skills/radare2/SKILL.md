# radare2 CLI 逆向

## 适用场景

- 使用 radare2 进行 CLI 二进制分析
- 快速反汇编、patch、搜索
- 脚本化批量分析

## 工具链

| 工具 | 用途 |
|------|------|
| r2 | 主分析工具 |
| rabin2 | 二进制信息提取 |
| rasm2 | 汇编/反汇编 |
| radiff2 | 二进制对比 |
| rafind2 | 模式搜索 |

## 常用命令

```bash
# 分析二进制
r2 -A target           # 自动分析

# 信息提取
rabin2 -z target       # 提取字符串
rabin2 -I target       # 文件信息
rabin2 -s target       # 符号表

# 反汇编
r2 -c 'pdf @main' target   # 反编译 main 函数

# 搜索
rafind2 -s "flag" target   # 搜索字符串

# 对比
radiff2 -s file1 file2     # 结构对比
```

## 参考文档

- `references/cheatsheet.md` — radare2 速查表
