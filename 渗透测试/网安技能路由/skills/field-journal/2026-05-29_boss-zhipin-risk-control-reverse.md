# 经验记录: BOSS直聘风控逆向分析

## 基本信息

- **日期**: 2026-05-29
- **目标类型**: Web (zhipin.com)
- **难度**: 困难
- **耗时**: 1 小时（含之前积累）

## 任务描述

逆向分析 BOSS 直聘网站的风控检测体系，理解其四层防御机制。

## 踩坑记录

### 坑 1: navigator.webdriver 是最直接的检测信号
- **现象**: Playwright 浏览器直接访问被 Code 37 拦截
- **原因**: navigator.webdriver = true 是自动化浏览器的明确标志
- **解决**: 使用 Camoufox (C++级指纹修改) 或真实 Chrome CDP

### 坑 2: zp_stoken 生成不够
- **现象**: 即使通过 security-js 生成了 zp_stoken，仍被 Code 35/36 拦截
- **原因**: BOSS 是多层检测，zp_stoken 只是 Layer 3，环境指纹(Layer 1)和行为(Layer 2)仍会触发
- **解决**: 必须同时解决所有四层检测

### 坑 3: Canvas 渲染防 DOM 抓取
- **现象**: document.querySelectorAll('.job-card') 返回空数组
- **原因**: BOSS 用 fabric.js 将职位卡片渲染到 canvas 上
- **解决**: 只能通过 API (/wapi/zpgeek/search/joblist.json) 获取数据

## 最终方案

四层防御的绕过策略:
1. Layer 1 (环境): Camoufox C++级指纹 或 真实Chrome
2. Layer 2 (行为): humanize=True 鼠标/键盘模拟
3. Layer 3 (网关): 自动生成 zp_stoken
4. Layer 4 (风控): 控制频率 + 使用真实账户

## 关键工具

| 工具 | 用途 |
|------|------|
| Camoufox | C++级Firefox指纹修改 |
| curl_cffi | TLS/JA3指纹绕过 |
| Chrome CDP | 控制真实浏览器 |
| Playwright | 浏览器自动化（需配合指纹修改） |

## 可复用的经验

- [ ] 是否需要更新 routing.md？否
- [ ] 是否需要更新 tool-index.md？否
- [ ] 是否需要新增 bootstrap 能力？否

## 标签

`BOSS直聘` `风控` `反爬` `指纹检测` `Web逆向` `Warlock` `zp_stoken`
