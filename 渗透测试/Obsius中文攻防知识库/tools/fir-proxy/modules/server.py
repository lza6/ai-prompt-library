# modules/server.py

import socket
import threading
import select
import struct
import socks 
from urllib.parse import urlparse

class _PlainForwardSocket(socket.socket):
    """带 `_plain_forward` 标记的**裸** socket（明文转发专用）。

    为什么需要子类：`socket.socket` 是 C 类型，**不允许挂自定义属性**（没有
    `__dict__`）。2026-10-26 实测：在 `socket.create_connection()` 返回的裸 socket 上
    写 `_plain_forward = True` 会 `AttributeError: 'socket' object has no attribute
    '_plain_forward' and no __dict__ for setting new attributes`，被
    `_get_upstream_connection` 的 `except` 吞成「上游代理错误」→ 客户端只看到
    `502 Bad Gateway`（与线上 `curl: (52)` 同款不可诊断）。子类由 Python 定义，
    实例有 `__dict__`，标记可挂；行为与裸 socket 完全一致。
    """


class ProxyServer:
    """本地代理服务，将进入的请求通过代理池转发。支持HTTP和SOCKS5。"""
    def __init__(self, http_host, http_port, socks5_host, socks5_port, rotator,
                 log_queue, traffic_queue=None):
        self._rotator = rotator
        self._log_queue = log_queue
        self._traffic_queue = traffic_queue
        self._running = False

        self._http_host = http_host
        self._http_port = http_port
        self._http_server_socket = None
        self._http_thread = None

        self._socks5_host = socks5_host
        self._socks5_port = socks5_port
        self._socks5_server_socket = None
        self._socks5_thread = None
        
        self._rotation_lock = threading.Lock()
        self._request_count_enabled = False
        self._request_count_limit = 10
        self._request_count = 0
        self._counted_proxy_address = None
        self._target_failure_enabled = False
        self._target_failure_threshold = 3
        self._target_failures = {}
        self._failover_lock = threading.Lock()
        self._failover_inflight = set()
        self._upstream_connect_timeout = 8
        self._client_read_timeout = 30
        self._handler_slots = threading.BoundedSemaphore(256)

    def log(self, message):
        self._log_queue.put(f"[Server] {message}")

    def log_traffic(self, message):
        if self._traffic_queue is not None:
            self._traffic_queue.put(f"[Proxy] {message}")

    def configure_rotation(self, request_count_enabled, request_count,
                           target_failure_enabled, target_failure_threshold):
        """Apply user-controlled request and target-failure rotation settings."""
        with self._rotation_lock:
            self._request_count_enabled = bool(request_count_enabled)
            self._request_count_limit = max(1, int(request_count))
            self._request_count = 0
            self._counted_proxy_address = None
            self._target_failure_enabled = bool(target_failure_enabled)
            self._target_failure_threshold = max(1, int(target_failure_threshold))
            self._target_failures.clear()

    @staticmethod
    def _target_key(target_host, target_port):
        return f"{str(target_host).lower()}:{int(target_port)}"

    def _record_successful_request(self, proxy_address, target_host, target_port):
        """Clear target failures and rotate the next request after its configured count."""
        next_proxy = None
        with self._rotation_lock:
            self._target_failures.pop(self._target_key(target_host, target_port), None)
            if not self._request_count_enabled:
                return
            if self._counted_proxy_address != proxy_address:
                self._counted_proxy_address = proxy_address
                self._request_count = 0
            self._request_count += 1
            if self._request_count < self._request_count_limit:
                return
            self._request_count = 0
            next_proxy = self._rotator.get_next_proxy()
            self._counted_proxy_address = next_proxy.get('proxy') if next_proxy else None

        if next_proxy:
            self.log(
                f"[按请求轮换] {proxy_address} 已转发 {self._request_count_limit} 个请求，"
                f"下一请求切换至 {next_proxy.get('proxy')}"
            )

    def _record_target_failure(self, target_host, target_port):
        """Return True only when this target reaches its configured failure threshold."""
        target_key = self._target_key(target_host, target_port)
        with self._rotation_lock:
            if not self._target_failure_enabled:
                return False, 0
            count = self._target_failures.get(target_key, 0) + 1
            if count >= self._target_failure_threshold:
                self._target_failures.pop(target_key, None)
                return True, count
            self._target_failures[target_key] = count
            return False, count

    def _open_upstream_socket(self, proxy_info, target_host, target_port,
                              plain_http=False):
        """通过指定代理建立到目标域名/端口的连接。

        ``plain_http=True`` 且上游是 **HTTP 协议**时走**明文转发**：直接把 TCP 连到
        上游代理、不做任何握手，由调用方发送**绝对 URI 形式**的请求（HTTP 代理的标准
        用法）。其余情形一律走 CONNECT / SOCKS 隧道。

        为什么必须分这两条路（2026-10-26 实测，日志实证）：
        PySocks 的 HTTP 模式**只会发 CONNECT**（它自己会打印 "The HTTP proxy server may
        not be supported by PySocks (must be a CONNECT tunnel proxy)"）。而池里的 http
        上游**多数只允许 CONNECT 到 443**——对 `CONNECT example.com:80` 直接回
        `403 Forbidden`。于是「经入口访问明文 http」永远失败：服务端日志恒为
        `[!] 上游代理 x 错误: Socket error: 403: Forbidden` →
        `curl -x http://127.0.0.1:1800 http://example.com` 得到
        `curl: (52) Empty reply from server`（连 example.com 都是）。
        对照：同一上游 `curl -x http://<上游> http://example.com` 直连返回 200——
        差别正是「绝对 URI 转发 vs CONNECT 隧道」。
        """
        addr = proxy_info.get('proxy')
        proto = proxy_info.get('protocol')
        if not addr or not proto:
            raise ValueError(f"代理信息格式不正确: {proxy_info}")

        if plain_http and proto.upper() == 'HTTP':
            upstream_addr, upstream_port_str = addr.rsplit(':', 1)
            # 必须用子类：裸 `socket.socket` 挂不上 `_plain_forward`（见类 docstring）
            forward_socket = _PlainForwardSocket(socket.AF_INET, socket.SOCK_STREAM)
            try:
                forward_socket.settimeout(self._upstream_connect_timeout)
                forward_socket.connect((upstream_addr, int(upstream_port_str)))
            except Exception:
                forward_socket.close()
                raise
            forward_socket._plain_forward = True
            return forward_socket

        upstream_addr, upstream_port_str = addr.rsplit(':', 1)
        proxy_type_map = {
            'HTTP': socks.HTTP,
            'SOCKS4': socks.SOCKS4,
            'SOCKS5': socks.SOCKS5,
        }
        upstream_protocol = proxy_type_map.get(proto.upper())
        if not upstream_protocol:
            raise ValueError(f"不支持的上游代理协议: {proto}")

        remote_socket = socks.socksocket()
        remote_socket.settimeout(self._upstream_connect_timeout)
        try:
            remote_socket.set_proxy(
                proxy_type=upstream_protocol,
                addr=upstream_addr,
                port=int(upstream_port_str),
            )
            remote_socket.connect((target_host, int(target_port)))
            remote_socket._plain_forward = False
            return remote_socket
        except Exception:
            remote_socket.close()
            raise

    def _get_failover_candidates(self, failed_address, prefer_https=False):
        """按代理评分取得候选池，排除本次失败的代理。

        ``prefer_https=True``（目标是 https，必须走 CONNECT 隧道）时把 **https 能力**
        出口排在最前。否则会切到做不了 CONNECT 的出口：下一请求又 TLS 失败 → 再触发
        切换，把 `current` 钉死在 https 无能出口上（2026-10-26 实测线上 `current` 恰是
        `https_ok:false` 的那个，1800 访问 https 恒 `exit 35`；直连同一上游也是 35）。
        这是 `_HttpsFirstRotator` 之外**唯一绕过 https 能力优先**的自动路径。
        """
        candidates = [
            p for p in self._rotator.get_all_proxies_for_revalidation()
            if p.get('status') == 'Working' and p.get('proxy') != failed_address
        ]
        if prefer_https:
            candidates.sort(key=lambda p: (p.get('https_ok') is True,
                                           p.get('score', 0)), reverse=True)
        else:
            candidates.sort(key=lambda p: p.get('score', 0), reverse=True)
        return candidates

    def _try_domain_failover(self, target_host, target_port, failed_proxy,
                             plain_http=False):
        """验证其它代理能否访问目标；成功后切换当前代理并返回连接。"""
        target_key = f"{target_host}:{target_port}"
        with self._failover_lock:
            if target_key in self._failover_inflight:
                self.log(f"[自动切换] {target_key} 已在验证中，跳过重复验证。")
                return None
            self._failover_inflight.add(target_key)

        try:
            candidates = self._get_failover_candidates(
                failed_proxy,
                # 需要 CONNECT 隧道（https 目标）时才要求 https 能力；明文 http 目标
                # 用不着 CONNECT，强行筛 https 能力只会白白缩小候选面。
                prefer_https=(not plain_http or int(target_port) == 443),
            )
            if not candidates:
                self.log(f"[自动切换] {target_key} 没有其它可用代理可验证。")
                return None

            self.log(f"[自动切换] {target_key} 访问失败，开始验证其它代理（共{len(candidates)}个）。")
            for candidate in candidates:
                candidate_address = candidate.get('proxy')
                try:
                    remote_socket = self._open_upstream_socket(
                        candidate, target_host, target_port,
                        plain_http=plain_http
                    )
                except Exception as exc:
                    self.log(f"[自动切换] 验证失败 {candidate_address}: {exc}")
                    continue

                if not self._rotator.set_current_proxy_by_address(candidate_address):
                    remote_socket.close()
                    continue

                self.log(
                    f"[自动切换] {target_key} 已切换: "
                    f"{failed_proxy} -> {candidate_address}"
                )
                remote_socket._proxy_label = (
                    f"{candidate.get('protocol', '').lower()}://{candidate_address}"
                )
                self._record_successful_request(
                    candidate_address, target_host, target_port
                )
                return remote_socket

            self.log(f"[自动切换] {target_key} 未找到可用代理。")
            return None
        finally:
            with self._failover_lock:
                self._failover_inflight.discard(target_key)

    def try_domain_failover(self, target_host, target_port, failed_proxy):
        """供健康检查调用：验证其它代理并切换当前代理，不保留测试连接。"""
        should_failover, failure_count = self._record_target_failure(
            target_host, target_port
        )
        if not should_failover:
            if self._target_failure_enabled:
                self.log(
                    f"[目标失败] {self._target_key(target_host, target_port)} "
                    f"连续失败 {failure_count}/{self._target_failure_threshold}，暂不切换。"
                )
            return False
        remote_socket = self._try_domain_failover(
            target_host, target_port, failed_proxy
        )
        if remote_socket:
            remote_socket.close()
            return True
        return False

    @staticmethod
    def _create_listening_socket(host, port):
        server_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            server_socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            server_socket.bind((host, port))
            server_socket.listen(20)
            return server_socket
        except Exception:
            server_socket.close()
            raise

    def start_all(self):
        """启动所有代理服务，并在两个监听端口均绑定成功后返回 True。"""
        if self._running:
            return True
        try:
            http_socket = self._create_listening_socket(
                self._http_host, self._http_port
            )
            try:
                socks5_socket = self._create_listening_socket(
                    self._socks5_host, self._socks5_port
                )
            except Exception:
                http_socket.close()
                raise
        except Exception as exc:
            self.log(f"[!] 启动代理服务失败: {exc}")
            return False

        self._http_server_socket = http_socket
        self._socks5_server_socket = socks5_socket
        self._running = True

        self._http_thread = threading.Thread(target=self._run_http_server, daemon=True)
        self._http_thread.start()

        self._socks5_thread = threading.Thread(target=self._run_socks5_server, daemon=True)
        self._socks5_thread.start()
        return True

    def stop_all(self):
        """平滑地停止所有正在运行的代理服务。"""
        if not self._running:
            return
        self._running = False
        
        if self._http_server_socket:
            self._http_server_socket.close()
        if self._socks5_server_socket:
            self._socks5_server_socket.close()

        if self._http_thread and self._http_thread.is_alive():
            self._http_thread.join()
        if self._socks5_thread and self._socks5_thread.is_alive():
            self._socks5_thread.join()
        self._http_server_socket = None
        self._socks5_server_socket = None
        self.log("所有代理服务已停止。")

    def _run_http_server(self):
        """HTTP服务监听循环。"""
        server_socket = self._http_server_socket
        if not server_socket:
            return
        self.log(f"HTTP 代理服务接口已启动于 {self._http_host}:{self._http_port}")

        while self._running:
            try:
                client_socket, _ = server_socket.accept()
                client_socket.settimeout(self._client_read_timeout)
                self._start_client_handler(self._handle_http_client, client_socket)
            except OSError:
                break 
        self.log("HTTP 代理服务循环已退出。")

    def _run_socks5_server(self):
        """SOCKS5服务监听循环。"""
        server_socket = self._socks5_server_socket
        if not server_socket:
            return
        self.log(f"SOCKS5 代理服务接口已启动于 {self._socks5_host}:{self._socks5_port}")

        while self._running:
            try:
                client_socket, _ = server_socket.accept()
                client_socket.settimeout(self._client_read_timeout)
                self._start_client_handler(self._handle_socks5_client, client_socket)
            except OSError:
                break
        self.log("SOCKS5 代理服务循环已退出。")

    def _start_client_handler(self, handler, client_socket):
        """Start a bounded client handler and reject connections when saturated."""
        if not self._handler_slots.acquire(blocking=False):
            self.log("[!] 并发连接数已达上限，已拒绝新的客户端连接。")
            client_socket.close()
            return False

        def run_handler():
            try:
                handler(client_socket)
            finally:
                self._handler_slots.release()

        try:
            threading.Thread(target=run_handler, daemon=True).start()
            return True
        except Exception:
            self._handler_slots.release()
            client_socket.close()
            raise
        
    def _get_upstream_connection(self, target_host, target_port, plain_http=False):
        """从轮换器获取一个上游代理，并用它来连接目标地址。

        ``plain_http=True``：目标是**明文 http**，HTTP 协议上游应走绝对 URI 转发
        （见 `_open_upstream_socket`）。
        """
        upstream_proxy_info = self._rotator.get_current_proxy()

        if not upstream_proxy_info:
            self.log("[!] 代理池为空或无符合条件的代理，无法转发请求。")
            return None

        addr = upstream_proxy_info.get('proxy')
        proto = upstream_proxy_info.get('protocol')

        if not addr or not proto:
            self.log(f"[!] 代理信息格式不正确: {upstream_proxy_info}")
            return None

        try:
            remote_socket = self._open_upstream_socket(
                upstream_proxy_info, target_host, target_port,
                plain_http=plain_http
            )
            remote_socket._proxy_label = f"{proto.lower()}://{addr}"
            self.log_traffic(
                f"已连接 {target_host}:{target_port} | 上游: {proto.lower()}://{addr}"
            )
            self._record_successful_request(addr, target_host, target_port)
            return remote_socket
        except Exception as e:
            self.log(f"[!] 上游代理 {addr} 错误: {e}")
            if self._target_failure_enabled:
                _, failure_count = self._record_target_failure(
                    target_host, target_port
                )
                self.log(
                    f"[目标失败] {self._target_key(target_host, target_port)} "
                    f"当前请求立即排除 {addr} 并尝试其它出口（连续失败 {failure_count} 次）。"
                )
            return self._try_domain_failover(
                target_host, target_port, failed_proxy=addr,
                plain_http=plain_http
            )

    @staticmethod
    def _recv_exact(sock, size):
        """读取指定字节数，处理 TCP 分包和提前断开。"""
        data = bytearray()
        while len(data) < size:
            chunk = sock.recv(size - len(data))
            if not chunk:
                raise ConnectionError("客户端在发送完整请求前断开")
            data.extend(chunk)
        return bytes(data)

    @staticmethod
    def _recv_until(sock, marker, max_size=65536):
        """读取到分隔符为止，同时保留已到达的后续请求体。"""
        data = bytearray()
        while marker not in data:
            if len(data) >= max_size:
                raise ValueError("请求头超过允许大小")
            chunk = sock.recv(min(4096, max_size - len(data)))
            if not chunk:
                raise ConnectionError("客户端在发送完整请求头前断开")
            data.extend(chunk)
        return bytes(data)

    @staticmethod
    def _parse_connect_target(authority):
        parsed = urlparse(f"//{authority}")
        if not parsed.hostname or parsed.port is None:
            raise ValueError("CONNECT 请求缺少有效目标地址")
        return parsed.hostname, parsed.port

    @staticmethod
    def _to_origin_form(request_data):
        """绝对 URI 请求行 → 源站形式（``GET http://h/p HTTP/1.1`` → ``GET /p HTTP/1.1``）。

        走**隧道**（CONNECT / SOCKS）时，隧道另一端就是目标源站本身，源站只认源站
        形式；把客户端的绝对 URI 原样灌进隧道虽然多数源站也认（RFC 7230 要求接受
        absolute-form），但改写成源站形式更稳妥。请求行之外只顺手去掉代理专用跳点头
        ``Proxy-Connection``（对源站无意义）。请求体原样保留。
        """
        head, sep, rest = request_data.partition(b"\r\n\r\n")
        lines = head.split(b"\r\n")
        if lines:
            parts = lines[0].split(b" ")
            if len(parts) == 3:
                method, target, version = parts
                parsed = urlparse(target.decode("utf-8", "ignore"))
                if parsed.scheme and parsed.netloc:
                    path = parsed.path or "/"
                    if parsed.query:
                        path = f"{path}?{parsed.query}"
                    lines[0] = b" ".join(
                        [method, path.encode("utf-8", "ignore"), version])
        lines = [ln for ln in lines
                 if not ln.lower().startswith(b"proxy-connection:")]
        return b"\r\n".join(lines) + sep + rest

    @staticmethod
    def _to_absolute_form(request_data, target_host, target_port):
        """源站形式请求行 → 绝对 URI 形式（HTTP 代理的标准请求形式）。

        走**明文转发**时隧道另一端是 HTTP 代理，它靠请求行里的绝对 URI 判断目标；
        客户端若发的是源站形式（`GET / HTTP/1.1` + `Host:`），必须补全，否则上游
        无从判断目标（真实上游回 400）。已经是绝对 URI 的原样返回（幂等）。
        """
        head, sep, rest = request_data.partition(b"\r\n\r\n")
        lines = head.split(b"\r\n")
        if lines:
            parts = lines[0].split(b" ")
            if len(parts) == 3:
                method, target, version = parts
                parsed = urlparse(target.decode("utf-8", "ignore"))
                if not (parsed.scheme and parsed.netloc):
                    path = target.decode("utf-8", "ignore") or "/"
                    if not path.startswith("/"):
                        path = "/" + path
                    authority = str(target_host)
                    if int(target_port) != 80:
                        authority = f"{authority}:{int(target_port)}"
                    absolute = f"http://{authority}{path}"
                    lines[0] = b" ".join(
                        [method, absolute.encode("utf-8", "ignore"), version])
        return b"\r\n".join(lines) + sep + rest

    def _handle_http_client(self, client_socket):
        """处理单个HTTP客户端连接。"""
        remote_socket = None
        try:
            request_data = self._recv_until(client_socket, b'\r\n\r\n')

            first_line = request_data.split(b'\r\n')[0].decode('utf-8', 'ignore')
            method, url, _ = first_line.split()
            method = method.upper()

            if method == 'CONNECT':
                target_host, target_port = self._parse_connect_target(url)
                plain_http = False
            else:
                parsed_url = urlparse(url)
                if not parsed_url.hostname:
                    host_header = next(
                        (
                            line.split(b':', 1)[1].strip().decode('utf-8', 'ignore')
                            for line in request_data.split(b'\r\n')[1:]
                            if line.lower().startswith(b'host:')
                        ),
                        '',
                    )
                    parsed_url = urlparse(f"//{host_header}")
                if not parsed_url.hostname:
                    raise ValueError("HTTP 请求缺少目标主机")
                target_host = parsed_url.hostname
                target_port = parsed_url.port or (
                    443 if parsed_url.scheme == 'https' else 80
                )
                # 明文 http：HTTP 协议上游要走绝对 URI 转发（PySocks 只会 CONNECT，
                # 而上游普遍只放行 CONNECT:443 → 恒 403，见 _open_upstream_socket）。
                plain_http = True

            remote_socket = self._get_upstream_connection(target_host, target_port,
                                                          plain_http=plain_http)
            if not remote_socket:
                # 可以给客户端一个更友好的错误响应
                client_socket.sendall(b'HTTP/1.1 502 Bad Gateway\r\n\r\n')
                return

            if method == 'CONNECT':
                client_socket.sendall(b'HTTP/1.1 200 Connection Established\r\n\r\n')
            elif getattr(remote_socket, '_plain_forward', False):
                # 明文转发：绝对 URI 是 HTTP 代理的标准请求形式。客户端发绝对 URI
                # 就原样转发；发源站形式则补全（否则上游无从判断目标）。
                remote_socket.sendall(self._to_absolute_form(
                    request_data, target_host, target_port))
            else:
                # 隧道：另一端是目标源站，改写成源站形式
                remote_socket.sendall(self._to_origin_form(request_data))

            self._forward_data(
                client_socket, remote_socket, target_host, target_port,
                getattr(remote_socket, '_proxy_label', '未知')
            )
        except Exception as e:
            if not isinstance(e, (ConnectionResetError, BrokenPipeError, OSError)):
                 self.log(f"处理 HTTP 请求时出错: {e}")
        finally:
            if remote_socket: remote_socket.close()
            if client_socket: client_socket.close()

    def _handle_socks5_client(self, client_socket):
        """处理单个SOCKS5客户端连接。"""
        remote_socket = None
        try:
            data = self._recv_exact(client_socket, 2)
            if data[0] != 5: return 
            nmethods = data[1]
            self._recv_exact(client_socket, nmethods)
            client_socket.sendall(b"\x05\x00")

            data = self._recv_exact(client_socket, 4)
            if data[0] != 5 or data[1] != 1: return
            
            atyp = data[3]
            if atyp == 1:
                addr = socket.inet_ntoa(self._recv_exact(client_socket, 4))
            elif atyp == 3:
                domain_len = self._recv_exact(client_socket, 1)[0]
                addr = self._recv_exact(client_socket, domain_len).decode('idna')
            elif atyp == 4:
                addr = socket.inet_ntop(socket.AF_INET6, self._recv_exact(client_socket, 16))
            else:
                client_socket.sendall(b"\x05\x08\x00\x01\x00\x00\x00\x00\x00\x00")
                return
            
            port = struct.unpack('!H', self._recv_exact(client_socket, 2))[0]

            # 明文 http 目标（80）走绝对 URI 转发，理由同 `_handle_http_client`：
            # HTTP 协议上游多数只放行 CONNECT:443，PySocks 又只会发 CONNECT。
            remote_socket = self._get_upstream_connection(addr, port,
                                                          plain_http=(port == 80))
            if not remote_socket:
                client_socket.sendall(b"\x05\x04\x00\x01\x00\x00\x00\x00\x00\x00") # Host unreachable
                return

            client_socket.sendall(b"\x05\x00\x00\x01\x00\x00\x00\x00\x00\x00")

            if getattr(remote_socket, '_plain_forward', False):
                if not self._forward_plain_http_head(client_socket, remote_socket,
                                                     addr, port):
                    return

            self._forward_data(
                client_socket, remote_socket, addr, port,
                getattr(remote_socket, '_proxy_label', '未知')
            )
        except Exception as e:
            if not isinstance(e, (ConnectionResetError, BrokenPipeError, OSError)):
                self.log(f"处理 SOCKS5 请求时出错: {e}")
        finally:
            if remote_socket: remote_socket.close()
            if client_socket: client_socket.close()

    #: 请求行以这些方法开头即认定为 HTTP 请求（用于 SOCKS5 + 明文转发的首包判定）。
    _HTTP_METHOD_PREFIXES = (b"GET ", b"POST ", b"HEAD ", b"PUT ", b"DELETE ",
                             b"OPTIONS ", b"PATCH ", b"TRACE ", b"CONNECT ")

    def _forward_plain_http_head(self, client_socket, remote_socket,
                                 target_host, target_port):
        """SOCKS5 + 明文转发：把客户端首个请求头补成**绝对 URI** 再发给上游。

        SOCKS5 客户端是**隧道语义**，它发的是源站形式请求行（`GET / HTTP/1.1`）；而
        明文转发的另一端是 HTTP 代理，只认绝对 URI。原样中继会得到 400 / 连接重置
        （2026-10-26 实测 `curl -x socks5h://127.0.0.1:1801 http://example.com` →
        `exit 56`，而同一时刻 HTTP 入口 1800 已能 200）。

        首包不像 HTTP 请求时**原样转发**（上游会拒，但不吞字节、不挂死——这一路本来
        就送不出去，因为 HTTP 协议上游不接受 `CONNECT host:80`）。返回 False 表示
        首包读取失败，调用方应直接收尾。
        """
        try:
            head = client_socket.recv(65536)
        except OSError:
            return False
        if not head:
            return False
        if not head.startswith(self._HTTP_METHOD_PREFIXES):
            remote_socket.sendall(head)
            return True
        while b"\r\n\r\n" not in head and len(head) < 65536:
            try:
                chunk = client_socket.recv(65536 - len(head))
            except OSError:
                break
            if not chunk:
                break
            head += chunk
        remote_socket.sendall(self._to_absolute_form(head, target_host, target_port))
        return True

    def _forward_data(self, sock1, sock2, target_host, target_port, proxy_label):
        """在两个socket之间双向转发数据，直到任意一方关闭。"""
        client_to_target = 0
        target_to_client = 0
        try:
            while self._running:
                try:
                    readable, _, exceptional = select.select([sock1, sock2], [], [sock1, sock2], 5)
                    if exceptional or not readable:
                        break
                    for sock in readable:
                        other_sock = sock2 if sock is sock1 else sock1
                        data = sock.recv(8192)
                        if not data:
                            return
                        if sock is sock1:
                            client_to_target += len(data)
                        else:
                            target_to_client += len(data)
                        other_sock.sendall(data)
                except (ConnectionResetError, BrokenPipeError, OSError, select.error):
                    break
        finally:
            self.log_traffic(
                f"已断开 {target_host}:{target_port} | 上游: {proxy_label} | "
                f"上传: {client_to_target} B | 下载: {target_to_client} B"
            )
