#!/usr/bin/env node
/* ============================================================================
   AEMCP/mcp/aemcp-mcp.js —— 给 MCP 客户端用的 stdio 服务（零依赖）
   ----------------------------------------------------------------------------
   它本身不干 AE 的活，只做一件事：把 stdio 上的 JSON-RPC 原样搬到面板里那个
   HTTP 桥上（POST /rpc），再把回包原样写回 stdout。

   为什么要这么绕：
     AE 2021 实测**不接受任何外部驱动**（AfterFX.exe -r/-s 拉起后 ReturnValue=0、
     约 20 秒自行退出、脚本一次都没跑），所以真正能执行 ExtendScript 的只有面板
     自己。这个进程只是搬运工 —— 它可以在任何有 Node 的地方跑，AE 那边不必重启。

   用法（MCP 客户端配置里）：
     {
       "mcpServers": {
         "aemcp": { "command": "node", "args": ["C:/.../AEMCP/mcp/aemcp-mcp.js"] }
       }
     }

   桥的位置来自（按优先级）：
     1) 环境变量 AEMCP_PORT + AEMCP_TOKEN
     2) 环境变量 AEMCP_BRIDGE_FILE 指向的 json
     3) %TEMP%\AEMCP-bridge.json   ← 面板起来时自己写的
   ============================================================================ */
"use strict";

var http = require("http");
var fs = require("fs");
var os = require("os");
var path = require("path");

var PROTOCOL_HINT = "请在 AE 里打开 窗口 > 扩展 > AE MCP 桥（面板一起来桥就通了）";

function logErr(s) {
    /* 任何情况下都不许往 stdout 写日志：那是 JSON-RPC 的通道 */
    try { process.stderr.write("[aemcp] " + s + "\n"); } catch (e) { }
}

function bridgeFile() {
    if (process.env.AEMCP_BRIDGE_FILE) { return process.env.AEMCP_BRIDGE_FILE; }
    return path.join(process.env.TEMP || process.env.TMP || os.tmpdir(), "AEMCP-bridge.json");
}

function readBridge() {
    var info = { port: 0, token: "", file: bridgeFile(), source: "file" };
    if (process.env.AEMCP_PORT) {
        info.port = parseInt(process.env.AEMCP_PORT, 10) || 0;
        info.token = process.env.AEMCP_TOKEN || "";
        info.source = "env";
    }
    if (!info.port || !info.token) {
        try {
            var raw = fs.readFileSync(info.file, "utf8").replace(/^\uFEFF/, "");
            var j = JSON.parse(raw);
            if (j && j.port) {
                info.port = j.port;
                info.token = j.token || "";
                info.version = j.version || null;
                info.pid = j.pid || null;
                info.host = j.host || null;
                info.source = "file";
            }
        } catch (e) { /* 没文件就等下面统一报错 */ }
    }
    return info;
}

function post(port, bodyObj, headers, cb) {
    var text = Buffer.from(JSON.stringify(bodyObj), "utf8");
    var req = http.request({
        host: "127.0.0.1",
        port: port,
        path: "/rpc",
        method: "POST",
        headers: Object.assign({
            "Content-Type": "application/json; charset=utf-8",
            "Content-Length": text.length
        }, headers || {})
    }, function (res) {
        var chunks = [];
        res.on("data", function (c) { chunks.push(c); });
        res.on("end", function () {
            var body = Buffer.concat(chunks).toString("utf8");
            cb(null, res.statusCode, body);
        });
    });
    req.on("error", function (e) { cb(e, 0, ""); });
    req.setTimeout(120000, function () { req.destroy(new Error("宿主响应超时（AE 可能被模态对话框卡住了）")); });
    req.write(text);
    req.end();
}

/* --------------------------------------------------------------- stdio 主环 */
var buf = "";
var seq = 0;

function send(obj) {
    if (obj === null || obj === undefined) { return; }          /* 通知：不回包 */
    var s;
    try { s = JSON.stringify(obj); } catch (e) { s = JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32603, message: "客户端收到无法序列化的结果" } }); }
    process.stdout.write(s + "\n");
}

function rpcError(id, code, message) {
    return { jsonrpc: "2.0", id: (id === undefined ? null : id), error: { code: code, message: message } };
}

function handleLine(line) {
    var req;
    line = String(line).replace(/\r$/, "");
    if (!line.replace(/\s/g, "")) { return; }
    try { req = JSON.parse(line); }
    catch (e) {
        send(rpcError(null, -32700, "解析 JSON 失败：" + e.message));
        return;
    }
    var info = readBridge();
    if (!info.port) {
        send(rpcError(req.id === undefined ? null : req.id, -32001,
            "找不到 AE 桥：" + info.file + " 不存在或没写 port。" + PROTOCOL_HINT));
        return;
    }
    var headers = {};
    if (info.token) { headers["X-AEMCP-Token"] = info.token; }
    seq++;
    post(info.port, req, headers, function (err, status, body) {
        if (err) {
            send(rpcError(req.id === undefined ? null : req.id, -32001,
                "连不上 127.0.0.1:" + info.port + "（" + err.message + "）。" + PROTOCOL_HINT));
            return;
        }
        if (status === 401) {
            send(rpcError(req.id === undefined ? null : req.id, -32002,
                "token 不匹配：桥是另一个 AE 实例/旧面板占着的，重启面板或删掉 " + info.file + " 再试"));
            return;
        }
        var out = null;
        try { out = JSON.parse(body); }
        catch (e2) {
            send(rpcError(req.id === undefined ? null : req.id, -32603, "桥回的不是 JSON：" + String(body).substring(0, 200)));
            return;
        }
        /* 桥对「通知」（没有 id 的请求）回 null —— 按协议不许回包 */
        if (out === null || out === undefined) { return; }
        send(out);
    });
}

process.stdin.on("data", function (chunk) {
    buf += chunk.toString("utf8");
    var idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
        var line = buf.substring(0, idx);
        buf = buf.substring(idx + 1);
        handleLine(line);
    }
});
process.stdin.on("end", function () {
    if (buf.replace(/\s/g, "")) { handleLine(buf); }
    buf = "";
});
process.stdin.resume();

process.on("SIGTERM", function () { process.exit(0); });
process.on("SIGINT", function () { process.exit(0); });
process.on("uncaughtException", function (e) {
    logErr("未捕获异常：" + (e && e.message ? e.message : e));
    send(rpcError(null, -32603, "shim 内部异常：" + (e && e.message ? e.message : e)));
});

if (process.argv.indexOf("--info") >= 0) {
    var inf = readBridge();
    process.stdout.write(JSON.stringify({ bridge: inf, node: process.version }, null, 2) + "\n");
    process.exit(0);
}
