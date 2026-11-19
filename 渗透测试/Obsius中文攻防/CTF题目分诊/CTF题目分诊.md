---
name: CTF 题目分诊入口
description: 拿到题包/远程服务/模糊题面时先判类别（web/pwn/reverse/crypto/forensics/misc/ai），再交对应能力包技能，避免开局走错方向
keywords: 分诊, 入口, 开局, 题包, 不知道, 从哪, 下手, 判类, triage, 题目分类
features: unknown_file_type
task_types: triage
mode: self-contained
---

# triage —— CTF 题目分诊（本技能只分诊，不深挖）

> 拿到一道题（题包 / 远程地址 / 一句模糊描述）不知道从哪下手时先走本流程。
> **分诊的唯一产物是一张分诊卡片**（Step 2 末尾），产出即交付、即结束分诊职责。
> 解题是专家的事，不是分诊的事——见下方「硬出口」。

## 硬出口：判定出类别就 deliver，不要往下做（2026-10-31）

分诊出结论后，**立刻**调 `deliver` 交一张卡片，然后本轮可以收尾：

```
载体：<文件类型 / 魔数 / 协议，实测得到的>
类别：<web / pwn / reverse / crypto / forensics / misc / ai-ml>
可入手面：<1-3 个具体方向，每个一句话说「查什么」>
已排除：<明确否定的方向 + 一句话依据>
建议派发：<给主控的方向清单，彼此不相似>
```

**为什么必须停**：主控拿到这张卡片才能派专家并行开工。你多做的每一步（
试偏移、找 gadget、跑 exploit）都会让主控**晚一步**拿到方向，整条链是串行的——
实测有分诊跑了近一小时才回主控，主控期间什么都不能派。深挖是解题专家的
职责，不是分诊的。

> 若你想继续做（用户允许分诊交付后继续跑），**先 deliver 再继续**，两者不冲突：
> 交付是给主控的闸门，继续做是你自己的探索。但永远先交。

## Step 0：先查库，再动手（30 秒，别跳）

拿到题面/附件后，**第一条命令之前**先 `kb_search` 一次。分诊阶段查库查的是
「这类形态通常怎么开局」，不是查答案——命中就 `kb_open` 读正文，再进 Step 1。

| 手上是什么 | 先查什么 |
|---|---|
| 看不出类型的附件 | `kb_search("<扩展名或魔数特征>")`、`route_lookup("<现象词>")` |
| 二进制（ELF/PE） | `kb_search("ELF 逆向 入口点")`、`kb_search("upx 脱壳")` |
| 压缩包 | `kb_search("zip 伪加密")`、`kb_search("压缩包 密码")` |
| 流量包 | `kb_search("pcap 提取 凭据")`、`kb_search("流量分析 隐蔽信道")` |
| 图片/音频 | `kb_search("图片 隐写 LSB")`、`kb_search("音频 频谱")` |
| 磁盘/内存镜像 | `kb_search("内存镜像 取证")`、`kb_search("磁盘 恢复 分区")` |
| 大整数/密码题 | `kb_search("RSA 小公钥指数")`、`kb_search("格攻击 lattice")` |
| 题面有明确技术词 | `kb_search("<那个词>")`，如 `kb_search("SSTI")` |

**一次零命中换个说法再查一次**（中文/英文、术语/现象各试一次），两次都不对口
才转自己探索——不要因为一次没中就再也不查。库里是历史踩坑沉淀，凭记忆拼命令
是分诊阶段最常见的浪费。

## Step 1：五件事侦察（顺序执行）

1. **列文件**：附件 zip **先调 `unpack_attachment`**（path=附件行给的
   `/workspace/artifacts/attachments/<zip>`）——服务端一次完成清旧残留+安全解压，
   落到 `scratch/att-<sha12>/` 并回结构化清单；**不要**用 run_cmd 拼
   `unzip -o`（只覆盖同名文件，同题重开时上轮分析脚本会整批残留进目录清单，
   把上下文淹掉）。已有解压目录时 `ls -lat` 看新旧（时间排序，残留一眼可辨）。
   对每个文件看真实类型：`file` 逐个点名，或
   `find . -maxdepth 1 -type f -exec file {} +`——**`file *` / `md5sum *` 遇到
   子目录直接报错**（`md5sum: xxx: Is a directory`，exit=1）。
2. **命令链拆开发**：`&&` 串起来时前半条报错会吞掉后面全部观察——用 `;` 或
   分多次 run_cmd，单条失败不阻断其余侦察。
