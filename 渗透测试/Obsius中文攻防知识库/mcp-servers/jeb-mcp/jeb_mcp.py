"""将 JEB 的本机 HTTP JSON-RPC 接口桥接为标准 stdio MCP。"""

import argparse
import ast
import asyncio
import json
import math
from pathlib import Path
import sys

import httpx
from mcp import types
from mcp.server import Server
from mcp.server.stdio import stdio_server


DEFAULT_SCRIPT = Path("D:/Tools/JEB-5.40/scripts/MCP.py")
RPC_URL = "http://127.0.0.1:16161/mcp"
DEFAULT_TIMEOUT = 30.0


def discover_tools(script_path: Path) -> list[types.Tool]:
    # 只解析源文件，绝不导入或执行依赖 Jython/JEB 的脚本。
    tree = ast.parse(script_path.read_text(encoding="utf-8-sig"), filename=str(script_path))
    tools = []
    for node in tree.body:
        if not isinstance(node, ast.FunctionDef) or not any(
            isinstance(decorator, ast.Name) and decorator.id == "jsonrpc"
            for decorator in node.decorator_list
        ):
            continue
        args = node.args
        if args.vararg or args.kwarg or args.posonlyargs:
            raise ValueError(f"不支持的 JEB RPC 签名：{node.name}")
        properties = {arg.arg: {} for arg in args.args + args.kwonlyargs}
        required = [arg.arg for arg in args.args[:len(args.args) - len(args.defaults)]]
        defaults = list(zip(args.args[len(args.args) - len(args.defaults):], args.defaults))
        for arg, default in zip(args.kwonlyargs, args.kw_defaults):
            if default is None:
                required.append(arg.arg)
            else:
                defaults.append((arg, default))
        for arg, default in defaults:
            properties[arg.arg]["default"] = ast.literal_eval(default)
        # 原脚本没有类型注解；保留 Any，而不是凭参数名猜测类型。
        tools.append(types.Tool(
            name=node.name,
            description=ast.get_docstring(node) or "",
            inputSchema={
                "type": "object", "properties": properties,
                "required": required, "additionalProperties": False,
            },
        ))
    if not tools:
        raise ValueError(f"未在 {script_path} 找到 @jsonrpc 工具")
    return tools


def text_result(value, *, error=False):
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
    return types.CallToolResult(
        content=[types.TextContent(type="text", text=text)], isError=error,
    )


class JebBridge:
    def __init__(self, tools: list[types.Tool], timeout: float = DEFAULT_TIMEOUT):
        if not math.isfinite(timeout) or timeout <= 0:
            raise ValueError("超时必须为有限正数")
        self.tools = {tool.name: tool for tool in tools}
        self.timeout = timeout

    async def call(self, name: str, arguments: dict):
        if name not in self.tools:
            return text_result(f"未知 JEB 工具：{name}", error=True)
        request = {"jsonrpc": "2.0", "id": 1, "method": name, "params": arguments}
        try:
            # 固定 loopback、禁用环境代理及重定向，不会自动启动 JEB。
            async with httpx.AsyncClient(trust_env=False, follow_redirects=False) as client:
                response = await asyncio.wait_for(
                    client.post(RPC_URL, json=request, timeout=self.timeout),
                    timeout=self.timeout,
                )
                response.raise_for_status()
                payload = response.json()
            if not isinstance(payload, dict) or payload.get("jsonrpc") != "2.0" or payload.get("id") != 1:
                return text_result("JEB 返回了无效的 JSON-RPC 响应", error=True)
            if "error" in payload:
                return text_result({"error": payload["error"]}, error=True)
            if "result" not in payload:
                return text_result("JEB JSON-RPC 响应缺少 result", error=True)
            return text_result(payload["result"])
        except (httpx.TimeoutException, asyncio.TimeoutError):
            return text_result(f"JEB RPC 超时（{self.timeout:g} 秒）", error=True)
        except httpx.HTTPStatusError as exc:
            return text_result(f"JEB RPC HTTP 错误：{exc.response.status_code}", error=True)
        except httpx.RequestError as exc:
            return text_result(f"无法连接 JEB RPC：{exc}；请手动在 JEB 中运行 MCP.py", error=True)
        except (ValueError, UnicodeError) as exc:
            return text_result(f"JEB RPC 响应解析失败：{exc}", error=True)


def create_server(bridge: JebBridge) -> Server:
    server = Server("jeb")

    @server.list_tools()
    async def list_tools():
        return list(bridge.tools.values())

    @server.call_tool()
    async def call_tool(name: str, arguments: dict):
        return await bridge.call(name, arguments)

    return server


async def run(script_path: Path, timeout: float):
    server = create_server(JebBridge(discover_tools(script_path), timeout))
    async with stdio_server() as (read_stream, write_stream):
        await server.run(read_stream, write_stream, server.create_initialization_options())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--script", type=Path, default=DEFAULT_SCRIPT, help="本机 JEB MCP.py 路径")
    parser.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT, help="RPC 超时秒数")
    args = parser.parse_args()
    try:
        asyncio.run(run(args.script, args.timeout))
    except (OSError, SyntaxError, ValueError) as exc:
        print(f"JEB MCP 适配器启动失败：{exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
