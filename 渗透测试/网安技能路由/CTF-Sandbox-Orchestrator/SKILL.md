# CTF 竞赛全栈技能

> 40+ 子技能，覆盖 CTF 竞赛的各个方向

## 总控入口

当用户提到 CTF 相关任务时，路由到这里，然后根据题目类型分发到子模块。

## 子模块列表

| 模块 | 方向 | 目录 |
|------|------|------|
| Web 安全 | SQL注入/XSS/SSRF/SSTI/序列化 | `competition-web-runtime/` |
| 逆向工程 | 二进制逆向/算法还原 | `competition-reverse-pwn/` |
| Pwn | 栈溢出/堆利用/内核 | `competition-reverse-pwn/` |
| 密码学 | RSA/AES/古典密码 | `competition-crypto-mobile/` |
| 取证 | 磁盘/内存/网络取证 | `competition-forensic-timeline/` |
| 隐写 | 图片/音频/视频隐写 | `competition-stego-media/` |
| 移动安全 | Android/iOS | `competition-android-hooking/` |
| 云安全 | AWS/GCP/Azure | `competition-agent-cloud/` |
| 容器安全 | Docker/K8s | `competition-container-runtime/` |
| 域渗透 | AD/Kerberos | `competition-identity-windows/` |
| Prompt 注入 | AI 安全 | `competition-prompt-injection/` |
| JWT | Token 攻击 | `competition-jwt-claim-confusion/` |
| GraphQL | API 安全 | `competition-graphql-rpc-drift/` |
| 固件 | IoT/嵌入式 | `competition-firmware-layout/` |
| PCAP | 网络流量 | `competition-pcap-protocol/` |
| 恶意软件 | 样本分析 | `competition-malware-config/` |
| 供应链 | 依赖投毒 | `competition-supply-chain/` |

## 使用方式

1. 描述 CTF 题目
2. AI 根据题目特征路由到对应子模块
3. 按子模块的工作流解题
4. 完成后生成 writeup