3. **字符串/魔数**：二进制 `strings -n 6`、`xxd | head`、binwalk 扫附加数据；
4. **取题面上下文**：描述/文件名/注释/附件里的提示词，给了 URL 先 GET 看一眼；
5. **摸远程**：`nc host port` 连一次，看它要什么（交互菜单/数学题/HTTP/受限 shell）；
6. **记 flag 格式**：题面或规则里的前缀（flag{ / CTF{ / 自定义），最后校验要用。

附件本体落 `bb_add_asset`（type=binary，value=sha256，meta 记类型/保护），
分诊结论落 `bb_add_finding`（vuln_class=triage）——后续会话不重复分诊。

> **CTF 轨边界（2026-10-21，实测事故）**：只有**附件本体**登记 binary，且**不要传
> parent_id**——自动挂到本题资产下。`unpack_attachment` 解压出来的 zip 内文件
> **不是资产、不要登记**（路径已在解压回执里，直接读；登记会落成根级 binary，
> 在题目页被渲染成「又声明了一道题」）。value 必须是文件**真实 sha256**
> （编造/抄错的哈希没有下游能反查，还会绕开同值去重）。

## Step 2：判类别（文件类型 → 类别）

| 附件/服务形态 | 类别 | 转谁 |
|---|---|---|
| URL / HTML/JS/PHP 源码 / HTTP 服务 | web | web 包：外网打点入口 |
| **URL 首页是纯静态页（游戏/工具/Canvas），无后端接口** | **web-前端逆向** | **web 包：前端 JS 逆向与混淆还原**（见下方 Step 2.5） |
| `.elf/.exe/.so/.dll`/无扩展名二进制 + **有远程服务** | pwn | binary 包：二进制利用手法（先 附件分诊 看保护） |
| 同上但**纯离线、要校验算法/序列号** | reverse | binary 包：二进制逆向手法 |
| `.py/.sage/.txt` 里是大整数 / `.pem/.pub` | crypto | crypto 包：密码学手法 |
| `.pcap/.raw/.dd/.evtx/.vmem`、看不到内容的图片音视频 | forensics | forensics 包：取证与隐写 |
| `.apk/.wasm/.pyc` | reverse（先） | 二进制逆向手法 |
| `.safetensors/.pt/.pth/.onnx`、prompt/LoRA 字眼 | ai-ml | misc 包（kb_open `misc/AI安全/AI、ML 题总入口.md`） |
| 编码套娃/jail/受限 shell/信号/游戏/小众语言 | misc | misc 包（kb_open `misc/知识库.md`） |
| 只有"找谁/在哪/什么时间"线索 | osint | forensics 包：取证与隐写 的 OSINT 段 |
| 混淆脚本/C2 流量/疑似恶意 PE | malware | binary 包：二进制利用手法 §1（**默认恶意，只静态**） |

题面关键词直判：buffer/ROP/heap/libc→pwn；RSA/AES/nonce/lattice→crypto；
XSS/SQL/JWT/SSRF→web；disk/memory/pcap/spectrogram→forensics；
packed/beacon/jail/encoding→malware/misc。

nc 行为：长输入崩溃→pwn；出数学题→crypto；受限 shell/eval→misc(jail)。

## Step 2.5：Web 题先分流「静态前端」还是「有后端」

> Web 类别内部还要再分一次。**纯静态前端题打注入/上传/爆破是空转**，
> 20 分钟过去一个包都没打进去，是分诊阶段最常见的浪费。

判据（同时命中 ≥3 条即判定为静态前端题）：

1. 首页响应头 `Server:` 为 nginx/openresty/Apache，`Etag`/`Last-Modified` 呈
   **静态文件特征**（如 `Etag: "7ad-5ccfc80d7bb40-gzip"`），无 `Set-Cookie`、无 `X-Powered-By`
2. 目录扫描（dirsearch/ffuf 全字典）只出 `index.html` + `js/` + `src/` + `images/`
   + `favicon.ico`（目录本身 403 禁列），**没有任何 .php/.jsp/.do 动态端点**
3. 全站 JS grep 不到 `XMLHttpRequest` / `fetch(` / `document.cookie` / `token` / `/api`
4. 页面是**游戏、计算器、登录壳、验证工具**（HTML5 小游戏 / Canvas 动画最常见）
5. 换个 path 或加 `?a=1` 时返回的是**前置代理自己的 404 页**（如 nginx 的
   `<center>404 Not Found</center>`），而不是应用框架的报错——说明没有应用层

判定成立 → 类别记为 **web-前端逆向**，在分诊卡片里写明
「转 `web/实战打法/前端 JS 逆向与混淆还原.md`」——**由解题专家去 open，不是你**。
flag 通常在 obfuscator.io 字符串数组 + RC4/XOR 里。

判据不成立（有动态端点/有 API/有登录态）→ 类别记为 **web（有后端）**。

## Step 3：出卡片并 deliver（本步骤是终点）

把 Step 1-2 的观察压缩成一张卡片，调 `deliver` 交出去，然后收尾：

```
载体：<文件类型 / 魔数 / 协议，实测得到的>
类别：<web / web-前端逆向 / pwn / reverse / crypto / forensics / misc / ai-ml>
可入手面：<1-3 个具体方向，每个一句话说「查什么」>
已排除：<明确否定的方向 + 一句话依据>
建议派发：<给主控的方向清单，彼此不相似>
```

**不要**在这里解出 flag、写 exploit、做深度分析——那些是解题专家的活。
若你判断有把握并想继续（用户允许交付后继续跑），**先 deliver 再继续探索**；
交付是给主控派发的闸门，绝不能因为「想先做完」而推迟。
