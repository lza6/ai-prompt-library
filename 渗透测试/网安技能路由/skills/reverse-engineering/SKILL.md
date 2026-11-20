# 通用逆向工程

## 适用场景

- 二进制文件（ELF / PE / Mach-O）的静态和动态分析
- 使用 GDB / Frida / angr / Unicorn / Qiling 进行分析
- 反分析对抗（反调试、混淆、壳）
- 全语言平台逆向（C/C++/Go/Rust/Python/.NET/Java）
- CTF 逆向题

## 工具链

| 工具 | 用途 | 安装 |
|------|------|------|
| GDB + GEF/pwndbg | 调试器 | `apt install gdb` + GEF/pwndbg |
| Frida | 动态 Hook | `pip install frida-tools` |
| angr | 符号执行 | `pip install angr` |
| Unicorn | CPU 模拟 | `pip install unicorn` |
| Qiling | 高级模拟 | `pip install qiling` |
| Ghidra | 反编译 | 下载安装 |
| strings / objdump / readelf | 基础工具 | 系统自带 |

## 工作流程

### 1. 侦察阶段
```bash
file <target>              # 文件类型
strings <target>           # 可读字符串
checksec <target>          # 安全机制（NX/ASLR/PIE/Canary）
readelf -h <target>        # ELF 头信息
objdump -d <target>        # 反汇编
```

### 2. 静态分析
- 用 Ghidra / IDA 打开，分析 main 函数和关键函数
- 识别算法、数据结构、控制流
- 关注字符串引用和系统调用

### 3. 动态分析
- GDB 断点调试，观察运行时行为
- Frida Hook 关键函数，修改参数/返回值
- ltrace / strace 追踪库调用和系统调用

### 4. 高级技术
- angr 符号执行：自动探索路径
- Unicorn 模拟执行：隔离运行代码片段
- Qiling：完整 OS 级模拟

## 参考文档

- `tools.md` — 工具详细用法
- `tools-dynamic.md` — 动态分析工具（Frida/angr/Unicorn）
- `tools-advanced.md` — 高级工具
- `patterns.md` — 常见逆向模式
- `patterns-ctf.md` — CTF 逆向模式
- `anti-analysis.md` — 反分析对抗
- `languages.md` — 各语言逆向
- `languages-compiled.md` — 编译型语言逆向
- `go-reverse.md` — Go 逆向
- `platforms.md` — 各平台逆向
- `kernel-driver-reverse.md` — 内核驱动逆向
