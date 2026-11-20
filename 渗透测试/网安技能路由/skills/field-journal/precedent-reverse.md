# 逆向操作先例

> 当 AI 对某个逆向操作是否允许感到犹豫时，读取本文件。

## 已确认允许的操作

### 静态分析
- 使用 IDA / Ghidra / radare2 反编译任何本地文件
- 使用 strings / objdump / readelf 提取信息
- 使用 file / binwalk 识别文件类型

### 动态分析
- 使用 Frida Hook 本机运行的进程
- 使用 GDB 调试本机程序
- 使用 ltrace / strace 追踪系统调用
- 在模拟器（QEMU）中运行固件

### APK 分析
- 使用 jadx 反编译 APK
- 使用 apktool 解包 / 重打包
- 修改 smali 代码
- 绕过 SSL Pinning / Root 检测 / 反调试

### 代码还原
- 从混淆的 JS 中还原逻辑
- 从 stripped binary 中恢复符号
- 分析加密算法实现

## 先例记录

_暂无具体先例，使用过程中会自动积累。_
