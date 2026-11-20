# APK 逆向

## 适用场景

- Android APK 解包、反编译、修改、重打包
- smali 代码修改
- Frida Hook Java/Native 层
- SSL Pinning / Root 检测 / 反调试绕过
- 签名验证分析

## 工具链

| 工具 | 用途 | 安装 |
|------|------|------|
| jadx | Java 反编译 | GitHub Release |
| apktool | APK 解包/重建 | `apt install apktool` 或下载 |
| Frida | 动态 Hook | `pip install frida-tools` |
| adb | Android 调试桥 | Android SDK platform-tools |
| zipalign | APK 对齐 | Android SDK build-tools |
| apksigner | APK 签名 | Android SDK build-tools |

## 工作流程

### 1. 解包与反编译
```bash
# apktool 解包（获取 smali + 资源）
apktool d target.apk -o unpacked/

# jadx 反编译（获取 Java 源码）
jadx target.apk -d decompiled/
```

### 2. 静态分析
- 在 jadx 中搜索关键字符串（API key、URL、加密逻辑）
- 分析 AndroidManifest.xml（权限、组件、入口）
- 审查 smali 代码中的关键逻辑

### 3. 动态分析
- 启动 Frida server
- Hook 目标函数，拦截参数和返回值
- 绕过 SSL Pinning / Root 检测 / 反调试

### 4. 修改与重打包
```bash
# 修改 smali 代码后重打包
apktool b unpacked/ -o modified.apk

# 对齐 + 签名
zipalign -v 4 modified.apk aligned.apk
apksigner sign --ks debug.keystore aligned.apk
```

## 参考文档

- `references/frida-cookbook.md` — Frida Hook 食谱
- `references/frida-bypass-kit.md` — Frida 绕过工具集
- `references/android-advanced.md` — Android 高级技术
- `references/apk-security-checklist.md` — APK 安全检查清单
