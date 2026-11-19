---
title: Webshell 流量识别与解密
phase: forensics
vuln_class: [pcap, webshell, traffic-decryption, incident-response]
summary: 从 pcap 里认出是哪一款 webshell 管理器，比认出「这是 webshell」更有价值——每款的加密形态与默认密钥不同，认对型号就能直接解密出明文命令。判据是请求体的加密结构与响应体的编码层次。
---

# Webshell 流量识别与解密

流量侧取证专题。webshell 的**投放与利用**见 [[web/实战打法/什么是rce.md|RCE 打法]] 与 [[web/漏洞分类/文件上传/文件上传漏洞测试手册.md|文件上传]]；本篇只讲**拿到 pcap 之后怎么认型号、怎么解出明文**。

## 0. 判据速查

| 现象 | 型号 | 去哪节 |
|---|---|---|
| 请求体含 `@ini_set` + `base64_decode`，响应明文 | 中国菜刀 | §1 |
| 请求体 16 字节倍数、AES 密文，响应也是 AES | 冰蝎 2.x | §2 |
| 请求体 AES，响应体内层 base64 | 冰蝎 3.x | §3 |
| 请求体 base64 + 固定 pass 参数，响应有 XOR 痕迹 | 哥斯拉 | §4 |
| 请求体 `@ini_set("display_errors","0")` | 蚁剑 | §5 |
| 只有 POST 到 `.php`，体长恒定但内容高熵 | 先按体长聚类，再比对 §1–§5 | §6 |

## 1. 中国菜刀（Chopper）

**判据**：请求体是**明文 PHP**，包含 `@ini_set("display_errors","0")`、`base64_decode`、`@eval`。

```text
POST /shell.php HTTP/1.1
Content-Type: application/x-www-form-urlencoded

z0=@ini_set("display_errors","0");@set_time_limit(0);...@eval(base64_decode($_POST['z1']));
z1=QGluaV9zZXQoImRpc3BsYXlfZXJyb3JzIiwiMCIpOw==
```

响应也是明文（可能带 `X-Powered-By` 或 `-->|` 分隔符）。**直接读，不需要解密**。

**特征参数字名**：`z0`/`z1`/`z2` 是菜刀默认；改过名的看 `eval(base64_decode($_POST['<name>']))` 里的 name。

## 2. 冰蝎 2.x（Behinder）

**判据**：请求体长度是 **16 的整数倍**，内容高熵（AES-CBC 密文），响应体同样是 16 倍数高熵。

```python
from Crypto.Cipher import AES
key = b'e45e329feb5d925b'        # 默认密钥 = md5("rebeyond")[:16]
cipher = AES.new(key, AES.MODE_ECB)   # 2.x 是 ECB，不是 CBC
plain = cipher.decrypt(payload)
```

**解密顺序**：AES-ECB 解出 → 去掉 PKCS#7 填充 → 得到 PHP 代码明文。

```bash
# 从 pcap 抽出 POST body
tshark -r a.pcap -Y "http.request.method==POST" -T fields -e http.file_data \
  | xxd -r -p > bodies.bin
```

**默认密钥表**（改过就要爆破或从马源码里读）：

| 版本 | 默认密钥 |
|---|---|
| 冰蝎 2.0 | `e45e329feb5d925b`（`md5("rebeyond")[:16]`） |
| 冰蝎 3.0 | 由 `md5(<连接密码>)[:16]` 派生 |

**不成立**：解出来是乱码且长度不是 16 倍数 → 可能是 3.x（走 §3）或经过 gzip。

## 3. 冰蝎 3.x

**判据**：请求体 AES 加密，**响应体是「AES 密文再 base64」的两层**。

```python
import base64, gzip
from Crypto.Cipher import AES

key = hashlib.md5(b"<连接密码>").hexdigest()[:16].encode()
raw = base64.b64decode(resp_body)             # 第一层：base64
plain = AES.new(key, AES.MODE_ECB).decrypt(raw)
plain = plain[:-plain[-1]]                    # 去 PKCS#7
try:
    plain = gzip.decompress(plain)            # 3.x 响应常再 gzip
except OSError:
    pass
```

**3.x 与 2.x 的分界**：3.x 的请求头常带 `Content-Type: application/x-www-form-urlencoded` 但体是二进制；响应体一定先 base64。

## 4. 哥斯拉（Godzilla）

**判据**：请求体 **base64 后接固定 `pass=<随机>`**，且解码后头部有一段**异或**过的字节。

哥斯拉的载荷结构是「AES 加密 + base64」或「XOR + base64」两种模式，密钥由 `pass` 与马内硬编码的 `key` 共同派生（MD5 拼接后取前 16 字节）。

```python
import base64, hashlib
raw = base64.b64decode(body)
# 头部 16 字节是 MD5(key+pass) 派生的 XOR 掩码
```

**判据**：base64 解码后的前 16 字节重复出现且后续内容高熵 → XOR 模式；整段高熵无重复 → AES 模式。
**不成立**：`pass` 参数每次都变但体长恒定 → 那是带随机 IV 的 AES 模式，需要从马源码取 key。

## 5. 蚁剑（AntSword）

**判据**：请求体含 `@ini_set("display_errors","0")` 且带 `function_exists` 探测，**默认不加密**（明文 PHP）。

与菜刀的区别：蚁剑会先发一段**探测请求**（`assert`/`function_exists` 检测可用函数），再发实际命令；菜刀直接发 payload。

**流量侧识别**：同一 URI 上「先小包探测、后大包执行」的两段式 POST → 蚁剑。

## 6. 未知型号的分流

按体长与熵聚类，再逐类比对：

```bash
# 导出所有 POST 体长度与 URI，看分布
tshark -r a.pcap -Y "http.request.method==POST" \
  -T fields -e http.request.uri -e http.content_length | sort | uniq -c | sort -rn
```

| 体长特征 | 倾向 |
|---|---|
| 恒定长度、内容每次不同 | AES-CBC/ECB + 固定 IV 或 ECB（冰蝎系） |
| 长度随命令长度线性增长 | 明文或流密码（菜刀/蚁剑） |
| 长度是 16 的倍数且等于命令长度取整 | 分组密码 + PKCS#7 |
| 长度 = 4×ceil(n/3) | 先 base64 再发（哥斯拉） |

## 7. 纪律

- **先定型号再解密**。拿冰蝎的密钥去解哥斯拉的包只会得到乱码，然后误判「加密强度高」。
- **默认密钥先试**。冰蝎 2.x 的 `e45e329feb5d925b` 在大量老题里没改。
- **响应体常比请求体多一层编码**（3.x 的 base64、gzip），解不开先剥外层。
- **明文 PHP 也要读**。菜刀/蚁剑不加密，直接看 `eval` 里的内容就是攻击者的真实命令。
- 提取的密钥与明文只在授权取证目录保存。
