# 经验记录: DCloud UniApp APK 逆向

## 基本信息

- **日期**: 2026-05-29
- **目标类型**: APK (DCloud UniApp)
- **难度**: 简单
- **耗时**: 30 分钟

## 任务描述

逆向分析华云学习系统 APK，提取业务逻辑、API接口、安全问题。

## 踩坑记录

### 坑 1: UniApp 业务逻辑不在 Java 层
- **现象**: jadx 反编译后主要看到 DCloud 框架代码，业务逻辑很少
- **原因**: UniApp 的业务逻辑在 assets/apps/xxx/www/app-service.js 中（Vue 编译产物）
- **解决**: 直接分析 app-service.js（3.9MB），用 grep 搜索 API 路径和关键逻辑

### 坑 2: apktool 解包正常但 smali 文件极多
- **现象**: 15667 个 smali 文件，大部分是框架代码
- **原因**: UniApp 框架 + 第三方库代码量巨大
- **解决**: 只关注 com/huayun 包下的自有代码（仅 4 个文件），其余跳过

## 最终方案

对于 DCloud UniApp 类型 APK，最高效的分析路径：
1. apktool 解包 → 看 AndroidManifest.xml 和 assets/ 结构
2. 直接分析 `assets/apps/{appId}/www/app-service.js` — 这是核心业务逻辑
3. grep 搜索 API 路径、域名、密钥、Token 逻辑
4. jadx 反编译只用于看原生层代码（自定义 Activity、SSL 配置等）

## 关键工具

| 工具 | 版本 | 用途 |
|------|------|------|
| apktool | 3.0.1 | APK 解包 |
| jadx | 1.5.5 | Java 反编译 |
| grep | 系统自带 | JS 代码搜索 |

## 可复用的经验

- [ ] 是否需要更新 routing.md？否
- [ ] 是否需要更新 tool-index.md？否
- [ ] 是否需要新增 bootstrap 能力？否

## 标签

`APK` `UniApp` `DCloud` `Vue3` `逆向` `教育APP`
