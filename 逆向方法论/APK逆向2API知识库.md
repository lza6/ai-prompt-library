# APK 逆向 → 2API 交付知识库

> 跨项目方法论沉淀。案例：NoTrackAI、OpenChat、Imagenai、Imagerator、AI视频成片、Nano Banana、phota3a、**Photoroom**。
> 配套：skill `~/.claude/skills/apk-to-2api/SKILL.md`（9 步 SOP + 阶段二 new-api 移植）、memoir `apk-2api-sop`（知识图谱）、ICM topic `context-new-api-Max`。

---

## 一、鉴权模式全谱（按破解难度升序）

| 模式 | 识别特征 | 破解要点 | 案例 |
|---|---|---|---|
| 无鉴权 | 400 missing_image 而非 401 | 直接调 | Photoroom segmentation |
| 静态 key | 硬编码 header（X-App-Key 等） | grep dex 字符串 | NoTrackAI |
| 动态签名 | X-App-Sig = f(签名证书) | SHA1/SHA256 离线复现 | NoTrackAI（`g50.java`） |
| **Firebase 匿名** | dex 有 FirebaseAuth + AIza key | 见下节 | **Photoroom** |
| magic code / 短信 | request-code 端点 + 验证码 | 需真实邮箱/手机；device_id 伪造可绕时优先 | Imagenai、AI视频成片 |
| 服务器 RSA 下发凭据 | findConfig 类接口 + 内嵌私钥 | raw socket 调接口解密 | Nano Banana |
| Play Integrity / 设备指纹 | 设备注册接口 + 硬件证明 | 模拟器农场或放弃 | nano-banana 教训 |

### Firebase 匿名链路（Photoroom 实战，通用性强）

```
① 注册（免验证）
POST https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=<AIza...>
  X-Android-Package: <app 包名>          ← 缺一即 403 API_KEY_ANDROID_APP_BLOCKED
  X-Android-Cert: <官方签名 SHA1>        ← 破解壳 bin.Apk.daddy 内嵌 PEM → sha1
  {"returnSecureToken": true}
→ {idToken(1h), refreshToken(永久), localId}

② 刷新（离线可持续）
POST https://securetoken.googleapis.com/v1/token?key=...
  grant_type=refresh_token&refresh_token=<rt>

③ 上游调用（⚠️ 关键差异）
Authorization: <裸 idToken>     ← 不带 Bearer！带 Bearer 反而 403 "Firebase: Invalid token"
```

SHA1 提取三种来源：① SignatureKillerEx 壳内嵌 PEM（破解版特有，最方便）② 正版 APK `keytool -printcert` ③ app 内硬编码字符串。

### 免费号池模式（Imagerator 首创，注册无验证时）

`device_id=uuid4().hex` 伪造注册 → `[id, credits, ts]` 池 + `_pool_lock` 并发安全 → 耗尽先同步上游真实余额 → 仍不足注册新号（重试 3）→ `device_pool.json` 持久化。Go 移植版见 `device-pool-golang` memoir 概念。

---

## 二、协议还原方法论

### 2.1 端点发现
1. 全 dex grep `https?://` → 排噪（google/play/ads/crashlytics）→ 业务域名清单
2. dex 内 grep 版本化路径 `"v[0-9]/..."` → 端点+所在接口类
3. Retrofit 接口类直接读：注解+参数即完整请求定义

### 2.2 R8 混淆注解还原（行为验证法）
jadx 会把 `retrofit2.http.*` 重命名成 b7c/i3l/h3l 等短名，dex 里 retrofit 字符串被 strip。**别猜，实测**：

| 混淆名 | 真身 | 判据 |
|---|---|---|
| `@b7c` | GET | gfonts json 下载类端点 GET 实测 200 |
| `@i3l` | POST | 带 @ur3 body；405 探测 |
| `@tgj` | Multipart | 多 Part 参数 |
| `@eel` | Part | MultipartBody.Part 参数 |
| `@ptn` | Query | 原始类型参数 |
| `@s7d` | Header | String 参数 |
| `@ur3` | Body | POJO 参数 |

405 响应自带 allowed methods（NestJS 最详细），一发就能确认。

### 2.3 host 归属（多服务器 app 必查）
同一 app 的端点分布多台上游，**打错 host = 404/502/500 假象**。查 Retrofit 装配（搜 `RetrofitPhotoroom*` / `n1p.b("https://...")` / nz5 型 switch-case 工厂）。
> Photoroom 教训：inpaint 502 卡了半小时，真因是 host 该是 segmentation-inference 而非 serverless。

### 2.4 multipart 字段名（逐台探测）
各上游字段名可能不一致（Photoroom: `sourceImage` / `imageFile` / `maskFile` 三种）。探测信号：
- 400 `missing_image`（Flask）= 字段名错
- 403 鉴权错 = **字段名对了**（走到鉴权层了）
- 422 `field required: body.imageFile`（FastAPI）= 直接告诉你字段名

### 2.5 b64 图片上传
先试裸 base64，再试 `data:image/...;base64,` 前缀。Photoroom inpaint：裸 b64 ✅、data-uri 500。反过来也有 app。

---

## 三、坑位总表（按事故率排序）

| 坑 | 症状 | 解法 |
|---|---|---|
| **Authorization 带 Bearer**（Firebase Admin 后端） | 403 Invalid token | 裸 token |
| **Firebase key 双头缺失** | 403 API_KEY_ANDROID_APP_BLOCKED | X-Android-Package + X-Android-Cert |
| **multipart 字段名错** | 400 missing_image | 逐个候选名探测（sourceImage/imageFile/image/file） |
| **host 打错** | 404/502 假象 | 查 Retrofit 装配 |
| **405 误判为 POST 端点** | 全部 405 | GET+query 实测（magic code 类常是 GET） |
| **mask 面积过大** | 上游 500 无 detail | mask <50% 面积 |
| **上游偶发 IncompleteRead** | 偶发 500/502 | 重试；画布尺寸用目标值（勿变形） |
| **uncrop/画布类** | 随便传图报 decode 失败 | 需按目标尺寸构造画布+mask（读 app 端构造类） |
| **passthrough 跳过 Convert**（new-api 阶段二） | 上游收缺省字段 422 | DoRequest 里统一判空补默认 |
| **改代码没生效** | 旧进程占端口 | `taskkill //F //IM python.exe` 全杀再启 |
| **凭据两套并存** | 一套能用一套死 | 分别实测权限矩阵 |
| **模拟器干扰** | app 行为异常 | `pm disable-user` 禁用分析残留 app |
| **`data` 是 String 就当明文 JSON** | 解密后全是乱码/解析失败 | 先看 base64 是否以 `U2FsdGVkX1`（`Salted__`）开头 → CryptoJS AES，见 Case 12 |
| **成功码只判 `code == 0`** | 部分端点恒判失败，但 HTTP 全 200，很安静 | 写成 `code in (0, 200)`；`/category/` 实测返回 200 |
| **按 token 加全局锁** | 并发 64 和 1 的 rps 一模一样（本例卡 1.2rps） | 只对"已有 conversation_id"的会话加锁；新会话必须并行 |

---

## 四、压测规范

- **只压自己的 demo server，绝不压上游**（红线）
- 场景组合：轻端点（health ×200 c10 + ×60 c60）→ 核心能力（×4~12 c2~c4）→ 错误路径（no-auth 401 / unknown 404 / no-image 400 / 边界值 clamp）
- 指标：ok/n、p50、p95、sample_codes
- 结论模板：网关自身开销（轻端点 p50）vs 上游推理耗时（核心端点 p50），分开报

## 五、交付清单（每个 2API 项目）

```
D:/{app}-2api-app/
├── demo_server.py      # ThreadingHTTPServer, 网关+网页demo, token自动注册/刷新/持久化
├── stress_test.py      # 9+ 场景
├── README.md           # 端点清单/鉴权链路/压测表/坑位/关键反编译文件
├── PROTOCOL.md         # 协议笔记（UTF-8!）
├── anon_token.json     # token 持久化(gitignore)
└── .gitignore          # jadx-out/ apk-unzip/ *.apk demo.log
```

GitHub：`lza6/{AppName}-2API-APP` + topics `reverse-engineering,android,apk-analysis,security-research,2api`
记忆：ICM `context-new-api-Max`（进度）+ memoir `apk-2api-sop`（方法图谱）+ 本文件更新

## 六、new-api 移植速查（阶段二）

- 渠道 type 从 68 起找空位（已占 62-67）；6 文件注册链见 SKILL.md
- 适配器模板选型：单轮 JSON→kilwa / SSE→notrack / 异步任务→imagerator / **图像编辑类→Photoroom 模式**（`relay/channel/photoroom/` 待建：ConvertImageRequest 分流 mask/upscale/erase/fill/inpaint/uncrop）
- 验证门禁：`go build ./...` + `go vet` + `go test` + `bun run build` + version-consistency
- 生产部署：git clone 秒建（勿 tar 610M）、VERSION 文件定镜像版本、deploy-zero-downtime.sh 蓝绿、显式 INSERT abilities
- E2E：`tokens 表 id=48` 取 key，Caddyfile 查当前端口 3000/3001

---
*更新: 2026-10-27 · Photoroom 案例并入*

---

## Case 7: Begamob ChatAI 35.2.8 — JWT 自签协议（2026-10-28）

