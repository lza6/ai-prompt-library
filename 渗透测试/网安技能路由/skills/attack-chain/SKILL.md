# 多阶段攻击链编排

## 适用场景

- 完整渗透测试（从外网到内网）
- HW 攻防演练
- 从外网打到域控
- 攻击路径规划

## 攻击链阶段

```
侦察 → 扫描 → 漏洞发现 → 初始突破 → 据点建立
→ 信息收集 → 横向移动 → 权限提升 → 目标达成 → 报告
```

## 工作方式

本 skill 是"总指挥"，根据目标环境组合其他 skill：

1. **侦察阶段** → `pentest-tools/` (Nmap, subfinder)
2. **Web 突破** → `pentest-tools/` (SQLMap, FFUF, Nuclei)
3. **二进制利用** → `pwn-chain/`
4. **内网渗透** → `pentest-tools/` (NetExec, BloodHound)
5. **凭证获取** → `pentest-tools/` (Mimikatz)
6. **报告输出** → `docs-generator/`

## 参考文档

- `references/attack-playbooks.md` — 攻击剧本
- `references/evasion-cheatsheet.md` — 免杀/规避速查
