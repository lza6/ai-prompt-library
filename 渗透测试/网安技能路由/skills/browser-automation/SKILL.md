# 浏览器与桌面自动化

## 适用场景

- 浏览器自动化操作（Playwright）
- Windows 桌面应用自动化（OpenReverse UIA/CUA）
- 网页抓取、截图、表单填写
- 自动化登录、爬取

## 工具链

| 工具 | 用途 |
|------|------|
| Playwright | 浏览器自动化（Chrome/Firefox/Safari） |
| OpenReverse | Windows 桌面自动化 (UIA/CUA) |
| agent-browser | AI 浏览器代理 |

## Playwright 快速上手

```python
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(headless=False)
    page = browser.new_page()
    page.goto('https://example.com')
    page.screenshot(path='screenshot.png')
    browser.close()
```

## 参考文档

- `references/playwright-cheatsheet.md` — Playwright 速查表
