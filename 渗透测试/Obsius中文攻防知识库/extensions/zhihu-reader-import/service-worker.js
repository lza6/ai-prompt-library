const API = "http://127.0.0.1:8420"
const ARTICLE_URL = /^https:\/\/zhuanlan\.zhihu\.com\/p\/\d+\/?(?:[?#].*)?$/

async function setBadge(tabId, text, color, title) {
  if (!Number.isInteger(tabId)) return
  await chrome.action.setBadgeText({ tabId, text })
  await chrome.action.setBadgeBackgroundColor({ tabId, color })
  if (title) await chrome.action.setTitle({ tabId, title })
}

async function importTab(tabId, expectedUrl) {
  const [{ result: page }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => ({
      url: location.href,
      title: document.title || "",
      ready: document.readyState,
      text: (document.querySelector("article") || document.querySelector("main") || document.body)?.innerText || "",
      html: "<!doctype html>" + document.documentElement.outerHTML,
    }),
  })
  if (!page || !ARTICLE_URL.test(page.url) || new URL(page.url).pathname !== new URL(expectedUrl).pathname) {
    throw new Error("浏览器最终页面与目标知乎文章不一致")
  }
  if (page.ready !== "complete" || page.text.trim().length < 400) {
    throw new Error("知乎文章尚未完成渲染或正文不足 400 字")
  }
  if (new Blob([page.html]).size > 12 * 1024 * 1024) throw new Error("文章页面超过 12 MiB")
  const response = await fetch(`${API}/api/intel/read/import-browser`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: expectedUrl, html: page.html }),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload.detail || `本机阅读器返回 HTTP ${response.status}`)
  return payload
}

chrome.action.onClicked.addListener(async (tab) => {
  const tabId = tab.id
  const url = tab.url || ""
  if (!Number.isInteger(tabId) || !ARTICLE_URL.test(url)) {
    await setBadge(tabId, "URL", "#b45309", "请在知乎专栏文章页使用导入")
    return
  }
  try {
    await importTab(tabId, url)
    await setBadge(tabId, "OK", "#15803d", "文章已导入本机阅读器")
  } catch (error) {
    await setBadge(tabId, "ERR", "#b91c1c", String(error?.message || error))
  }
})
