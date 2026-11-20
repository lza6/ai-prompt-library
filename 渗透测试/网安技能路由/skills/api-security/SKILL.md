# API 安全测试

## 适用场景

- REST / GraphQL / WebSocket 安全测试
- BOLA / IDOR / BFLA 漏洞
- JWT / OAuth / SAML 攻击

## 测试范围

| 漏洞类型 | 说明 |
|----------|------|
| BOLA | 对象级授权绕过 |
| BFLA | 功能级授权绕过 |
| 过度数据暴露 | API 返回过多数据 |
| 资源消耗 | 无限制的分页/查询 |
| SSRF | 服务端请求伪造 |
| JWT 攻击 | 算法混淆、密钥泄露 |
| OAuth 攻击 | redirect_uri 劫持 |

## 参考文档

- `references/rest-graphql-testing.md` — REST/GraphQL 测试
- `references/jwt-oauth-testing.md` — JWT/OAuth 测试
