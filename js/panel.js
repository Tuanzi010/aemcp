/* AEMCP panel.js —— 面板侧（跑在 CEP 的 Node/CEF 上下文里，不是 ExtendScript）

   这一步只做一件事：**把「AE 2021 上这套桥到底能不能跑」变成可读的数字**。

   两条通道都要探：
     1. 面板 → 宿主：CSInterface.evalScript("AEMCP_probe()")，量往返延迟和载荷大小。
     2. 面板 → 外部：在面板自己的 Node 上下文里开一个 loopback HTTP 服务器。
        这条是**整套架构的地基**：外部进程（MCP 客户端/服务端）用 HTTP 打进来，
        面板再转成 ExtendScript，就绕开了"AE 2021 不接受任何外部驱动"这个死结
        （-r / -s 都不跑脚本，这是本项目实测过的）。

   落盘通道一律优先 Node 的 fs：它不受 AE「允许脚本写入文件」首选项管，
   而且面板本来就是 JS 上下文，写 JSON 不用手搓转义。
*/

(function () {
    "use strict";

    var VERSION = "1.3.0";
    var CHANNEL = "次元の仓库_A";
    var CHANNEL_URL = "https://t.me/DimensionID";
    var GUIDE_KEY = "aemcp.guideSeen.v2";   /* 新手引导：看过一次就不再自动弹（带版本位，改内容就换 v3） */
    var GUIDE_TITLES = ["保持面板打开", "把桥信息发给 AI", "手动填写", "看到已连接"];
    var guideStep = 0;
    var PORTS = [47821, 47822, 47823, 47824, 47825];   /* 依次试，占不到就下一个 */
    var logBuf = [];
    var lastProbe = null;
    var httpState = { ok: false, port: null, err: null, requests: 0, lastPath: null };
    var clientConn = { seen: false, lastAt: 0, lastMethod: "", calls: 0 };   /* AI 客户端是否连上桥 */
    var csInstance = null;
    var TOKEN = "";                     /* 每次面板起来换一个：别的本机进程不该顺手用这个桥 */
    var BRIDGE_FILE = null;             /* %TEMP%\AEMCP-bridge.json，外部 MCP 客户端靠它找到桥 */
    var MCP_CALLS = 0;
    /* 引擎卡死检测：ExtendScript 引擎被死循环 / 改文本内容 / MOGRT 导出等操作卡住后，
       后续所有 eval 都会挂到 60s 超时。连续 2 次超时判「疑似卡死」，banner 给醒目提示。 */
    var engineStuck = false;
    var consecTimeouts = 0;

    /* ---------------------------------------------------------- 宿主调用队列
       每个 ExtendScript 调用都在 AE 主线程上跑，跑的时候 AE 的 UI 是冻的。
       所以这里守两条规矩（「不卡顿」不是口号，是这两条）：
         1. 同一时刻只允许一个 evalScript 在飞 —— 串行，不排队轰炸 AE；
         2. 单次调用有超时 —— 超了就放行队列并记账，别把后面的请求一起拖死。
       账本会出现在 /health 与面板设置区，拿数字说话。 */
    var HOST_TIMEOUT_MS = 60000;
    var SLOW_MS = 1000;             /* 超过它算一次「慢调用」（AE 主线程被占住的信号） */
    var HOSTQ = { waiting: 0, inflight: 0, done: 0, sumMs: 0, lastMs: 0, maxMs: 0, slow: 0, timeouts: 0, errs: 0 };

    function hostStat() {
        return {
            done: HOSTQ.done,
            avgMs: HOSTQ.done ? Math.round(HOSTQ.sumMs / HOSTQ.done) : 0,
            lastMs: HOSTQ.lastMs,
            maxMs: HOSTQ.maxMs,
            slow: HOSTQ.slow,
            timeouts: HOSTQ.timeouts,
            errs: HOSTQ.errs,
            queued: HOSTQ.waiting,
            inflight: HOSTQ.inflight
        };
    }

    /* 串行通道：拿到「跑道」才发 evalScript；等的时候每 30ms 看一次。 */
    function hostRun(script) {
        HOSTQ.waiting++;
        var t0 = Date.now();
        return new Promise(function (resolve) {
            var timer = null;
            var settled = false;

            function finish(out, counted) {
                if (settled) { return; }
                settled = true;
                if (timer) { clearTimeout(timer); }
                HOSTQ.inflight = 0;
                HOSTQ.waiting--;
                if (counted) {
                    HOSTQ.done++;
                    HOSTQ.sumMs += out.ms;
                    HOSTQ.lastMs = out.ms;
                    if (out.ms > HOSTQ.maxMs) { HOSTQ.maxMs = out.ms; }
                    if (out.ms > SLOW_MS) {
                        HOSTQ.slow++;
                        log("宿主调用偏慢：" + out.ms + "ms（AE 主线程被占住的信号）", "warn");
                    }
                    if (!out.ok) { HOSTQ.errs++; }
                    /* 成功一次就说明引擎还活着，清掉「疑似卡死」标记 */
                    if (out.ok && !out.timeout) {
                        consecTimeouts = 0;
                        if (engineStuck) { engineStuck = false; renderBanner(); }
                    }
                }
                renderPerf();
                resolve(out);
            }

            function pump() {
                if (settled) { return; }
                if (HOSTQ.inflight > 0) { setTimeout(pump, 30); return; }
                HOSTQ.inflight = 1;
                renderPerf();   /* 让「排队 N」在慢调用执行期间就能看见 */
                timer = setTimeout(function () {
                    HOSTQ.timeouts++;
                    consecTimeouts++;
                    if (consecTimeouts >= 2 && !engineStuck) {
                        engineStuck = true;
                        log("⚠ 连续 " + consecTimeouts + " 次宿主调用超时，ExtendScript 引擎疑似卡死", "err");
                        renderBanner();
                    }
                    finish({ ok: false, result: "TIMEOUT:" + HOST_TIMEOUT_MS + "ms", ms: Date.now() - t0, timeout: true }, true);
                }, HOST_TIMEOUT_MS);
                evalScript(script).then(function (r) { finish(r, true); }, function (e) {
                    finish({ ok: false, result: "THROW:" + errText(e), ms: Date.now() - t0 }, true);
                });
            }

            pump();
        });
    }

    /* ------------------------------------------------------------- 基础工具 */

    function $(id) { return document.getElementById(id); }

    function log(msg, cls) {
        var line = "[" + new Date().toTimeString().split(" ")[0] + "] " + msg;
        logBuf.push(line);
        if (logBuf.length > 400) { logBuf.shift(); }
        var el = $("log");
        if (el) {
            var span = document.createElement("span");
            span.className = cls || "";
            span.textContent = line + "\n";
            el.appendChild(span);
            el.scrollTop = el.scrollHeight;
        }
    }

    function fatal(msg) {
        if (window.__aemcpFatal) { window.__aemcpFatal(msg); }
        log("FATAL " + msg, "err");
    }

    function errText(e) {
        if (e === null || e === undefined) { return "(null)"; }
        try { return (e.message ? e.message : String(e)); } catch (x) { return "(unprintable)"; }
    }

    /* Node 模块是可选能力：拿不到不算错，只记下来。 */
    function safeRequire(name) {
        try {
            if (typeof require !== "function") { return null; }
            return require(name);
        } catch (e) { return null; }
    }

    var fsm = safeRequire("fs");

    function tmpDir() {
        try {
            if (typeof process !== "undefined" && process.env && process.env.TEMP) { return process.env.TEMP; }
        } catch (e) { }
        try {
            if (window.cep && window.cep.fs) { return window.cep.fs.getSystemPath("temp"); }
        } catch (e) { }
        return null;
    }

    function writeText(path, text) {
        if (fsm) {
            try { fsm.writeFileSync(path, text, "utf8"); return true; } catch (e) { log("fs 写入失败：" + errText(e), "err"); }
        }
        try {
            if (window.cep && window.cep.fs) {
                var r = window.cep.fs.writeFile(path, text);
                return (r === 0 || (r && r.err === 0));
            }
        } catch (e) { log("cep.fs 写入失败：" + errText(e), "err"); }
        return false;
    }

    function cs() {
        if (csInstance === null) { csInstance = new CSInterface(); }
        return csInstance;
    }

    /* evalScript 只有一个回调式接口；包成 Promise 让探测流程线性可读。 */
    function evalScript(script) {
        return new Promise(function (resolve) {
            var t0 = Date.now();
            try {
                cs().evalScript(script, function (res) {
                    var r = (res === null || res === undefined) ? "" : String(res);
                    resolve({ ok: r !== "EvalScript error." && r !== "", result: r, ms: Date.now() - t0 });
                });
            } catch (e) {
                resolve({ ok: false, result: "THROW:" + errText(e), ms: Date.now() - t0 });
            }
        });
    }

    /* --------------------------------------------------------- 宿主操作通道 */

    /* 每次面板起来换一个 token：桥只给本机的 MCP 客户端用，别的进程不该顺手调。 */
    function makeToken() {
        var crypto = safeRequire("crypto");
        try {
            if (crypto && crypto.randomBytes) { return crypto.randomBytes(16).toString("hex"); }
        } catch (e) { }
        return (String(Math.random()) + String(Date.now())).replace(/[^0-9a-z]/gi, "").substring(0, 24);
    }

    /* 把 JS 字符串变成 ExtendScript 字面量：换行、引号、反斜杠都得转干净 */
    function esStr(s) {
        return '"' + String(s)
            .replace(/\\/g, "\\\\")
            .replace(/"/g, '\\"')
            .replace(/\r/g, "\\r")
            .replace(/\n/g, "\\n")
            .replace(/\u2028/g, "\\u2028")
            .replace(/\u2029/g, "\\u2029") + '"';
    }

    /* 一次宿主操作 = 一次 evalScript：AEMCP_op(op, argsJson) 回一个 JSON 串，
       信封是 {ok, op, ms, data|error}（见 host.jsx 第 9 节）。这里只搬运与拆包。 */
    function callHost(op, args) {
        var t0 = Date.now();
        var aJson = "{}";
        try { aJson = JSON.stringify(args || {}); } catch (e) { aJson = "{}"; }
        if (aJson === undefined) { aJson = "{}"; }
        var jsx = "AEMCP_op(" + esStr(String(op)) + "," + esStr(aJson) + ")";
        return hostRun(jsx).then(function (r) {
            if (!r.ok) {
                if (r.timeout) {
                    return { ok: false, error: "宿主调用超时（" + HOST_TIMEOUT_MS + "ms）—— AE 可能卡在模态对话框上，或这段脚本太重", ms: Date.now() - t0 };
                }
                return { ok: false, error: "宿主没执行成功（AE 可能在等模态框）：" + String(r.result).substring(0, 300), ms: Date.now() - t0 };
            }
            var env;
            try { env = JSON.parse(r.result); }
            catch (e) { return { ok: false, error: "宿主回的不是 JSON：" + String(r.result).substring(0, 300), ms: Date.now() - t0 }; }
            if (!env || env.ok !== true) {
                return { ok: false, error: (env && env.error) ? env.error : "宿主报了错", ms: Date.now() - t0 };
            }
            return { ok: true, data: (env.data === undefined ? null : env.data), ms: env.ms || (Date.now() - t0) };
        });
    }

    /* 把「桥在哪」写成外部进程可读的文件。关了面板就没用了，所以每次起来都重写。 */
    function writeBridge(port) {
        if (!TOKEN) { TOKEN = makeToken(); }
        var dir = tmpDir();
        if (!dir) { log("拿不到临时目录：MCP 客户端会找不到桥文件", "warn"); return; }
        BRIDGE_FILE = dir.replace(/[\\\/]+$/, "") + "/AEMCP-bridge.json";
        var info = {
            plugin: "aemcp",
            version: VERSION,
            port: port,
            token: TOKEN,
            pid: (typeof process !== "undefined" && process.pid) ? process.pid : null,
            node: (typeof process !== "undefined") ? process.version : null,
            tools: (window.__AEMCP_MCP && window.__AEMCP_MCP.toolCount) ? window.__AEMCP_MCP.toolCount() : 0,
            startedAt: new Date().toString()
        };
        var wrote = writeText(BRIDGE_FILE, JSON.stringify(info, null, 2));
        log(wrote ? ("桥文件已写：" + BRIDGE_FILE) : "桥文件写入失败：MCP 客户端会找不到桥", wrote ? "dim" : "err");
    }

    function removeBridge() {
        try { if (fsm && BRIDGE_FILE) { fsm.unlinkSync(BRIDGE_FILE); } } catch (e) { /* 已经不在了 */ }
    }

    /* ---------------------------------------------------------- 面板侧探测 */

    function cepInfo() {
        var out = { api: null, cef: null, ua: null, cepApi: {} };
        try { out.api = cs().getCurrentApiVersion(); } catch (e) { out.api = "ERR:" + errText(e); }
        try { out.ua = navigator.userAgent; } catch (e) { out.ua = null; }
        if (out.ua) {
            var m = /Chrome\/([\d.]+)/.exec(out.ua);
            out.cef = m ? m[1] : null;
        }
        try {
            out.cepApi.fs = typeof (window.cep && window.cep.fs);
            out.cepApi.process = typeof (window.cep && window.cep.process);
            out.cepApi.node = typeof (window.cep && window.cep_node);
            out.cepApi.dispatchEvent = typeof (window.__adobe_cep__ && window.__adobe_cep__.dispatchEvent);
        } catch (e) { out.cepApi.note = errText(e); }
        return out;
    }

    function nodeInfo() {
        var out = { require: typeof require, version: null, versions: null, arch: null, platform: null, modules: {} };
        try {
            if (typeof process !== "undefined") {
                out.version = process.version;
                out.versions = process.versions ? JSON.parse(JSON.stringify(process.versions)) : null;
                out.arch = process.arch;
                out.platform = process.platform;
                out.tmp = process.env ? process.env.TEMP : null;
            }
        } catch (e) { out.err = errText(e); }
        var mods = ["http", "https", "fs", "net", "child_process", "path", "os", "url", "crypto"];
        for (var i = 0; i < mods.length; i++) {
            try {
                if (typeof require !== "function") { out.modules[mods[i]] = "no-require"; continue; }
                require(mods[i]);
                out.modules[mods[i]] = "ok";
            } catch (e) { out.modules[mods[i]] = "ERR:" + errText(e); }
        }
        return out;
    }

    /* -------------------------------------------------- HTTP 桥（架构地基） */

    function route(method, path, body, headers) {
        httpState.requests++;
        httpState.lastPath = method + " " + path;

        if (path === "/health" || path === "/ping") {
            return {
                ok: true,
                plugin: "aemcp",
                version: VERSION,
                port: httpState.port,
                mcp: (window.__AEMCP_MCP && window.__AEMCP_MCP.VERSION) ? window.__AEMCP_MCP.VERSION : null,
                tools: (window.__AEMCP_MCP && window.__AEMCP_MCP.toolCount) ? window.__AEMCP_MCP.toolCount() : 0,
                calls: MCP_CALLS,
                node: (typeof process !== "undefined") ? process.version : null,
                host: window.__aemcpHostSummary || null,
                hostQueue: hostStat(),
                engineStuck: engineStuck,
                probeFile: httpState.probeFile || null,
                bridgeFile: BRIDGE_FILE || null,
                requests: httpState.requests
            };
        }

        if (path === "/status") {
            return { ok: true, probe: lastProbe };
        }

        /* GET /ui：把面板此刻渲染出来的东西读回来。
           看不到面板时（比如我在外面驱动 AE）就靠它自证 DOM 有没有更新。
           必须验 token —— 这一份里含「桥令牌」那一行，白给等于把 token 泄出去。 */
        if (path === "/ui") {
            var utok = headers ? (headers["X-AEMCP-Token"] || headers["x-aemcp-token"] || "") : "";
            if (TOKEN && String(utok) !== TOKEN) {
                return { __status: 401, ok: false, error: "token 不匹配" };
            }
            return { ok: true, ui: uiSnapshot(),
                     info: bridgeInfoText(),
                     http: { ok: httpState.ok, port: httpState.port, requests: httpState.requests },
                     hostQueue: hostStat(), mcpCalls: MCP_CALLS };
        }

        /* MCP 客户端走的正规入口：POST /rpc，body 是 JSON-RPC 2.0 */
        if (path === "/rpc" || path === "/mcp") {
            return handleRpc(body, headers);
        }

        if (path === "/exec") {
            var script0 = null;
            if (body) {
                try { script0 = (JSON.parse(body) || {}).script; } catch (e) { script0 = null; }
            }
            if (!script0) { return { ok: false, error: "缺少 script 字段" }; }
            /* evalScript 是异步的，这里先把 Promise 交出去，由调用方 await */
            return hostRun(script0).then(function (r) {
                return { ok: r.ok, result: r.result, ms: r.ms };
            });
        }

        return { ok: false, error: "未知路由 " + path };
    }

    /* MCP 的真正入口。token 不对直接 401 —— 桥只认自己这个面板实例。 */
    function handleRpc(body, headers) {
        var tok = "";
        if (headers) {
            tok = headers["X-AEMCP-Token"] || headers["x-aemcp-token"] || "";
        }
        if (TOKEN && String(tok) !== TOKEN) {
            return { __status: 401, ok: false, error: "token 不匹配：这个桥属于另一个面板实例" };
        }
        var req;
        try { req = JSON.parse(body); }
        catch (e) {
            return { jsonrpc: "2.0", id: null, error: { code: -32700, message: "JSON 解析失败：" + errText(e) } };
        }
        clientConn.seen = true;
        clientConn.lastAt = Date.now();
        clientConn.calls++;
        clientConn.lastMethod = (req && req.method) ? req.method : "?";
        renderClient();
        var mcp = window.__AEMCP_MCP;
        if (!mcp || typeof mcp.handle !== "function") {
            return { jsonrpc: "2.0", id: (req && req.id !== undefined) ? req.id : null,
                     error: { code: -32603, message: "mcp.js 没加载（面板 js 目录不完整？）" } };
        }

        function one(r) {
            MCP_CALLS++;
            var out;
            try { out = mcp.handle(r); }
            catch (e) { out = { jsonrpc: "2.0", id: (r && r.id !== undefined) ? r.id : null,
                                error: { code: -32603, message: "服务内部异常：" + errText(e) } }; }
            var method = (r && r.method) ? r.method : "?";
            if (out && out.result && out.result.content) {
                /* 工具调用：把结果规模写进日志，方便判断有没有拖慢 AE */
                var n = 0;
                try { n = out.result.content[0].text.length; } catch (e2) { n = 0; }
                log("MCP tools/call " + ((r.params && r.params.name) || "?") + " → " + n + " 字符", out.result.isError ? "err" : "ok");
            } else {
                log("MCP " + method, "dim");
            }
            return out;
        }

        if (Object.prototype.toString.call(req) === "[object Array]") {
            var arr = [];
            for (var i = 0; i < req.length; i++) {
                var r = one(req[i]);
                if (r) { arr.push(r); }
            }
            return Promise.all(arr).then(function (rs) {
                return rs.filter(function (x) { return x !== null && x !== undefined; });
            });
        }
        return one(req);
    }

    function startHttp(ports, idx, done) {
        if (idx >= ports.length) {
            httpState.ok = false;
            httpState.err = "全部端口都被占用或不可绑定：" + ports.join(", ");
            render();
            if (done) { done(); }
            return;
        }
        var http = safeRequire("http");
        if (!http) {
            httpState.ok = false;
            httpState.err = "require('http') 不可用（CEP 没给 Node 上下文？）";
            render();
            if (done) { done(); }
            return;
        }
        var port = ports[idx];
        var server = http.createServer(function (req, res) {
            var chunks = [];
            req.on("data", function (c) { chunks.push(c); });
            req.on("end", function () {
                var body = Buffer.concat(chunks).toString("utf8");
                var out;
                try {
                    out = route(req.method, (req.url || "/").split("?")[0], body, req.headers);
                } catch (e) {
                    out = { ok: false, error: errText(e) };
                }
                Promise.resolve(out).then(function (payload) {
                    var code = 200;
                    if (payload && payload.__status) { code = payload.__status; delete payload.__status; }
                    var text;
                    if (payload === null || payload === undefined) {
                        text = "null";        /* 通知：按协议不回内容 */
                    } else {
                        try { text = JSON.stringify(payload); }
                        catch (e) { text = JSON.stringify({ ok: false, error: "结果无法序列化" }); }
                    }
                    try {
                        res.writeHead(code, {
                            "Content-Type": "application/json; charset=utf-8",
                            "Content-Length": Buffer.byteLength(text, "utf8"),
                            "Cache-Control": "no-store"
                        });
                        res.end(text);
                    } catch (e) { /* 客户端提前断了，不算错 */ }
                });
            });
        });

        server.on("error", function (e) {
            log("端口 " + port + " 绑定失败：" + errText(e) + "，试下一个", "warn");
            try { server.close(); } catch (x) { }
            startHttp(ports, idx + 1, done);
        });

        try {
            server.listen(port, "127.0.0.1", function () {
                httpState.ok = true;
                httpState.port = port;
                httpState.err = null;
                log("HTTP 桥已监听 127.0.0.1:" + port, "ok");
                writeBridge(port);
                render();
                if (done) { done(); }
            });
        } catch (e) {
            log("端口 " + port + " 监听异常：" + errText(e), "warn");
            startHttp(ports, idx + 1, done);
        }
    }

    /* ------------------------------------------------------------ 探针流程 */

    /* 宿主返回的是 `键|值` 行协议 —— 不引 JSON，是因为 AE 自己的 ExtendScript
       里没有 JSON 对象（这正是探针要证的事之一）。 */
    function parseHostPayload(text) {
        var out = {};
        var lines = String(text).split("\n");
        for (var i = 0; i < lines.length; i++) {
            var ln = lines[i];
            if (!ln) { continue; }
            var p = ln.indexOf("|");
            if (p < 0) { out["_raw" + i] = ln; continue; }
            var k = ln.substring(0, p);
            var v = ln.substring(p + 1);
            out[k] = /^-?[\d.]+$/.test(v) ? parseFloat(v) : v;
        }
        return out;
    }

    /* 面板自证：把 DOM 里**真正渲染出来**的东西读回来写进探针文件。
       这台机器上我看不到画面，OCR 也只认得出大字号 —— 所以要靠面板自己
       交证据：设置区在不在、频道显示成什么、扩展名里还有没有 @次元。 */
    function uiSnapshot() {
        function txt(id) {
            var el = $(id);
            return el ? String(el.textContent).replace(/\s+/g, " ").substring(0, 90) : null;
        }
        function q(sel) {
            var el = document.querySelector(sel);
            return el ? String(el.textContent).replace(/\s+/g, " ").substring(0, 90) : null;
        }
        var box = $("settings");
        var tg = $("s-tg");
        var head = $("setHead");
        var out = {
            title: document.title,
            h3: q("h3"),
            brand: q(".brand"),
            size: window.innerWidth + "x" + window.innerHeight,
            setHead: head ? head.textContent : null,
            settingsVisible: !!(box && box.style.display === "block"),
            tgText: txt("s-tg"),
            tgUrl: tg ? (tg.title || tg.getAttribute("href") || null) : null,
            port: txt("s-port"),
            mcp: txt("s-mcp"),
            tokenMask: txt("s-token") ? String(txt("s-token")).substring(0, 10) + "…" : null,
            perf: txt("s-perf"),
            tools: txt("p-tools"),
            health: txt("p-health"),
            clientConn: { seen: clientConn.seen, calls: clientConn.calls, lastMethod: clientConn.lastMethod, text: txt("p-client") },
            hostQueue: hostStat(),
            banner: txt("banner"),
            logLines: logBuf.length,
            /* 新手引导的验收位：是否显示、当前步、标题、是否已看过、步骤 3 的动态状态 */
            guideVisible: (function () { var ov = $("guideOverlay"); return !!(ov && ov.style.display === "flex"); })(),
            guideStep: guideStep,
            guideTitle: txt("guide-title"),
            guideActiveStep: (function () { var el = document.querySelector(".guide-step.active"); return el ? el.getAttribute("data-step") : null; })(),
            guideSeen: (function () { try { return localStorage.getItem(GUIDE_KEY) === "1"; } catch (e) { return false; } })(),
            guideStatus: txt("guide-status"),
            /* 品牌位的自检：@次元 不该再出现在面板里（频道名里的「次元の仓库_A」不算） */
            hasAtCiYuan: document.body.innerHTML.indexOf("@次元") >= 0
        };
        return out;
    }

    function runProbe() {
        var btn = $("btnProbe");
        if (btn) { btn.disabled = true; }
        log("=== 开始探测 ===", "hi");

        var t0 = Date.now();
        var dir = tmpDir();
        var result = {
            schema: 1,
            plugin: "aemcp",
            version: VERSION,
            at: new Date().toISOString(),
            tmp: dir,
            panel: { cep: cepInfo(), node: nodeInfo(), http: null },
            host: null,
            hostRaw: null,
            eval: {},
            log: logBuf.slice()
        };
        if (dir) { result.probeFile = dir + "\\AEMCP-probe.json"; }

        /* HTTP 快照**不在这里取** —— startHttp 的 listen 回调是异步的，
           早取会永远记成 ok=false（上一轮就踩了这个坑，白判一次「桥不可用」）。
           现在统一在落盘前那一刻取，见下面 flush 段。 */

        /* 1) 宿主往返：先一条最小脚本量延迟，再跑真探针。
           全部走 hostRun（不是裸 evalScript）—— 探针也得排队，
           不然它会在别人调用时插队跑 ExtendScript，还绕过了耗时账。 */
        hostRun("AEMCP_echo('ping')").then(function (r) {
            result.eval.echo = { ok: r.ok, ms: r.ms, result: String(r.result).slice(0, 120) };
            log("evalScript 往返：" + (r.ok ? "ok" : "失败") + "  " + r.ms + "ms  → " + String(r.result).slice(0, 60),
                r.ok ? "ok" : "err");
            return hostRun("AEMCP_resetLog()");
        }).then(function () {
            return hostRun("AEMCP_probe()");
        }).then(function (r) {
            result.eval.probe = { ok: r.ok, ms: r.ms, bytes: r.result.length };
            log("宿主探针：" + (r.ok ? "ok" : "失败") + "  " + r.ms + "ms  " + r.result.length + " 字节",
                r.ok ? "ok" : "err");
            if (!r.ok || r.result.indexOf("probe.protocol|") !== 0) {
                log("宿主探针没有按协议返回，前 200 字节：", "err");
                log(r.result.slice(0, 200), "err");
                result.hostRaw = r.result;
                return null;
            }
            result.hostRaw = r.result;
            result.host = parseHostPayload(r.result);
            var h = result.host;
            log("宿主版本：" + h["app.version"] + "  构建 " + h["app.buildName"], "hi");
            log("JSON 对象：" + h["js.JSON"] + "   scheduleTask：" + h["app.scheduleTask"], "dim");
            log("写文件首选项：" + h["pref.fileNetwork"] + "（1=允许）", h["pref.fileNetwork"] === 1 ? "ok" : "warn");
            return true;
        }).then(function (hostOk) {
            /* 落盘前取 HTTP 快照：这时 listen 回调早已跑完，状态是真的 */
            result.panel.http = { ok: httpState.ok, port: httpState.port, err: httpState.err,
                                  requests: httpState.requests };
            /* 面板 DOM 自证快照必须在落盘**之前**取 —— 这份快照本身就是证据，
               要跟探针结果一起进同一个文件里。 */
            result.panel.ui = uiSnapshot();
            if (dir) {
                var okJson = writeText(dir + "\\AEMCP-probe.json", JSON.stringify(result, null, 2));
                var okRaw = writeText(dir + "\\AEMCP-host-payload.txt", result.hostRaw || "");
                log("结果落盘：" + (okJson ? "ok" : "失败") + "  " + dir + "\\AEMCP-probe.json", okJson ? "ok" : "err");
                if (!okRaw) { log("宿主原始载荷落盘失败", "err"); }
                httpState.probeFile = dir + "\\AEMCP-probe.json";
            } else {
                log("拿不到临时目录，结果只在面板里", "err");
            }
            lastProbe = result;
            window.__aemcpHostSummary = {
                appVersion: result.host ? result.host["app.version"] : null,
                build: result.host ? result.host["app.buildName"] : null,
                json: result.host ? result.host["js.JSON"] : null,
                evalMs: result.eval.probe ? result.eval.probe.ms : null
            };
            render(hostOk);
            var dt = Date.now() - t0;
            log("=== 探测结束 " + dt + "ms ===", "hi");
            if (btn) { btn.disabled = false; }
        })["catch"](function (e) {
            fatal("探针流程异常：" + errText(e));
            if (btn) { btn.disabled = false; }
            render(false);
        });
    }

    /* ------------------------------------------------------------- 渲染 */

    function setV(id, text, cls) {
        var el = $(id);
        if (!el) { return; }
        el.textContent = text;
        el.className = "v" + (cls ? " " + cls : "");
    }

    /* 排队账只刷这一行。宿主每完成一次调用就调它 ——
       以前只在 render() 里写，而 render() 只在启动/换状态时跑，
       于是面板永远停在启动时那句「还没调用过宿主」。 */
    var PERF_T = 0, PERF_TIMER = null;
    function renderPerf(force) {
        var now = Date.now();
        if (!force && (now - PERF_T) < 250) {
            /* 节流丢掉的那一笔不能就这么算了：连打几发之后行上会留下
               「排队 2」这种过期状态。补一个尾刷，让显示落回最终值。 */
            if (!PERF_TIMER) {
                PERF_TIMER = setTimeout(function () { PERF_TIMER = null; renderPerf(true); }, 260);
            }
            return;
        }
        PERF_T = now;
        var q = hostStat();
        var busy = (q.queued > 0 || q.inflight > 0) ? (" · 排队 " + (q.queued + (q.inflight ? 1 : 0))) : "";
        setV("s-perf", q.done ? (q.done + " 次 · 上次 " + q.lastMs + "ms · 平均 " + q.avgMs + "ms · 最大 " + q.maxMs + "ms" +
                (q.slow ? " · 慢 " + q.slow : "") + (q.timeouts ? " · 超时 " + q.timeouts : "") + busy)
                             : (busy ? "进行中" : "还没调用过宿主"),
             q.timeouts ? "bad" : (q.slow ? "warn" : (q.done ? "ok" : "dim")));
    }

    function render(hostOk) {
        var cep = lastProbe ? lastProbe.panel.cep : cepInfo();
        var node = lastProbe ? lastProbe.panel.node : nodeInfo();
        setV("p-cep", String(cep.api), cep.api ? "ok" : "bad");
        setV("p-cef", "Chrome/" + cep.cef + (cep.cef ? "" : " (未解析)"), cep.cef ? "ok" : "warn");
        var modOk = 0, mods = node.modules || {};
        for (var k in mods) { if (mods.hasOwnProperty(k) && mods[k] === "ok") { modOk++; } }
        setV("p-node", (node.version || "无") + "  require=" + node.require + "  模块 " + modOk + "/9",
             node.require === "function" && modOk > 4 ? "ok" : "bad");
        setV("p-http", httpState.ok ? ("监听中 127.0.0.1:" + httpState.port) : ("不可用：" + (httpState.err || "未启动")),
             httpState.ok ? "ok" : "bad");
        renderClient();
        var h = lastProbe && lastProbe.host ? lastProbe.host : null;
        setV("p-host", h ? ("AE " + h["app.version"] + " / " + h["app.buildName"] + "  JSON=" + h["js.JSON"]) : "未探测",
             h ? "ok" : "warn");
        setV("p-file", lastProbe && lastProbe.probeFile ? lastProbe.probeFile : "未写",
             lastProbe && lastProbe.probeFile ? "ok" : "warn");

        var mcpTools = (window.__AEMCP_MCP && window.__AEMCP_MCP.toolCount) ? window.__AEMCP_MCP.toolCount() : 0;
        var cap = window.__AEMCP_CAP || { major: 0, tier: "?" };
        setV("p-tools", mcpTools + " 个（AE " + (cap.major || "?") + " · " + (cap.tier || "?") + "）",
             mcpTools > 0 ? "ok" : "warn");
        var q = hostStat();
        var healthTxt = engineStuck ? "引擎疑似卡死" :
                        (q.timeouts ? "有超时 " + q.timeouts : (q.slow ? "有慢调用 " + q.slow : (q.done ? "正常 · " + q.done + " 次" : "空闲")));
        setV("p-health", healthTxt,
             engineStuck || q.timeouts ? "bad" : (q.slow ? "warn" : (q.done ? "ok" : "dim")));
        setV("s-port", httpState.ok ? String(httpState.port) : "未启动", httpState.ok ? "ok" : "bad");
        setV("s-mcp", httpState.ok
                ? ("http://127.0.0.1:" + httpState.port + "/rpc · MCP v" +
                   ((window.__AEMCP_MCP && window.__AEMCP_MCP.VERSION) || "?") + " · " + mcpTools + " 个工具")
                : "桥不可用，等桥起来再说",
             httpState.ok ? "ok" : "bad");
        /* 手工调 HTTP（curl / 自己的客户端）时要照着抄这个 token */
        setV("s-token", TOKEN || "未生成", TOKEN ? "ok" : "bad");
        /* 排队账：数字一直很小就是「没卡 AE」的证据；慢调用会标黄。
           真正的刷新点在每次宿主调用结束时（renderPerf），这里只补一次强制刷新。 */
        renderPerf(true);
        renderBanner();
        renderGuideStatus();
    }

    /* AI 客户端连接状态：客户端每次 POST /rpc（initialize/tools/list/tools/call）都会刷一次 */
    function renderClient() {
        var el = $("p-client");
        if (!el) { return; }
        if (clientConn.seen) {
            el.textContent = "已连接 · " + clientConn.calls + " 次 · " + clientConn.lastMethod;
            el.className = "v ok";
        } else {
            el.textContent = "未连接";
            el.className = "v";
        }
        renderGuideStatus();
    }

    /* 单独管 banner：正常时显示桥状态；引擎卡死时覆盖成醒目警告。
       抽出来是因为 hostRun 的超时分支要立即刷新（render() 只在启动/换状态跑）。 */
    function renderBanner() {
        var banner = $("banner");
        if (!banner) { return; }
        var mcpTools = (window.__AEMCP_MCP && window.__AEMCP_MCP.toolCount) ? window.__AEMCP_MCP.toolCount() : 0;
        var h = lastProbe && lastProbe.host ? lastProbe.host : null;
        if (engineStuck) {
            banner.className = "bad";
            banner.textContent = "⚠ ExtendScript 引擎疑似卡死：连续 " + consecTimeouts + " 次调用超时（" +
                HOST_TIMEOUT_MS + "ms）。常见诱因：死循环脚本、修改文本内容（text）、MOGRT 导出。" +
                "恢复：任务管理器结束 AfterFX.exe → 重开 AE → 重开本面板；或点「检查引擎」确认。";
        } else if (httpState.ok && h) {
            banner.className = "good";
            banner.textContent = "MCP 桥就绪：http://127.0.0.1:" + httpState.port + "/rpc（" + mcpTools +
                " 个工具）。面板保持打开，AE 不用重启。";
        } else if (httpState.ok && !h) {
            banner.className = "warn";
            banner.textContent = "HTTP 桥已就绪（127.0.0.1:" + httpState.port + "），正在自检宿主…";
        } else {
            banner.className = "bad";
            banner.textContent = "HTTP 桥不可用：" + (httpState.err || "未启动") +
                "。ExtendScript 侧仍然可用（面板 → 宿主），但外部进程进不来。";
        }
    }

    /* ---------------- 新手引导 ----------------
       分步弹窗：首次打开自动弹，之后点标题栏「?」重开。看过记进 localStorage。
       每步从右滑入（CSS animation），顶部圆点指示器，底部「上一步 / 下一步」。 */
    function guideToStep(i) {
        guideStep = Math.max(0, Math.min(3, i));
        var steps = document.querySelectorAll(".guide-step");
        for (var k = 0; k < steps.length; k++) {
            steps[k].className = (k === guideStep) ? "guide-step active" : "guide-step";
        }
        var dots = document.querySelectorAll(".guide-dot");
        for (var j = 0; j < dots.length; j++) {
            dots[j].className = (j === guideStep) ? "guide-dot on" : "guide-dot";
        }
        var title = $("guide-title");
        if (title) { title.textContent = GUIDE_TITLES[guideStep]; }
        var prev = $("btnGuidePrev"), next = $("btnGuideNext"), done = $("btnGuideDone"), skip = $("btnGuideSkip");
        if (skip) { skip.style.display = (guideStep === 0) ? "" : "none"; }
        if (prev) { prev.style.display = (guideStep === 0) ? "none" : ""; }
        if (next) { next.style.display = (guideStep === 3) ? "none" : ""; }
        if (done) { done.style.display = (guideStep === 3) ? "" : "none"; }
    }
    function showGuide() {
        var ov = $("guideOverlay");
        if (!ov) { return; }
        guideToStep(0);
        ov.style.display = "flex";
        void ov.offsetWidth;                 /* 强制回流：display 先生效，再加 on 才触发遮罩/卡片动画 */
        ov.className = "on";
        renderGuideStatus();
    }
    function hideGuide() {
        var ov = $("guideOverlay");
        if (!ov) { return; }
        ov.className = "";
        setTimeout(function () { ov.style.display = "none"; }, 320);   /* 等淡出动画走完 */
        try { localStorage.setItem(GUIDE_KEY, "1"); } catch (e) { }
    }
    function renderGuideStatus() {
        var el = $("guide-status");
        if (!el) { return; }
        if (clientConn.seen) {
            el.textContent = "AI 已连接（" + clientConn.lastMethod + "），现在就可以让 AI 操作 After Effects 了。";
            el.className = "guide-v ok";
        } else if (httpState.ok) {
            el.textContent = "把桥信息发给 AI 后，等面板「AI 连接」行变绿色「已连接」，就能开始了。";
            el.className = "guide-v";
        } else {
            el.textContent = "桥还没就绪，稍等面板自检完成。";
            el.className = "guide-v";
        }
    }

    /* 「检查引擎」：发一个极轻的 1+1 探针，活着就清卡死标记，死了就坐实并提示。 */
    function checkEngine() {
        var btn = $("btnCheck");
        if (btn) { btn.disabled = true; }
        log("=== 检查引擎 ===", "hi");
        hostRun("1+1").then(function (r) {
            if (r.ok) {
                consecTimeouts = 0;
                engineStuck = false;
                log("引擎正常（1+1 往返 " + r.ms + "ms）", "ok");
            } else {
                engineStuck = true;
                consecTimeouts++;
                log("引擎仍无响应：" + String(r.result).slice(0, 140), "err");
            }
            renderBanner();
            if (btn) { btn.disabled = false; }
        });
    }

    /* ------------------------------------------------------------- 按钮 */

    function openFile(path) {
        var cp = safeRequire("child_process");
        if (cp) {
            try {
                cp.spawn("cmd", ["/c", "start", "", path], { detached: true, stdio: "ignore" }).unref();
                return true;
            } catch (e) { log("打开文件失败：" + errText(e), "err"); }
        }
        try {
            if (window.cep && window.cep.process) {
                window.cep.process.createProcess("cmd", "/c", "start", "", path);
                return true;
            }
        } catch (e) { log("cep.process 打开失败：" + errText(e), "err"); }
        return false;
    }

    /* 打开外部链接：CEP 面板里 <a href> 会在面板内导航（等于把面板刷掉），
       所以一律走系统浏览器。优先用 CEP 自己的 API，再退到 cmd start。 */
    function openUrl(url) {
        try {
            if (window.cep && window.cep.util && window.cep.util.openURLInDefaultBrowser) {
                window.cep.util.openURLInDefaultBrowser(url);
                return true;
            }
        } catch (e) { /* 落到下面 */ }
        var cp = safeRequire("child_process");
        if (cp) {
            try {
                cp.spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
                return true;
            } catch (e) { log("打开链接失败：" + errText(e), "err"); }
        }
        try {
            if (window.cep && window.cep.process) {
                window.cep.process.createProcess("cmd", "/c", "start", "", url);
                return true;
            }
        } catch (e) { log("cep.process 打开链接失败：" + errText(e), "err"); }
        return false;
    }

    function copyText(text) {
        try {
            var ta = document.createElement("textarea");
            ta.value = text;
            ta.style.position = "fixed";
            ta.style.opacity = "0";
            document.body.appendChild(ta);
            ta.select();
            var ok = document.execCommand("copy");
            document.body.removeChild(ta);
            return ok;
        } catch (e) { return false; }
    }

    function shimPath() {
        var p = null;
        try { p = cs().getSystemPath("extension").replace(/[\\\/]+$/, "") + "/mcp/aemcp-mcp.js"; } catch (e) { p = null; }
        if (!p) { p = "%APPDATA%\\Adobe\\CEP\\extensions\\com.yg.aemcp\\mcp\\aemcp-mcp.js"; }
        return p;
    }

    /* 复制到剪贴板的三行要「对齐得好看」：标签列按显示宽度补空格（中日韩算 2 列），
       值都从同一列起 —— 粘到记事本、聊天框里都是齐的。 */
    function vw(s) {
        s = String(s);
        var w = 0, i, c;
        for (i = 0; i < s.length; i++) {
            c = s.charCodeAt(i);
            if (c >= 0x1100 && (c <= 0x115F || (c >= 0x2E80 && c <= 0xA4CF) ||
                (c >= 0xAC00 && c <= 0xD7A3) || (c >= 0xF900 && c <= 0xFAFF) ||
                (c >= 0xFE30 && c <= 0xFE6F) || (c >= 0xFF00 && c <= 0xFF60))) { w += 2; }
            else { w += 1; }
        }
        return w;
    }
    function padLabel(label, cols) {
        var s = String(label);
        while (vw(s) < cols) { s += " "; }
        return s;
    }

    function bridgeInfoText() {
        /* 三行，标签对齐、值从同一列起：
             MCP 客户端  http://127.0.0.1:<端口>/rpc
             端口        <端口>
             桥令牌      <token>
           不放版本、工具数、自检命令这些（要完整客户端配置去按「复制桥 JSON」）。 */
        var port = httpState.port || 0;
        var GAP = 2;
        var labels = ["MCP 客户端", "端口", "桥令牌"];
        var cols = 0, i;
        for (i = 0; i < labels.length; i++) { if (vw(labels[i]) > cols) { cols = vw(labels[i]); } }
        cols += GAP;
        var L = [];
        L.push(padLabel(labels[0], cols) + (port ? ("http://127.0.0.1:" + port + "/rpc") : "(面板没起来，端口还没绑上)"));
        L.push(padLabel(labels[1], cols) + (port ? port : "-"));
        L.push(padLabel(labels[2], cols) + (TOKEN ? TOKEN : "(还没生成)"));
        return L.join("\r\n");
    }

    function wire() {
        var b1 = $("btnProbe");
        if (b1) { b1.addEventListener("click", runProbe); }
        var b2 = $("btnOpen");
        if (b2) {
            b2.addEventListener("click", function () {
                var path = lastProbe && lastProbe.probeFile;
                if (!path) { log("还没有结果文件，先探测", "warn"); return; }
                log(openFile(path) ? ("已请求打开 " + path) : ("请手动打开 " + path), "dim");
            });
        }
        var bInfo = $("btnCopyInfo");
        if (bInfo) {
            bInfo.addEventListener("click", function () {
                var ok = copyText(bridgeInfoText());
                log(ok ? ("已复制桥信息：MCP 客户端 / 端口 " + (httpState.port || "-") + " / 令牌 " +
                          (TOKEN ? TOKEN.substring(0, 8) + "…" : "无"))
                       : "复制失败（CEF 剪贴板受限）", ok ? "ok" : "err");
            });
        }
        var b3 = $("btnCopy");
        if (b3) {
            b3.addEventListener("click", function () {
                var snip = {
                    mcpServers: {
                        aemcp: { command: "node", args: [shimPath()] }
                    }
                };
                var ok = copyText(JSON.stringify(snip, null, 2));
                log(ok ? ("已复制桥 JSON 配置（桥 " + httpState.port + "）") : "复制失败（CEF 剪贴板受限）", ok ? "ok" : "err");
            });
        }
        var bCheck = $("btnCheck");
        if (bCheck) { bCheck.addEventListener("click", checkEngine); }

        /* 新手引导：标题栏「?」、分步导航、复制桥信息/JSON、设置区里重开 */
        var gHelp = $("btnGuideHelp");
        if (gHelp) { gHelp.addEventListener("click", showGuide); }
        var gSkip = $("btnGuideSkip");
        if (gSkip) { gSkip.addEventListener("click", hideGuide); }
        var gNext = $("btnGuideNext");
        if (gNext) { gNext.addEventListener("click", function () { guideToStep(guideStep + 1); }); }
        var gPrev = $("btnGuidePrev");
        if (gPrev) { gPrev.addEventListener("click", function () { guideToStep(guideStep - 1); }); }
        var gDone = $("btnGuideDone");
        if (gDone) { gDone.addEventListener("click", hideGuide); }
        var gCopyInfo = $("btnGuideCopyInfo");
        if (gCopyInfo) {
            gCopyInfo.addEventListener("click", function () {
                var ok = copyText(bridgeInfoText());
                log(ok ? ("已复制桥信息：MCP 客户端 / 端口 " + (httpState.port || "-") + " / 令牌 " +
                          (TOKEN ? TOKEN.substring(0, 8) + "…" : "无"))
                       : "复制失败（CEF 剪贴板受限）", ok ? "ok" : "err");
            });
        }
        var gCopyInfo3 = $("btnGuideCopyInfo3");
        if (gCopyInfo3) {
            gCopyInfo3.addEventListener("click", function () {
                var ok = copyText(bridgeInfoText());
                log(ok ? ("已复制桥信息：MCP 客户端 / 端口 " + (httpState.port || "-") + " / 令牌 " +
                          (TOKEN ? TOKEN.substring(0, 8) + "…" : "无"))
                       : "复制失败（CEF 剪贴板受限）", ok ? "ok" : "err");
            });
        }
        var gCopy = $("btnGuideCopy");
        if (gCopy) {
            gCopy.addEventListener("click", function () {
                var snip = { mcpServers: { aemcp: { command: "node", args: [shimPath()] } } };
                var ok = copyText(JSON.stringify(snip, null, 2));
                log(ok ? ("已复制桥 JSON 配置（桥 " + httpState.port + "）") : "复制失败（CEF 剪贴板受限）", ok ? "ok" : "err");
            });
        }
        var gCopy3 = $("btnGuideCopy3");
        if (gCopy3) {
            gCopy3.addEventListener("click", function () {
                var snip = { mcpServers: { aemcp: { command: "node", args: [shimPath()] } } };
                var ok = copyText(JSON.stringify(snip, null, 2));
                log(ok ? ("已复制桥 JSON 配置（桥 " + httpState.port + "）") : "复制失败（CEF 剪贴板受限）", ok ? "ok" : "err");
            });
        }

        /* 设置区：默认收起；TG 频道只在设置里出现，不挂在扩展名上。 */
        var head = $("setHead");
        var box = $("settings");
        if (head && box) {
            head.addEventListener("click", function () {
                var open = box.style.display === "block";
                box.style.display = open ? "none" : "block";
                head.textContent = (open ? "▸" : "▾") + " 设置";
            });
        }
        var tg = $("s-tg");
        if (tg) {
            tg.title = CHANNEL_URL;
            tg.addEventListener("click", function () {
                var ok = openUrl(CHANNEL_URL);
                log((ok ? "已打开频道 " : "请手动访问 ") + CHANNEL_URL, ok ? "ok" : "warn");
            });
        }

        /* 关于区：默认收起；写清工具用处、可调用主体、参考开源项目（带超链接）。 */
        var aHead = $("aboutHead");
        var aBox = $("about");
        if (aHead && aBox) {
            aHead.addEventListener("click", function () {
                var open = aBox.style.display === "block";
                aBox.style.display = open ? "none" : "block";
                aHead.textContent = (open ? "▸" : "▾") + " 关于";
            });
        }
        [
            { id: "a-dakkshin", url: "https://github.com/Dakkshin/after-effects-mcp" },
            { id: "a-junkdoge", url: "https://github.com/JUNKDOGE-JOE/after-effects-mcp" }
        ].forEach(function (r) {
            var el = $(r.id);
            if (el) {
                el.title = r.url;
                el.addEventListener("click", function () {
                    var ok = openUrl(r.url);
                    log((ok ? "已打开 " : "请手动访问 ") + r.url, ok ? "ok" : "warn");
                });
            }
        });
    }

    /* ------------------------------------------------------------- 启动 */

    /* 启动时先问宿主「能力分层」：决定 mcp.js 工具表要不要挂 2022+ 的工具。
       失败也继续 —— 用安全默认（major=0 → 只出基础工具，2022+ 工具隐藏）。 */
    function fetchCap(done) {
        window.__AEMCP_CAP = { major: 0, tier: "unknown", hasLayerId: false, hasLayerById: false };
        callHost("cap", {}).then(function (r) {
            if (r && r.ok && r.data) { window.__AEMCP_CAP = r.data; }
            done();
        }, function () {
            done();
        });
    }

    function boot() {
        try {
            log("面板就绪 " + VERSION, "dim");
            /* 宿主通道交给 mcp.js：那边只说 JSON-RPC 与工具表，不碰 CEP 的 API */
            window.__AEMCP_HOST = {
                call: function (op, args) { return callHost(op, args); },
                evalScript: function (script) { return hostRun(script); }
            };
            window.addEventListener("unload", function () { removeBridge(); });
            /* 给自动化用的只读把手：面板里的东西正常情况下从外面看不见，
               这两个函数让 CDP（Tools\debug-panel.ps1 开的 DevTools 端口）能读到
               「复制桥信息」会用到的文本和面板 DOM 快照，便于真机验收。 */
            try {
                window.__AEMCP_UI = {
                    version: VERSION,
                    infoText: bridgeInfoText,
                    snapshot: uiSnapshot
                };
            } catch (e) { }
            wire();
            render();
            /* 首次打开显示新手引导（看过就不自动弹；localStorage 不可用就每次都弹） */
            try {
                if (localStorage.getItem(GUIDE_KEY) !== "1") { showGuide(); }
            } catch (e) { showGuide(); }
            /* 先取能力分层（决定工具面），再起桥 —— 桥文件里的 tools 数要按能力过滤；
               2.5s 兜底，避免 listen 不回调时卡住不出结果 */
            fetchCap(function () {
                if (window.__AEMCP_MCP) {
                    log("MCP 服务就绪 v" + window.__AEMCP_MCP.VERSION + "，工具 " + window.__AEMCP_MCP.toolCount() + " 个", "ok");
                } else {
                    log("mcp.js 没加载：面板只能跑内置探针", "err");
                }
                var booted = false;
                startHttp(PORTS, 0, function () {
                    if (booted) { return; }
                    booted = true;
                    runProbe();
                });
                setTimeout(function () {
                    if (booted) { return; }
                    booted = true;
                    log("HTTP 桥 2.5s 内没回调，先跑宿主探针", "warn");
                    runProbe();
                }, 2500);
            });
        } catch (e) {
            fatal("面板初始化失败：" + errText(e));
        }
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", boot);
    } else {
        boot();
    }
})();
