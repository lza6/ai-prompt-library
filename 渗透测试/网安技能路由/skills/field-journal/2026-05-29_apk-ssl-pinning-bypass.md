# 经验记录: APK SSL Pinning 绕过

## 基本信息

- **日期**: 2026-05-29
- **目标类型**: APK
- **难度**: 中等
- **耗时**: 2 小时

## 任务描述

目标 APP 使用了 SSL Pinning，需要绕过后抓包分析 API 请求。

## 踩坑记录

### 坑 1: Frida Hook 不生效
- **现象**: 使用通用 SSL Unpinning 脚本后仍然无法抓包
- **原因**: 目标 APP 使用了自定义的 OkHttp CertificatePinner，不是标准的系统 SSL
- **解决**: Hook OkHttp3 CertificatePinner.check() 方法
- **代码**:
```javascript
Java.perform(function() {
    var CertificatePinner = Java.use('okhttp3.CertificatePinner');
    CertificatePinner.check.overload('java.lang.String', 'java.util.List').implementation = function(hostname, peerCertificates) {
        console.log('[+] Bypassing SSL Pinning for: ' + hostname);
        return;  // 直接返回，不做校验
    };
});
```

### 坑 2: APP 有 Root 检测
- **现象**: Frida 注入后 APP 直接闪退
- **原因**: APP 检测到了 su 二进制和 Frida server
- **解决**: 先用 Frida Hook Root 检测类，再注入 SSL Unpinning
- **代码**:
```javascript
// 先绕过 Root 检测
Java.perform(function() {
    var RootDetection = Java.use('com.app.security.RootDetection');
    RootDetection.isRooted.implementation = function() {
        return false;
    };
});
```

## 最终方案

1. 启动 Frida server（重命名为非标准名称避免检测）
2. 先注入 Root 检测绕过脚本
3. 再注入 SSL Pinning 绕过脚本（针对 OkHttp3）
4. 使用 Burp Suite 抓包

## 关键工具

| 工具 | 版本 | 用途 |
|------|------|------|
| Frida | 16.x | 动态 Hook |
| Burp Suite | 2024.x | HTTP 代理 |
| Objection | latest | 运行时探索 |

## 可复用的经验

- [ ] 是否需要更新 routing.md？否
- [ ] 是否需要更新 tool-index.md？否
- [ ] 是否需要新增 bootstrap 能力？否

## 标签

`APK` `SSL Pinning` `Frida` `OkHttp3` `Root检测绕过`
