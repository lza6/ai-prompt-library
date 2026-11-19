"""阅读器 AI 问答（阅读器模块，2026-10-27）：把「文章上下文 + 划线片段 + 问题」
拼成一次问答请求。

**为什么独立成模块**：prompt 的取舍直接决定回答质量，且这几个约束都必须被测试
钉住（上下文预算、划线片段必须显式引用、不得编造原文没有的内容）。混在
`app.py` 里就只能靠读代码保证。

三个入口对应三种真实使用姿势：
- `answer_about_selection`  划词后点「问 AI」——必须聚焦在被划的那句话上；
- `answer_about_article`    侧栏直接提问——带全文上下文但不带划线；
- `suggest_from_selection`  划线后要「解释这段」这类固定动作（前端内置按钮）。
"""

from __future__ import annotations

from dataclasses import dataclass

#: 给 AI 的文章上下文预算（字符）。技术长文常 3-6 万字，全塞会把上下文吃满、
#: 挤掉对话历史；2.4 万字够覆盖绝大多数安全研究文章的主体。
CONTEXT_BUDGET = 24000
#: 单条划线片段上限——防止用户全选（等于又问一遍全文）
MAX_SELECTION = 4000
#: 对话历史保留轮数（一问一答算 1 轮）。再多对「读这篇」的场景没有增益。
MAX_HISTORY_TURNS = 6

SYSTEM_PROMPT = """你是这个阅读器内置的技术阅读助手，帮助用户读懂他们正在阅读的文章。

规则：
1. **只依据提供的文章内容回答**。文章没有提到的，明确说「文章未提及」，不要用你自己的知识补全成像是文章说的。
2. 用户划了某一段来提问时，那个片段是问题的焦点——先针对它回答，必要时再引用文章的其它部分作补充。
3. 涉及代码、命令、CVE 编号、payload 时保持原样，不要改写或省略细节。
4. 回答简洁：能用几句话讲清就不要写小标题和列表。需要步骤时再用列表。
5. 用户问「这是什么意思」「解释一下」时，先给出直白的一句话解释，再补充必要的背景。
6. 用中文回答（除代码、术语原文）。"""


@dataclass
class ArticleContext:
    """喂给 AI 的文章信息。字段与 `reader.ReadResult` 对齐但更窄，
    便于测试直接构造而不依赖抓取层。"""
    title: str = ""
    url: str = ""
    site: str = ""
    published: str = ""
    text: str = ""

    def header(self) -> str:
        parts = [f"标题：{self.title or '(未知)'}"]
        if self.site:
            parts.append(f"来源：{self.site}")
        if self.published:
            parts.append(f"发布：{self.published}")
        if self.url:
            parts.append(f"链接：{self.url}")
        return "\n".join(parts)


def clip(text: str, limit: int) -> str:
    """按字符裁剪并显式标注省略——**绝不静默截断**。

    静默截断的后果是模型不知道内容被剪过，会把「剪断处之后没有」当成「文章
    没写」，进而给出「文章未提及」的错误结论。
    """
    text = (text or "").strip()
    if len(text) <= limit:
        return text
    return f"{text[:limit]}\n\n……（上下文已截断，原文更长）……"


def build_messages(article: ArticleContext, question: str, *,
                   selection: str = "",
                   history: list[dict] | None = None,
                   budget: int = CONTEXT_BUDGET) -> list[dict]:
    """组装 messages（OpenAI/Anthropic 通用形态）。

    第一轮把文章正文放进 user 消息（而非 system）：多数供应商对 system 的长度
    与缓存策略有额外约束，放 user 侧最稳，也与「这是一份材料」的语义一致。
    """
    question = (question or "").strip() or "请概括这篇文章的核心内容。"
    body = clip(article.text, budget)
    parts = [f"以下是用户正在阅读的文章。\n\n{article.header()}\n\n---\n{body}\n---"]

    sel = (selection or "").strip()
    if sel:
        parts.append(f"\n用户划选了这一段：\n\n「{clip(sel, MAX_SELECTION)}」")

    messages: list[dict] = [{"role": "user", "content": "\n".join(parts)},
                            {"role": "assistant",
                             "content": "好的，我已读完这篇文章。请问你想了解什么？"}]

    # 历史只取最近若干轮；超预算的旧轮次丢掉而不是无限增长
    for turn in (history or [])[-MAX_HISTORY_TURNS * 2:]:
        role = str(turn.get("role") or "")
        content = str(turn.get("content") or "").strip()
        if role in ("user", "assistant") and content:
            messages.append({"role": role, "content": content})

    messages.append({"role": "user", "content": question})
    return messages


def answer_about_selection(article: ArticleContext, selection: str,
                           question: str, *, history: list[dict] | None = None,
                           budget: int = CONTEXT_BUDGET) -> list[dict]:
    """划线提问：selection 必填（空则退化为整篇提问）。"""
    return build_messages(article, question, selection=selection,
                          history=history, budget=budget)


def answer_about_article(article: ArticleContext, question: str, *,
                         history: list[dict] | None = None,
                         budget: int = CONTEXT_BUDGET) -> list[dict]:
    """侧栏直接提问：不带划线焦点。"""
    return build_messages(article, question, history=history, budget=budget)


#: 划线浮动菜单的固定动作（前端按 key 取 prompt，避免前端各写一套措辞）。
#: 值是 (展示标签, prompt)——标签放后端是为了前后端只维护一份，加动作不必改两处。
SELECTION_ACTIONS: dict[str, tuple[str, str]] = {
    "explain": ("解释这段",
                "解释这段内容是什么意思，用直白的语言说明它讲的是什么、为什么重要。"),
    "translate": ("翻译",
                  "把这段翻译成中文（术语与代码保持原样）。"),
    "simplify": ("说人话",
                 "用更简单的话重述这段，假设读者只有基础知识。"),
    "expand": ("补充背景",
               "这段涉及的技术背景是什么？结合文章上下文补充必要的背景知识。"),
}


def selection_action_prompt(action: str) -> str:
    """取固定动作的 prompt；未知 key 回通用提问（不抛，避免前端加按钮就 500）。"""
    entry = SELECTION_ACTIONS.get(str(action or ""))
    return entry[1] if entry else "解释这段内容，并结合文章上下文说明其含义。"
