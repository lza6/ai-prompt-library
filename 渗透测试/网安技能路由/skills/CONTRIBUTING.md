# 新增 Skill 指南

## 如何新增一个技能模块

### 1. 创建目录结构

```
skills/your-skill-name/
├── SKILL.md              # 必须 — 技能描述和工作流
├── references/           # 可选 — 参考文档
│   ├── xxx.md
│   └── xxx.md
├── scripts/              # 可选 — 辅助脚本
│   └── xxx.sh / xxx.ps1
└── templates/            # 可选 — 模板文件
    └── xxx.md
```

### 2. SKILL.md 必须包含

```markdown
# 技能名称

## 适用场景
[清晰描述何时使用此技能]

## 工具链
| 工具 | 用途 | 安装方式 |
|------|------|----------|

## 工作流程
[步骤化的操作指南]

## 参考文档
[列出 references/ 下的文件]
```

### 3. 更新路由矩阵

在 `skills/routing.md` 中添加：

- **按目标类型** 表格中添加新行
- **按用户意图** 表格中添加触发词
- **路径交叉** 如需跨模块组合

### 4. 更新 bootstrap 清单

如果引入了新工具，在 `skills/scripts/bootstrap-manifest.json` 中添加：
```json
{
  "tool-name": {
    "name": "tool-name",
    "description": "工具描述",
    "install_type": "pip-package|apt-package|github-release|...",
    "package": "包名",
    "verify_cmd": "验证命令",
    "platforms": ["windows", "linux", "macos"]
  }
}
```

### 5. MCP 服务集成（可选）

如果工具需要通过 MCP 暴露给 AI：

1. 在 `.kiro/settings/mcp.json` 中添加 MCP 服务器配置
2. 在 SKILL.md 中说明 MCP 工具的使用方式
3. 确保 bootstrap 能自动启动 MCP 服务

### 6. 测试

- [ ] AI 能通过触发词正确路由到新 skill？
- [ ] SKILL.md 的工作流程可执行？
- [ ] bootstrap 能自动安装依赖工具？
- [ ] tool-index 能正确检测工具状态？

### 7. 提交 PR

```
git add skills/your-skill-name/ skills/routing.md skills/scripts/bootstrap-manifest.json
git commit -m "feat: add your-skill-name skill"
git push origin main
```