**App**: com.begamob.chatgpt_openai (Begamob「Chat AI」) v35.2.8, 43MB, 7 dex / 27628 类, 无壳。
**交付**: [lza6/Begamob-app-2api](https://github.com/lza6/Begamob-app-2api) · 本地 D:/apk-analysis/chatai-3528/

### 鉴权链
- 客户端自签 JWT HS256：密钥 `stteam-ikameglobal-chatapiopenai` 硬编码于 `rf.java`（jadx 搜 `hmacShaKeyFor` 一步命中）
- claims: `{iat, exp(秒级!), bundleId, os:Android, versionApp}` — exp 用毫秒 401 `auth_invalid`，秒级 200
- Header: `user-header` + `User-Agent`（bundleId/versionApp/deviceId 拼接），userId 空可过、deviceId 任意 = 无设备绑定

### 端点面
| 端点 | 状态 |
|---|---|
| POST /api/v1/chat, /api/v1/chat_v4 | ✅ 打通（OpenAI 格式请求） |
| /api/v1/chatCustom(v2/v3), /api/v2/chat(带图), topic_chat, summarize_chat, suggestChatQuestion, generate_art | 已还原未逐测 |
| GET /api/getTime → {token:毫秒ts} | ✅ |
| wss /api/v1/ws/chat | ❌ 服务端 404（客户端代码在、上游关） |

### 响应特性
非 OpenAI 标准：`{type:"com.ikame.model.ResponseResultDto.ChatCompletionDto", choices:[...]}` 无 id/usage；**无效模型名兜底 200**；错误 401={error:{code,message:auth_invalid}}，400=Spring 默认体。

### 压测定论（含补测）
50 并发 50/50、90 连发零 429 — **无 IP 限流、无设备绑定、密钥自签可无限签发**。
**上下文硬上限（二分法实测）= 128K 中文字符**：127,900 过 / 128,000 报 400 `request_invalid`，与 OpenChat 同源阈值；渠道层 127K 截断保护。
**WS 流式定案关闭**：`/api/v1/ws/chat` 7 种变体全 404（裸握手/子协议/路径变体/chat-ai-iaa 域/aiapi-art 域），客户端代码在、服务端未注册 — 无真流式可切，2API 网关模拟 SSE。

### 可复用经验
1. JWT 自签型是最优逆向目标：搜 `hmacShaKeyFor` 直接出全部秘密
2. Retrofit interface = 端点地图，一次 grep 全出
3. 动态抓包前先手动 WS HTTP 握手验证端点存在性（省 2 小时模拟器折腾）
4. Windows curl 下载 GitHub 资产需 `--ssl-no-revoke`

---

# OpenChat 1.4.2 (dialgptapi) 实战记录 — 2026-10-28

## 目标
- App: AI Chatbot Assistant 1.4.2 (ALONEYTMODS 破解版), 包名 `ai.assistant.ask.chatbot`
- OpenChat 1.3.4 的换代版本 — **协议彻底重写**（旧 gptapi.rotech.dev AES 体系全废）

## 协议（明文 REST，已实测打通）
| 项 | 值 |
|---|---|
| 基址 | `https://api.dialgptapi.com/v1/` |
| 认证 | Firebase 匿名注册 → `/auth/login` → Bearer JWT (1h) + refresh (30d) |
| 聊天 | `POST /ai/services/{gpt|gemini|grok|deepseek}`，OpenAI 格式 + SSE |
| 模型 | 免费白名单: gpt-5-nano / gpt-4.1-2025-04-14（gpt-4.1-nano 已 deprecated） |

## 风控破案（方法论价值最高）
**去重键 = `revenue_cat_app_user_id`（实为 android_id），与 IP 无关**
- 变量隔离实验: 同 IP + 不同 rc_id → 新 user_id；不同 IP + 相同 rc_id → 仍归并
- 免费额度精确 = **6 次/user_id**；rc_id 任意伪造 = 无限用户
- Firebase 注册本身同 IP 无频控
- **渠道结论: 直连即可，无需代理池**；每 6 次换随机 uuid rc_id 重开凭证

## 可复用经验
1. **大版本换代必须重新侦察**: grep 全 dex 的 `https://` host，别套旧协议记忆
2. **API key 在 resources.arsc**: `AIza[0-9A-Za-z_-]{30,}` 正则直接抽
3. **去重键判定实验模板**: 固定其他变量只变嫌疑字段（android_id/device_id/uuid/UA），一轮实验定案，避免"按 IP 限流"的想当然
4. **透明代理陷阱**: 免费代理大量不换出口 IP，测 IP 假说前先打 `api.ipify.org` 验证
5. FastAPI 端点嵌套对象字段传 `{}` 不传 null（否则 422）
6. 完整报告: github lza6/config.rotech.dev-2api-app `v142/README.md`

---

# AIVG 1.8.8 全链路打通案例（2026-10-28）

## 项目档案
- 仓库: https://github.com/lza6/t2v-staging.aritek.app-2api (be845b7)
- 本地: D:/aivg188/ (jadx源码/patched APK/工具) + D:/t2v-staging.aritek.app-2api/ (交付物)
- 桥接: aivg_2api_bridge.py :8914 (OpenAI /v1/chat/completions 兼容)

## 打通要点（对同类"明文JSON+自定义Sign头"app 通用）
1. Sign = SHA1(签名证书DER)。魔改 APK 的原版 Play 证书藏在 ApkSignatureKiller 的 killPM() Base64 参数里
2. **token 不必解 bootstrap**——设备跑一次 app，JWT 直落 SharedPreferences，adb root 读出即用（~1h 有效，定时重导）
3. 广告导流包抢前台：pm disable-user 冻结（uninstall 会被 SDK 再拉起）
4. t2v 同步返回成品 URL（sora.aritek.app/generated/*.mp4）；CDN 要带 Sign+Bearer，403→带头 206 Range OK
5. MITM 只在"必须看请求"时才用：emulator -http-proxy 最可靠；CA 要 subject_hash_old 命名放 system cacerts + stop;start 才生效
6. apktool 编译 NSC @raw 引用静默丢失——别用 NSC 内嵌 CA 方案

## 验证记录（真实输出）
- t2v ×2: 200 {"code":0,"data":{"url":"https://sora.aritek.app/generated/t2vSt....mp4"}}
- CDN: 206 Range 1KB, ftypisom magic 确认真 MP4
- bridge /v1/chat/completions: 返回 [▶️ AI Video](url) markdown
- /health: token_hours_left 实时显示
- guest 限额: check-limit type=t2v_prompt → {allowed:true, remaining:1, total_limit:2}

---

# AIVG (aritek AI Video Generator) v1.9.1 b91 — 全链路打通案例 (2026-10-28)

## 定论速查
| 项 | 值 |
|---|---|
| 上游 | https://t2v.aritek.app (生产, v4 协议) |
| Sign 头 | 固定白名单 `68d6165b72a7f2d8d17b0dc6fe9691abdf77c583`（非证书 SHA1！） |
| Token | `GET /api/v1/user/info` 免鉴权 → guest JWT ttl 3600（Device-Id 任意伪造） |
| t2v | `POST /api/v4/video/t2v` `{prompt:str, aspect_ratio, ai_sound}` → 同步 MP4（≈5s） |
| t2i | `POST /api/v4/image/t2i` `{prompt:[str]}`（数组）→ 异步 jobId → PNG |
| i2v | multipart `image`+`code`+`prompt` → 异步 MP4（Premium 检查服务端不强制） |
| i2i | multipart `images`(复数)+`code` → 异步 PNG |
| 轮询 | `POST /api/v1/generate/status` `{ids:[…]}` 免鉴权 |
| 免费配额/号 | t2v 10 / t2i 3 / i2i 1（`check-limit?type=`，用尽换 Device-Id） |
| 限流 | 10 并发无 429；建议 ≤5 并发 + 号池轮换 |

## 可复用方法论新增
1. **okhttp 日志拦截器捷径**：`adb logcat -d | grep okhttp.OkHttpClient` 直接看请求头 — 先查这个再决定要不要 frida。
2. **签名算法必须动态验证**：静态推导（Sign=SHA1(证书)）会被服务端白名单反制。
3. **jadx 注解常量要追定义**：`@t(KEY_AD_TYPE)` 实际值是 `"type"`。
4. **同一 API 内部字段不对称**：i2v `image` 单数 vs i2i `images` 复数；t2v prompt 字符串 vs t2i prompt 数组。
5. **配额型上游的号池模式**：Device-Id 伪造 + 配额跟踪（device_pool.json）+ 用尽换号。

## 交付位置
- GitHub: lza6/t2v-staging.aritek.app-2api（v1.9.1/，commit 459a977）
- new-api 渠道接入文档：仓库 `v1.9.1/NEWAPI_CHANNEL_GUIDE.md`

---

## 案例十一：Seekee v2.13.1（com.enzo.paulo，RN+原生混合，2026-10-28）

仓库：github.com/lza6/Seekee-app-2api · 本地 D:/apk-analysis/seekee/

### 新增鉴权模式：**四头签名体系（RSA 密钥交换 + AES-ECB 双向）**

```
固定头: clientType/versionCode=211/buildCode=154(!!)/platformId=4/channel/deviceId...
签名头: curTime(毫秒) signVal aKey app_request_aes_key
  aesKey            = 16位随机(0-9A-Za-z+chr30-39, i<10输出数字本身)
  aKey              = b64(RSA-PKCS1(aesKey))     ← 服务器私钥解
  app_request_aes_key = md5(aKey)
  signVal           = md5(b64(AES-ECB(urlencode(参数值拼接+curTime))))
GET query 值: URL-decode 后按 URL 顺序拼; POST: json值按key字典序递归拼
响应: code=00000 且 data 长 b64 → AES-ECB(json, 请求侧aesKey)
```

**三大坑**（每个都烧了时间）：
1. `buildCode` 必须传 154（=ApiVersionCode），传真实 build 211 得 `-50006 Unable to obtain version information`
2. GET query 值必须 URL-decode 后再拼签名（`GMT%2B08:00` 不 decode 则 `sign error!`）
3. 头语义与变量名反直觉：`aKey`=RSA 块、`app_request_aes_key`=md5（别按名字猜）

### 新增协议模式：**阿里 OSS V4 PostObject 上传**（业务端点下发 token → 直传 OSS）

```
GET tokenv2?businessType=X&timeZone=GMT+08:00 → {host,dir,policy,signature,x_oss_credential(STS),x_oss_date,security_token}
POST host multipart: success_action_status/policy/x-oss-signature/x-oss-signature-version/
  x-oss-credential/x-oss-date/key={dir}/{uuid}.ext/x-oss-security-token/file
坑: 不加 OSSAccessKeyId(V4 用 x-oss-credential); 字段名横线风格; key 在 file 前
```

### 风控层新形态：**DEVICEID_SIGN 设备签名**（错误码伪装）

- `usertype = HMAC-SHA256(b64(AES-ECB(deviceId, RSA_PUB[:16])), app_request_aes_key)` 客户端可复现
- 但服务器有 deviceId 绑定/注册逻辑（首次启动流程），随机 deviceId 固定拒绝：doChat 返回 `code:00000` 但 `data.code=DEVICEID_SIGN_1000128`；generate/submit 伪装成 `param error`
- **启示**：错误码 ≠ 真实原因。t2i 等匿名端点不校验此层 → 先把无风控端点全打通，风控端点留给模拟器动态
- 限速形态：无 IP/设备硬限速，高并发挤兑 `-100003`（~80% 通过率），重试即恢复，5 并发安全

### 反编译效率技巧（本项目验证）

- Retrofit 注解还原：找 `p13xxoo00Oo` 包下 `@interface` 定义文件的 `compiled from` 注释直接给原名（POST.java/GET.java/Body.java…），比猜快 10 倍
- Kotlin data class 字段名：jadx 反编译的 `d2 = {...}` Metadata 数组完整保留字段名+类型签名
- SSE 端点定位：grep `"stream"` / `aegis` / `text/event-stream`
- 上传实现定位：grep `addFormDataPart` / `x-oss` / `PostObject`；OSS 字段名看真实调用处而非 bean 类

---

## PhotoFlux AI / imggen81 (2026-10-28) ✅ 全链路破译

**APK**: `AI_Image_Generator_81.0_xs_fixed.apk` · `com.technosub.unlimitedaiimagen` · pairip 加固 + ApkSignatureKillerEx
**完整报告**: [APK逆向知识库/PhotoFlux-imggen81-逆向报告.md](APK逆向知识库/PhotoFlux-imggen81-逆向报告.md) · GitHub: lza6/imggen81-app-2api

### 核心协议（模拟器动态分析确认）

| 项 | 值 |
|----|----|
| 主生成端点 | `https://api.unlimimages.online/api/generate` |
| 签名 | `HMAC-SHA256(secret, "{ts}:{nonce}:{sha256hex(body)}")` → X-Signature/X-Timestamp/X-Nonce 三头 |
| Secret | `8974fe9d9e7a59d3a400e4dc4babde3ee84c98570521f89c4aab0636936b26af`（svc=2） |
| 密钥提取 | `libphotoflux_security.so` → Frida `getApiSecret(0..8)` 一次全 dump（9 个 secret） |
| 链路 | generate→request_id → status 轮询(空body hash) → /images/{rid}.jpg，全带签名 |
| 性能 | 2s/张顺序无限流、5 并发 100%、15 并发→150s 冷却、SDXL 级 1024px |

### 静态分析陷阱（新教训）

jadx 静态看 `BingImageCreatorService` 的 `api.unlim.store`（svc=8）像主链，**实际 app 主用 unlimimages（svc=2）**——双通道同签名结构的 APK 必须动态实跑确认优先级，不能信 static order。

### 环境方法论

- mitmproxy 必须挂 `--mode upstream:http://127.0.0.1:10808`（本机 v2ray 系统代理），否则出不了墙
- pairip 绕过 = hook LicenseClient 全部 54 方法（按返回类型分发）+ `checkStartActivityResult` 静默
- Firebase 登录注入 = frida 直调 `signInWithEmailAndPassword` + AuthStateListener 轮询，比 UI 打字快 10 倍
- ARM-only APK 在 x86_64 AVD 上 PMS 偶发丢 launcher resolve → `pm uninstall` 干净重装

### Seekee 动态篇：壳适配与风控定案方法论

1. **壳→模拟器适配公式**（爱加密通用）：`assets/ijm_lib/<abi>/libexec.so` → `lib/<abi>/libexec_x86.so` + 删 arm64 目录。壳代码里 `System.loadLibrary("exec_x86")` 是适配锚点，先 grep 确认再动包。
2. **壳存活窗口定律**：重签名后壳只在首次启动存活（环境/签名二次校验），crash log 一片空白=静默 `_exit`。所有动态操作（frida attach/CA 挂载/抓包）必须塞进首启窗口；时间不够就写自动化脚本（UI 驱动+hook 一体）。
3. **风控定位三步法**（协议还原后发现仍被拒时）：①确认错误码语义（伪装很常见）②提取真实设备凭据重放（排除客户端算法问题）③换 TLS 栈（h2/h1.1/raw socket 头序）——三步全拒才能定案"服务器侧状态"，避免在错误层面挖坑。
4. **mitm 失败排查顺序**：代理可达(SNI 可见)→CA 格式（Android 需 PEM+text 元数据拼接，hash_old 命名）→tmpfs 挂载→**壳 certificate pinner**（此层失败即宣告 mitm 死刑，转 frida unpinning 或真机）。

---

## Genius Art (amobear 厂) — 2026-10-28 交付

- 仓库: github.com/lza6/Genius_Art-APP-2api · 对接: 编码规则/GeniusArt-2api-new-api对接指南.md · 密码学: GeniusArt-逆向报告-libamg密码学分析.md
- 协议: get-token→JWT(14d,随机device_id无限号池) → prompt-to-image 同步201出GCS签名URL(15min)，tier=国家分级三档同权
- 加密: libamg.so Rust native（ ChaCha痕迹 + assets/dic KDF + 会话hdr ），frida RPC 桥 = 生产方案，unicorn 离线化脚手架已留
- 新增方法论: 指令流逐字节 key 提取法（strb/mov 配对按栈偏移重排）、密文结构三步判定法（hdr恒定/长度曲线/雪崩）、专用 AVD + heal.py 自愈对抗并行会话互杀

### Genius Art 补遗：predict-art 风格模型（2026-10-28）

- 三步链路：create → PUT(GCS签名, **CT=application/octet-stream**) → status=1 触发即出结果
- 输出 1152×1536（比文生图 512×512 高一档），5~10s，1553 个风格模板（52 组）
- 关键类型坑：`skin_color`=int、`num_image`=str、`status`=int、`original_name` 必须非空数组
- GCS V2 签名（GoogleAccessId+Expires+Signature=344字符）CT 猜错即 403，octet-stream 一次命中
- demo 双模型 + `/v1/images/edits` multipart + `/styles` 清单

## Case 8: Pawxy VPN 1.15.0 — WireGuard 节点池（2026-10-29）

> 完整报告：`APK逆向知识库/Pawxy-WireGuard节点池-逆向报告.md`
> 仓库：github **lza6/Pawxy-VPN-APK-2api**

- 类目不同：这是**节点池收割**而非 2API 文本/图像，产物是 WG 凭证 + SOCKS5 转换层
- 鉴权只有一个门槛：`device` 头必须 36 位 UUID 且**首字符为 `1`**
  （`UUIDv3("Pawxy:"+android_id)` 首字符替换）→ 格式错全站 POST `406`；
  `token`/`signature` 完全不校验，mod 签名可拿全部 premium 国
- `public-key` 必须 **小写 hex**（64 字符），base64 一律 `400`
- 无速率限制（25 连续 + 12 突发全 200），密钥对客户端自生成 → 无限发号
- **方法论新增**：全站统一的错误码（不分已知/未知路由）＝全局过滤器，先改请求头；
  Noise 握手探针必须用独立 responder 自校验，否则无法区分"报文错"与"对端不回"；
  0/N 全超时先比对 HTTPS 出口 IP 与 UDP 出口 IP，不一致就是源 IP 绑定

---

## Case 9: ChatAI 35.2.4 复刻包（同源白标复用 + 「N 个模型名 = 1 个后端」证伪法，2026-10-29）

> 仓库：github **lza6/ChatAI-3524-2api**｜本地 `D:/apk-analysis/chatai3524/`
> 对接文档：`ChatAI35.2.4-2api-new-api对接指南.md`｜协议规格：仓库 `docs/PROTOCOL.md`

### 定论速查
- 包名 `com.chatbot.ai.aichat.openaibot.chat`（v35.2.4，代码版本串仍写 35.2.2/352201），
  但业务包是 `com.begamob.chatgpt_openai.*` → **与 Case 7（Begamob 35.2.8）同一套白标代码**
- 同密钥 `stteam-ikameglobal-chatapiopenai`、同 bundleId、同上游 `chatapi.begamob.com` → **协议零新增成本**
- `exp` 必须秒级（APK 里 `jc.java` 用 `Date.getTime()+900000` 是毫秒，照抄必 401）
- `max_tokens` 硬上限 **16384**（16385→400）；上下文 **127,948 中文字符**过 / 127,977 拒
- VIP 纯客户端（SharedPreferences `key_save_status_premium_data`），服务端不查付费 → 这是所有 begamob 白标的通性

### 方法论 1：见到新包先做「同源判定」（省掉 90% 逆向时间）
```
1. unzip -p app.apk AndroidManifest.xml | strings -e l  → 看有没有熟悉的业务包名
2. grep dex 里的域名/密钥字符串 → 与历史 case 对照
3. 命中即：直接复用历史协议脚本，只核对版本串、模型表、新增端点
```
本例 20 分钟完成协议确认（vs 首次 35.2.8 花了数小时）。

### 方法论 2（本轮最有价值）：**「N 个模型名 = 1 个后端」三步证伪法**
上游对未知模型名一律 200 兜底 → 说明**只有一个默认模型**。要验证「多模型」是不是真的：
1. **固定 prompt × N 个模型**：挑 3 个确定性任务（翻译一句话 / 列素数 / 数字数），
   比对输出 md5。本例 17 个模型 → **每种只有 1 种字节级一致的答案**。
2. **看是否「连错都一起错」**：用经典陷阱题（`9.11 vs 9.9`、`2^100 mod 1000`）。
   本例 17/17 全答 `9.11`、全答 `24`（正确 376）。
3. **看延迟分布**：真多模型会有「强模型明显更慢」的规律；本例 1.12–1.47s 混在一起，无规律。
> 结论直接改写交付物：模型名只能当 alias，**按名字差异化定价 = 虚假宣传**。

### 方法论 3：AES 常量「长度非法」= 死代码（可直接放弃该链路）
art 域拦截器 `pj.java` 本应用 AES/ECB 解组织令牌，但硬编码密钥是 **61 字节**（AES 只接受 16/24/32）
→ `cipher.init` 抛 `InvalidKeyException` 被 `catch{}` 吞 → 实际发出去的是 `timestamp`。
配合 `/api/v2/art` 恒 500 + style 列表 `GET /list` 404 ⇒ **绘图链路已废**，别再试字段组合。

### 坑位新增
- **`stream` 字段会让上游 400**（Jackson `FAIL_ON_UNKNOWN_PROPERTIES`），不是忽略而是拒 → 必须白名单透传
- **多模态在另一台机器**：`chat-ai-iaa.begamob.com/api/v3/chatCustom`，成功码 **201**、响应多一层 `data`、
  `content` 必须是 `[{type:text|image_url}]`、**服务端自己下载图片 URL**（被墙图床 → 500 code 15500）
- **thread-local `requests.Session` 在 `ThreadingHTTPServer` 里会漏隧道**：每连接新线程 → session 永不释放
  → 把本机代理 6–7 条并发额度吃满 → 表现为「并发全 502」。改固定大小连接池 borrow/return 即解决
- **压测前先测出口代理的并发隧道上限**（对照 `api.github.com`）：x8 全 SSLEOF = 环境限制，不是上游限流
- 自家网关的上下文 cap 会**掩盖**上游真实边界（needle 探针填 160K 被自家 400 拦 → 误判模型失败）

## Case 10: Photify AI 3.0.8（ai.photify.app，Ex-Human Inc.，2026-10-29）✅ 真实出图打通

仓库 `lza6/Photify-AI-APP-2api`｜本地 `D:/apk-analysis/photify/2api`｜交付文档 `docs/REVERSE-REPORT.md` + `docs/NEW-API-INTEGRATION.md`

### 项目档案

| 项 | 值 |
| --- | --- |
| 包/版本 | `ai.photify.app` 3.0.8，74.6 MB，5 dex / 46689 类 |
| 后端 | `https://api.photify.ai/photify/v1/`（FastAPI + pydantic v2） |
| 网络层 | OkHttp5 + Retrofit + kotlinx.serialization，R8 混淆为 `n60`/`p60`/`e50` |
| 加固 | 无整体壳；`libprotect/libstub/libsigner` 仅广告 SDK 完整性辅助 |
| 变现 | AppLovin MAX / IronSource / Meta / Chartboost / Mintegral / InMobi + Adjust + Adapty 内购 |
| 对象存储 | Cloudflare R2 公开桶 |

### 鉴权：Firebase 匿名链路的「最省事变体」

**与 Photoroom 版的关键差异：不需要 `X-Android-Package` / `X-Android-Cert` 头**，
直接裸 key 就能匿名注册成功（本项目实测 200）。所以判据要放宽：

```
① accounts:signUp?key=<google_api_key>   {"returnSecureToken": true}
   → 先不带 X-Android-* 试一次；403 API_KEY_ANDROID_APP_BLOCKED 才需要补包头
② auth/login {userId: localId, token: idToken}  → accessToken (HS256 JWT, 24h)
③ 后续 Authorization: Bearer <accessToken>   ← 这里是 Bearer，不是裸 idToken（与 Photoroom 相反）
④ refreshToken → securetoken.googleapis.com 永久续期
```

**通用判据**：Manifest 有 `firebaseinitprovider` + strings.xml 有 `google_api_key` → 先试匿名登录，
一次 HTTP 就能跳过全部社交登录逆向。

### 协议特征：@Streaming 同步出图（逆向时最该先看的一个注解）

`POST images/standard` 的返回类型是 `ResponseBody` + 注解 `p60/w`(`@Streaming`)
→ **响应体就是图片二进制（768×1152 JPEG）**，无 task_id / 无轮询 / 无回调。
2API 里直接 `resp.content` 落盘，省掉整个任务状态机。
判据：Retrofit 签名出现 `Call<ResponseBody>` / `n60/t0<ResponseBody>`。

### 方法论新增 1：参考图 + 参数化属性 → 必须做 A/B 对照

`images/standard` 同时带 `identityImageId` 和 `gender/skinColor/hairColor/bodyType`，
后者是**显式覆盖**（实测：男性蓝皮肤身份图 + `gender=woman` → 出女性，脸型发型都变）。
所以「上传身份图后必须回填 `identity_traits`」，否则默认值会换人。
> 通用规律：凡是「一张参考图 + 一堆枚举属性」的生图协议，都要做两组对照
> （只换参考图 / 只换参数），否则会误判成「参考图没生效」或「参数是装饰」。

### 方法论新增 2：枚举零成本拿全（FastAPI/pydantic 回显法）

每个枚举字段传一次 `"x"` → 422 里直接列出合法值：
`Input should be 'man', 'woman' or 'nonbinary'`。
一次请求拿全 `gender / skinColor / hairColor / bodyType / modelType`，
**优先于翻 smali 常量**。对任何暴露 pydantic 校验错误的上游都成立。

### 方法论新增 3：一账号一脸 → persona 路由（接 new-api 的通用解法）

上游身份图是账号维度（`identity_images/<uid>/...`），而 new-api 只转发
`/v1/images/generations`（JSON，不支持 multipart edits）。解法：
`accounts.json` 给账号起 `persona` 名 → 网关多暴露模型名 `photify/<persona>` 并固定路由该账号
→ new-api「一个渠道一个人设」。**所有「参考图驱动」类 2API 接 new-api 时都可照抄。**

### 坑位（本轮新增）

- **延迟方差极大**：同参数同账号 4.99/6.2/8.6/13.1/17.2/29.8s，还出现 **144s**
  → 网关超时给 180s，别按 p50 设
- **单账号并发 3 → 上游 `Connection reset`** → 同账号串行 + 锁（上传身份图与生成必须在同一把锁里，
  否则并发上传互相覆盖身份图）；扩容只加账号
- **服务「启动成功」但配置没生效（Windows 端口占用）**：uvicorn bind 失败仍打印
  `[accounts] loaded N` 后退出，curl 打到的是旧进程。固定两步排查：
  `Get-NetTCPConnection -LocalPort <port> -State Listen` + 日志里搜 `10048`
- **纯色块/二次元当身份图 → `400 Image processing error`**（服务端真人脸校验），
  测试要用真人清晰正脸
- `images/standard` 曾出现一次 `404 Image not found`，重传身份图后正常 → 怀疑身份图建档时序，
  排障先怀疑身份图 id 的新鲜度

### 工具链踩坑（本机，值得写进 SOP）

- `apktool 2.11.1`（`/d/apk-analysis/apktool.jar`）可用；`/d/tools/apktool.jar`、`apktool2.jar` **已损坏**
- `jadx 1.5.6` CLI 本机**卡死在 `Resetting disk code cache`**（换 JADX_CACHE_DIR / `-j 8` / `--no-res` /
  `--no-debug-info` / 删缓存全无效）→ 走 `apktool d --no-res` + ripgrep
- 6 万 smali 文件**禁用 `grep -rn`**（超时），用内置 `rg`
- bash 里 `cd A && cmd &` 会把整个复合命令丢后台 → 后续 `tail 日志` 找不到文件，要用 `(cd A && cmd &)`

---

## CreArt v2.7.2 —— 「占位图」型 Play Integrity 门禁（报告归档案例）

- **样本**：`ai.aiart.aiartgenerator.creart`，Flutter / Dart 3.11（arm64-only）。仓库 https://github.com/lza6/CreArt-APP-2api
- **协议**：base `api.creartai.com`；`POST /api/v2/{text2image,image2image,upscale}` → **image/png 裸字节**；唯一鉴权头 `X-Firebase-AppCheck`；body `prompt/aspect_ratio/style/model/quality/width/height/base64/imageUrl/deviceId`。
- **门禁（关键新形态）**：不是 401，而是 **HTTP200 + 固定占位图**（`Unable to verify app integrity / official source`，md5 `379426a18eca81366a05cd39a39ea4a7`）。
  **一条命令判定**：`curl` 空 body + `GET` → 若返回**字节完全相同的 200 image** → 前置门禁兜底图，别再猜字段。
- **机制判据**：dex `com.google.android.play.core.integrity` + `PlayIntegrity` + libapp `X-Firebase-AppCheck` 字面量。
- **可否 2API**：纯协议/Mod/模拟器 **不可**（token 由 Play Integrity 设备侧签发、服务端验签、30-60min 短时）。真图唯一路：官方签名 APK + 真 GMS 手机 + frida 常驻 token 桥。
- **工具坑**：blutter 预编译仅 Dart 3.6/3.7，App 3.11 不支持 → 走字符串+黑盒；arm64-only + x86_64 无 GMS 模拟器 → 无法动态跑。
- **交付物**：demo_server.py(mock 本地合成打 MOCK 水印 / upstream 忠实透传占位图) + stress_test.py + 三档 docs（REVERSE_REPORT / INTEGRITY-ANALYSIS / NEW-API-INTEGRATION）。
- **变现**：RevenueCat 订阅 + AdMob 奖励广告 + 后端 credits 记账。

---

## Case: SnapClip 1.1.1 —— 匿名 provider 换 JWT + STS 直传 + 日额度号池（2026-10-29）

- **样本**：`ai.video.photo.animator.face.dance.animation`（Flutter / arm-only / 66 MB）
- **仓库**：https://github.com/lza6/SnapClip-APP-2api（public，tag v1.0.0）
- **对接**：仓库 `docs/NEW-API-HANDOFF.md`（渠道 type 74）+ 桌面 `SnapClip-2api-new-api对接指南.md`
- **一句话**：匿名 token → STS 直传 S3 → 提交任务 → 轮询 → 下载；每匿名账号每日 3 次免费；PRO/chain 不可用。

### 协议速查

| 环节 | 请求 |
|---|---|
| 身份 | `POST https://saas.castbox.fm/auth/api/v1/tokens/provider/secret`，`X-APP-ID: ai-video`，body `{"provider":"anonymous","secret":"<随机>"}` → `data.token`（RS256，exp≈10y） |
| 业务头 | `X-APP-ID: ai-video` + `X-ACCESS-TOKEN: <jwt>`；`X-DEVICE-INFO` **不校验** |
| 端点自描述 | `GET https://ai-video.thebetter.ai/v1/api_meta`（**零鉴权**，12 端点 + 参数枚举） |
| 上传凭证 | `GET /v1/token/generate_image_token?count=1..20` → `imageS3KeyList` + STS，bucket `cre8vid-user`（us-east-1） |
| 提交 | `POST /v1/task/{emote,hug,magic,beastify,transform,video_swap,dance,harry_potter,figure,step,chain}` |
| 提交体 | `{s3_key_list, theme_id, theme_item_id, restricted_type:"FREE_USER", mode_type:"GENERATE"}` |
| 轮询 | `GET /v1/task/task_result?task_id=` → `{status, s3Key, accessKeyId/secretAccessKey/sessionToken}` |
| 目录 | `GET /v1/task/theme_category_list`（17 类）/ `theme_image_hot_list` / `theme_image_list_by_category` |
| 额度 | `GET /v1/user/daily_free_count` → `{"count":3}` |

### 四条可复用判据（对同类 SaaS 白标 app 通用）

1. **自描述端点优先**：`/v1/api_meta`、`/api/meta`、`/config`、`/openapi.json` 这类零鉴权端点常直接吐全协议。
   本案例 30 分钟拿到 12 端点全参数，未反编译任何 Dart 逻辑。
2. **Guru SaaS（castbox）家族认证口**：`/auth/api/v1/tokens/provider/secret` 用 `{provider,secret}` 换 JWT；
   `secret` 即身份主键（幂等）→ **号池无限扩**。同族：`/auth/api/v1/renewals/firebase`、`/device/api/v1/devices`、
   `/order/api/v1/orders/android`。**路径前缀=模块名，探测时必须带前缀**（漏了全 404）。
3. **报错即枚举器**：`app_id can't be null → app_id not match → access token can't be null` 逐层推进；
   本案例 `X-APP-ID` 正解 `ai-video`（非包名、非 `aivd`）。
4. **PRO 门控是账号级**：`restricted_type` 任意非 `FREE_USER` → `400 code=2003 your device is not support for pro`；
   三种 `X-DEVICE-INFO` 形态同样报错 = 「不用再折腾设备头」的判定实验，可直接抄。

### 结论表（上线前必看）

| 能力 | 结论 |
|---|---|
| 免费档（`FREE_USER` + `mode_type=GENERATE`） | **可用**，`usedPoint=0`，成品 784×1176 / 24fps / 5.04s / 4 MB |
| PRO 档（vidu/kling/alibaba/pixverse 40–600 点） | **不可用**（2003，需 Google Play 内购账号） |
| `step` 双图 | **可用**，960×960 / 4.03s / 1.12 MB，`s3Key` 带 `_mva`；单图报 `1200 theme item invalid` |
| `chain` | **不可用**：全目录 `CONCAT_NO`，提交必 FAILED **且白扣 1 次额度**；缺图 `1104`、假 ID `21010`、跨账号 task_id 不校验归属 |
| `mode_type` 枚举 | 免费分支不校验（乱填也 200） |
| 并发 | 8 任务 × 并发 4/8 全成功零 429，wall 154.2 s → 73.9 s |

### 交付清单（模板）

`snapclip_client.py`（协议封装）· `server.py`（mock/real 双模 + 匿名号池 + OpenAI 风格 `/v1/videos/generations` + 原生路由）·
`demo.html`（中文页，data-uri 上传）+ `verify_demo.py`（Playwright e2e）· `bench.py`（只压本地）·
`test_plugin.mjs`（9 断言）· `plugins/tasks/snapclip/plugin.js`（new-api type 74）·
`docs/{REVERSE-REPORT,NEW-API-INTEGRATION,NEW-API-HANDOFF}.md` · `probe/`（原始响应 + 额度/并发探针）

### 踩坑

- **arm-only APK 在 x86_64 模拟器 `INSTALL_FAILED_NO_MATCHING_ABIS`** → 静态 + 黑盒为主，别指望动态。
- **Flutter 无 blutter 也能出活**：`rg -a -o "[[:print:]]{6,}" libapp.so > dart_strings.txt` 后做 `-B/-A` 上下文检索；
  本样本 3.4 万行字符串足够还原全协议。
- **展示截断值当参数用 → 404**：`theme_item_id` 必须用完整 `.mp4` 全路径，日志里截断展示要留全量字段。
- **网关误删用户素材**：本地路径图片若在 `finally` 里 `unlink` 会删原图；必须 `(path, is_temp)` 区分，
  只清理下载/解码产生的临时文件 —— 交付前专门回归一次。

## Case 11: OneSearch — Begamob 白标统一多模型网关 + Cloudflare 限流（2026-10-29）

> 仓库 `lza6/OneSearch-2API-APP`（public）｜文档 `docs/NEW-API-INTEGRATION.md`
> `com.chat.chatai.chatbot.aichatbot` v1.5.5。与 ChatAI 同 Begamob/iKame 体系、**同 SECRET_KEY**，但域/端点/请求体全不同。

### 项目档案
| 项 | 值 |
|----|-----|
| 包名 | com.chat.chatai.chatbot.aichatbot |
| 上游 | https://chat-ai.begamob.com （Spring Boot）；ChatAI 是 chatapi.begamob.com |
| 认证 | 自签 HS256 JWT，SECRET_KEY=`stteam-ikameglobal-chatapiopenai`（与 ChatAI 同）；claims: iat**毫秒**/exp**秒**/bundleId/os=Android/versionApp=1.5.5/timezone |
| 聊天端点 | `POST /api/v3/chat/stream`（**真 SSE**，另有 /api/v2/chatStream） |
| 鉴权关键 | chatStream **只认自签 JWT**（登录 accessToken → 401）→ **零号池零登录零设备注册** |
| 模型 | 68 个实测全 200（GPT-5/5.1/o1-o4/claude-opus-4.6/sonnet-4.5/gemini-3/grok-4/llama-4/deepseek-r1/qwen-max…） |
| 能力 | 真流式 + 多模态 image_url 读图 + Google 联网（tools=["web_search"]） |
| 限流 | **Cloudflare IP 级**：并发≤20 稳/≤30 基本过/50 立即 429 且封禁 6-7min |

### 需带头 + 请求体
```
Authorization: Bearer <自签JWT>
user-header: bundleId:com.chat.chatai.chatbot.aichatbot/versionApp:1.5.5/OS:Android/osVersion:34/userId:/deviceId:<uuid>
x-app-version: 1.5.5 ｜ x-app-bundle-id: <包名> ｜ x-os: android ｜ x-adjust-id: (空)
User-Agent: okhttp/4.12.0
{"max_tokens":4096,"model":"gpt-4o-mini","messages":[{"role":"user","content":[{"type":"text","text":"hi"}]}],
 "response_length":"medium","response_tone":"default","topic_type":"general",
 "image_and_analytic":false,"tools":[],"is_image_vip":false}
```
SSE chunk：`data:{"statusCode":200,"message":"ok","data":{"contentText":"..","finishReason":"stop","webs":[...]}}`；`"error":` 前缀=错误块。

### 立类型（与 ChatAI 区分，别套错）
`grep -aoE "https?://[a-z.]*begamob[^\" ]*" classes*.dex` → 得 `chat-ai.begamob.com`（ChatAI 是 `chatapi`）。
同密钥证明是同厂，但端点/响应/流式要重验：**ChatAI 是真多轮非流式 /api/v1/chat；OneSearch 是真 SSE /api/v3/chat/stream**。

### 关键实验：聊天要不要登录
三组对照打 chatStream：[自签JWT]201出字 / [登录accessToken]401 / [无token]401 → **只认自签JWT**，号池工程全省。

### 模型枚举铁律（本次踩到 UI 假名）
- UI `/api/v1/chat-setting/option` 只给 11 个，但**实测 68 个标准名全 200**，UI 列表大小不代表可用数
- **`gemini-3-pro-preview`/`gemini-3-flash-preview` 是 UI 假名**，上游 Vertex 报 `404 code 1002`；真实名**去掉 `-preview`** = `gemini-3-pro`/`gemini-3-flash`
- 枚举法：批量候选名看 200，别信 UI 列表

### 限流定论（对接前必读）
- 并发 50 立即 429（**Cloudflare HTML 拦页 `<doctype html>`，非应用层 JSON**），出口 IP 封 6-7min
- 直连与本地代理**同出口段一起封**（换同 IP 代理无效，需真正不同 IP）
- 对策：单出口并发≤20 + 多出口代理池 + 429 指数退避换 IP

### 加固壳（无碍）
`libpglarmor.so`+`com.pairip`+`libsigner.so` 存在，但网络层**明文 Moshi JSON，无加密无 TLS pinning** → 静态还原端点直连即可，无需动态脱壳。

### new-api 对接
方案 A（首选）：OpenAI 渠道指向本仓库 `server.py` 网关（`/v1/chat/completions` 已 OpenAI 格式），零改代码。
方案 B：原生 Go adaptor（channel type 74），Go 版 JWT 生成 `jwt.MapClaims{iat: UnixMilli, exp: Unix}`。

---

# Case 12：AI Cartoon Pet Video 1.2.3（aritek t2p）— 证书 SHA1 白名单 + device_id 池化（2026-10-29）✅

仓库：`https://github.com/lza6/AI-Cartoon-Pet-Video-APP-2api` ｜ 本地：`D:/apk-analysis/ai-cartoon-pet/2api/`
包名 `text.to.video.aivideo.generator`，上游 `https://t2p.aritek.app/`（与 AIVG `t2v.aritek.app` 同厂 aritek）。

## 一、鉴权模型：三头无账号体系

| 头 | 值 | 性质 |
|---|---|---|
| `Sign` | **APK 签名证书 DER 的 SHA1 小写 hex** | 服务端白名单，静态常量 |
| `Device-Id` | 客户端自造 16 hex，**`user_id` 就等于它** | 每换一个新值 = 新 guest + 满额额度 |
| `Ctry-Target` | `others`/`US`/… | 不校验取值 |

`GET /api/v1/user/info` 用三头换 HS256 JWT（`ttl=3600`，claim 含 `is_premium`）。
**没有注册、没有邮箱/验证码、没有图形验证码、没有 Play Integrity** → 这是唯一可池化的根基。

## 二、Sign 的静态推导（可复用套路）

smali 链路（`dexdump -d`，地址级确认）：
```
da.D.onCreate (4c82a8)  if (a.a.length == 0) a.a = <util>.s(context)
util.s(Context) (43eb94):
    pm.getPackageInfo(pkg, GET_SIGNING_CERTIFICATES).signatures[0].toByteArray()
    -> MessageDigest("SHA1").digest(...) -> toHexString().lowercase()
```
即 `Sign = SHA1(证书 DER)`，**与 apksigner 打印的 "certificate SHA-1 digest" 完全一致**。

## 三、关键破局：mod 包必然失败，去拿官方包（本次新增的通用解法）

- mod（modyolo）重签后 `Sign` 变，服务端 `401 {"code":-2,"message":"Invalid signature"}`；
- **一行命令取官方包**（无需登录、无需 playwright）：
  ```bash
  curl -sL -A "Mozilla/5.0 (Linux; Android 13)" \
    "https://d.apkpure.com/b/APK/<package>?version=latest" -o x.apk
  ```
  返回可能是 **XAPK**（zip 内含 `base.apk` + `config.*.apk` + `manifest.json`），解出 base.apk 再
  ```bash
  apksigner verify --print-certs base.apk   # → certificate SHA-1 digest 就是 Sign
  ```
- 本例官方值 `7259cb222a66496242650023583742fe40ea0a80`，直接 200 拿到 JWT。
- **同厂不一定同证书**：AIVG 的 Sign（`68d6165b…`）用在这个 app 上是 401，别想当然复用。

## 四、隐藏端点枚举法（本次收益最大的一招）

App 只做了 3 个功能入口，但服务端留了 9 个。**判据是状态码语义，不是 404**：

| 响应 | 含义 |
|---|---|
| `404 {"code":-4,"data":{"resource":"<path>"}}` | 路由不存在（会回显路径，可用于批量确认） |
| `409/500/502` | **路由存在**，后端/参数有问题 → 值得挖 |
| `400 "…required"` | 路由存在，且**直接回显参数名** |
| `402 premium` | 路由存在，付费门 |

按此扫 `/api/v1/image/{enhance,aging,expand,object-remover,open-eyes,i2i}`，命中
`enhance`（可用，4x 超分 2048²，**100 次/设备**）、`aging`（100 次但输出 failed）、
`expand`/`object-remover`（409 无后端）、`open-eyes`（参数名 `eye_regions.left` 泄露）。

**额度表就是免费额度清单**：`check-limit?type=xxx` 传错 type 时，400 会回显**全部合法 type**：
```
t2v_prompt i2v_prompt t2i_prompt i2i_edit image_enhance image_aging
open_eyes image_expand object_remover i2i_swap i2v_swap i2v_dance i2v_lora i2v_r2v
```
逐个查额度 = 免费能力全景图（本例：t2v 10 / t2i 3 / enhance 100 / aging 100 / open_eyes 10 / expand 5 / remover 5 / i2i_swap 3）。

## 五、付费门判定（省时间）

`i2v/i2i/dance/lora/r2v` 全部 `402 Premium subscription required`。
把 `isPremium=1` 塞进请求体、补 `pt_` 头、改 `versionCode` **全部无效** —— 门读 JWT 的
`is_premium` claim，只有 IAP 校验服务（`android-api-verify.aritek.app`）能置位。**判定类型：服务端门，收手**。

## 六、产物实测

- t2v：同步 3.3–3.8 s 返回 mp4 URL，480×832 / 16 fps / 5.06 s / h264+aac / 3.11 MB
- t2i：异步 jobId，4–6 s 出 1024×1024 PNG / 1.18 MB
- enhance：异步，~13 s 出 2048×2048 JPEG（输入 1024²）

## 七、踩坑（新增两条）

1. **端口抢占**：`ThreadingHTTPServer` 绑 `0.0.0.0:8950` 的同时若有一个历史 demo 绑着
   `127.0.0.1:8950`，`curl 127.0.0.1:8950` 会命中**别人**的服务（表现为 health 返回别家 JSON）。
   `netstat -ano | rg :PORT` 必须看**全部** PID；本机 89xx 段已被 8901/8911/8916/8920/8940/8942/8945/8955/8960/8990 占满，改用 18xxx。
2. **`request_queue_size` 默认 5**：20 并发压测会零星 SYN 丢失 → 表现为"零散失败 + p99 飙到 500ms"。
   子类化 `ThreadingHTTPServer` 设 `request_queue_size = 512` 后，同一套压测 p99 从 512 ms 降到 172 ms 且零失败。
3. **jadx 对某些 dex 会整类失败**（`newPosition < 0` / `IllegalArgumentException`），但 `dexdump -d` 仍能完整反汇编 ——
   jadx 报 `NullPointerException in pass` 时不要以为包坏了，换 `dexdump` 按 `Class descriptor` 段落抽。

## 八、压测（只打本地 mock）

20 并发 × 8 s/路由：`/health` 858 rps（p50 14 ms）、`/v1/models` 1449 rps、
`/v1/images/generations` 537 rps（瓶颈是每次新 prompt 落一张 PNG）、`/v1/videos/generations/sync` 1240 rps，**全 200 零失败**。

## 九、new-api 对接

方案 A：`type=1 OpenAI` 渠道指向本地网关（`/v1/images/generations`、`/v1/images/edits` 直接可用）。
方案 B：任务插件 `ChannelType=74`（现最大 73 = Duck），网关已按 OpenAI 任务形状返回 `{id,status,url}`，插件只做字段搬运。
详细字段级配置见 `Desktop/编码规则/AI-Cartoon-Pet-Video-2api-new-api对接指南.md`。

---

## Case 12: Code AI v3.3.2（com.itechgemini.code_ai）— **Firebase callable 首个案例**（2026-10-29）

> GitHub：`lza6/Code-AI-332-APP-2api` ｜ 产物：`D:\apk-analysis\aicg332\2api`
> 对接指南：`Desktop/编码规则/CodeAI332-2api-new-api对接指南.md`

### 定论速查

| 项 | 结论 |
|---|---|
| 形态 | Flutter + Dart AOT（`libapp.so` 7.2M），dex 7.6M 全是插件垃圾，业务逻辑 100% 在 AOT 快照 |
| 后端 | **单个 Firebase Cloud Functions callable function**，不是 REST |
| 端点 | `POST https://us-central1-<projectId>.cloudfunctions.net/getOpenAIResponse` |
| 鉴权 | 仅 `Authorization: Bearer <Firebase 匿名 idToken>`；无签名/设备指纹/证书固定/App Check |
| 需要真机/Frida | **不需要** |
| 模型 | OpenAI GPT-4 系，**上游硬编码**，`model` 参数被忽略 |
| 额度 | 每 Firebase uid **5 次**，同 uid **严格串行**（并发第二个 409 `pending`） |
| 输出上限 | **≈500 token / ≈1900 字符**；超长不是截断而是 **HTTP 500 空结果** |
| 延迟 | p50 6.5–10 s，长答 26 s |
| 多模态 | 无。图片走设备端 MLKit OCR，之后只发文本 |

### 还原路径（可直接套用的 4 步）

1. **抽 Firebase 配置**：`resources.arsc` 明文有 `google_api_key` / `google_app_id`（本例 `AIzaSyApRibMUSjrvy2tgRgRzPLSEG-ZVuU9Xl8`、`1:185515517167:android:a311e6353b297592f527`）。`project_id` **不在 arsc 里**。
2. **反解 projectId**：用 `google_api_key` 打 `identitytoolkit accounts:signUp`（空 body + `{"returnSecureToken":true}`）拿匿名 `idToken`，其 JWT 载荷 **`iss` / `aud` 就是 projectId**（本例 `codeai-6970b`）。
3. **探区域 + 函数名**：按 `<region>-<projectId>.cloudfunctions.net/<fn>` 拼，跨 6 个区域 × 候选名探活。存在 → 返回 **HTTP 400 业务错误**；不存在 → 404 `Page not found`（HTML）。再用 500 个候选名扫一遍可确认「服务端只有 1 个函数」。
4. **数据契约**：见下节。

### 静态特征：怎么判断「这是 callable 而不是 REST」

在 `libapp.so` 上全量扫字符串，如果同时满足：
- `https?://` 只命中 flutter.dev / github.com/flutter / play.google.com / firebase 文档链接（**业务域名 0 命中**）
- `chat/completions`、`/v1/...`、`sk-[A-Za-z0-9]{20,}` **全部 0 命中**
- 能扫到 `package:firebase_functions` / `cloud_functions` 依赖 + 函数名字符串（本例 `getOpenAIResponse`）

→ 就是 **Firebase callable**：URL 是 SDK 运行时用 projectId 拼的，静态必然看不到。

> 抽出字符串用自写 Python（`re.findall(rb'[\x20-\x7e]{6,}', data)`），Windows Git Bash 没有 `strings`。

### 请求 DTO（靠错误文案当 oracle 逐层剥）

| 试的 payload | 上游回 | 推断 |
|---|---|---|
| `{}` | `Valid conversation is required.` | 必填 `conversation` |
| `{conversation:[{role,text}]}` | `Valid messages are required.` | 字段名必须是 `content`，且 content 必须是**字符串** |
| `{conversation:[{role,content}]}` | `A request UUID is required.` | 必填 UUID |
| 试 `requestUUID`/`request_uuid`/`uuid`/`id`/`requestUuid` | 仍报 UUID | 都不是 |
| `requestId`（camelCase） | **200 + 真实回答** | 命中 |

```json
{"data":{
  "conversation":[{"role":"system","content":"..."},{"role":"user","content":"..."}],
  "messages":[ ...同一份数组... ],
  "requestId":"<uuid4>"
}}
```

响应：`{"result":{"response","requestId","remainingChats","rewardedCredits","visionApiTries","isPro"}}`

### 三个必踩的坑

1. **`requestId` 必须是 camelCase**，其它命名全被拒（错误文案只说 "A request UUID is required"，不会告诉你字段名）。
2. **`conversation` 与 `messages` 双字段并存，但只有 `conversation` 驱动推理**。
   A/B 实证：`conversation="zzz"` + `messages=[user,"Reply with BANANA"]` → 模型围绕 zzz 展开。`messages` 只过校验。
   实现上两个字段填同一份数组最安全。
3. **`content` 必须是纯字符串**。传 OpenAI 那种 `[{type:"text",...}]` 多模态数组会被判 `Valid messages are required`
   —— 这个报错极具误导性，会让你以为是字段层级错，其实是**类型错**。

### 错误码表（= 行为契约，直接照此实现重试策略）

| HTTP | details / status | 含义 | 正确动作 |
|---|---|---|---|
| 400 | `INVALID_ARGUMENT` | DTO 不合规 | 修 payload，别重试 |
| 401 | `UNAUTHENTICATED` `Please reconnect to sign in.` | token 失效 | refreshToken 换新，失败弃号 |
| 409 | `details.pending=true` | 同 uid 并发 | 换号或稍等重试 |
| 429 | `details.reason=quota-exhausted` | 额度耗尽 | 弃号 + 铸新号 |
| 500 | `details.final=true` `No result was returned` | 输出超长被截断 | **确定性失败，不要重试**（重试纯烧额度） |

### 额度模型 → 匿名 uid 铸造池

- 每 uid 5 次；`refreshToken` 刷新**不重置**额度（uid 不变）。
- 同 uid 严格串行 → 每号一把容量 1 的信号量。
- 实测铸造速率 **3.2 uid/s**（30/30 成功，10 线程，wall 9.4 s，单次 ~2.76 s 主要是 TLS 握手）。
- 吞吐公式：`每分钟请求数 ≈ 存活账号数 × 60 / 单请求延迟(s)`。
- **池化决定性验证方法**：把 `max_size` 设成 **1**，连打 7 次 —— 第 6 次必须自动换号且全绿。
  本例 7/7 成功、`retired=1`，这是「换号无感」最硬的证据，比任何 mock 都强。

### 交付物（可复用骨架）

```
codeai_client.py   协议 + 匿名 uid 铸造池（懒铸造 / keeper 后台补给 / 429·409·401 自动换号 / 铸造指数退避）
server.py          FastAPI OpenAI 兼容网关（/v1/models /v1/chat/completions(SSE) /health /metrics /demo）
demo.html          可视化 demo（右侧实时账号池面板：逐号剩余额度 + 存活时长）
bench.py           mock / real 双模压测（mock 走 CODEAI_MOCK=1，零上游成本）
test_contract.py   30 条断言契约回归（models/补全/SSE 帧/校验/鉴权/池统计/demo）
verify_demo.py     Playwright 真实浏览器 e2e（带截图）
```

### 本轮新增的通用教训

1. **端口抢占会伪装成"协议错"**：本例 8931/8932 已被历史服务占用，我的 uvicorn 静默失败，
   而 `curl 127.0.0.1:8931/health` 返回的是**别家**的 `{"upstream":"aibr.elway-mobile.com"}`。
   教训：起服务后**必须**用 `netstat -ano | rg :PORT` 确认 PID 是自己的，或直接用 19xxx 段。
2. **bench 的 rps 不能用 max(latency) 当 wall**：那样会算出 conc=1 时 373 rps 这种荒谬值。
   必须记录该档位真实 wall clock（本例修正后 conc=1 → 3.8 rps，符合 1/0.26s）。
3. **demo 页流式渲染不要用 `box.firstChild`**：`textContent=''` 会清空所有子节点导致 `firstChild === null`。
   固定结构 `<div class="body"><span class="txt"></span></div>`，流式只写 `.txt`，e2e 断言也锚 `.txt`。
4. **Windows 上 `curl -d` 带中文会乱码** → 网关回 `invalid JSON body`，看着像 bug 实则是编码。
   自检用 ASCII，中文用 Python/httpx 打。

---

## Case 14: AI Art Generator 1.4.7 — 签名证书白名单型（2026-10-29）

### 定论速查

| 项 | 值 |
|---|---|
| 包名 | `ai.art.generator.paint.draw.photo`（Kotlin+Compose，R8，Laravel 后端） |
| 上游 | `https://aga.coolsummerdev.com/api/v3/*`（全 POST JSON，Debug 未关可读堆栈） |
| 鉴权① | header `MD5 = md5(PACKAGE + 官方APK证书DER小写hex + TIMESTAMP)`，白名单=Play 官方证书 |
| 鉴权② | body `md5 = md5(<该接口固定字段顺序> + uid + NATIVE_KEY)` |
| NATIVE_KEY | `Emoji_JingNCK567`（`libcipher-jni.so`，5.7KB，strings 直接读） |
| uid | `md5(uuid4())`，服务端不校验设备；额度按 uid 计 |
| 出图 | creating → getResult 轮询（25–70s，p50 47s），真实 JPEG ~500KB 可下载 |
| 交付 | `github.com/lza6/AI-Art-Generator-APP-2api`；5并发×10=10/10，6.38 img/min，单 uid 25 次无阻断 |

### 本案例最有价值的三个方法

**1. 官方包只用来取证书，不用来跑**

用户给的永远是 Mod/重签名包，而服务端白名单是**官方证书**，所以 Mod 包在协议层就死。
只需从 `d.apkpure.com/b/APK/<pkg>?version=latest` 下 XAPK（慢，`curl -C -` 后台续传），
解出内层 `base.apk`，`APK(base).get_certificates_der_v3()[0].hex()` 即得签名串。
装包、模拟器、Frida 全部可以省掉 —— 这一步把「必须真机」的项目直接变成纯静态 + curl。

**2. 错误码阶梯就是逆向地图**

```
{}                                    → 40104 Empty Parameter
+ header(MD5 错)                       → 40101 Authentication Failed 1
+ header(MD5 对)                       → 40103 missing valid verification parameter
+ body {uid, md5=md5(uid+KEY)}         → 200 + 真数据
```
不要一上来猜参数。先把「鉴权层」逐层打通，业务字段用 Laravel 的 `ret=0` 校验 JSON 白拿
（`{"style":["The style field is required."]}` 就是免费 schema）。

**3. body md5 按「请求里实际出现的字段」拼接**

未传的字段按空串参与 → 「只传 uid+md5」等价于 `md5(uid+KEY)`，这就是空 body 探针能过鉴权的原因。
反过来，**多传一个非空字段就必须同步进拼接串**，否则 `Invalid MD5`。
所以调用方永远只传必要字段，千万别照抄客户端全字段 body（本案例最久的一个坑）。

### 未打通（如实记录，勿重复尝试）

| 分支 | 状态 |
|---|---|
| `createJobLogo`/`getResultLogo` | 签名+字段全解出、请求 200，但上游队列恒 `status=4` 不消费，无产物 |
| `reface/create`、`filter/create`（multipart） | JSON 可过签名（回 `Missing files`），multipart 恒 `Invalid MD5`；文件 md5/文件名/字段顺序/字节数全试过 |

收口办法只有一个：arm64 真机 + Frida hook 对应 `invokeSuspend`，打印 md5 与 `MultipartBody` part 列表。
端口占坑、`simCountryCode` 之类的非空字段、snake/camel 字段名漂移，都是这类项目的高频误判点。

### 通用教训补充

5. **服务端与客户端版本会漂移**：同一端点 JSON 能过、multipart 过不了，先怀疑服务端改造口径，
   而不是自己算错。本例服务端 validate 用 `style_id`，客户端 multipart 用 `styleId`。
6. **native key 优先静态取**：5KB 的 JNI 库没必要上 Frida，`strings` / `objdump -s .rodata` 更快。
7. **能力状态三分档**：✅已验证 / ⚠️请求通但无产物 / ❌未打通，逐条给证据；
   不要把「请求 200」包装成「已支持」，logod 分支就是这个反面教材。

## Case 15: FotoPlay 8.4.1 b654（youjia-studio）— 厂商自有 DashScope key 直连，图生图，交付定案 BYO-key（2026-10-29）

**工件**：`videoeditor.videomaker.slideshow.fotoplay`，77.7MB，8 dex，`md5 39a9665b…`，`sha256 e77cb008…`
**仓库**：`lza6/FotoPlay-APP-2api`
**本地**：`D:/apk-analysis/fotoplay841`（`jadx_out` 用于常规检索，`jadx_bad` 才拿到核心类）

### 判型：这一型叫「厂商自有云 key 硬编码 + 无 AI 后端」

比 Case「Draw Anything 硬编码上游凭证」更值得注意的一点：那张 key 不是作者自己的 OpenAI key，
而是**厂商自己的阿里云百炼（DashScope）付费 key**。技术上直接可调，账记在对方公司名下。
所以判型之后的第一动作不是复现请求，是**验证 key 死活**，然后把交付形态改成 BYO-key。

四条判型指纹（全部命中即可 10 分钟内定案）：

1. dex 里出现 DashScope **具体路径**：`/api/v1/services/aigc/image-generation/generation`、
   `/api/v1/services/aigc/multimodal-generation/generation`、`/api/v1/tasks/`
2. 出现 `X-DashScope-Async`（异步 task 开关）
3. 自有域名只做素材 CDN（`cloud.youjia-studio.com` 全是 `/filter/`、`/fotoplay/music3/`、
   `/fotoplay/sticker/zip/`、`/version_new/*.json`），**零写路径**
4. `Bearer` + `sk-` 常量，且是 **`List<String>` + `List.random()` 随机取**

### ★零成本鉴权探针（本案例最重要的可复用资产）

不要为验证 key 去真生一张图 —— 那正是给对方计费。查一个不存在的 task 即可：

```bash
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer sk-xxx" \
  https://dashscope.aliyuncs.com/api/v1/tasks/00000000-0000-0000-0000-000000000000
# 401 + {"code":"InvalidApiKey"}  → key 已吊销（本次实测）
# 400/404 其它 code              → key 有效，但仍不用于生产出图
```

**这类 key 被吊销是常态**：它写在公开渠道的重打包包里，迟早被轮换。所以按"已死"设计不会白干。

### 协议全表（3 端点，全在混淆类 `e6/f.java`）

| 能力 | 端点 | 形态 |
|---|---|---|
| 风格重绘（AI 艺术家） | `POST .../aigc/image-generation/generation` + `X-DashScope-Async: enable` | `{model:"wanx-style-repaint-v1", input:{image_url:"data:image/jpeg;base64,…", style_index:int}}` → `output.task_id` → 轮询 `GET /api/v1/tasks/{id}` → `output.results[0].url` |
| 指令编辑（AI 抠图） | `POST .../aigc/multimodal-generation/generation` | `{model:"qwen-image-edit", input:{messages:[{role:"user",content:[{image},{text}]}]}, parameters:{negative_prompt,seed}}` → `output.choices[0].message.content[*].image` |
| 结果下载 | `GET <url>` | 普通 GET，APP 自己落地 |

鉴权一律 `Authorization: Bearer <key>`；Ktor 超时 connect/request/socket 全 180s；
`Seedream4Error/Exception` 是**死代码**（无端点无模型名），别当线索。

### 混淆还原：string pool 有原始 FQCN，type_ids 里没有

`com.fotoplayapp.libs.aiimage.repository.bean.*` 全被 R8 压成 `f6.C8517b`，但
`I0("com.fotoplayapp.libs.aiimage.repository.bean.AliyunImageStyleRequest", …)` 与
`toString()` 常量（`"AliyunImageStyleRequest(model="`）都是明文 —— 据此做映射表。
`i02.p("image_url", false)` 第二参 = required 标志，字段顺序 = 序列化顺序。

**坑**：`jadx` 默认对「Ktor + 协程 + 单例」的类报 error 并**整类丢弃**，`jadx_out` 里
`aiimage` 包只剩 1 个文件，会误判"不存在"。必须再跑一次 `--show-bad-code` 才拿到 `E6/f.java`。

### 能力边界：只有图生图，不许伪装成文生图

两个模型**都是图生图**。`/v1/images/generations` 是 OpenAI 的文生图语义，上游没这能力 →
网关在该端点**强制要求 `image`，缺了直接 400 `missing_image`**。做"无图也能生"的降级就是伪实现，
且会让下游以为接了个文生图渠道。

### 非标字段 `style_index` 的三种编码（让存量渠道零改动可用）

new-api 的 OpenAI 适配器对 `images/edits` 会 multipart **重序列化**，标准外字段可能丢。网关一次实现对三种：

1. `style_index` 字段（form/JSON）
2. `style` 字段（接受数字字符串；`vivid`/`natural` 必须判为非索引而不是 `int()` 崩）
3. **写进 prompt**：`"... style:3"`，正则 `style\s*[=:]\s*(\d+)`

第 3 条让「只能透传 model/prompt/image」的存量渠道也能驱动风格重绘模型。

### 结果图必须转存

DashScope 返回的是**会过期的平台对象 URL**。不转存，下游拿到 24h 后失效链接，排查起来极像"渠道坏了"。
转存用内容寻址 `sha256[:32]` 天然去重；`FOTOPLAY_PUBLIC_BASE` 必须可配，
否则回相对路径 `/files/x.jpg`，new-api 取不到图。

### 实测数据（mock 模式，本机）

| 项 | 结果 |
|---|---|
| `/health` | 999 rps（10 并发 × 20 轮） |
| `images/edits` 爬坡 1/4/8/16/32 | 4/16/32/64/**128 请求零失败**；p50 11→44→94→184→319ms；p99 13→59→115→196→430ms |
| 风格重绘（异步 task 路径）c=1 | p50 12ms，0 错 |
| 确定性 | 同输入 3 次 → **1 个 sha256** |
| 错误路径 | **9/9** 正确 4xx + 正确 `error.code`（含 `n` 非整数不 500 的回归） |
| demo 页 Playwright E2E | **7/7 PASS**（含上传→出图→`naturalWidth>0`→错误码可见） |
| 契约 + 端点测试 | **60/60 PASS**（12 条请求体契约 + 48 条端点/异步/SSRF/体积回归） |

注意：mock 的 rps 瓶颈是 PIL 渲染的 CPU，不是 IO；真实上游性能**待验证**（需有效 key）。

### 收口判定

- ✅ 协议 100% 还原（含 DTO 字段顺序/required/可选性），契约测试锁死
- ✅ 网关 mock/real 双模、BYO-key、无厂商凭证、无回退分支
- ✅ demo + 压测 + E2E + 对接文档 + 逆向报告全部落地并实测
- ⚠️ 真实出图未验证（key 死且不代跑第三方付费 API）
- ⚠️ `style_index` 有效范围未验证（APP 纯透传，无校验表）→ 交上游文档/自有 key 实测

---

# Case 12 · Glovy AI Photo Generator 1.9.0 → Apero 网关 2API（2026-10-29）

**目标**：`com.aiphotogenerator.aivideomaker.photoslideshow`（Modyolo 重签名，38.5 MB）
**结论**：图片/视频/11 项图像处理全链路打通并实测出图出片；new-api 侧零 adaptor（OpenAI 兼容）。
**产物**：GitHub `lza6/Glovy-AI-Photo-Generator-2api` · 本地 `D:/apk-analysis/glovy/2api`

## 1. 为什么这个案例值得单独记

它是 **Apero 集团（越南）白标模板**的代表：Fravix / Kreivo / Glovy / AI Art Generator 等
54 个 project 共用一套网关与一套 RSA 公钥。**学会一个就通了全族**，且协议面极宽
（文生图 / 图生图 / 图生视频 / 增强 / 修复 / 扩图 / 抠图 / 去物 / 换装 / 试穿 / 美颜 / 分割 / 局部重绘）。

## 2. 鉴权：RSA 信封，不是 HMAC

```
x-api-signature = Base64( RSA/ECB/PKCS1v1.5( pubkey, f"{ts}@@@{api_key}@@@{rand(0..33554431)}" ) )
```

- pubkey 在 `BuildConfig.PUBLIC_KEY` 与 Firebase RC `app_public_key`（全族相同）
- **8 个头缺一即 HTTP 412**：`x-api-signature` / `x-api-timestamp` / `x-api-keyid` / `x-api-token` /
  `x-api-bundleId` / `App-name` / `App-version` / `Country-code`，外加 `device: android` + `UA: okhttp/4.12.0`
- **签名不覆盖请求体** → 一个合法签名可在时间窗内复用任意请求
- `x-api-token`（Play Integrity）传 `not_get_api_token` 也能过；`x-api-bundleId` 不参与 key 归属校验
- `/timestamp` 也要带全套头（否则 412），但它**不校验 key**（可用任意 keyId 探测连通性）

## 3. 凭据链（无需真机 / 无需 Play Integrity）

```
res/values/strings.xml: google_api_key + project_id + google_app_id  （全明文）
  → POST firebaseinstallations.googleapis.com/v1/projects/{p}/installations
     headers: x-goog-api-key, X-Android-Package, X-Android-Cert(APK签名SHA1，mod 重签名也过)
  → POST firebaseremoteconfig.googleapis.com/v1/projects/{p}/namespaces/firebase:fetch?key={gkey}
     headers: X-Goog-Firebase-Installations-Auth: authToken
     body: {app_id, app_instance_id, package_name, ...}  ⚠ 不要带 analytics_user_properties（400）
  → entries{api_key 或 app_api_key/app_bundle_id/app_app_name/app_public_key}
```

**坑**：老版（Glovy 1.9.0 / AIP893）RC 里的 `api_key` 已被上游置为 **401 ERR15 Not active**；
新版（Fravix 2.1.1 / AIP862）结构化下发且 key 有效。因 key 不绑 bundleId，**换活 key 即可**。
ERR15 与 IP/国家/App-name 无关（直连、德国代理、VN country-code 全部同样结果）。

## 4. 端点与实测

| 能力 | 端点 | host | 实测 |
|---|---|---|---|
| 时间戳 | GET `/timestamp` | wrapper | 200 |
| 上传直链 | GET `/api/v5/presigned-link`（**任意 `/api/v5/*/presigned-link` 都通**） | **仅 wrapper** | 200 |
| 图生图/风格化 | POST `/api/v5/image-ai` `{file, styleId?, positivePrompt?}` | wrapper | 201 同步，848×848 |
| 文生图 | POST `/api/v5/premium/text-2-image` `{positivePrompt,width,height,styleId?,seed?}` | wrapper | 201 同步，1024×1024 |
| 图生视频 | POST `/api/v5/image-2-video` `{files, mode:"i2v", notificationProvider, notificationId, model:"inhouse", keepFace, positivePrompt}` | video-gen-core | 201 → 轮询 → mp4 |
| 增强/修复/扩图/抠图/去物/qwen编辑 | `/api/v5/image-enhance`·`image-restore`·`image-outpainting`·`remove-background`·`remove-object`·`/api/v5.1/qwen-editing` | **全部 wrapper** | 5.2/14.0/8.9/3.0/16.2/9.6 s |
| 美颜/换装/试穿/分割 | `/api/v5/beauty`·`clothes-changing`·`fitting`·`segment` | beauty/cloth/fitting/segment-core | 2.9/9.1/5.4/2.8 s |
| 局部重绘 | POST `/api/v1/image-inpainting`（multipart） | wrapper | 12.0 s |
| 风格库 | GET `/v3/styles?page=N`（3826 条/39 页）+ `/category`（590 类） | api-style-manager | 200 免 key |

- 视频状态：`data.result.videoStatus`（processing→completed），成品 `data.result.resultFile`
- 视频产出：**h264 / 704×704 / 121 帧 / 5.04 s / 927 KB**，端到端 ~35 s

## 5. 五个必踩的坑

1. **`mode` 必须小写 `"i2v"`**。APK 里的 `EnumC18481f(IMAGE_TO_VIDEO…)` 是 Qwen 模块的枚举，
   传它必得 `Not supported mode: IMAGE_TO_VIDEO of model: inhouse`；正确值来自 RC 的
   `image_to_video_style.styles[].style_mode = "i2v"`。
2. **presigned 只有 wrapper 有路由**。`core-outpaint` / `image-restore-core` 上的 presigned 全 404，
   `BuildConfig` 里的 `URL_RESTORE/URL_EXPAND/URL_REMOVE_BG` 是装饰性域名；处理端点也在 wrapper。
3. **`styleId` 必须是 style-manager 的 24 位 ObjectId**，RC 里的数字 `style_id`（10009）→
   400 `Expect: length > 24, Value: 5`。服务端会把 styleId 拼成 `style-manager/v3/styles/{id}` 去查。
4. **视频 `notificationProvider`+`notificationId` 必填**（缺 → `client.bad-request`）；`fitting` 用
   `inputImage/clothImage/clothType=upper_body|lower_body|full_body`；`remove-object` 的 `mask` 是
   另一次上传的 path；`inpainting` 必须 multipart。
5. **上传 PUT 不带签名头**（`NOT_ADD_HEADER_METHODS = ["PUT"]`）。

## 6. 交付与实测数据

```
t2i   8 req/2 并发 → 8/8 ok  p50 6.4s  p95 8.6s   (1024×1024)
i2i   6 req/2 并发 → 6/6 ok  p50 8.0s  p95 14.3s  (848×848)
video 1 次 → completed 704×704 h264 5.04s 927KB  ~35s
op    11 项 → 全部 201
mock  300 req/30 并发 → 100% 326 rps p50 88.9ms
e2e   浏览器 → 选风格→上传→出图 848px→统计刷新 PASS
上游  GET /health → {"isHealth":true,"details":[{"wrapper":{"limit":20}}]}
```

**容量结论**：上游 wrapper 并发上限 20 → 网关/渠道并发设 ≤4。

## 7. 商业模型（RC 下发，供定价）

`free_image_generation_limit_per_day=1`、`ads_per_image_generate=1`（激励广告加次数）、
`limit_gen_image_sub_per_day=100`。**额度全在客户端**，服务端无账号体系 → 2API 只需转发，无需伪造内购。


## Case 16: AI Writer v1.0.10（com.smartwidgetlabs.ai.writer）— **Remote Config 本地默认值 + 自签 JWT 型**（2026-10-29）

### 1. 目标画像

| 项 | 值 |
|---|---|
| 包名 / 版本 | `com.smartwidgetlabs.ai.writer` / 1.0.10 (versionCode 53) |
| 发行方 | SmartWidgetLabs；签名 `CN=TRUMods`（mod 重签，SHA1 `99:74:B5:20:...:27:D5:B0`） |
| 技术栈 | Kotlin + Compose、Koin、Retrofit2/OkHttp、Room、Firebase(RC/Analytics/Crashlytics)、AppLovin/AdMob/Pangle |
| 加固 | **无壳**，7 dex 明文；`libaiwriter.so` 仅模板 `stringFromJNI` |
| 分析耗时 | ~40 分钟，纯静态，零 Frida |

### 2. 突破口：apktool 解包后的 `res/xml/remote_config_defaults.xml`

Firebase Remote Config 的 App 内置默认值**明文**打进 APK。本次一条条目即拿到全部凭证：

```json
jwtParam = {"secret":"vulcan@v4-chatgpt","token":"admin","timeExp":5,
            "baseUrl":"https://grammar.metaverselabs.ai/api/"}
```

同一个 XML 还给出 `endpointConfig[]`（5 个功能的 prompt 模板 + `endpointName` 路由映射）、
`dailyFreeUsageConfig`、广告位、订阅项 —— **App 行为的唯一权威**。

> 教训：检索顺序应改为 **先读本地 XML → 再考虑 FIS/firebaseremoteconfig 远拉**。
> mod 版重签后 SHA1 变了，远拉会被 X-Android-Cert 校验挡住，内置默认值反而是唯一稳定路径。

### 3. 鉴权链（客户端自签）

```
K40.a.v() → JwtParam(secret,token,timeExp,baseUrl)      # Gson from RC
  → JWebToken(secret, token, now + timeExp*60s)
      header {"alg":"HS256","typ":"JWT"} + payload {"token":…,"exp":…}
      Base64 NO_WRAP|NO_PADDING|URL_SAFE (Android flag 11) + HmacSHA256
  → Authorization: Bearer <jwt>
     User-Agent: com.smartwidgetlabs.ai.writer 1.0.10 53 Android SDK: <sdk> (<ver>)
```

校验严格度实测：

| 用例 | 结果 |
|---|---|
| 正确 secret、`token=some-random-user-42` | **200**（token 值不校验 → 无用户体系） |
| 正确 secret、`exp` 已过期 60 s | 401 |
| 错误 secret / 空 payload | 401 |
| 无 `Authorization` | 401 `{"code":401,"message":"cookie token is empty"}` + `Www-Authenticate: JWT realm=Flight Tracker API`（gin-jwt 指纹） |

### 4. 端点与上游

| App 功能 | 路由 | 备注 |
|---|---|---|
| writing / expand / shorten | `POST v2/grammar` | 三者共用同一路由 |
| rephrase | `POST v2/rephrase` | 纯透传 |
| email_composer | `POST v2/email_composer` | 纯透传 |

- 直接打 `/api/v2/writing` → **404**（`endpointName` 才是 URL 段）
- `/api/v1/{name}` → 转发 `/v1/completions`；`/api/v2/{name}` → `/v1/chat/completions`
- 上游真身：Go(gin+gin-jwt) 网关 → **Azure OpenAI**，模型错误泄露 `Project proj_X1WDGCYLzyHLtbhST4XJNkkN`
- 可用模型仅 `gpt-5-mini`、`gpt-5-nano`；`gpt-4` 家族走另一条分流上游（`{"data":null,"error":{"message":"Invalid Signature","code":14}}`，未还原）

### 5. 三个新坑（Go 自研网关特征）

1. `temperature`/`top_p` 在 Go struct 里是 **int** → 传小数 400
   `json: cannot unmarshal number 0.2 into Go struct field request.temperature of type int`
2. **不支持 stream**：`stream:true` → 400 `invalid character 'd' looking for beginning of value` → 网关侧伪流式
3. 限流是 **nginx HTML 503**（不是 429），8 并发即触发，重试 2~3 次恢复

### 6. 压测与容量

```
真实上游（每档 8 请求，全部 100% 成功）
并发 2 → p50 12.1s  p90 12.8s  0.17 rps
并发 3 → p50 17.9s  p90 18.5s  0.17 rps
并发 4 → p50 23.8s  p90 25.4s  0.16 rps
并发 8 → p50 33.5s  p90 41.5s  0.16 rps
裸打 16 并发（无重试）→ 10/16，6× nginx 503
MOCK 网关自身 32 并发 → 1157 rps（瓶颈不在网关）
```

**结论**：p50 随并发线性涨、rps 恒定 = 上游串行单通道（低配额 Azure 部署）。
生产建议并发闸门 3、超时 ≥120 s、权重给低，别当主力渠道。

### 7. 交付

`D:/apk-analysis/ai-writer/2api/`：`server.py`（OpenAI 兼容 + 伪流式 + `/v1/aiwriter/*` 原生五功能 +
503 重试 + 并发闸门 + `max_tokens→max_completion_tokens` 自动翻译 + MOCK）、`demo.html`、`bench.py`、
`verify_demo.py`（playwright 4/4 PASS）、`docs/REVERSE-REPORT.md`、`docs/NEW-API-INTEGRATION.md`。

---

## Case 17: StoryBit v3.0.6（snovxgames 白标）— **Firebase RC 下发「端点+密钥」的零设备提取链**（2026-10-29）

### 1. 识别特征（一眼认这套）

- dex/资源/so 全量字符串扫描 **0 个业务域名**，但类名未混淆、有 `remote/ApiUtils` + `comman/AES`
- `ApiUtils` 里出现 `FirebaseRemoteConfig;->getString("API_URL")` → **端点走 RC**
- `AES` 里出现 `FirebaseRemoteConfig;->getString("ED")` → **密钥也走 RC，且 APK 内无默认值**
- 同族：Cloudi AI / Nano AI（leansoft 系）也是这套；本例厂商是 `snovxgames.com`（白标供 `lovi`、`nocrop` 等）

### 2. 零设备提取链（不用模拟器、不用 Frida，3 步官方 API）

```
① resources.arsc → google_api_key(AIza*) + project_id + google_app_id
   签名证书 SHA1 = keytool -printcert -jarfile <apk>（用**分发版**签名，不是原版）
② POST firebaseinstallations.googleapis.com/v1/projects/<proj>/installations
     X-Goog-Api-Key / X-Android-Package / X-Android-Cert
     body {appId, authVersion:"FIS_v2", sdkVersion:"a:17.2.0"}  → fid + authToken
③ POST firebaseremoteconfig.googleapis.com/v1/projects/<proj>/namespaces/firebase:fetch?key=<api key>
     body {app_instance_id:fid, app_instance_id_token:token, app_id, package_name, ...}
     → 全部 entries
```

**本案例产出**：`API_URL=https://stb.snovxgames.com:2053`、`API_AI_URL=https://aa.snovxgames.com:5000`、
`MORE_APP_URL=…:7000`、`ED/AI_ED/AED/MORE_APP_URL_ED` 四把 32 字节 AES key、`aiTool` 开关、`isAIOption`。

**坑集**：
- `analytics_user_properties` 必须 **map**，传 `[]` → `400 Cannot bind a list to map`
- RC 无本地默认值时，拉不到 → key 为空 → `Key must be 32 bytes` 崩溃（这是判断「端点确实在 RC」的铁证）
- 网关必须**启动时拉 RC + 硬编码 fallback**，否则 Firebase 一抖就全挂

### 3. 加密与传输

```java
IV = new byte[16];                    // 全 0
alg = AES/CBC/PKCS5Padding; key = RC 值（32B → AES-256）
body = {"data": Base64.NO_WRAP(ct)}   // 响应同构
```
- 三主机三密钥：主后端 `ED` / AI 后端 `AI_ED` / 互推 `MORE_APP_URL_ED`
- 主后端参数进 **query**（`cc/version_name/version_code/andorid_os_version/package_name/installer`），
  AI 后端参数进 **header**（同样字段但**连字符风格**）——照抄拦截器原文别猜
- **无签名、无时间戳、无 uid、无 session** → 协议彻底无状态、天然可池化
- **Cloudflare 1010 墙**：三域名挂 CF，非 `okhttp/*` UA → `403 error code: 1010`（`text/plain`）

### 4. 端点结构（25 个，双 Retrofit 实例）

同一 `UserService` 接口被两个 Retrofit.Builder 复用，只是 baseUrl 不同 → **路径相同但主机不同**，
`effects/getExplore`、`processStatus/*`、`loadBalance/*` 在 AI 主机（主主机 404）。
`loadBalance/gen_i` 是 **multipart**：文本段 `data`(AES) + 图片原始段（**字段名 = 本地文件名**）。

### 5. 权益：premium 纯客户端（可白嫖判定锚点）

`AppPreferences.new()` 被改成方法头 `const/4 v0,0x1; return v0`，后面全是死代码
（原逻辑：SharedPreferences `isBhupat` → AES(ED) 解密 → `equals("bhupat")`）。
该布尔以 `is_riksha` 上报，**服务端只记录不校验** → AI 生图零额度零账号。

### 6. 上游维护识别（本轮最大教训）

协议全通但不出片时，按这个顺序定性：
1. `upScale_n` 回 `code 120 "under maintenance"` → 功能级下线
2. `gen_i` 受理成功返回 `job_id`，`getProcessStatus` 恒 `state=waiting`（4 个 job 20 分钟无变化）→ 消费者不在
3. RC 里 `aiTool.UpScale.enable=false`、`isAIOption=false` → **厂商主动关的，不是我们参数错**
4. 对照组：传无效 `process_id` 回 `state:"completed" + "Somthing Wrong !"` → 证明轮询链路本身正常

→ 网关设计成 **202 + job_id 排队态 + `MOCK=1` 双模**，上游复活即自动出片，零改代码。

### 7. 压测

```
网关自身(mock) generate c=16 → 100/100 ok, 457 rps, p99 43ms
网关自身(mock) effects  c=32 → 200/200 ok, 380 rps, p99 277ms
上游真实延迟      config/vu p50 538ms · categories p50 520ms · effects(AI 主机) p50 1753ms
```

### 8. 交付

`D:/apk-analysis/storybit/2api/`（GitHub `lza6/StoryBit-APP-2api`）：
`rc.py`（RC 自动引导 + fallback）、`storybit_client.py`（三主机/三密钥/multipart/轮询）、
`server.py`（OpenAI 兼容 generations+edits + 目录 REST + 202 降级 + 并发闸门）、`demo.html`、
`bench.py`、`verify_demo.py`（playwright live+mock 双 PASS）、`matrix.py`（18 端点矩阵）、`effects.json`（914 效果）、
`docs/REVERSE-REPORT.md`、`docs/NEW-API-INTEGRATION.md`；对接交接件 `Desktop/编码规则/StoryBit-2api-new-api对接指南.md`。

### 9. 一条新判据

> **「APK 里查不到域名」不要急着上动态**。先 grep `FirebaseRemoteConfig` / `getString(` 附近的字符串常量，
> 十有八九是 RC 下发。RC 提取走官方 Installations+fetch API，比 mitm/Frida 快一个数量级，
> 且 GMS 私有通道 + pinning 拦不到——动态在这里是纯亏。

### 第二轮：独立 Critic 审查发现的 8 条 P1（2026-10-29 深夜返工）

**教训：自己写的代码自查一遍不够。** 第一轮自检抓了 4 个缺陷，独立 Critic（另起 agent、只读代码、
实际起实例发包）又抓出 8 条 P1，其中 6 条是"用户可控输入 → 500"。全部归类如下：

| # | 缺陷 | 失败场景（实测） | 修法 |
|---|---|---|---|
| 1 | JSON body 不是对象 | `-d '[1,2,3]'` → `AttributeError` 500 | `isinstance(body, dict)` 守卫 |
| 2 | `data:` 串无逗号 | `{"image":"data:image/png;base64"}` → `IndexError` 500 | split 前判长度 |
| 3 | chat `messages` 无守卫 | `messages:"abc"` / `content:5` → 500 ×3 | 逐层类型检查 |
| 4 | 截断 JPEG 过 verify | PIL `verify()` 只验头，`load()` 才炸 → mock 里 OSError 500 | verify + load 双验 |
| 5 | real 模式 chat 下载异常未捕 | mock 永不触发（`mock://` 短路），real 才 500 | 补 `except httpx.HTTPError` |
| 6 | 默认配置 = 开放 SSRF 代理 | `image` 收任意 URL，错误文本当 oracle 探内网端口 | 私网/回环/链路本地封禁 + 关重定向 + 下载上限 |
| 7 | 并发闸门对 `n` 失效 | `CONCURRENCY=8, n=4` → 32 个上游任务在飞，与文档承诺相反 | 信号量下沉到单任务 |
| 8 | `Content-Length` 检查被 chunked 绕过 | 同一 5MB body，chunked → 400 而非 413（说明已全读进内存） | 按实际读到的字节计数 |

P2 里最值得记的三条：

- **PIL 跑在事件循环里**：8 并发时 `/health` p50 从 1ms 涨到 53ms → **bench 测的是 PIL 吞吐不是网关能力**，
  修法是 `asyncio.to_thread`，并在文档里写明"压测数字不代表上游能力"。
- **`gather` 失败不取消兄弟任务**：`n=4` 第 2 个失败后，另外 2 个仍在烧上游配额 → 换 `asyncio.TaskGroup`。
- **上游 429/4xx 被压平成 502**：new-api 会判定"网关坏了"并熔断，正确做法是 4xx 原样、429 透传。

**通用铁律（新增）**：
1. 每个 `await request.json()` 后必须 `isinstance(x, dict)`，每个 `content.split(",")[1]` 必须判长度。
2. `PIL.Image.verify()` ≠ 可解码，必须再 `load()`；同理任何"只验头"的校验都要补真实解码。
3. 接受 URL 参数 = 接受 SSRF，默认封私网并关掉重定向。
4. 限流器要放在**真正产生上游请求**的那一层，放在请求外层等于没放。
5. 体积上限必须按**实际字节**计，`Content-Length` 只是快路径预检。
6. **mock 会掩盖 real-only 的异常路径**（本案 chat 下载 500 在 mock 里 100% 隐藏）→ 用 `httpx.MockTransport`
   注入 transport 做上游契约测试，别只靠 mock 分支。


---

## Case 18: Animefy v2.37.10186（com.picastory.ins.editor，ufotosoft/vibe 白标）— **匿名自造 userid + MD5 签名型；AI 接口不在 face-api 域**（2026-10-30）

### 1. 为什么值得单独记
它是「**AI 接口挂在主业务 API 域、而 SDK 命名会把你引到死路**」的典型。`com.ufotosoft.ai.*` 这套云算法
SDK 里到处是 `face-api.videomate.cc` / `face-api.ufotosoft.com`，**但这两个域全都 404**；真正入口是主服务
`sci.videomate.cc`（`mb.b.a.d(null)` 的默认值 + `LaunchHelper.setAIGCHost(bVar.a())`）。按命名猜会白烧两小时。

### 2. 鉴权：无账号、无设备指纹、无证书固定

```
sign    = md5(signKey + str(int(time.time())))      # 必须秒级
signKey = "mhmjYS"                                  # DES-CBC 解出来的
# 来源: k.java:272  q9.c.c().f(new yb.d().a("aQOWS13Le3U="))
#       DES/CBC/PKCS5  key=Const.DES_KEY="IM41OUCa"
#                      iv={0x12,0x34,0x56,0x78,0x90,0xAB,0xCD,0xEF}
userid  = 客户端自造 20 位串（SharedPreferences sp_key_appset_user_id，首启随机）
```

**服务端只校验签名，不校验 userid 是否存在** —— 黑盒用 `probe0000000000000001` 直接出图。

请求头：`userid` + `userId`（上传端点叫 userId，任务端点叫 userid，两个都带最稳）+ `timeStamp` + `cp` +
`version`(=versionCode 10186) + `platform=1` + `sign`；query 恒带 `ifWise=true`。

### 3. 链路（三步）

```
POST /algo/v1/aiGenerate-aigc/multipleUpload?ifHttps=true     multipart，字段名只能是 files
  → d:["https://algo.videomate.cc/original/<date>/<uuid>.jpeg"]

POST /algo/v1/faceFusion/createAiStyleTask?ifWise=true
  {"styleParams":{"style":"aiGenerate",
                  "params":"{\"effectType\":\"2402\",\"width\":512,\"height\":512,\"oldPicture\":\"1\"}",
                  "requestUrls":[{"index":0,"imgUrl":"<上面那个 URL>"}]},
   "level":0,"token":"","width":1080}
  → d:{jobId, jobStatus:"doing"}

POST /algo/v1/faceFusion/queryAiStyleTask?ifWise=true  {"jobId":"…"}
  → d:{jobStatus:"success", responseUrls:["https://algo-v1.videomate.cc/temp/…"]}
```

三个易错点：`params` 是**字符串化的内层 JSON**（双层编码）；外层 `width` 是**屏幕宽 1080**不是图片宽；
`+width/height` 真正的图片尺寸在内层。

### 4. jobId 前缀 = 上游引擎名（逆向里最省事的探针）

| 前缀 | effectType | 语义 | 实测 |
|---|---|---|---|
| `aiGenerate…` | 2402 | 超分锐化 `aiImageResolution/imagesharpen` | ✅ 1024×1024 |
| `PL_60016_IMG_HA-…` | 9999 | 写实生成 | ✅ 768×1376 |
| `60019-…` | 2501 | `gx_img2img_speed_2511` 人像 img2img | ✅ 792×1320 |
| `hairRepaint…` | 2701 | 染发（走视频查询端点） | `c=3035 IMAGE2VIDEO_OTHER` |
| `22-…` | 21xx/22xx/23xx | 卡通/动漫家族 | ❌ `fail reason=-1`（缺参） |
| `4-…` | 29xx | 未知 | ❌ 同上 |

effectType 家族白名单（`com/gallery/preload/m.java:351`）：`2100/2200/2300/2400/2500/2700/2900`。
dex 里四位 2xxx 串只有 47 个 → **风格库在服务端，客户端只有引擎路由**。

### 5. 商业定位红线
**上游忽略 prompt**：给 9999/2501 传"红苹果/蓝猫"，输出仍是同一套固定模板（同款海边夕阳人像）。
所以它只能做「风格/模板 API」，接 new-api 时不能按文生图定价，也不能承诺尺寸（2402 恒 1024²、2501 恒竖版）。

### 6. 交付与实测（D:/apk-analysis/animefy/2api）
`animefy_client.py` + `demo_server.py`(OpenAI 形，real:8937 / mock:8931) + `static/demo.html` +
`stress_test.py` + `verify_demo.py` + `test_client.py`(8 passed) + `docs/REVERSE-REPORT.md` +
`docs/NEW-API-INTEGRATION.md`(建议渠道号 80) + `evidence/`。

- mock 阶梯压测 600/600 零失败，峰值 56.5 rps@c=10
- real 小样本 12/12 零失败（c=1 p50 6192ms；c=3 p50 6045ms / p95 11925ms）
- 真实出图 enhance 9–11s / portrait 14s / gen 26.7s
- Playwright E2E mock + real 双 PASS

### 7. 本轮新增坑
1. **jadx 把字符串折叠成 `n`**：`@o("algo/v1/{engineName}/n")` 实际是 `multipleUpload`，
   `put("style","n")` 实际是 `aiGenerate`（dex 里存的是 `com.json.*` 静态字段引用）。
   → 别信单字母字符串，回 dex 字符串面或黑盒试错。
2. **host 三态判定法**：打 `/algo/v1/...` 看返回 —— `stgw` 404 = 被腾讯网关挡；Spring Boot JSON 404 =
   真应用但路径错；`{"c":100x}` = **命中**。用这个 30 秒内可定位正确域。
3. **上传字段名严格**：`file/img/image/images` 一律 `param illegal: files is empty`。

## Case 19: AI Zelouri 1.9.6（com.aiart.aigenerator.aifilter.aieditor）— **proxglobal 系第二代：`transfer/config` 一次判死 + token 非门禁**（2026-10-30）

仓库 `lza6/AI-Zelouri-APP-2api`｜目录 `D:/apk-analysis/zelouri196/2api/`｜同族前案：Case「PicGo v2.0.8」
定位：白标 AI 绘图/视频/头像全家桶（Prox Global / NowTech AI / procyoni 三个牌子同一套后端），重广告变现。

### 1. 架构：9 个 Retrofit 实例 = 一张基础设施地图

`ServiceGenerator` 构造函数里逐个 `baseUrl(...)`，把整张网直接交出来：

| baseUrl | 承载 | 状态 |
|---|---|---|
| `http://art12.procyoni.com/` | home/intro/art、expand、video、chat | ❌ 域名停放 |
| `http://TARGET_HOST_1:8005/` | token、txt2img、img2img | ⚠️ 服务活、算力死 |
| `http://TARGET_HOST_1:8006/` | 年鉴上传 | ❌ 端口关 |
| `https://ai-art.proxglobal.co/` | 静态风格目录（175 KB） | ✅ 活 |
| `https://aiart-api.nowtechai.com/` | img2img 新网关 | ❌ 依赖 proxglobal 502 |
| `https://api.openai.com/v1/`（Hilt 注入） | `chat/completions` gpt-3.5-turbo | ❌ key 全停 |

→ **`baseUrl` 密度 = 判死速度**。一个 `ServiceGenerator` 里出现 9 个 baseUrl 的白标，
八成只有 1~2 个还活着，先把每个 `baseUrl` 的根路径各打一次。

### 2. 判定链（按性价比排序，本案全跑过）

1. `GET /api/v1/transfer/config` → 直接吐出 4 个 RunPod pod 地址（50 个风格共用 3 个 img2img pod）。
2. pod 探活（**用 curl**）：`404 + 0 字节` = 已销毁（4/4 全中）。
3. 生成端点下钻业务字段：`200 {"msg":"Finish","content":null}` = 死。
4. token 三态对照（合法/不带/deadbeef 返回一致）→ 非门禁。
5. 结果存储 `:9000` TCP 直连 → 拒绝（产物无处落地，URL 必死）。
6. 侧门：RC 内 294 个 OpenAI key 全 `401 deactivated`；Gemini `403 project suspended`。
7. 假活识别：`qr_art` 回 310×310 1-bit 裸二维码；`video-generate` 41s 返回恒定 `wedding_template.mp4`。

### 3. 签名（本案唯一"完整"的部分）

```
content = "TokenImg2Img" + epoch_ms
hash    = sha256_hex("serverapp@proxglobal%23%^?!154625" + content)   // CommonUtils.i
POST /api/v2.0/token → JWT HS256 {unique, app:"prox_app", exp}  TTL 600s
```
上游提供 **`GET /api/sha256?content=`** 自证端点，本地重算逐比特相同 → 算法还原 100% 闭环。

**但服务端不校验 hash**：`{"content":"x","hash":"x"}` 在 `/api/v2.0/token` 和 `/api/v3/token` 都能签出合法 JWT。
→ 三步判定法（本案固化）：①`/api/sha256` 证明公式；②垃圾 body 试签证明是否校验；③带/不带 token 打生成端点证明是否门禁。
本案三步结论：公式对、不校验、不门禁 = **整个鉴权层是装饰品**。
旧版视频链路另一套：`Key = base64_nw(HmacSHA512(RC["key_hash_hmac_sha512"], str(epoch_ms)))` + `Guard: admin`（源码字面量）。

### 4. 端点形态差异（最耗时的坑，背下来）

| 形态 | 端点 |
|---|---|
| **JSON**（`negative_prompt` 必填） | `api/{v1.0,v2.0}/generator/txt2img`、`.../img2img`（`base64_image` 裸 base64） |
| **form** | `api/v1.0/aiart/txt2img`、`api/v3/txt2img*`、`api/v1.0/aishop/*` |
| **multipart** + `?style=` in query | `api/{v1.0,v1.1,v2.0,v3}/transfer`、`transfer_ios`、`transfer_turbo` |
| **multipart** 普通字段 | `api/v3/img2img`、`aipaint/img2img`、`expand`、`video-generate`、`aiavatar` |

### 5. 交付（D:/apk-analysis/zelouri196/2api → GitHub）

`zelouri_client.py`（token 按 exp 续签 + 全端点）／`demo_server.py`（FastAPI OpenAI 形，mock\|real\|auto，
`X-Zelouri-Source` 标注，并发闸门 429 背压，/metrics）／`demo.html`／`stress_test.py`（压测 + `--upstream` 矩阵）／
`verify_demo.py`（Playwright 8 断言）／`docs/REVERSE-REPORT.md`／`docs/NEW-API-HANDOFF.md`／
`docs/UPSTREAM-STATUS.md`（存活台账）／`evidence/`（openapi、风格表、算力配置、脱敏 RC、压测报告）。

- mock 压测：4 并发 55 rps p50 30ms；8 并发 113 rps；100% 成功
- 浏览器 e2e：8/8 PASS（含"像素可解码 naturalWidth>0"这种真断言）
- 干净 clone 复跑通过；远端复扫 0 明文密钥

### 6. 本轮新增坑

1. **`httpx.Client` 每次新建 = Windows 上被系统代理拖到 3 秒**（同一请求复用 client 只要 22 ms）。
   压测脚本一律 `trust_env=False` + 连接池复用，否则会把客户端开销误判成网关瓶颈。
2. **端口被 `127.0.0.1` 独占监听抢路由**：`netstat` 看到 `0.0.0.0:8947` 是自己的，但连接被另一个
   `127.0.0.1:8947` 的服务接走（返回了完全不相干的 JSON）。换端口前先 `findstr`。
3. **bash `&` 起的后台服务会随工具调用结束被回收**；Windows 上用 `Start-Process -WindowStyle Hidden`。
4. **Firebase RC 匿名可读**（同 Case 17 手法）：`project_id` 从 `resources.arsc` 的
   `google_storage_bucket`（`xxx.appspot.com`）反推；`AIza…` / `1:NNN:android:HEX` 也在 arsc 不在 dex。
5. **不要把"能签 token"写成"渠道可用"**——本案三态对照证明 token 连门禁都不是。

### 8. 归档与交付物（已落地）
- GitHub（public，main）：https://github.com/lza6/Animefy-APP-2api
  （README 能力矩阵 + `animefy_client.py` / `demo_server.py` / `static/demo.html` / `stress_test.py` /
  `verify_demo.py` / `test_client.py` / `docs/REVERSE-REPORT.md` / `docs/NEW-API-INTEGRATION.md` / `evidence/）
- 本地交接文档：`Desktop/编码规则/Animefy-2api-new-api对接指南.md`
- 对接会话启动 Prompt：`Desktop/编码规则/Animefy-对接会话启动Prompt.md`（新会话可直接粘）
- 上游可用性二次确认（2026-10-30 06:09）：real enhance 8.99s 成功，非一次性偶然

---

## Case 20: Video AI v3.2.0（com.codeway.videoapp，Codeway/Cerebro）— **Firestore 文档型：无 REST 生成接口；sig 由规则真值校验，Worker 门禁未解**（2026-10-30）

仓库：https://github.com/lza6/Video-AI-320-APP-Reverse （tag v0.1.0，已脱敏）

### 0. 一句话
这是本系列**第一个"没有 REST 生成接口"的目标**：任务由客户端**匿名写 Firestore 文档**提交，
服务端 Worker 异步回写状态与产物。协议 100% 还原且可复现，但 Worker 在 6 种客户端形态下均不接管 → **当前不可用**。

### 1. 分诊（新增判据，写进 skill）
- `libapp.so` 出现 `cloud_firestore` / `*ProcessAndGetCreationId` / `*StreamById`
- **有 `firebase_core`/`analytics` 但完全没有 `firebase_auth`**（→ Firestore 走匿名规则）
- 反汇编全工程 `http.post` 只有配置与上报两处

命中即转 `firestore-app-2api` 技能，不要再找 baseUrl + 签名 + 轮询。

### 2. 三条链路（全部打通）
```
配置（免鉴权）GET config-api.cdwapi.com/android?aid=com.codeway.videoapp&uid=<任意UUID>&...
              → 51 键：106 模板 / 26 风格 / 5 ai_model / 积分策略 / txt2vidModel=fal_ai_stable_video
用户（HMAC）  POST gateway.cerebroapi.com/user/android
              authorization=<apiKey>; ts=<ms>; rs=HMAC_SHA256(<hmacKey>, f"{body}_{apiKey}_{ts}_/user/android").hex
              → 任意 UUID 200 Successful
任务（Firestore 匿名）POST .../documents/videos ，字段 = model.toJson() + sig
              sig = SHA256("<SIG_SALT>_{cerebroId}_{createdAtMs}").hex.**UPPER**
状态机        CREATED → WAITING → PROCESSING → COMPLETED / FAILED
```

### 3. 本轮最有价值的方法论：**规则单变量 A/B 指纹**
同一 payload 只改一个变量，就能把"黑盒规则"变成可判定的白盒结论：

| 变量 | 结果 | 结论 |
|---|---|---|
| 正确 sig / 随机 64hex / 小写 / 漏盐 / 无 sig | 200 / 403 / 403 / 403 / 403（各 2 轮） | **规则对 sig 做真值校验**，算法+盐 100% 正确 |
| 缺 `cerebroId` | 403 | 规则强制项 |
| `PATCH` 已存在文档 | 403 | 客户端 **create-only**，状态回写只能服务端 |
| `GET /videos?pageSize=1` vs `GET /videos/{id}` | 403 vs 200 | 禁枚举、凭 docId 可读 |
| `PATCH /cerebro-users/{cerebroId}` + 同算法 sig | 200 | 用户文档不是服务端独占 |
| `POST /cerebro-users`（自动 id） | 403 | docId 必须 == cerebroId |

**这一步直接证伪了"sig 不对导致 Worker 拒绝"的假设**，省掉几小时瞎猜。

### 4. Worker 门禁（真正的卡点，纯黑盒无法确证）
6 种形态 × 100–200s 全部 `updateTime` 不动：最少字段 / `status=WAITING` / `inputs` 结构 /
`id` 字段+PATCH / 已有账号（credits=0）/ 完整 `toJson()` 全字段。
→ 触发条件在服务端私有处（白名单/订阅态/Storage 事件）。`images` 集合写入 403（规则与 videos 不同）；
Storage 上传 403/402；项目未启用匿名 Auth（`accounts:signUp` → `CONFIGURATION_NOT_FOUND`）。
**解卡必须 arm64 真机动态抓包**（本机 3 个 AVD 全 x86_64，APK 仅 arm64-v8a）。

### 5. 交付
`docs/PROTOCOL.md`（协议全量）／`docs/EVIDENCE.md`（探针台账）／`docs/NEW-API-HANDOFF.md`（对接交接书：
type=80、TaskAdaptor 14 方法清单、参数映射、**解卡三判据**、红线）／`docs/PLAYBOOK.md`（可复用 SOP）／
`vapi/`（cerebro.py + firestore.py + app.py：MOCK/LIVE/AUTO 网关 + `/api/live/probe`）／`demo.html`／
`stress_test.py`／`gate_test.py`／`probe_full.py`／`tests/`。

- MOCK 压测（零错误）：c8 **542 rps** p50 9.0ms｜c16 **575 rps** p50 21.5ms｜c32 **675 rps** p50 33.3ms
- 全链路 24/24 COMPLETED，e2e p50 **4.08s**；Playwright 真浏览器 console error = **0**
- 密钥全走环境变量：`CEREBRO_API_KEY` / `CEREBRO_HMAC_KEY` / `FIREBASE_API_KEY` / `VIDEOAI_SIG_SECRET`

### 6. 本轮新增坑
1. **blutter 遇到非预编译 Dart 版本（3.5.4）要现场编译 dartvm**：`cmd /c 调 vcvars64.bat` 在本机静默失败
   （只打印 shell banner）；正确做法是 Git Bash 里手工 `export LIB/INCLUDE/PATH`（MSVC lib\x64 +
   Windows Kits `ucrt\x64`/`um\x64`）后直接 `python blutter.py`。
2. **Firestore 规则能做 sha256 真值比对**——不要因为"规则不能哈希"就否定签名假设，先跑 A/B。
3. **`sig` 用的时间戳必须原样写进文档**（`createdAt` 同毫秒），否则 200→403。
4. **`set(merge:true)` 在"文档已存在"时等于 update，会被规则 403**；复刻 App 必须用**预生成 docId 的 create**。
5. **`_getSignature` 结尾常跟一次 GDT 调用**（`toUpperCase`），漏掉大小写就是 403。
6. **不要为了"接渠道"伪造 credits**——红线；正确做法是写解卡判据让别人在有真机时验证。

---

## Case 12: AI Anywhere v0.2.1（com.aichat.aiassistant，CSC Mobi 越南，2026-10-29）

**类型：** 原生 Kotlin + Retrofit/Gson，双主机（业务 + 订阅），**响应体 AES 信封** + 客户端自报 premium。

### 1. 技术定论

| 项 | 值 |
|---|---|
| 业务 Base | `https://app.cscmobicorp.com/aieverywhere/api/v1` |
| 订阅 Base | `https://gsm.cscmobicorp.com`（**protobuf**，与聊天链路完全解耦） |
| 鉴权 | 自定义头 `access-token: Bearer <token>`；未登录发字面量 `guest_user` |
| 信封 | `{"code":int,"message":str,"data":str}`，**成功码 {0,200}** |
| 加密 | base64(`Salted__`+salt[8]+AES-256-CBC/PKCS7)，KDF=EVP_BytesToKey(MD5×3)→48B |
| 口令 | `com.aichat.aiassistant__21__gCsHXrs2ayQSic2w8sdm2tvThZgRgHRX`（`nr.java` 的 `g` 字段） |
| 解包层数 | 外层 JSON → AES → JSON 字符串 → 对象（**四层**） |
| 聊天 | 非流式，connect/read/write 全 180s；会话状态在服务端，请求只带当前一句 |
| 模型 | 只有 2 个端点 = 2 个档位（`chat` / `chat/gemini`），dex 内零模型名 |
| 完整性 | 无 App Check / Play Integrity / 请求签名 / 证书绑定 |

### 2. 本轮最有价值的三条方法论

1. **"类型是 String" 不推出 "内容是明文"**。第一轮就是这样漏掉整层 AES，第二轮用一个
   **登录前就会打的公开 GET**（`/category/`）实测才发现。→ 以后凡是 `data: String` 的信封，
   第一步先看 base64 前缀是不是 `U2FsdGVkX1`。
2. **静态找口令的路径是"解密类 → 调用点 → 常量字段"**，不需要 Frida：
   `rg "Salted__"` 命中兼容解密类 → 看它的调用点形如 `aa.b(resBodyData.getData(), xxxVar.g)` →
   去 `nr.java` 取 `g` 字段。口令本身是 `<包名>__<versionCode>__<32hex>`，**跨版本会变**。
3. **`(Premium)` 类 mod 包的"破解"在字节码层**：`d54.i()` 读取 `isAppPurchased` 后丢弃结果恒 `return true`，
   jadx 一眼可见。这类包证明的是"客户端判定可改"，**不代表服务端有漏洞**——写报告时别混为一谈。

### 3. 上游状态（实测，未认证）

| 链路 | 结果 | 判定 |
|---|---|---|
| DNS + TLS | `TARGET_HOST_2`，TLS 1.69s | ✅ 活 |
| `GET /category/?...`（公开） | `200 {"code":200,...,"data":"U2FsdGVkX1..."}` 3.04s | ✅ 活，且**加密层已破** |
| `GET /user/current-user-info` + guest | **HTTP 500**（应为 401） | ⚠️ 异常处理不健壮 |
| `POST /chat` | 未发起（需合法账号） | ⚠️ 待验证 |

### 4. 号池与限流的判断（值得复用）

- dex 里**没有任何限流相关代码**：无 `Retry-After` 解析、无 429 分支、无退避重试。
- 客户端唯一用量控制是**本地计数器** `count_remaining_use_chat_key` + 激励广告加成（`plus_every_day_chat`）。
- 权益既然是客户端自报，**在没实测到服务端账号级闸门之前，号池对本目标是无效投入**；
  号池只在"服务端按账号计额度 / 账号会封 / 按 IP 限速"三者成立时才有价值。
- → **先 1 个自有账号小流量爬坡探边界，再决定要不要池化**。这一条对所有"客户端自报权益"的目标通用。

### 5. 交付

`D:/apk-analysis/ai-anywhere/2api/`（GitHub `lza6/AI-Anywhere-APP-2api`）：
`aia_crypto.py`（加解密）／`mock_aianywhere.py`（契约复刻 + 5 类故障注入）／`client.py`／
`server.py`（OpenAI 兼容网关，mock/real 双模）／`demo.html`／`stress.py`／
`docs/REVERSE-REPORT-R2.md`／`docs/NEW-API-HANDOFF.md`。

- 压测（mock + AES 全链路）：c1 1.23rps → c64 **46.0rps**，**324 请求 0 失败**，p50 903ms
- 故障注入：429/500/畸形/超时/402 **5/5 PASS**
- 多轮会话映射：连续两轮同一 `conversation_id`，mock 侧该会话 4 条消息

---

## Case 21: Waifu Chat v1.15（chat.ai.mycompanions）— **Unity IL2CPP 型（本系列首个）+ 场景序列化 byte[] 破 AES；上游三条全死**（2026-10-30）

本地：`D:/apk-analysis/waifu-chat/2api`｜仓库：`lza6/Waifu-Chat-APP-2api`
对接书：`Desktop/编码规则/WaifuChat-2api-new-api对接指南.md`

### 0. 一句话
本系列**第一个 Unity IL2CPP 目标**。协议（Flowise 预测契约）100% 还原、立绘 AES 密钥全破，
但 App 的三条 AI 后端链路实测全死 → 归档型交付 + BYO-LLM。

### 1. 判型（新增一行，已写进 skill 路由表）
```bash
unzip -l app.apk | grep -E 'libil2cpp\.so|global-metadata\.dat|libunity\.so'
```
命中 `libil2cpp.so` + `global-metadata.dat` → **Unity IL2CPP**。dex 里只有 UnityPlayer + 插件，
**别去 jadx 找业务代码**。`global-metadata.dat` 头 8 字节 = `sanity 0xFAB11BAF` + `version`（本例 31）。

工具链：`gh release download v6.7.46 -R Perfare/Il2CppDumper -p "*net7-win*"`，
本机只有 .NET 6/8/9/10 → **必须 `DOTNET_ROLL_FORWARD=Major`**。
产物 `dump.cs` 给全类/字段/方法签名 + 字段偏移 + RVA；`script.json` 的 `ScriptMethod` 是
「RVA → 方法名」索引，`bl` 目标一解析就能画出调用链（本例靠它认出 `Aes::Create` / `CryptoStream`）。

### 2. 协议（ChatBehaviour）
```json
POST {CharacterAPI}                       // 每角色一个 Flowise chatflow
{"question":"…","overrideConfig":{"returnSourceDocuments":false,"sessionId":"…"},"history":[{}]}
响应 APIResponse 只有 public string text;（偏移 0x10，反汇编 ldr x1,[x0,#0x10] 双印证）
```
- `HistoryItem` **零字段** → 序列化成 `[{}]`：客户端从不发历史，记忆全靠 `sessionId`。
- `[Serializable]` + 公有字段 → Unity `JsonUtility` **按字段名逐字序列化**，不用猜 camelCase。

### 3. 存活判定：Render.com 三种 404/503 必须分开
| 响应 | 含义 | 判法 |
|---|---|---|
| `404` + `x-render-routing: no-server` | 服务已删除 | **拿随机子域做对照**，逐字节相同即证明 |
| `503` + `suspend-by-user` + "suspended by its owner" | 所有者主动停用 | 与过载/限流区分 |
| `200` JSON | 活着 | — |

10 字节 `text/plain Not Found` 是 Render 边缘兜底，**不是**应用层 404。本例：APK 字面量
`waifu-nb3k` 已删、RTDB 里 30 条 `CharacterAPI` 指向的 `flowise-waifu` 被 suspend、
副链路 `firo.ai` 域名被他人注册改成 Drupal 站。

### 4. ★ 场景序列化 `byte[]` = 立绘 AES 密钥（最值钱的一条）
`dump.cs` 里 `ImageLoader : MonoBehaviour` 带 `public byte[] key; public byte[] iv;`
且**全部字面量都爆破不出 key** → 不是代码里，是资源包里。

```python
import UnityPy, struct
env = UnityPy.load("assets/bin/Data/data.unity3d")
for o in env.objects:
    if str(o.type) != '114': continue          # MonoBehaviour
    raw = o.get_raw_data()                      # typetree 读坏也能拿原始字节
```
MonoBehaviour 原始布局：`PPtr m_GameObject(12) + m_Enabled(4) + PPtr m_Script(12) + string m_Name`
之后才是脚本字段。本例 28 字节头 + 空名字 4 字节 = 32，于是 `raw[32:36] == 20 00 00 00`
紧跟 32 字节 key，再 `10 00 00 00` + 16 字节 iv —— 与「key/iv 是前两个可序列化字段」完全吻合；
`m_Script.pathID=780` 反查 MonoScript 得到类名 `ImageLoader`。

**结果**：AES-256-CBC + PKCS7（`Aes.Create()` 未改 Mode/Padding 即 .NET 默认），
553 张 `.enc` 全解成 JPEG 1024×2048。

**无 IV 时验证 key 的通用技巧**：CBC 尾块 `P_n = D(C_n) XOR C_{n-1}` **与 IV 无关**，
拿「尾块满足 PKCS7」当 key 判定器，一个 key 只需一次 AES 解密。
**必须要求 `pad >= 2`**：只认 `pad==1` 时假阳性 1/256（29k 候选实测命中 106 个全是假的）。

坑：`cryptography` 的 `decryptor()` **不剥 PKCS7**，必须自己 unpad，否则长度恒差 16 字节。

### 5. Firebase 三面（本例全存活，且严重暴露）
- RTDB `/<node>.json?shallow=true` 免鉴权；配置在 `assets/google-services-desktop.json`（Unity 桌面版，
  不是 `google-services.json`），直接给 `firebase_url` / `storage_bucket` / `api_key`。
- **RTDB 公网读 = 角色目录的权威来源**（本例 30 角色 + 每角色 chatflow URL）。
- Storage `/v0/b/<bucket>/o?maxResults=1000` 免鉴权可列，553 个对象。
- Auth 匿名登录 = `ADMIN_ONLY_OPERATION`（provider 已关），别在号池上浪费时间。
- **自我约束**：同一库里躺着 `notifications`（真实 FCM token）、`Report`（450KB 用户举报原文）、
  `userData_Collections`（**62,779 条**用户节点）、`SystemManager.apiKey/organization`（一组 OpenAI 形态
  operator 凭证）。这些**一律不导出、不入交付物、不调用**，只在报告「安全发现」里脱敏记一句。
  该库已被 HackerOne 白帽在 `/test` 节点留名标记过。

### 6. 内容面：Unity 资源里常有意外金矿
`data.unity3d` 的 TextAsset 里直接掏出 `Character Data` CSV（列名就叫
`System Prompt` / `Character Prompt` / `Opening`）与 137KB 多语言 `Translation` CSV。
本例 `System Prompt` 两列**全空**（人设在服务端 chatflow），但 `CharaterInfo_*` /
`CharaterOpening_*` 30/30 命中，成了 persona 的唯一可用来源。
坑：CSV 里的 `Character Info(Translate)` 列**与角色错位**（按名字排序、按另一顺序填键）→
一律以服务端 RTDB 字段为准。

### 7. 两个与上游无关的新工程坑
- **`httpx.Client()` 每请求新建 → 单请求 3.4s**（Windows 默认 SSL context 加载证书库 700–3000ms）。
  症状：延迟随并发线性增长、rps 恒定 ~1，极易误判成"上游串行单通道"。
  分层定位：`curl` 打 `/health` 2ms、`httpx` 打同一端点 600–1200ms → 问题在客户端构造。
  修：FastAPI `lifespan` 建一个共享 client，修后 5–14ms。
- **`asyncio.wait_for(sem.acquire(), timeout=0)` 在空槽时也抛 TimeoutError** →
  闸门 `slot_wait=0` 时连第一个请求都 503。先判 `sem.locked()`，空槽直接 `acquire()`。
  修后契约可精确断言：`max_conc=2 slot_wait=0.5s` + 8 个慢请求 → 恰好 **2×200 + 6×503**。

### 8. 交付与验证
`2api/`：`protocol.py`（契约）+ `gateway.py`（三模式 OpenAI 兼容 + SSE 切片 + 闸门 + 错误映射）+
`mock_upstream.py`（独立进程 + 6 类故障注入）+ `photos.py`（.enc 解密）+ `catalog.py` +
`data/{characters,photos}.json` + `demo/`（含 Playwright 验收）+ `bench/`(压测 + 立绘证据) +
`tests/test_contract.py`（**38 条**）+ `docs/{PROTOCOL,NEW-API-HANDOFF}.md`

- 压测 **305 请求零失败**（并发 1→32），450–652 rps，p99 ≤ 271ms
- Playwright：30 角色 / **30/30 头像解密渲染** / 流式+非流式 / **零 console error**
- 立绘证据：`bench/verify_photos.py` 9/9 解出合法 JPEG
- 独立 Critic 抓出 **4 条 P1 + 7 条 P2**（全部是「用户可控输入 → 500」类），已修并 live 复验；
  其中 P1-4「头号功能零测试覆盖」促成提交 640B 密文向量 fixture。

### 9. 结论档位
**协议可还原但上游不可用**（三档制第二档）→ README 第一句就写"这不是可用渠道"，
三 backend 里只有 `openai`（BYO-key）能上生产，mock 回复必须带 `[MOCK]` 前缀 + `X-Waifu-Source` 头，
杜绝假数据混进监控。

---

## Case 22: Genie v7.9.2（co.appnation.geniechat）— **Flutter AOT 型：一个模型吃满 236K 字符 + 假门禁真文案**（2026-11-12）

白标 Appnation 系（`appnation_devkit` / `appnation_purchases` 复用），Dart 3.5.3 AOT，业务全在 `libapp.so`。
GitHub: `lza6/Genie-APP-2api`。

### 1. 逆向路径
jadx 只能看到壳与插件（4 dex / 13 764 类），业务必须走 blutter：
```
cmd /c "vcvars64.bat && python blutter.py <apk>/lib/arm64-v8a <out>
```
**Windows 下不进 MSVC 环境，cmake -GNinja 必报 CalledProcessError**（找不到 cl.exe）。编译 Dart VM 约 3 分钟。

### 2. 鉴权：Firebase 匿名 + 内嵌 apiKey
apiKey 在 **`resources.arsc`**（不在 dex、不在 so）—— `grep -a -o "AIza[0-9A-Za-z_-]{35}" resources.arsc` 一击命中。
```
signUp?key=<AIza...> {"returnSecureToken":true} -> idToken/refreshToken/localId
Authorization: Bearer <idToken>
```
`X-App-Platform/Version/Id` 三次对照实测**非必需**，只有 Bearer 是硬要求。

### 3. ★ 两套文案同源：软限流 vs Pro 门禁（最容易误判）
两者都以 `I would love to answer this, but it seems that you are not subscribed to the Pro version` 开头，
只能靠尾句区分：

| 尾句 | 含义 | 状态码 |
|---|---|---|
| `Please upgrade to Pro for advanced chat models.` | 当日额度用尽 | **200 + SSE**，且缺 `completion-done` |
| `Please upgrade to Pro for image generation.` | 生图权益不足 | 200 + SSE，有 `completion-done` |
| `Please upgrade to Pro to get web search access.` | 联网权益不足 | 同上 |
| 请求非 mini 模型 | 模型需订阅 | **402** + `{"error":{"code":"NEEDS_PRO"}}` |

第一版把生图拦截当成软限流，号池连换 9 个账号、每个都标 `soft_limited`，全是假阳性。
**判据要按「service 通道 + 尾句」组合，不要只看文案头。**

### 4. ★ 上下文按字符截断，不按 token
needle-in-haystack 阶梯（问题放末尾）：

| 字符 | 英文 | 中文 |
|---|---|---|
| 2K–236K | 全通过 | 60K/88K/120K/180K/236K 全通过 |
| 240K | ✗ | — |
| 256K | ✗ | — |

超限表现：**HTTP 200、SSE 正常、无报错**，但末尾问题丢失，模型回"你给了一段很长很重复的文本"。
256K 时连 8% 位置的 needle 都答不出 → 截断区间不固定，不能假设保头。
中英阈值一致 = 按字符算，配置侧必须按字符留余量（建议 200K）。

**测法要点**：填充文本要带编号避免极端 token 压缩；needle 位置至少测 2%/60%/97% 三档才能定截断策略。

### 5. ★ `?type=` 不是开关，服务端有自己的意图分类器
`?type=image_generation / text2image / IMAGE_GENERATION / garbage`、甚至**完全不带 type**，
只要 prompt 是"画一只猫"，服务端都回 `agent-status {"status":"tool_calling","service":"text2image"}`。
反过来 `?type=websearch`（非枚举值）不触发任何工具。
→ 别在 type 值上做绕过尝试，它只是客户端提示。

### 6. 视觉能力：免费档能吃图，走 content 首行 URL
```
content: "https://placehold.co/600x400/1e3a8a/f8fafc/png?text=ZX9\n图里写了什么字？"
```
实测读出 `ZX9` + 蓝色系 + 文字居中/浅色/四边留白（版面信息 URL 里没有，排除"从 URL 猜"）。
**坑：URL 必须排在文本前面**。放问题后面，模型回"无法查看图片"。
`media` 字段（客户端附件通道）裸协议不识别。

### 7. 伪函数调用：上游没有就在网关补
上游无 tools/tool_choice/function_call 任何字段（`parameters` 整块被丢）。
网关做法：工具定义渲染成协议文本注入首条 prompt → 模型只输出 `{"tool_call":{...}}` → 转标准 `tool_calls`。
`role:tool` 回灌转 `[工具结果 <name>]`；`tool_choice=required` 用提示词强制。
实测 5/5 功能项 + 6/6 触发率，双工具选择正确，延迟 1.87–2.80 s。
**结论：function calling 是 2API 层的活，不是上游的活——上游没有不等于渠道没有。**

### 8. 权益伪造全失败（别浪费时间）
`X-Is-Pro` / `X-Premium-Status` / `premiumStatus`(header) / `X-Premium` / body `isPro` / `premiumStatus` /
`isPremium+user` / `X-App-Platform:ios` / 去掉全部 X-App-* —— 9 组全部无效。
客户端 `isPro` 只是 assistant 卡片展示字段；`premiumStatus` 只用于 `ANEnvironmentInfo` 上报
management-api；`genie_wishes` 是 shared_preferences 本地键；`test_reset_credits` 是本地调试方法名。
**权益服务端按 uid 查，客户端没有任何可伪造面。**

### 9. 输出与吞吐
- 输出：请求 ≤2500 字可接受，≥2800 字模型直接拒答；实际自然收尾在 1000–1400 中文字（≈800 tok）。
- 流式：**伪流式**，所有 delta 在生成完成后一次性到达（首 delta 时刻 ≈ 总时长，spread 0–0.25 s）。
  结束靠 `completion-done{"reason":"stop"}`，**没有 `data:[DONE]`**。
- 吞吐：86–122 中文字符/秒（≈51–72 tok/s），TTFT 6–9 s。
- 额度：8 次/uid，跨 UTC 零点**不重置**；同 IP 新建 uid 首次请求 3/3 正常 → 按 uid 不按 IP。

### 10. 旁路资产
`GET /v2/assistants/system`（需 Bearer）返回 7 分类 **34 个官方助手**，每项带 `prompt`/`systemPrompts`/`questions`/`action`。
`action` 里藏着 8 种能力标记：`image_generation`(image/tattoo/signature/logo)、`web_search`、
`pdf_summary`、`image_identifier`(plantIdentifier)。其中 `generationType` **只用于页面路由，不进 HTTP**。

### 11. 交付
`genie_client.py`（协议 + 号池 + 视觉 + agent）/ `demo_server.py`（chat + images + 伪函数调用 + mock 双模）/
`tool_calling.py` / `demo.html`（双 tab + 工具开关）/ `stress_test.py` / `browser_test.py` /
`tools/`（smoke 7 项、bench 5 suite、边界探针）/ `docs/{CAPABILITIES,REVERSE-REPORT,NEW-API-INTEGRATION}.md`
实测：冒烟 7/7、伪调用 5/5 + 6/6、视觉透传、mock 160 请求 0 失败、real 18 请求 0 失败、Playwright 4/4。
