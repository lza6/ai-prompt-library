#!/usr/bin/env python3
"""交叉校验：自写 IL 反汇编器 vs dncil（真值）。

用法：
    # 在容器内（有 dnfile/dncil）
    python scripts/verify_ildis.py --ildis /path/to/ildis.py --dll /path/to/x.dll

    # 或分两步：先在容器里 dump dncil 真值，再在宿主比对
    python scripts/verify_ildis.py --ildis ... --dll ... --dncil-json truth.json
    python scripts/verify_ildis.py --ildis ... --dncil-json truth.json --ildis-only

背景（2026-10-28，proj-2ac5b789c6e9「降维打击」）：
0.3 镜像没有 .NET 工具链，逆向专家自写了 metadata 堆解析 + IL 反汇编器
（`worker/ildis.py`）。那个反汇编器对 `0xFE` 前缀指令**只打印不消耗操作数**，
导致后续指令流静默错位 4 字节。真实样本 `Server.dll` 里 6 处，全在 async
`MoveNext`（C2 主循环）——不报错、不崩、末条仍以 ret 收尾、18 个方法零异常，
结论看着完全正常。

**这个脚本存在的意义：让「看着对」变成「可证明对」。** 任何自写解析器在交付
结论前都必须过这一关；镜像里已装 dnfile/dncil（0.4 起），真值随时可得。

判据（任一不满足即 FAIL）：
  1. 方法集合一致（dncil 有 RVA 的方法 ⊆ ildis 能解的方法）
  2. 每条方法的**指令条数**一致
  3. 每条方法的**指令起始偏移序列**逐条一致  ← 这条能抓住「错位但长度凑巧对上」
  4. ildis 输出里不出现 UNKNOWN 标记

第 3 条是关键：只比条数不够（错位后重新同步也可能凑出同样条数），
只比末条偏移也不够（错位 4 字节后末条仍可能落在 ret 上）。
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import re
import subprocess
import sys
from pathlib import Path

# ── dncil 真值采集（在容器内跑，宿主机没有 dnfile）────────────────────────
# **key 必须是方法行号（rid），不能用方法名**：.NET 里同名方法极常见
# （async 状态机的 MoveNext / SetStateMachine 每个状态机各一份）。用名字做 key
# 会静默互相覆盖 —— 实测 Server.dll 18 个方法只剩 13 个，被吞掉的恰好是带
# 0xFE 前缀的那两个 MoveNext，等于把最该测的样本丢了。
_DNCIL_PROBE = r'''
import json, sys
import dnfile
from dncil.cil.body import CilMethodBody
from dncil.cil.body.reader import CilMethodBodyReaderBase

pe = dnfile.dnPE(sys.argv[1])

class R(CilMethodBodyReaderBase):
    # offset 从 **RVA 起点**（含 method header）开始：dncil 自己解析 tiny/fat
    # header。从 code0 开始会把 code 首字节当 header 解，报
    # "not enough data while parsing method body @ offset ..."。
    def __init__(s, pe, row):
        s.pe = pe
        s.offset = pe.get_offset_from_rva(row.Rva)
    def read(s, n):
        d = s.pe.get_data(s.offset, n); s.offset += n; return d
    def tell(s): return s.offset
    def seek(s, o): s.offset = o

out = {}
for i, row in enumerate(pe.net.mdtables.MethodDef, 1):
    if not row.Rva:
        continue
    o = pe.get_offset_from_rva(row.Rva)
    b0 = pe.get_data(o, 1)[0]
    if (b0 & 3) == 2:
        code0 = o + 1
    else:
        code0 = o + ((int.from_bytes(pe.get_data(o, 2), "little") >> 12) * 4)
    body = CilMethodBody(R(pe, row))
    out[str(i)] = {"name": str(row.Name),
                   "offsets": [ins.offset - code0 for ins in body.instructions]}

print(json.dumps(out))
'''


def _load_ildis(path: Path):
    """加载自写反汇编器。

    注意 ildis.py 顶部有 `sys.path.insert(0, '/workspace/scratch/httpobj/worker')`
    （容器内绝对路径）再 `import dnparse` —— 在宿主机上这行不生效，dnparse
    会 ImportError。所以这里先把 ildis 自己的目录塞进 sys.path，
    让 `import dnparse` 落到同目录的 dnparse.py。
    """
    import sys as _sys
    d = str(path.parent)
    if d not in _sys.path:
        _sys.path.insert(0, d)
    spec = importlib.util.spec_from_file_location("ildis_under_test", path)
    mod = importlib.util.module_from_spec(spec)
    _sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


def _ildis_offsets(mod, dll: Path, base: int) -> dict[str, list[int]]:
    """用 ildis 解每个方法，返回 {方法行号: [指令起始偏移...]}。

    key 用 rid（与 dncil probe 一致），**不用方法名** —— 同名方法会互相覆盖。
    """
    dis = mod.Dis(str(dll), base)
    md = dis.m.table(0x06)
    out: dict[str, list[int]] = {}
    for rid in range(1, len(md) + 1):
        if not md[rid - 1][0]:
            continue
        lines = dis.dis(rid)
        offsets = [int(l.split()[0], 16) for l in lines if re.match(r"^[0-9a-f]{4}\s", l)]
        out[str(rid)] = offsets
    return out


def _run_dncil_probe(dll: Path, docker_image: str | None) -> dict[str, list[int]]:
    """在容器里跑 dncil 采集真值（镜像 0.4 起自带 dnfile/dncil）。

    **Windows 上的挂载坑**：`-v /tmp:/probe` 会被 Git Bash 的路径转换改写成
    `\\tmp`，docker 直接报 `is not a valid Windows path`。所以这里不用 /tmp，
    而是在**待校验文件同目录**下建临时子目录（已经是 Windows 绝对路径，
    不会再被改写），跑完删掉。
    """
    work = dll.parent / "_dncil_probe"
    work.mkdir(exist_ok=True)
    probe = work / "probe.py"
    probe.write_text(_DNCIL_PROBE, encoding="utf-8")
    try:
        if docker_image:
            # 挂载用 **绝对 Windows 路径**；容器内目标路径固定 /w。
            # 三条都是实测坑：
            #  · 相对路径（tools/...）会被 docker 当成**卷名**，报
            #    "includes invalid characters for a local volume name"；
            #  · `/tmp` 会被 Git Bash 改写成 `\tmp`，报 "not a valid Windows path"；
            #  · `--network none` 保证可复现（dncil 纯本地解析，不需要网）。
            host_dir = str(dll.resolve().parent)
            cmd = ["docker", "run", "--rm", "--network", "none",
                   "-v", f"{host_dir}:/w:ro",
                   docker_image, "python3", "/w/_dncil_probe/probe.py",
                   f"/w/{dll.name}"]
        else:
            cmd = [sys.executable, str(probe), str(dll)]
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
        if r.returncode != 0:
            raise RuntimeError(f"dncil 真值采集失败：{(r.stderr or r.stdout).strip()[:600]}")
        return json.loads(r.stdout)
    finally:
        try:
            probe.unlink()
            work.rmdir()
        except OSError:
            pass


def main() -> int:
    ap = argparse.ArgumentParser(description="自写 IL 反汇编器 vs dncil 交叉校验")
    ap.add_argument("--ildis", required=True, help="自写反汇编器 ildis.py 路径")
    ap.add_argument("--dll", help="待校验程序集（.dll/.exe）")
    ap.add_argument("--base", type=lambda s: int(s, 0), default=0,
                    help="程序集在容器文件里的起始偏移（内嵌 PE 用；独立 dll 填 0）")
    ap.add_argument("--dncil-json", help="预先采集的 dncil 真值 JSON（省一次容器运行）")
    ap.add_argument("--docker-image", default="cyberstrike/pentest-box:0.5",
                    help="用来跑 dncil 的镜像（空字符串=用宿主 python）")
    args = ap.parse_args()

    ildis_path = Path(args.ildis)
    if not ildis_path.is_file():
        print(f"[!] 找不到 ildis：{ildis_path}")
        return 2

    if args.dncil_json:
        truth = json.loads(Path(args.dncil_json).read_text(encoding="utf-8"))
    else:
        if not args.dll:
            print("[!] 需要 --dll 或 --dncil-json 之一")
            return 2
        truth = _run_dncil_probe(Path(args.dll), args.docker_image or None)

    if not args.dll:
        print("[!] 需要 --dll 才能跑 ildis")
        return 2

    mod = _load_ildis(ildis_path)
    mine = _ildis_offsets(mod, Path(args.dll), args.base)

    fails: list[str] = []
    checked = 0
    for rid, info in truth.items():
        name = info["name"] if isinstance(info, dict) else rid
        expect = info["offsets"] if isinstance(info, dict) else info
        if rid not in mine:
            fails.append(f"rid={rid} {name}: ildis 未解出该方法")
            continue
        got = mine[rid]
        checked += 1
        if len(got) != len(expect):
            fails.append(f"rid={rid} {name}: 指令数 ildis={len(got)} dncil={len(expect)}")
            continue
        if got != expect:
            # 定位第一处偏移分歧，这是最有信息量的一行
            for i, (a, b) in enumerate(zip(got, expect)):
                if a != b:
                    fails.append(f"rid={rid} {name}: 第 {i} 条偏移 "
                                 f"ildis={a:#06x} dncil={b:#06x}")
                    break
            else:
                fails.append(f"rid={rid} {name}: 偏移序列不一致")

    # UNKNOWN 标记：一旦出现，说明该方法的指令流已不可信
    dis = mod.Dis(str(args.dll), args.base)
    md = dis.m.table(0x06)
    for rid in range(1, len(md) + 1):
        if not md[rid - 1][0]:
            continue
        for line in dis.dis(rid):
            if "UNKNOWN" in line:
                fails.append(f"rid={rid} {dis.m.string(md[rid - 1][3])}: {line.strip()}")
                break

    print(f"[i] 比对 {checked}/{len(truth)} 个方法"
          f"（ildis 共解出 {len(mine)} 个）")
    if fails:
        print(f"[!] {len(fails)} 项不一致：")
        for f in fails[:20]:
            print(f"    · {f}")
        if len(fails) > 20:
            print(f"    … 另有 {len(fails) - 20} 项")
        return 1
    print("[+] 全部一致：指令数与偏移序列逐条相同，无 UNKNOWN")
    return 0


if __name__ == "__main__":
    sys.exit(main())
