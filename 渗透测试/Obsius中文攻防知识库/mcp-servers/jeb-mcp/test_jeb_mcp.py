"""运行：python -m unittest discover -s mcp-servers/jeb-mcp -v。"""

import asyncio
from datetime import timedelta
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

import httpx
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

import jeb_mcp


FIXTURE = '''
raise RuntimeError("不得执行此脚本")
@jsonrpc
def ping():
    """真实 ping 说明。"""
    return "pong"
@jsonrpc
def search(filepath, query, search_type="string"):
    """真实搜索说明。"""
    pass
def private_helper():
    pass
'''


class SchemaTests(unittest.TestCase):
    def test_ast_only_required_optional_docstring(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "MCP.py"
            path.write_text(FIXTURE, encoding="utf-8")
            tools = {tool.name: tool for tool in jeb_mcp.discover_tools(path)}
        self.assertEqual(set(tools), {"ping", "search"})
        self.assertEqual(tools["ping"].inputSchema["required"], [])
        schema = tools["search"].inputSchema
        self.assertEqual(schema["required"], ["filepath", "query"])
        self.assertEqual(schema["properties"]["search_type"], {"default": "string"})
        self.assertEqual(schema["properties"]["query"], {})
        self.assertFalse(schema["additionalProperties"])
        self.assertEqual(tools["search"].description, "真实搜索说明。")

    def test_empty_catalog_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "MCP.py"
            path.write_text("pass", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "@jsonrpc"):
                jeb_mcp.discover_tools(path)

    @unittest.skipUnless(jeb_mcp.DEFAULT_SCRIPT.is_file(), "本机未安装 JEB 脚本")
    def test_installed_script_catalog(self):
        tools = {tool.name: tool for tool in jeb_mcp.discover_tools(jeb_mcp.DEFAULT_SCRIPT)}
        self.assertEqual(len(tools), 20)
        schema = tools["search_in_project"].inputSchema
        self.assertEqual(schema["required"], ["filepath", "query"])
        self.assertEqual(schema["properties"]["search_type"]["default"], "string")
        self.assertEqual(tools["export_all_resources"].inputSchema["required"], ["filepath"])


class ForwardTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.bridge = jeb_mcp.JebBridge([
            jeb_mcp.types.Tool(name="ping", inputSchema={"type": "object"})
        ], timeout=0.05)

    async def invoke(self, payload=None, status=200, exception=None):
        response = httpx.Response(status, json=payload, request=httpx.Request("POST", jeb_mcp.RPC_URL))
        post = AsyncMock(return_value=response, side_effect=exception)
        with patch("jeb_mcp.httpx.AsyncClient") as factory:
            factory.return_value.__aenter__.return_value.post = post
            result = await self.bridge.call("ping", {})
            factory.assert_called_once_with(trust_env=False, follow_redirects=False)
        return result, post

    async def test_success_and_fixed_endpoint(self):
        result, post = await self.invoke({"jsonrpc": "2.0", "id": 1, "result": "pong"})
        self.assertFalse(result.isError)
        self.assertEqual(result.content[0].text, "pong")
        post.assert_awaited_once_with(jeb_mcp.RPC_URL, json={
            "jsonrpc": "2.0", "id": 1, "method": "ping", "params": {},
        }, timeout=0.05)

    async def test_rpc_error_preserved(self):
        error = {"code": -32602, "message": "参数错误", "data": "详情"}
        result, _ = await self.invoke({"jsonrpc": "2.0", "id": 1, "error": error})
        self.assertTrue(result.isError)
        self.assertEqual(json.loads(result.content[0].text), {"error": error})

    async def test_timeout(self):
        result, _ = await self.invoke(exception=httpx.ReadTimeout("超时"))
        self.assertTrue(result.isError)
        self.assertIn("超时", result.content[0].text)

    async def test_total_deadline(self):
        async def stalled_post(*args, **kwargs):
            await asyncio.Event().wait()
        with patch("jeb_mcp.httpx.AsyncClient") as factory:
            factory.return_value.__aenter__.return_value.post = stalled_post
            result = await asyncio.wait_for(self.bridge.call("ping", {}), 1)
        self.assertTrue(result.isError)
        self.assertIn("超时", result.content[0].text)

    async def test_invalid_json(self):
        response = httpx.Response(200, text="not json", request=httpx.Request("POST", jeb_mcp.RPC_URL))
        with patch("jeb_mcp.httpx.AsyncClient") as factory:
            factory.return_value.__aenter__.return_value.post = AsyncMock(return_value=response)
            result = await self.bridge.call("ping", {})
        self.assertTrue(result.isError)
        self.assertIn("解析失败", result.content[0].text)

    async def test_connection_error(self):
        result, _ = await self.invoke(exception=httpx.ConnectError("连接失败"))
        self.assertTrue(result.isError)
        self.assertIn("手动", result.content[0].text)

    async def test_http_error(self):
        result, _ = await self.invoke(status=503)
        self.assertTrue(result.isError)
        self.assertIn("503", result.content[0].text)

    async def test_invalid_rpc_response(self):
        for payload in [[], {}, {"jsonrpc": "2.0", "id": 2, "result": "pong"}, {"jsonrpc": "2.0", "id": 1}]:
            with self.subTest(payload=payload):
                result, _ = await self.invoke(payload)
                self.assertTrue(result.isError)

    async def test_unknown_tool_never_connects(self):
        with patch("jeb_mcp.httpx.AsyncClient") as factory:
            result = await self.bridge.call("not_a_tool", {})
            factory.assert_not_called()
        self.assertTrue(result.isError)

    def test_invalid_timeout_rejected(self):
        for timeout in [0, -1, float("inf"), float("nan")]:
            with self.assertRaises(ValueError):
                jeb_mcp.JebBridge([], timeout)


class ConfigurationGuardTests(unittest.TestCase):
    def test_reverse_mcp_entries_enabled_and_existing(self):
        project_root = Path(__file__).resolve().parents[2]
        config = json.loads((project_root / "config/mcp.json").read_text(encoding="utf-8"))
        for name in ("jeb", "jadx"):
            with self.subTest(server=name):
                entries = [entry for entry in config["servers"] if entry.get("name") == name]
                self.assertEqual(len(entries), 1, f"{name} 配置必须唯一")
                entry = entries[0]
                self.assertIs(entry["enabled"], True)
                self.assertEqual(entry["transport"], "stdio")
                self.assertTrue(entry["args"], f"{name} 缺少启动入口")
                entry_path = Path(entry["args"][0])
                if not entry_path.is_absolute():
                    entry_path = project_root / entry_path
                self.assertTrue(entry_path.is_file(), f"{name} 入口不存在：{entry_path}")

    def test_reverse_experts_allow_both_servers(self):
        import yaml
        project_root = Path(__file__).resolve().parents[2]
        for expert in ("reverse", "reverse-analyst"):
            with self.subTest(expert=expert):
                config = yaml.safe_load((project_root / f"packs/experts/{expert}.yaml").read_text(encoding="utf-8"))
                self.assertTrue({"jeb", "jadx"}.issubset(set(config["mcp_servers"])))


class PlatformBridgeTests(unittest.TestCase):
    @unittest.skipUnless(jeb_mcp.DEFAULT_SCRIPT.is_file(), "本机未安装 JEB 脚本")
    def test_platform_bridge_real_list_tools(self):
        project_root = Path(__file__).resolve().parents[2]
        sys.path.insert(0, str(project_root))
        try:
            from core.chat.mcp_bridge import MCPBridge
        finally:
            sys.path.pop(0)
        with tempfile.TemporaryDirectory() as directory:
            config_path = Path(directory) / "mcp.json"
            config_path.write_text(json.dumps({"servers": [{
                "name": "jeb", "enabled": True, "transport": "stdio",
                "command": sys.executable,
                "args": [str(Path(jeb_mcp.__file__).resolve())],
            }]}), encoding="utf-8")
            bridge = MCPBridge(config_path)
            try:
                status = bridge.status()
                self.assertEqual(len(status), 1)
                self.assertTrue(status[0]["online"])
                self.assertEqual(len(status[0]["tools"]), 20)
                specs = {spec["name"]: spec for spec in bridge.tool_specs()}
                schema = specs["mcp__jeb__search_in_project"]["input_schema"]
                self.assertEqual(schema["required"], ["filepath", "query"])
                self.assertEqual(schema["properties"]["search_type"]["default"], "string")
            finally:
                for runtime in bridge._servers.values():
                    runtime.close()


class StdioTests(unittest.IsolatedAsyncioTestCase):
    async def check_session(self, script):
        params = StdioServerParameters(command=sys.executable, args=[
            str(Path(jeb_mcp.__file__).resolve()), "--script", str(script),
        ])
        async with stdio_client(params) as (read, write):
            async with ClientSession(read, write, read_timeout_seconds=timedelta(seconds=15)) as session:
                initialized = await session.initialize()
                self.assertEqual(initialized.serverInfo.name, "jeb")
                catalog = await session.list_tools()
                expected = {tool.name for tool in jeb_mcp.discover_tools(script)}
                self.assertEqual({tool.name for tool in catalog.tools}, expected)
                # 输入校验必须在本地返回错误，不接触真实 JEB。
                result = await session.call_tool("ping", {"unexpected": True})
                self.assertTrue(result.isError)
                return len(catalog.tools)

    async def test_real_stdio_initialize_and_list(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "MCP.py"
            path.write_text(FIXTURE, encoding="utf-8")
            self.assertEqual(await asyncio.wait_for(self.check_session(path), 25), 2)

    @unittest.skipUnless(jeb_mcp.DEFAULT_SCRIPT.is_file(), "本机未安装 JEB 脚本")
    async def test_installed_catalog_over_real_stdio(self):
        self.assertEqual(await asyncio.wait_for(self.check_session(jeb_mcp.DEFAULT_SCRIPT), 25), 20)


if __name__ == "__main__":
    unittest.main(verbosity=2)
