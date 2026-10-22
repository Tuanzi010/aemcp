/* AEMCP — ExtendScript 宿主桥（ES3，跑在 AE 自己的 ExtendScript 引擎里）

   这个文件有两条身份，别混淆：

   1) 现在（0.1.x）：**真机探针**。AEMCP_probe() 把 AE 2021 (18.0) 的能力面逐条
      试一遍，用 `键|值` 行协议返回，面板负责落盘成 JSON。目的是回答「两份参考
      （dakkshin / JUNKDOGE-JOE）的 API 面有多少能在 18.0 上跑」，而不是靠猜。

   2) 之后（0.2.x）：**真实执行层**。subtask 的 JSX 从面板进来，在这里 eval。

   三条必须守住的规矩（本项目踩过的坑，见 Tools/README.md）：

   - **【铁律】ES3 语法。** 没有 let/const/箭头函数/模板串、没有 JSON、没有
     Array.forEach/includes。写完必须过 `node Tools/check-extendscript.js`。
   - **【铁律】`"" + 错误对象` 会抛异常**（"在需要数字、数组或属性的位置找到类型为
     Error 的对象"），整段脚本会静默死掉。所有错误一律走 AEMCP_es()。
   - **【铁律】面板不开，扩展就不加载，这个文件不会被求值。** 所以面包屑要无条件
     写：只 catch 不写文件的话，「没跑」和「炸了」长得一模一样。

   性能立场：AE 的 ExtendScript 跑在**主线程**，脚本一停 UI 就不重绘。探针这种
   一次性动作可以厚，但**热路径（每次工具调用）必须薄**：不扫目录、不遍历
   app.project、不重复 stat 文件。
*/

/* ================================================================ 输出原语 */

/* 把任意东西变成一行字符串。绝不直接 `"" + v` —— Error 对象会抛。 */
function AEMCP_es(v) {
    if (v === null) return "null";
    if (v === undefined) return "undefined";
    try { return v.toString(); } catch (x) { return "(unprintable)"; }
}

/* 单行化 + 截断：换行会破坏行协议，竖线是分隔符。 */
function AEMCP_san(v) {
    var s = AEMCP_es(v);
    s = s.replace(/[\r\n]+/g, " ");
    s = s.replace(/\|/g, "/");
    if (s.length > 400) s = s.substring(0, 400) + "...[截断]";
    return s;
}

/* 一操作一 try 的探针行：fn 抛了就记 ERR，不影响后面的行。
   为什么用闭包：ExtendScript 里一条语句炸掉会带走整段脚本，必须逐条隔离。 */
function AEMCP_probeLine(arr, key, fn) {
    try { arr.push(key + "|" + AEMCP_san(fn())); }
    catch (e) { arr.push(key + "|ERR:" + AEMCP_san(AEMCP_es(e))); }
}

/* 面包屑：面板侧只看得到 evalScript 的返回值，返回值丢了就什么都看不到。
   无条件追加一行到 %TEMP%\AEMCP-host.log。 */
function AEMCP_hostLogPath() {
    try { return Folder.temp.fsName + "/AEMCP-host.log"; }
    catch (e) { return null; }
}

function AEMCP_breadcrumb(text) {
    try {
        var p = AEMCP_hostLogPath();
        if (p === null) return false;
        var f = new File(p);
        f.encoding = "UTF-8";
        f.open("a");
        f.write(AEMCP_san(text) + "\n");
        f.close();
        return true;
    } catch (e) {
        return false;   /* 面包屑失败本身不能带走探针 */
    }
}

/* 清空面包屑（面板每次探测前调用，避免日志无限长）。 */
function AEMCP_resetLog() {
    try {
        var f = new File(AEMCP_hostLogPath());
        if (f.exists) f.remove();
        return "ok";
    } catch (e) { return "ERR:" + AEMCP_san(AEMCP_es(e)); }
}

/* ============================================================ 探针本体 */

function AEMCP_version() {
    return "1.3.0";
}

/* 最小往返测试：面板用它量 evalScript 的单次延迟。 */
function AEMCP_echo(s) {
    return "echo:" + AEMCP_es(s);
}

/* 返回 `键|值` 行协议。第一行固定 probe.protocol，最后一行 probe.totalMs。 */
function AEMCP_probe() {
    var L = [];
    var tStart = new Date().getTime();
    var tPrev = tStart;
    var msOf = {};

    function mark(name) {
        var now = new Date().getTime();
        msOf[name] = now - tPrev;
        tPrev = now;
    }

    AEMCP_breadcrumb("--- probe start ---");

    /* ---------------------------------------------------------- 1. 引擎面 */
    L.push("probe.protocol|1");
    L.push("probe.pluginVersion|" + AEMCP_san(AEMCP_version()));
    AEMCP_probeLine(L, "es.version", function () { return $.version; });
    AEMCP_probeLine(L, "es.os", function () { return $.os; });
    AEMCP_probeLine(L, "es.engineName", function () { return $.engineName; });
    AEMCP_probeLine(L, "es.hiresTimer", function () { return typeof $.hiresTimer; });
    AEMCP_probeLine(L, "es.getenv_TEMP", function () { return $.getenv("TEMP"); });
    AEMCP_probeLine(L, "es.evalFile", function () { return typeof $.evalFile; });

    /* ES3 能力面：这些是「参考源码里的写法能不能直接抄」的判据 */
    AEMCP_probeLine(L, "js.JSON", function () { return typeof JSON; });
    AEMCP_probeLine(L, "js.ArrayIndexOf", function () { return typeof [].indexOf; });
    AEMCP_probeLine(L, "js.ArrayForEach", function () { return typeof [].forEach; });
    AEMCP_probeLine(L, "js.ArrayMap", function () { return typeof [].map; });
    AEMCP_probeLine(L, "js.ObjectKeys", function () { return typeof Object.keys; });
    AEMCP_probeLine(L, "js.StringTrim", function () { return typeof "".trim; });
    AEMCP_probeLine(L, "js.DateNow", function () { return typeof Date.now; });
    /* JSON 在宿主里到底能不能用 —— 这决定 RPC 的参数怎么传。
       只报 typeof 不算证据（AE 里出过「有 JSON 对象但没有方法」的实现），所以真跑一次
       嵌套往返 + 中文 + 转义字符，逐字段比对。 */
    AEMCP_probeLine(L, "js.JSON.parse", function () { return typeof JSON.parse; });
    AEMCP_probeLine(L, "js.JSON.stringify", function () { return typeof JSON.stringify; });
    AEMCP_probeLine(L, "json.roundTrip", function () {
        var o = { s: "中文 ok", n: 42, b: true, z: null, a: [1, "x", 3],
                  o: { k: 7, q: "a\"b\\c" } };
        var t = JSON.stringify(o);
        var b = JSON.parse(t);
        var same = (b.s === "中文 ok" && b.n === 42 && b.b === true && b.z === null &&
                    b.a.length === 3 && b.a[1] === "x" && b.o.k === 7 && b.o.q === "a\"b\\c");
        return (same ? "ok" : "MISMATCH") + " len=" + t.length +
               " tail=" + AEMCP_san(t.substring(t.length - 20));
    });
    AEMCP_probeLine(L, "json.parseBad", function () {
        try { JSON.parse("{oops"); return "NO-THROW(坏输入也放过了)"; }
        catch (e) { return "throws:" + AEMCP_es(e).substring(0, 36); }
    });
    mark("engine");

    /* ------------------------------------------------------- 2. 宿主 app 面 */
    AEMCP_probeLine(L, "app.version", function () { return app.version; });
    AEMCP_probeLine(L, "app.buildName", function () { return app.buildName; });
    AEMCP_probeLine(L, "app.buildNumber", function () { return app.buildNumber; });
    AEMCP_probeLine(L, "app.isRenderEngine", function () { return app.isRenderEngine; });
    AEMCP_probeLine(L, "app.isoLanguage", function () { return app.isoLanguage; });
    AEMCP_probeLine(L, "app.scheduleTask", function () { return typeof app.scheduleTask; });
    AEMCP_probeLine(L, "app.cancelTask", function () { return typeof app.cancelTask; });
    AEMCP_probeLine(L, "app.beginUndoGroup", function () { return typeof app.beginUndoGroup; });
    AEMCP_probeLine(L, "app.undo", function () { return typeof app.undo; });
    AEMCP_probeLine(L, "app.purge", function () { return typeof app.purge; });
    AEMCP_probeLine(L, "app.beginSuppressDialogs", function () { return typeof app.beginSuppressDialogs; });
    AEMCP_probeLine(L, "app.effects", function () { return typeof app.effects; });
    AEMCP_probeLine(L, "app.fonts", function () { return typeof app.fonts; });
    AEMCP_probeLine(L, "app.project", function () { return typeof app.project; });
    AEMCP_probeLine(L, "app.newProject", function () { return typeof app.newProject; });

    /* 新版枚举：18.0 大概率没有 —— 这是"现代写法"的主要门 */
    AEMCP_probeLine(L, "enums.KeyframeInterpolationType", function () { return typeof KeyframeInterpolationType; });
    AEMCP_probeLine(L, "enums.PropertyValueType", function () { return typeof PropertyValueType; });
    AEMCP_probeLine(L, "enums.Shape", function () { return typeof Shape; });
    AEMCP_probeLine(L, "enums.PurgeTarget", function () { return typeof PurgeTarget; });
    AEMCP_probeLine(L, "enums.MaskMode", function () { return typeof MaskMode; });

    /* 首选项：写文件 / 访问网络 —— ExtendScript 侧落盘的前提 */
    AEMCP_probeLine(L, "pref.fileNetwork", function () {
        return app.preferences.getPrefAsLong("Main Pref Section", "Pref_SCRIPTING_FILE_NETWORK_SECURITY");
    });
    mark("app");

    /* -------------------------------------------------------- 3. 项目 / 文件 */
    AEMCP_probeLine(L, "file.tempFolder", function () { return Folder.temp.fsName; });
    AEMCP_probeLine(L, "file.deleteFile", function () { return typeof Folder.temp.getFiles; });

    /* 写一个真文件再读回来，中文内容 + UTF-8，直接判定"脚本能落盘吗" */
    AEMCP_probeLine(L, "file.writeUtf8", function () {
        var f = new File(Folder.temp.fsName + "/AEMCP-write-test.txt");
        f.encoding = "UTF-8";
        f.open("w");
        f.write("中文写入测试 AEMCP 2021\n");
        f.close();
        return f.exists && f.length > 0;
    });
    AEMCP_probeLine(L, "file.readUtf8", function () {
        var f = new File(Folder.temp.fsName + "/AEMCP-write-test.txt");
        if (!f.exists) return "missing";
        f.encoding = "UTF-8";
        f.open("r");
        var s = f.read();
        f.close();
        return s;
    });

    AEMCP_probeLine(L, "prj.exists", function () { return app.project !== null; });
    AEMCP_probeLine(L, "prj.fileName", function () {
        return (app.project.file === null) ? "(无标题/未保存)" : app.project.file.fsName;
    });
    AEMCP_probeLine(L, "prj.numItemsBefore", function () { return app.project.numItems; });
    AEMCP_probeLine(L, "prj.layerByID", function () { return typeof app.project.layerByID; });
    AEMCP_probeLine(L, "prj.itemByID", function () { return typeof app.project.itemByID; });
    AEMCP_probeLine(L, "prj.renderQueue.items.add", function () { return typeof app.project.renderQueue.items.add; });
    AEMCP_probeLine(L, "prj.importFile", function () { return typeof app.project.importFile; });
    AEMCP_probeLine(L, "prj.activeItem", function () { return typeof app.project.activeItem; });
    mark("project");

    /* ================================================== 4. 真建一个合成来试
       不碰用户工程：建完、试完、remove() 掉，再用 purge 清掉 undo 记录。
       名字带前缀，万一 remove 失败也一眼看得出是谁留下的。 */
    var comp = null;
    var nBefore = 0;
    /* 记账：探针跑之前工程里有哪些 item（记 id 集合就够了）。收尾时「不在册的」
       就是探针自己造出来的东西 —— 包括 AE 给 solid / null 自动建的「纯色」文件夹。
       不靠名字匹配（typeName 和素材名都是本地化的，中文版给「文件夹 / 空 1」）。 */
    var preIds = {};
    try {
        nBefore = app.project.numItems;
        for (var pi = 1; pi <= nBefore; pi++) { preIds["i" + app.project.item(pi).id] = true; }
    } catch (pe) { }

    var undoOpened = false;
    try { app.beginUndoGroup("AEMCP probe"); undoOpened = true; } catch (e) { }

    AEMCP_probeLine(L, "comp.addComp", function () {
        comp = app.project.items.addComp("__AEMCP_PROBE__", 320, 240, 1, 2, 25);
        return (comp !== null && comp !== undefined) ? ("ok:" + comp.name) : "null";
    });
    mark("addComp");

    AEMCP_probeLine(L, "comp.width", function () { return comp.width; });
    AEMCP_probeLine(L, "comp.frameDuration", function () { return comp.frameDuration; });
    AEMCP_probeLine(L, "comp.duration", function () { return comp.duration; });
    AEMCP_probeLine(L, "comp.layers.addText", function () { return typeof comp.layers.addText; });
    AEMCP_probeLine(L, "comp.layers.addShape", function () { return typeof comp.layers.addShape; });
    AEMCP_probeLine(L, "comp.layers.addSolid", function () { return typeof comp.layers.addSolid; });
    AEMCP_probeLine(L, "comp.layers.addNull", function () { return typeof comp.layers.addNull; });
    AEMCP_probeLine(L, "comp.layers.addCamera", function () { return typeof comp.layers.addCamera; });
    AEMCP_probeLine(L, "comp.layers.addLight", function () { return typeof comp.layers.addLight; });
    AEMCP_probeLine(L, "comp.layers.precompose", function () { return typeof comp.layers.precompose; });
    AEMCP_probeLine(L, "comp.openInViewer", function () { return typeof comp.openInViewer; });
    AEMCP_probeLine(L, "comp.layerByID", function () { return typeof comp.layer; });
    AEMCP_probeLine(L, "comp.markerProperty", function () { return typeof comp.markerProperty; });

    /* ---- 文本层：TextDocument 是 18.0 的核心创作面 ---- */
    var textLayer = null;
    AEMCP_probeLine(L, "layer.addText", function () {
        textLayer = comp.layers.addText("AEMCP 探针文本");
        return (textLayer !== null) ? ("ok:" + textLayer.name + " idx=" + textLayer.index) : "null";
    });
    AEMCP_probeLine(L, "layer.id", function () { return typeof textLayer.id; });
    AEMCP_probeLine(L, "layer.sourceText", function () { return typeof textLayer.sourceText; });
    AEMCP_probeLine(L, "layer.textDocExists", function () {
        return typeof textLayer.property("ADBE Text Properties").property("ADBE Text Document");
    });
    AEMCP_probeLine(L, "layer.textDoc.fontSize", function () {
        var p = textLayer.property("ADBE Text Properties").property("ADBE Text Document");
        var td = p.value;
        return td.fontSize + " / font=" + td.font + " / just=" + td.justification;
    });
    AEMCP_probeLine(L, "layer.textDoc.setValue", function () {
        var p = textLayer.property("ADBE Text Properties").property("ADBE Text Document");
        var td = p.value;
        td.fontSize = 72;
        td.fillColor = [1, 0.2, 0.2];
        p.setValue(td);
        return "ok:" + p.value.fontSize;
    });
    AEMCP_probeLine(L, "layer.textAnimators", function () {
        return typeof textLayer.property("ADBE Text Properties").property("ADBE Text Animators");
    });
    mark("text");

    /* ---- 关键帧 + 插值速度图 ---- */
    var posProp = null;
    AEMCP_probeLine(L, "kf.getPositionProp", function () {
        posProp = textLayer.property("ADBE Transform Group").property("ADBE Position");
        return typeof posProp;
    });
    AEMCP_probeLine(L, "kf.setValueAtTime", function () {
        posProp.setValueAtTime(0, [160, 120]);
        posProp.setValueAtTime(1, [200, 140]);
        return "numKeys=" + posProp.numKeys;
    });
    AEMCP_probeLine(L, "kf.api", function () {
        return typeof posProp.keyTime + "," + typeof posProp.keyValue + "," +
               typeof posProp.setInterpolationTypeAtKey + "," +
               typeof posProp.addKey + "," + typeof posProp.removeKey;
    });
    AEMCP_probeLine(L, "kf.keyValue", function () { return posProp.keyValue(1); });
    AEMCP_probeLine(L, "kf.setTemporalEase", function () {
        /* 手写 ease 数组：18.0 用数字化的 KeyframeEase，不是枚举 */
        var easeIn = new KeyframeEase(0, 33);
        var easeOut = new KeyframeEase(0, 33);
        posProp.setTemporalEaseAtKey(1, [easeIn], [easeOut]);
        return "ok";
    });
    AEMCP_probeLine(L, "kf.KeyframeEase_speedOnly", function () {
        var e = new KeyframeEase(10);
        return "[speed,infl=" + e.influence + "]";
    });
    mark("keyframes");

    /* ---- 表达式 ---- */
    AEMCP_probeLine(L, "expr.set", function () {
        posProp.expression = "value + [10, 0]";
        return "enabled=" + posProp.expressionEnabled;
    });
    AEMCP_probeLine(L, "expr.read", function () { return posProp.value; });
    AEMCP_probeLine(L, "expr.expressionError", function () { return typeof posProp.expressionError; });
    AEMCP_probeLine(L, "expr.clear", function () {
        posProp.expression = "";
        return "ok";
    });
    mark("expression");

    /* ---- 固态 / 形状 / 空对象 / 相机 / 灯光 ---- */
    AEMCP_probeLine(L, "layer.addSolid", function () {
        var s = comp.layers.addSolid([1, 0, 0], "探针固态", 320, 240, 1, 2, 0);
        return "ok:" + s.name;
    });
    var shapeLayer = null;
    AEMCP_probeLine(L, "layer.addShape", function () {
        shapeLayer = comp.layers.addShape();
        return "ok:" + shapeLayer.name;
    });
    AEMCP_probeLine(L, "shape.rootVectors", function () {
        return typeof shapeLayer.property("ADBE Root Vectors Group");
    });
    AEMCP_probeLine(L, "shape.addRectDirect", function () {
        var r = shapeLayer.property("ADBE Root Vectors Group").addProperty("ADBE Vector Shape - Rect");
        return "ok:" + r.matchName;
    });
    AEMCP_probeLine(L, "shape.addGroup", function () {
        var g = shapeLayer.property("ADBE Root Vectors Group").addProperty("ADBE Vector Group");
        return "ok:" + g.matchName;
    });
    AEMCP_probeLine(L, "shape.groupContents", function () {
        var g = shapeLayer.property("ADBE Root Vectors Group").property("ADBE Vector Group");
        var c = g.property("ADBE Vectors Group");
        var r = c.addProperty("ADBE Vector Shape - Rect");
        return "ok:" + r.matchName + " contents=" + g.numProperties;
    });
    /* 上一轮把 fill+stroke 写在一行，只得到「对象无效」，分不清是哪一句炸的。
       拆成三行，并且都先把 group/contents 重新取一遍。 */
    AEMCP_probeLine(L, "shape.addFill", function () {
        var c = shapeLayer.property("ADBE Root Vectors Group").property("ADBE Vector Group").property("ADBE Vectors Group");
        var f = c.addProperty("ADBE Vector Graphic - Fill");
        return "ok:" + (f ? f.matchName : "(null)");
    });
    AEMCP_probeLine(L, "shape.addStroke", function () {
        var c = shapeLayer.property("ADBE Root Vectors Group").property("ADBE Vector Group").property("ADBE Vectors Group");
        var s = c.addProperty("ADBE Vector Graphic - Stroke");
        return "ok:" + (s ? s.matchName : "(null)");
    });
    AEMCP_probeLine(L, "shape.fillColor", function () {
        var c = shapeLayer.property("ADBE Root Vectors Group").property("ADBE Vector Group").property("ADBE Vectors Group");
        var f = c.property("ADBE Vector Graphic - Fill");
        if (!f) return "(没有 Fill 可写)";
        var col = f.property("ADBE Vector Fill Color");
        col.setValue([1, 0, 0]);
        return "color=" + col.value.join(",");
    });
    AEMCP_probeLine(L, "shape.pathProp", function () {
        var g = shapeLayer.property("ADBE Root Vectors Group").property("ADBE Vector Group");
        var r = g.property("ADBE Vectors Group").property("ADBE Vector Shape - Rect");
        return typeof r.property("ADBE Vector Rect Size");
    });
    AEMCP_probeLine(L, "layer.addNull", function () { return "ok:" + comp.layers.addNull().name; });
    AEMCP_probeLine(L, "layer.addCamera", function () { return "ok:" + comp.layers.addCamera("探针相机", [160, 120]).name; });
    AEMCP_probeLine(L, "layer.addLight", function () { return "ok:" + comp.layers.addLight("探针灯光", [160, 120]).name; });
    AEMCP_probeLine(L, "layer.parenting", function () {
        var n = comp.layers.addNull();
        shapeLayer.parent = n;
        return "parent=" + shapeLayer.parent.name;
    });
    mark("layers");

    /* ---- 效果 ---- */
    AEMCP_probeLine(L, "effect.parade", function () {
        return typeof textLayer.property("ADBE Effect Parade");
    });
    AEMCP_probeLine(L, "effect.addFill", function () {
        var e = textLayer.property("ADBE Effect Parade").addProperty("ADBE Fill");
        return "ok:" + e.matchName + " " + e.name;
    });
    AEMCP_probeLine(L, "effect.addGaussianBlur", function () {
        var e = textLayer.property("ADBE Effect Parade").addProperty("ADBE Gaussian Blur 2");
        return "ok:" + e.matchName;
    });
    AEMCP_probeLine(L, "effect.addDropShadow", function () {
        var e = textLayer.property("ADBE Effect Parade").addProperty("ADBE Drop Shadow");
        return "ok:" + e.matchName;
    });
    AEMCP_probeLine(L, "effect.addTint", function () {
        var e = textLayer.property("ADBE Effect Parade").addProperty("ADBE Tint");
        return "ok:" + e.matchName;
    });
    AEMCP_probeLine(L, "effect.addBlurLegacy", function () {
        var e = textLayer.property("ADBE Effect Parade").addProperty("ADBE Blur");
        return "ok:" + e.matchName;
    });
    AEMCP_probeLine(L, "effect.byMatchName", function () { return typeof app.effects; });
    AEMCP_probeLine(L, "effect.count", function () { return textLayer.property("ADBE Effect Parade").numProperties; });
    AEMCP_probeLine(L, "effect.paramAccess", function () {
        var e = textLayer.property("ADBE Effect Parade").property("ADBE Fill");
        return typeof e.property(1);
    });
    mark("effects");

    /* ---- 遮罩 / 混合 / 时间 ---- */
    AEMCP_probeLine(L, "mask.add", function () {
        var m = textLayer.Masks.addProperty("ADBE Mask Atom");
        return "ok:" + m.matchName + " count=" + textLayer.Masks.numProperties;
    });
    AEMCP_probeLine(L, "mask.shape", function () {
        var m = textLayer.Masks.property(1);
        var sh = m.property("ADBE Mask Shape");
        sh.setValue(new Shape());
        return "ok:shape";
    });
    AEMCP_probeLine(L, "layer.blendMode", function () {
        textLayer.blendingMode = BlendingMode.ADD;
        return "ok:" + textLayer.blendingMode;
    });
    AEMCP_probeLine(L, "layer.timeRemap", function () { return typeof textLayer.timeRemapEnabled; });
    AEMCP_probeLine(L, "layer.inOutSplit", function () {
        textLayer.inPoint = 0.5;
        return "in=" + textLayer.inPoint + " out=" + textLayer.outPoint;
    });
    mark("maskMix");

    /* ---- 收尾：删掉探针合成，尽量不污染用户工程 ---- */
    AEMCP_probeLine(L, "comp.remove", function () {
        if (comp === null) return "skip(comp=null)";
        comp.remove();
        return "ok";
    });
    if (undoOpened) {
        try { app.endUndoGroup(); } catch (e) { }
    }
    /* 注意：这两条都是**回收之前**的快照。comp.remove() 管不到 solid / null 落成的素材，
       所以这里必然「不为 0」—— 它不是失败判据，是「必须记账」的证据。
       真正的收尾判据是下面的 prj.reclaim + prj.backToBefore。 */
    AEMCP_probeLine(L, "prj.numItemsAfter", function () { return app.project.numItems; });
    AEMCP_probeLine(L, "prj.preReclaimLeak", function () { return (app.project.numItems - nBefore); });
    /* 上一轮 numItemsAfter=3（before=0），说明工程里留了东西。先列出「是谁」，
       只回收名字带 __AEMCP 的自家合成，绝不碰用户工程里别的东西。 */
    AEMCP_probeLine(L, "prj.leftover", function () {
        var names = [];
        for (var i = 1; i <= app.project.numItems; i++) {
            var it = app.project.item(i);
            names.push(i + ":" + it.name + "[" + it.typeName + " id=" + (it.id || "-") + "]");
        }
        return (names.length ? names.join("  ") : "(空)");
    });
    AEMCP_probeLine(L, "prj.cleanup", function () {
        var killed = 0;
        for (var i = app.project.numItems; i >= 1; i--) {
            var it = app.project.item(i);
            if (it.name.indexOf("__AEMCP") === 0) { it.remove(); killed++; }
        }
        return "removed=" + killed + " rest=" + app.project.numItems;
    });
    /* solid / null 会在工程面板里落成素材，并且 AE 会自动建一个「纯色」文件夹 ——
       comp.remove() 完全管不到它们。这是写工具必须自己记账的东西：谁建的素材谁删。
       做法用 **id 集差集**：不在 preIds 里的就是探针自己造的。不按名字匹配
       （typeName 与「空 1 / 纯色」都是本地化字符串，换语言就废），也不写死 instanceof
       （FolderItem 得等它变空才删得掉，倒序扫天然满足：子项的下标总比父文件夹大）。 */
    AEMCP_probeLine(L, "prj.reclaim", function () {
        var killed = [], i, it, rk = 0;
        for (i = app.project.numItems; i >= 1; i--) {
            it = app.project.item(i);
            var key = "i" + it.id;
            if (preIds[key]) { continue; }          /* 探针之前就在 = 用户的，别动 */
            killed.push(i + ":" + it.name);
            try { it.remove(); rk++; } catch (rke) { killed.push("ERR:" + AEMCP_es(rke)); }
        }
        return "reclaimed=" + rk + " [" + killed.join(" ") + "] rest=" + app.project.numItems;
    });
    AEMCP_probeLine(L, "prj.backToBefore", function () { return (app.project.numItems === nBefore); });
    AEMCP_probeLine(L, "prj.purgeUndo", function () {
        app.purge(PurgeTarget.UNDO_CACHES);
        return "ok";
    });
    AEMCP_probeLine(L, "prj.activeItemAfter", function () {
        var a = app.project.activeItem;
        return (a === null) ? "(none)" : a.name;
    });
    mark("cleanup");

    /* --------------------------------------------------------- 5. 计时面 */
    var tEnd = new Date().getTime();
    for (var k in msOf) {
        if (msOf.hasOwnProperty(k)) {
            L.push("ms." + k + "|" + msOf[k]);
        }
    }
    L.push("probe.totalMs|" + (tEnd - tStart));
    L.push("probe.end|ok");

    AEMCP_breadcrumb("--- probe end, lines=" + L.length + " totalMs=" + (tEnd - tStart) + " ---");

    return L.join("\n");
}

/* ==================================================================== 8. 执行层
   对外只有一个入口：AEMCP_op(name, argsJson) → JSON 字符串
       成功 {"ok":true,"op":"...","ms":N,"data":{...}}
       失败 {"ok":false,"op":"...","error":"一句话说清哪儿不对"}
   MCP 工具全部落到这里；面板只负责把 args 变成 JSON、把结果读回来。

   真机（AE 18.0x39）实测锁死的三条硬约束，写这层时不许绕：
     1) **没有 Layer.id / project.layerByID**（那是 22.0+ 才有的）→ 图层只能按
        index / 名字 / 我方写进 layer.comment 的戳来寻址。index 会随增删漂移，
        所以给 MCP 用的稳定寻址是 layer.stamp。
     2) **属性树不能用中文名走**（「位置」「不透明度」是本地化字符串，换语言就废）
        → 一律 matchName；友好名只是我方的别名表（AEMCP_PROP_MAP）。
     3) **一次调用一个 undo 组，绝不主动 purge**。purge 会把用户自己的 undo 历史
        一起清掉 —— 脚本化的编辑必须让用户按 Ctrl+Z 撤得回来。
*/

function AEMCP_ms() {
    try { if (Date.now) { return Date.now(); } } catch (e) { }
    return new Date().getTime();
}

/* ---------------------------------------------------------- 8.1 JSON 底座 */
function AEMCP_pad4(h) {
    h = String(h);
    while (h.length < 4) { h = "0" + h; }
    return h;
}

function AEMCP_jstr(s) {
    var out = '"', i, c, code;
    s = String(s);
    for (i = 0; i < s.length; i++) {
        c = s.charAt(i);
        code = s.charCodeAt(i);
        if (c === '"') { out += '\\"'; }
        else if (c === "\\") { out += "\\\\"; }
        else if (c === "\n") { out += "\\n"; }
        else if (c === "\r") { out += "\\r"; }
        else if (c === "\t") { out += "\\t"; }
        else if (code < 32) { out += "\\u" + AEMCP_pad4(code.toString(16)); }
        else { out += c; }
    }
    return out + '"';
}

/* 自研序列化：只吃「我方新建的纯数据」。宿主对象（Layer / Property …）不硬拆 ——
   它们的属性访问可能抛异常，硬拆等于把一次好调用炸掉。 */
function AEMCP_j(v, depth, seen) {
    depth = depth || 0;
    seen = seen || [];
    var i, t = typeof v, parts;
    if (v === null || v === undefined || t === "undefined") { return "null"; }
    if (t === "number") { return isFinite(v) ? String(v) : "null"; }
    if (t === "boolean") { return v ? "true" : "false"; }
    if (t === "string") { return AEMCP_jstr(v); }
    if (t === "function") { return '"<function>"'; }
    if (depth > 8) { return '"<too deep>"'; }
    for (i = 0; i < seen.length; i++) { if (seen[i] === v) { return '"<cycle>"'; } }
    seen.push(v);
    if (v instanceof Array) {
        parts = [];
        for (i = 0; i < v.length; i++) { parts.push(AEMCP_j(v[i], depth + 1, seen)); }
        return "[" + parts.join(",") + "]";
    }
    var ctor = "";
    try { ctor = (v.constructor && v.constructor.name) ? String(v.constructor.name) : ""; } catch (ce) { ctor = ""; }
    if (ctor && ctor !== "Object") { return AEMCP_jstr("<" + ctor + ">"); }
    parts = [];
    for (var k in v) {
        if (v.hasOwnProperty && !v.hasOwnProperty(k)) { continue; }
        parts.push(AEMCP_jstr(k) + ":" + AEMCP_j(v[k], depth + 1, seen));
    }
    return "{" + parts.join(",") + "}";
}

/* 参数解析：优先宿主自带 JSON（探针已验），没有/坏了就退回自研解析器 ——
   这一层不能有「宿主没给 JSON 就整个工具面瘫掉」这种单点。 */
function AEMCP_pj(s) {
    if (s === null || s === undefined || s === "") { return {}; }
    s = String(s);
    try {
        if (typeof JSON !== "undefined" && JSON && JSON.parse) { return JSON.parse(s); }
    } catch (e) { /* 落到自研解析器 */ }
    return AEMCP_pjFallback(s);
}

function AEMCP_pjFallback(s) {
    var i = 0, n = s.length;
    function skip() {
        var c;
        while (i < n) {
            c = s.charAt(i);
            if (c === " " || c === "\t" || c === "\n" || c === "\r") { i++; } else { break; }
        }
    }
    function pStr() {
        var out = "";
        i++;
        while (i < n) {
            var c = s.charAt(i);
            if (c === "\\") {
                var e = s.charAt(i + 1);
                if (e === "n") { out += "\n"; }
                else if (e === "t") { out += "\t"; }
                else if (e === "r") { out += "\r"; }
                else if (e === "b") { out += "\b"; }
                else if (e === "f") { out += "\f"; }
                else if (e === "u") { out += String.fromCharCode(parseInt(s.substring(i + 2, i + 6), 16)); i += 4; }
                else { out += e; }
                i += 2;
            } else if (c === '"') { i++; return out; }
            else { out += c; i++; }
        }
        throw new Error("JSON 字符串没闭合");
    }
    function pVal() {
        skip();
        var c = s.charAt(i), o, a, k;
        if (c === "{") {
            i++; o = {}; skip();
            if (s.charAt(i) === "}") { i++; return o; }
            for (;;) {
                skip(); k = pStr(); skip();
                if (s.charAt(i) !== ":") { throw new Error("JSON 对象缺冒号"); }
                i++; o[k] = pVal(); skip();
                if (s.charAt(i) === ",") { i++; continue; }
                if (s.charAt(i) === "}") { i++; return o; }
                throw new Error("JSON 对象没闭合");
            }
        }
        if (c === "[") {
            i++; a = []; skip();
            if (s.charAt(i) === "]") { i++; return a; }
            for (;;) {
                a.push(pVal()); skip();
                if (s.charAt(i) === ",") { i++; continue; }
                if (s.charAt(i) === "]") { i++; return a; }
                throw new Error("JSON 数组没闭合");
            }
        }
        if (c === '"') { return pStr(); }
        if (s.substring(i, i + 4) === "true") { i += 4; return true; }
        if (s.substring(i, i + 5) === "false") { i += 5; return false; }
        if (s.substring(i, i + 4) === "null") { i += 4; return null; }
        var j = i;
        while (j < n && "-+.eE0123456789".indexOf(s.charAt(j)) >= 0) { j++; }
        if (j === i) { throw new Error("JSON 在位置 " + i + " 处不是合法值"); }
        var num = parseFloat(s.substring(i, j));
        i = j;
        return num;
    }
    var v = pVal();
    skip();
    return v;
}

function AEMCP_clean(s) {
    s = String(s);
    s = s.replace(/\r?\n/g, " ");
    s = s.replace(/^Error:\s*/, "");
    if (s.length > 400) { s = s.substring(0, 400) + "…"; }
    return s;
}

function AEMCP_keys(o) {
    var out = [];
    for (var k in o) { if (o.hasOwnProperty(k)) { out.push(k); } }
    return out;
}

/* ------------------------------------------------------- 8.2 参数与寻址 */
function AEMCP_get(a, key, def) {
    if (a && a[key] !== undefined && a[key] !== null) { return a[key]; }
    return def;
}

function AEMCP_num(v, def) {
    if (typeof v === "number" && isFinite(v)) { return v; }
    if (typeof v === "string" && v.length) {
        var f = parseFloat(v);
        if (isFinite(f)) { return f; }
    }
    return def;
}

function AEMCP_bool(v, def) {
    if (typeof v === "boolean") { return v; }
    if (v === "true" || v === 1) { return true; }
    if (v === "false" || v === 0) { return false; }
    return def;
}

function AEMCP_pair(v, def) {
    var d = def || [0, 0];
    if (v instanceof Array && v.length >= 1) {
        return [AEMCP_num(v[0], d[0]), AEMCP_num(v.length > 1 ? v[1] : d[1], d[1])];
    }
    return [d[0], d[1]];
}

/* 颜色三吃：数组 0..1 / 数组 0..255 / "#rrggbb"。给 LLM 用的接口要能容忍三种写法。 */
function AEMCP_color(v, def) {
    var d = def || [1, 1, 1], i, max = 1, out = [], f;
    if (typeof v === "string") {
        var h = v.replace(/^\s*#/, "");
        if (h.length === 6) {
            return [parseInt(h.substring(0, 2), 16) / 255,
                    parseInt(h.substring(2, 4), 16) / 255,
                    parseInt(h.substring(4, 6), 16) / 255];
        }
        return d;
    }
    if (v instanceof Array && v.length >= 3) {
        for (i = 0; i < 3; i++) { max = Math.max(max, AEMCP_num(v[i], 0)); }
        var scale = (max > 1.0001) ? 255 : 1;
        for (i = 0; i < 3; i++) {
            f = AEMCP_num(v[i], 0) / scale;
            out.push(f < 0 ? 0 : (f > 1 ? 1 : f));
        }
        return out;
    }
    return d;
}

function AEMCP_comp(ref) {
    var p = app.project, i, it, s;
    if (ref === null || ref === undefined || ref === "" || ref === "active") {
        var act = p.activeItem;
        if (act instanceof CompItem) { return act; }
        throw new Error("没有活动合成（app.project.activeItem 是 null 或不是合成）：请显式给 comp，"
            + "或先 ae_comp_create 建一个（它会顺手在查看器里打开，从而成为活动合成）");
    }
    if (typeof ref === "number" || /^\d+$/.test(String(ref))) {
        it = p.item(AEMCP_num(ref, 1));
        if (it instanceof CompItem) { return it; }
        throw new Error("工程第 " + ref + " 项不是合成");
    }
    s = String(ref);
    if (s.indexOf("@id:") === 0) {
        var want = AEMCP_num(s.substring(4), -1);
        for (i = 1; i <= p.numItems; i++) {
            it = p.item(i);
            if (it instanceof CompItem && it.id === want) { return it; }
        }
        throw new Error("没有 id=" + want + " 的合成");
    }
    for (i = 1; i <= p.numItems; i++) {
        it = p.item(i);
        if (it instanceof CompItem && it.name === s) { return it; }
    }
    for (i = 1; i <= p.numItems; i++) {
        it = p.item(i);
        if (it instanceof CompItem && String(it.name).toLowerCase() === s.toLowerCase()) { return it; }
    }
    throw new Error("找不到合成：" + s);
}

function AEMCP_layer(comp, ref) {
    if (comp === null || comp === undefined) { throw new Error("寻址图层需要 comp"); }
    var i, n = comp.numLayers, l, s;
    if (ref === null || ref === undefined || ref === "") { throw new Error("缺 layer（图层名或下标）"); }
    if (typeof ref === "number" || /^\d+$/.test(String(ref))) {
        var idx = AEMCP_num(ref, 0);
        if (idx < 1 || idx > n) { throw new Error("图层下标越界：" + idx + "（该合成有 " + n + " 层，1.." + n + "）"); }
        return comp.layer(idx);
    }
    s = String(ref);
    if (s.indexOf("aemcp:") === 0) {
        for (i = 1; i <= n; i++) {
            l = comp.layer(i);
            if (String(l.comment).indexOf(s) >= 0) { return l; }
        }
        throw new Error("没有图层带戳 " + s + "（戳是 layer.stamp 写的，存在 layer.comment 里）");
    }
    for (i = 1; i <= n; i++) {
        l = comp.layer(i);
        if (l.name === s) { return l; }
    }
    for (i = 1; i <= n; i++) {
        l = comp.layer(i);
        if (String(l.name).toLowerCase() === s.toLowerCase()) { return l; }
    }
    throw new Error("找不到图层：" + s);
}

function AEMCP_PROP_MAP() {
    return {
        "position": ["ADBE Transform Group", "ADBE Position"],
        "anchor": ["ADBE Transform Group", "ADBE Anchor Point"],
        "anchorPoint": ["ADBE Transform Group", "ADBE Anchor Point"],
        "scale": ["ADBE Transform Group", "ADBE Scale"],
        "rotation": ["ADBE Transform Group", "ADBE Rotate Z"],
        "rotationZ": ["ADBE Transform Group", "ADBE Rotate Z"],
        "rotationX": ["ADBE Transform Group", "ADBE Rotate X"],
        "rotationY": ["ADBE Transform Group", "ADBE Rotate Y"],
        "orientation": ["ADBE Transform Group", "ADBE Orientation"],
        "opacity": ["ADBE Transform Group", "ADBE Opacity"],
        "transform": ["ADBE Transform Group"],
        "text": ["ADBE Text Properties", "ADBE Text Document"],
        "sourceText": ["ADBE Text Properties", "ADBE Text Document"],
        "textAnimators": ["ADBE Text Properties", "ADBE Text Animators"],
        "masks": ["ADBE Mask Parade"],
        "effects": ["ADBE Effect Parade"],
        "shape": ["ADBE Root Vectors Group"],
        "contents": ["ADBE Root Vectors Group"],
        "audio": ["ADBE Audio Group"],
        "cameraOptions": ["ADBE Camera Options Group"],
        "cameraZoom": ["ADBE Camera Options Group", "ADBE Camera Zoom"],
        "intensity": ["ADBE Light Options Group", "ADBE Light Intensity"],
        "lightOptions": ["ADBE Light Options Group"],
        "timeRemapEnabled": null
    };
}

function AEMCP_prop(layer, ref) {
    if (layer === null || layer === undefined) { throw new Error("寻址属性需要 layer"); }
    var s = String(ref), i, cur, nx, k, pr;
    if (s.indexOf("ADBE ") === 0) {
        pr = layer.property(s);
        if (pr) { return pr; }
        throw new Error("这个图层没有 matchName 为 " + s + " 的属性");
    }
    var map = AEMCP_PROP_MAP();
    if (map[s] instanceof Array) {
        cur = layer;
        var path = map[s];
        for (i = 0; i < path.length; i++) {
            cur = cur.property(path[i]);
            if (!cur) { throw new Error("属性路径断了：" + path[i] + "（图层类型可能不支持）"); }
        }
        return cur;
    }
    if (s.indexOf(".") > 0) {
        var segs = s.split(".");
        if (segs[0] === "Effects") {
            var parade = layer.property("ADBE Effect Parade");
            var fx = null;
            for (i = 1; i <= parade.numProperties; i++) {
                if (parade.property(i).name === segs[1] || parade.property(i).matchName === segs[1]) { fx = parade.property(i); break; }
            }
            if (!fx) { throw new Error("这个图层没有效果：" + segs[1]); }
            if (segs.length === 2) { return fx; }
            for (i = 1; i <= fx.numProperties; i++) {
                if (fx.property(i).name === segs[2] || fx.property(i).matchName === segs[2]) { return fx.property(i); }
            }
            throw new Error("效果 " + segs[1] + " 没有参数 " + segs[2]);
        }
        cur = layer;
        for (i = 0; i < segs.length; i++) {
            nx = null;
            try { nx = cur.property(segs[i]); } catch (e1) { nx = null; }
            if (!nx && cur.numProperties) {
                for (k = 1; k <= cur.numProperties; k++) {
                    var ch = cur.property(k);
                    if (ch.name === segs[i] || ch.matchName === segs[i]) { nx = ch; break; }
                }
            }
            if (!nx) { throw new Error("属性路径断了：" + segs.slice(0, i + 1).join(".")); }
            cur = nx;
        }
        return cur;
    }
    throw new Error("不认识属性 " + s + "：请用友好名（position/scale/opacity/...）或 ADBE matchName");
}

function AEMCP_val(prop) {
    if (!prop) { return null; }
    try { return prop.value; } catch (e) { return null; }
}

function AEMCP_setProp(prop, v, atTime) {
    var pvt = null, out;
    try { pvt = prop.propertyValueType; } catch (e0) { pvt = null; }
    try { if (prop.numProperties !== undefined && pvt === null) { throw new Error("这是属性组，不能直接赋值"); } } catch (e1) { }

    function put(x) {
        if (atTime === null || atTime === undefined) { return prop.setValue(x); }
        return prop.setValueAtTime(atTime, x);
    }

    if (pvt === PropertyValueType.TwoD || pvt === PropertyValueType.TwoD_SPATIAL) {
        return put(AEMCP_pair(v, AEMCP_val(prop) instanceof Array ? AEMCP_val(prop) : [0, 0]));
    }
    if (pvt === PropertyValueType.ThreeD || pvt === PropertyValueType.ThreeD_SPATIAL) {
        var cur = AEMCP_val(prop);
        var base = (cur instanceof Array && cur.length >= 3) ? cur : [0, 0, 0];
        var a3 = AEMCP_pair(v, base);
        return put([a3[0], a3[1], AEMCP_num(v instanceof Array ? v[2] : v, base[2])]);
    }
    if (pvt === PropertyValueType.COLOR) {
        var c = AEMCP_color(v, [1, 1, 1]);
        return put([c[0], c[1], c[2], 1]);
    }
    if (pvt === PropertyValueType.OneD) {
        return put(AEMCP_num(v, 0));
    }
    if (v instanceof Array) {
        out = [];
        for (var i = 0; i < v.length; i++) { out.push(AEMCP_num(v[i], 0)); }
        return put(out);
    }
    return put(v);
}

// 把入参 v 按目标属性的类型规整（用于 setValueAtKey 等按值写关键帧的接口）
function AEMCP_coerceForProp(prop, v) {
    var pvt = null;
    try { pvt = prop.propertyValueType; } catch (e0) { pvt = null; }
    if (pvt === PropertyValueType.TwoD || pvt === PropertyValueType.TwoD_SPATIAL) {
        return AEMCP_pair(v, [0, 0]);
    }
    if (pvt === PropertyValueType.ThreeD || pvt === PropertyValueType.ThreeD_SPATIAL) {
        var base = AEMCP_val(prop);
        var b3 = (base instanceof Array && base.length >= 3) ? base : [0, 0, 0];
        var a3 = AEMCP_pair(v, b3);
        return [a3[0], a3[1], AEMCP_num(v instanceof Array ? v[2] : v, b3[2])];
    }
    if (pvt === PropertyValueType.COLOR) {
        var c = AEMCP_color(v, [1, 1, 1]);
        return [c[0], c[1], c[2], 1];
    }
    if (pvt === PropertyValueType.OneD) { return AEMCP_num(v, 0); }
    return v;
}

function AEMCP_layerBrief(l) {
    var d = { index: l.index, name: l.name, enabled: l.enabled, locked: l.locked, shy: l.shy,
              inPoint: l.inPoint, outPoint: l.outPoint, startTime: l.startTime,
              blend: l.blendingMode, parent: l.parent ? l.parent.name : null };
    try { d.comment = l.comment || null; } catch (e1) { d.comment = null; }
    try { d.source = l.source ? l.source.name : null; } catch (e2) { d.source = null; }
    try { d.threeD = l.threeDLayer; } catch (e3) { d.threeD = null; }
    try { d.nullLayer = l.nullLayer; } catch (e4) { d.nullLayer = null; }
    try { d.adjustment = l.adjustmentLayer; } catch (e5) { d.adjustment = null; }
    try { d.effects = l.property("ADBE Effect Parade").numProperties; } catch (e6) { d.effects = null; }
    try { d.masks = l.property("ADBE Mask Parade").numProperties; } catch (e7) { d.masks = null; }
    try {
        var td = l.property("ADBE Text Properties").property("ADBE Text Document").value;
        d.text = (td && typeof td.text === "string") ? td.text : null;
    } catch (e8) { d.text = null; }
    return d;
}

function AEMCP_compBrief(c) {
    var d = { id: c.id, name: c.name, width: c.width, height: c.height,
              duration: c.duration, frameRate: c.frameRate, pixelAspect: c.pixelAspect,
              numLayers: c.numLayers, workArea: [c.workAreaStart, c.workAreaDuration] };
    try { d.index = c.index; } catch (e1) { d.index = null; }
    try { d.selected = c.selected; } catch (e2) { d.selected = null; }
    try { d.bg = c.bgColor; } catch (e3) { d.bg = null; }
    try { d.motionBlur = c.motionBlur; } catch (e4) { d.motionBlur = null; }
    try { d.folder = (c.parentFolder && c.parentFolder !== app.project.rootFolder) ? c.parentFolder.name : null; } catch (e5) { d.folder = null; }
    return d;
}

function AEMCP_params(fx) {
    var out = [], i, p, v;
    if (!fx || fx.numProperties === undefined) { return out; }
    for (i = 1; i <= fx.numProperties; i++) {
        p = fx.property(i);
        if (p.numProperties !== undefined && p.propertyValueType === undefined) { continue; }
        v = null;
        try { v = p.value; } catch (e1) { v = null; }
        var row = { index: i, name: p.name, value: (v instanceof Array) ? v : v };
        try { row.matchName = p.matchName; } catch (e2) { }
        out.push(row);
    }
    return out;
}

/* ============================================================ 7b. P0 扩展辅助函数
   给第 8b 节的新 op 用。全部 ES3，不依赖任何未验证的宿主 API：
   凡是「可能没有」的成员一律 try/catch 包住，失败就回 null 而不是让 AE 抛。 */

/* ---- 通用小件 ---- */
function AEMCP_keyNum(p) {
    try { return p.numKeys; } catch (e) { return null; }
}

function AEMCP_isGroup(node) {
    var g = false;
    try { g = (node.numProperties !== undefined && node.numProperties !== null); } catch (e) { g = false; }
    return g;
}

function AEMCP_layerRoots(l) {
    var names = ["ADBE Transform Group", "ADBE Anchor Point", "ADBE Position", "ADBE Scale",
                 "ADBE Rotate Z", "ADBE Opacity", "ADBE Effect Parade", "ADBE Mask Parade",
                 "ADBE Text Properties", "ADBE Root Vectors Group", "ADBE Audio Group",
                 "ADBE Camera Options Group", "ADBE Light Options Group",
                 "ADBE Material Options Group", "ADBE Geometry Options Group", "ADBE Time Remapping"];
    var out = [], i, p;
    for (i = 0; i < names.length; i++) {
        p = null;
        try { p = l.property(names[i]); } catch (e) { p = null; }
        if (p) { out.push(p); }
    }
    return out;
}

/* 统一「下一层」：Layer 走名单，属性组走下钻。返回空数组 = 这是叶子（可取值/可打关键帧）。 */
function AEMCP_children(node) {
    var out = [], i;
    if (!node) { return out; }
    if (node instanceof Layer) { return AEMCP_layerRoots(node); }
    if (AEMCP_isGroup(node)) {
        for (i = 1; i <= node.numProperties; i++) { out.push(node.property(i)); }
    }
    return out;
}

function AEMCP_interpName(v) {
    try {
        if (v === KeyframeInterpolationType.LINEAR) { return "linear"; }
        if (v === KeyframeInterpolationType.BEZIER) { return "bezier"; }
        if (v === KeyframeInterpolationType.HOLD) { return "hold"; }
    } catch (e) { }
    return (v === null || v === undefined) ? null : AEMCP_es(v);
}

function AEMCP_easeOut(arr) {
    var out = [], i, e;
    if (!arr) { return null; }
    for (i = 0; i < arr.length; i++) {
        e = arr[i];
        try { out.push([e.speed, e.influence]); } catch (x) { out.push(null); }
    }
    return out;
}

/* ---- 工程项寻址（item.* 那一组用；comp/layer 的寻址另有 AEMCP_comp / AEMCP_layer）---- */
function AEMCP_item(p, ref) {
    var i, it, s;
    if (ref === null || ref === undefined || ref === "" || String(ref) === "active") {
        it = p.activeItem;
        if (!it) { throw new Error("现在没有活动项：请显式给 item（名字或 @id:N）"); }
        return it;
    }
    s = String(ref);
    if (s.indexOf("@id:") === 0) {
        var want = parseInt(s.substring(4), 10), hit = null;
        for (i = 1; i <= p.numItems; i++) { if (p.item(i).id === want) { hit = p.item(i); break; } }
        if (!hit) { throw new Error("工程里没有 id=" + want + " 的项"); }
        return hit;
    }
    if (s.match(/^\d+$/)) {
        i = parseInt(s, 10);
        if (i >= 1 && i <= p.numItems) { return p.item(i); }
    }
    for (i = 1; i <= p.numItems; i++) { if (p.item(i).name === s) { return p.item(i); } }
    for (i = 1; i <= p.numItems; i++) {
        if (String(p.item(i).name).toLowerCase() === s.toLowerCase()) { return p.item(i); }
    }
    throw new Error("工程里没有这一项：" + s + "（可先 project.info 看清单）");
}

function AEMCP_missingOf(it) {
    var v = null;
    try { v = it.footageMissing; } catch (e) { v = null; }
    return v;
}

/* ---- 效果寻址 ---- */
function AEMCP_effectFind(l, ref) {
    var g = l.property("ADBE Effect Parade"), i, want = String(ref);
    if (want.match(/^\d+$/)) {
        i = parseInt(want, 10);
        if (i < 1 || i > g.numProperties) { throw new Error("效果下标越界：这个图层有 " + g.numProperties + " 个效果"); }
        return g.property(i);
    }
    for (i = 1; i <= g.numProperties; i++) { if (g.property(i).name === want) { return g.property(i); } }
    for (i = 1; i <= g.numProperties; i++) { if (g.property(i).matchName === want) { return g.property(i); } }
    throw new Error("这个图层没有效果：" + want + "（可先 effect.list 看清单）");
}

/* ---- 蒙版 ---- */
function AEMCP_maskParade(l) {
    var g = null;
    try { g = l.property("ADBE Mask Parade"); } catch (e) { g = null; }
    if (!g) { throw new Error("这个图层没有蒙版通道（只有 AVLayer 能加蒙版）"); }
    return g;
}

function AEMCP_maskNames() {
    return [["none", MaskMode.NONE], ["add", MaskMode.ADD], ["subtract", MaskMode.SUBTRACT],
            ["intersect", MaskMode.INTERSECT], ["lighten", MaskMode.LIGHTEN],
            ["darken", MaskMode.DARKEN], ["difference", MaskMode.DIFFERENCE]];
}

function AEMCP_maskModeName(v) {
    var t = AEMCP_maskNames(), i;
    for (i = 0; i < t.length; i++) { if (t[i][1] === v) { return t[i][0]; } }
    return (v === null || v === undefined) ? null : "mode#" + AEMCP_es(v);
}

function AEMCP_maskModeSet(m, v) {
    var t = AEMCP_maskNames(), i;
    if (typeof v === "string") {
        var s = v.toLowerCase();
        for (i = 0; i < t.length; i++) { if (t[i][0] === s) { m.maskMode = t[i][1]; return t[i][0]; } }
        throw new Error("mode 只认 none / add / subtract / intersect / lighten / darken / difference");
    }
    m.maskMode = v;
    return AEMCP_maskModeName(m.maskMode);
}

function AEMCP_maskBoolSet(m, key, v) {
    if (v === null || v === undefined) { return null; }
    var b = AEMCP_bool(v, false);
    if (key === "inverted") { m.inverted = b; return m.inverted; }
    return null;
}

function AEMCP_maskPropSet(m, matchName, v, kind) {
    if (v === null || v === undefined) { return null; }
    var p = null;
    try { p = m.property(matchName); } catch (e) { p = null; }
    if (!p) { return "n/a"; }
    if (kind === "pair") { p.setValue(AEMCP_pair(v, [0, 0])); }
    else { p.setValue(AEMCP_num(v, 0)); }
    return AEMCP_val(p);
}

function AEMCP_mask(l, ref) {
    var g = AEMCP_maskParade(l), n = g.numProperties, i, s;
    if (ref === null || ref === undefined || ref === "" || String(ref) === "last") {
        if (n < 1) { throw new Error("这个图层还没有蒙版：先 mask.add"); }
        return g.property(n);
    }
    s = String(ref);
    if (s.match(/^\d+$/)) {
        i = parseInt(s, 10);
        if (i < 1 || i > n) { throw new Error("蒙版下标越界：这个图层共 " + n + " 个蒙版"); }
        return g.property(i);
    }
    for (i = 1; i <= n; i++) { if (g.property(i).name === s) { return g.property(i); } }
    for (i = 1; i <= n; i++) {
        if (String(g.property(i).name).toLowerCase() === s.toLowerCase()) { return g.property(i); }
    }
    throw new Error("没有这个蒙版：" + s + "（可先 mask.list 看清单）");
}

function AEMCP_maskBrief(m, idx) {
    var d = { index: idx, name: m.name };
    try { d.enabled = m.enabled; } catch (e0) { }
    try { d.mode = AEMCP_maskModeName(m.maskMode); } catch (e1) { d.mode = null; }
    try { d.inverted = m.inverted; } catch (e2) { }
    try { d.locked = m.locked; } catch (e3) { }
    try { d.rotoBezier = m.rotoBezier; } catch (e4) { }
    try { d.featherFalloff = m.maskFeatherFalloff; } catch (e5) { }
    var names = ["ADBE Mask Shape", "ADBE Mask Feather", "ADBE Mask Opacity", "ADBE Mask Expansion"];
    var keys = ["path", "feather", "opacity", "expansion"], i, p, o, kn;
    d.props = {};
    for (i = 0; i < names.length; i++) {
        p = null;
        try { p = m.property(names[i]); } catch (e6) { p = null; }
        if (!p) { d.props[keys[i]] = "n/a"; continue; }
        kn = AEMCP_keyNum(p);
        if (keys[i] === "path") {
            o = null;
            try { o = AEMCP_shapeToObj(p.value); } catch (e7) { o = null; }
            d.props.path = { vertices: o ? o.vertices.length : null, closed: o ? o.closed : null,
                             numKeys: kn, animated: (kn !== null && kn > 0) };
        } else {
            d.props[keys[i]] = { value: AEMCP_val(p), numKeys: kn };
        }
    }
    return d;
}

/* ---- 路径 / 形状 ---- */
function AEMCP_shapePreset(kind, cx, cy, w, h) {
    var k = String(kind).toLowerCase();
    if (k === "rect") {
        var hw = w / 2, hh = h / 2;
        return { closed: true,
                 vertices: [[cx - hw, cy - hh], [cx + hw, cy - hh], [cx + hw, cy + hh], [cx - hw, cy + hh]],
                 inTangents: [[0, 0], [0, 0], [0, 0], [0, 0]],
                 outTangents: [[0, 0], [0, 0], [0, 0], [0, 0]] };
    }
    if (k === "ellipse") {
        var rx = w / 2, ry = h / 2, c = 0.5522847498307936, tx = rx * c, ty = ry * c;
        return { closed: true,
                 vertices: [[cx + rx, cy], [cx, cy + ry], [cx - rx, cy], [cx, cy - ry]],
                 inTangents: [[0, -ty], [tx, 0], [0, ty], [-tx, 0]],
                 outTangents: [[0, ty], [-tx, 0], [0, -ty], [tx, 0]] };
    }
    throw new Error("shape 预设只认 rect / ellipse");
}

/* 认识四种写法：\"rect\" / \"ellipse\" / [[x,y],...] / {preset,center,size} / {vertices,inTangents,outTangents,closed} */
function AEMCP_shapeSpec(spec, defW, defH) {
    if (spec === null || spec === undefined) { throw new Error("缺 shape"); }
    if (typeof spec === "string") { return AEMCP_shapePreset(spec, defW / 2, defH / 2, defW, defH); }
    if (spec instanceof Array) {
        return { closed: true, vertices: spec, inTangents: [], outTangents: [] };
    }
    if (spec.preset) {
        var ctr = (spec.center instanceof Array) ? spec.center : [defW / 2, defH / 2];
        var sz = (spec.size instanceof Array) ? spec.size : [defW, defH];
        return AEMCP_shapePreset(spec.preset, AEMCP_num(ctr[0], defW / 2), AEMCP_num(ctr[1], defH / 2),
                                 AEMCP_num(sz[0], defW), AEMCP_num(sz[1], defH));
    }
    if (spec.vertices || spec.points) {
        return { closed: (spec.closed === undefined) ? true : AEMCP_bool(spec.closed, true),
                 vertices: spec.vertices || spec.points,
                 inTangents: spec.inTangents || [], outTangents: spec.outTangents || [] };
    }
    throw new Error("shape 写法：\"rect\" / \"ellipse\" / [[x,y],...] / {preset,center,size} / {vertices,...}");
}

function AEMCP_shapeMake(spec, defW, defH) {
    var o = AEMCP_shapeSpec(spec, defW, defH), sh = new Shape(), i, n = o.vertices.length;
    var vs = [], ins = [], outs = [], p, q, r;
    for (i = 0; i < n; i++) {
        p = o.vertices[i];
        vs.push([AEMCP_num(p[0], 0), AEMCP_num(p[1], 0)]);
        q = o.inTangents[i]; r = o.outTangents[i];
        ins.push(q ? [AEMCP_num(q[0], 0), AEMCP_num(q[1], 0)] : [0, 0]);
        outs.push(r ? [AEMCP_num(r[0], 0), AEMCP_num(r[1], 0)] : [0, 0]);
    }
    sh.vertices = vs;
    sh.inTangents = ins;
    sh.outTangents = outs;
    sh.closed = !!o.closed;
    return sh;
}

function AEMCP_shapeToObj(sh) {
    var d = { closed: false, vertices: [], inTangents: [], outTangents: [] }, i, n = 0, p;
    try { d.closed = !!sh.closed; } catch (e0) { }
    try { n = sh.vertices.length; } catch (e1) { n = 0; }
    for (i = 0; i < n; i++) {
        p = sh.vertices[i];
        d.vertices.push([AEMCP_num(p[0], 0), AEMCP_num(p[1], 0)]);
        p = null;
        try { p = sh.inTangents[i]; } catch (e2) { p = null; }
        d.inTangents.push(p ? [AEMCP_num(p[0], 0), AEMCP_num(p[1], 0)] : [0, 0]);
        p = null;
        try { p = sh.outTangents[i]; } catch (e3) { p = null; }
        d.outTangents.push(p ? [AEMCP_num(p[0], 0), AEMCP_num(p[1], 0)] : [0, 0]);
    }
    return d;
}

function AEMCP_maskKeyList(p, which) {
    var n = AEMCP_keyNum(p), out = [], i, d, o;
    if (n === null) { return out; }
    for (i = 1; i <= n; i++) {
        d = { i: i, t: p.keyTime(i) };
        if (which === "path") {
            o = null;
            try { o = AEMCP_shapeToObj(p.keyValue(i)); } catch (e) { o = null; }
            d.vertices = o ? o.vertices.length : null;
            d.shape = o;
        } else {
            d.v = null;
            try { d.v = p.keyValue(i); } catch (e2) { }
        }
        out.push(d);
    }
    return out;
}

/* ---- 标记 ---- */
function AEMCP_markerProp(c, lyrRef) {
    var p = null;
    if (lyrRef === null || lyrRef === undefined || lyrRef === "") { return c.markerProperty; }
    var l = AEMCP_layer(c, lyrRef);
    try { p = l.property("ADBE Marker"); } catch (e0) { p = null; }
    if (!p) { try { p = l.property("Marker"); } catch (e1) { p = null; } }
    if (!p) { throw new Error("这个图层没有标记属性：先别给 layer，用合成标记（comp.markerProperty）"); }
    return p;
}

function AEMCP_markerApply(mv, a) {
    var strs = ["comment", "chapter", "url", "frameTarget", "cuePointName"], i, v;
    for (i = 0; i < strs.length; i++) {
        v = AEMCP_get(a, strs[i], null);
        if (v !== null) { try { mv[strs[i]] = String(v); } catch (e) { } }
    }
    v = AEMCP_get(a, "duration", null);
    if (v !== null) { try { mv.duration = AEMCP_num(v, 0); } catch (e2) { } }
    v = AEMCP_get(a, "label", null);
    if (v !== null) { try { mv.label = Math.round(AEMCP_num(v, 0)); } catch (e3) { } }
    v = AEMCP_get(a, "protectedRegion", null);
    if (v !== null) { try { mv.protectedRegion = AEMCP_bool(v, false); } catch (e4) { } }
    v = AEMCP_get(a, "eventCuePoint", null);
    if (v !== null) { try { mv.eventCuePoint = AEMCP_bool(v, false); } catch (e5) { } }
    return mv;
}

function AEMCP_markerBrief(mv, idx, t) {
    var d = { index: idx, time: t };
    var f = ["comment", "chapter", "url", "frameTarget", "cuePointName", "duration",
             "label", "protectedRegion", "eventCuePoint"];
    var i;
    for (i = 0; i < f.length; i++) {
        d[f[i]] = null;
        try { d[f[i]] = mv[f[i]]; } catch (e) { }
    }
    return d;
}

function AEMCP_markerIndexAt(mp, t) {
    var n = AEMCP_keyNum(mp), i;
    if (n === null) { return null; }
    for (i = 1; i <= n; i++) { if (Math.abs(mp.keyTime(i) - t) < 0.0005) { return i; } }
    return null;
}

/* dir: nearest / next / prev（找不到就回 null，由调用方决定怎么说） */
function AEMCP_markerFind(mp, t, dir) {
    var n = AEMCP_keyNum(mp), i, tt, best = null, bt = 0;
    if (n === null || n < 1) { return null; }
    if (dir === "next") {
        for (i = 1; i <= n; i++) { tt = mp.keyTime(i); if (tt >= t - 0.0005 && (best === null || tt < bt)) { best = i; bt = tt; } }
        if (best === null) { for (i = 1; i <= n; i++) { tt = mp.keyTime(i); if (best === null || tt < bt) { best = i; bt = tt; } } }
    } else if (dir === "prev") {
        for (i = 1; i <= n; i++) { tt = mp.keyTime(i); if (tt <= t + 0.0005 && (best === null || tt > bt)) { best = i; bt = tt; } }
        if (best === null) { for (i = 1; i <= n; i++) { tt = mp.keyTime(i); if (best === null || tt > bt) { best = i; bt = tt; } } }
    } else {
        for (i = 1; i <= n; i++) { tt = mp.keyTime(i); if (best === null || Math.abs(tt - t) < Math.abs(bt - t)) { best = i; bt = tt; } }
    }
    return AEMCP_markerBrief(mp.keyValue(best), best, bt);
}

/* ---- 关键帧批量读写 ---- */
function AEMCP_keyList(p) {
    var n = AEMCP_keyNum(p), out = [], i, d;
    if (n === null) { return out; }
    for (i = 1; i <= n; i++) {
        d = { i: i, t: p.keyTime(i) };
        try { d.v = p.keyValue(i); } catch (e0) { d.v = null; }
        try { d.inInterp = AEMCP_interpName(p.keyInInterpolationType(i)); } catch (e1) { }
        try { d.outInterp = AEMCP_interpName(p.keyOutInterpolationType(i)); } catch (e2) { }
        try { d.inEase = AEMCP_easeOut(p.keyInTemporalEase(i)); } catch (e3) { }
        try { d.outEase = AEMCP_easeOut(p.keyOutTemporalEase(i)); } catch (e4) { }
        out.push(d);
    }
    return out;
}

/* 读成「可回写的原始态」：值、插值枚举、缓动对象都保持宿主对象，便于原样写回 */
function AEMCP_keysRead(p) {
    var n = AEMCP_keyNum(p), out = [], i, d;
    if (n === null) { return out; }
    for (i = 1; i <= n; i++) {
        d = { t: p.keyTime(i), v: null, inT: null, outT: null, inE: null, outE: null };
        try { d.v = p.keyValue(i); } catch (e0) { }
        try { d.inT = p.keyInInterpolationType(i); } catch (e1) { }
        try { d.outT = p.keyOutInterpolationType(i); } catch (e2) { }
        try { d.inE = p.keyInTemporalEase(i); } catch (e3) { }
        try { d.outE = p.keyOutTemporalEase(i); } catch (e4) { }
        out.push(d);
    }
    return out;
}

/* 先清空再按给定时序重写；插值/缓动在原位回填（键下标 = 重写后的名次） */
function AEMCP_keysWrite(p, list) {
    var i, n = list.length, d, k;
    k = AEMCP_keyNum(p);
    if (k !== null) { for (i = k; i >= 1; i--) { p.removeKey(i); } }
    for (i = 0; i < n; i++) { p.setValueAtTime(list[i].t, list[i].v); }
    for (i = 0; i < n; i++) {
        d = list[i];
        if (d.inT !== null && d.outT !== null) {
            try { p.setInterpolationTypeAtKey(i + 1, d.inT, d.outT); } catch (e1) { }
        }
        if (d.inE !== null && d.outE !== null) {
            try { p.setTemporalEaseAtKey(i + 1, d.inE, d.outE); } catch (e2) { }
        }
    }
    return n;
}

/* ---- 表达式扫描（只读；会真的求值一次，所以能抓到运行期错误）---- */
function AEMCP_exprScan(node, bad, compName, layerName) {
    var ok = 0, scanned = 0, kids = AEMCP_children(node), i, q, ex, err;
    if (kids.length) {
        for (i = 0; i < kids.length; i++) {
            q = AEMCP_exprScan(kids[i], bad, compName, layerName);
            ok += q.ok; scanned += q.scanned;
        }
        return { ok: ok, scanned: scanned };
    }
    try {
        ex = node.expression;
        if (ex) {
            scanned = 1;
            try { var vv = node.value; } catch (e1) { }
            err = null;
            try { err = node.expressionError; } catch (e2) { err = null; }
            if (err && String(err).length) {
                bad.push({ comp: compName, layer: layerName, property: node.name, matchName: node.matchName,
                           error: String(err), expression: String(ex).substring(0, 120) });
            } else { ok = 1; }
        }
    } catch (e3) { }
    return { ok: ok, scanned: scanned };
}

function AEMCP_keyCount(node) {
    var n = 0, kids = AEMCP_children(node), i, k;
    if (kids.length) {
        for (i = 0; i < kids.length; i++) { n += AEMCP_keyCount(kids[i]); }
        return n;
    }
    k = AEMCP_keyNum(node);
    return (k === null || k === undefined) ? 0 : k;
}

/* ---- 属性树 dump ---- */
function AEMCP_propTree(node, maxDepth, depth) {
    var d = { name: null, matchName: null, kind: "group", count: 0, children: [] };
    try { d.name = node.name; } catch (e0) { }
    try { d.matchName = node.matchName; } catch (e1) { }
    var kids = AEMCP_children(node), i, v;
    if (kids.length) {
        d.count = kids.length;
        if (depth < maxDepth) {
            for (i = 0; i < kids.length; i++) { d.children.push(AEMCP_propTree(kids[i], maxDepth, depth + 1)); }
        }
        return d;
    }
    d.kind = "value";
    try { d.valueType = AEMCP_es(node.propertyValueType); } catch (e2) { }
    v = AEMCP_val(node);
    if (v instanceof Array) { d.value = v; }
    else if (v !== null && typeof v === "object") {
        d.value = "<" + (function () { try { return v.constructor ? v.constructor.name : "obj"; } catch (e) { return "obj"; } })() + ">";
    } else { d.value = v; }
    d.numKeys = AEMCP_keyNum(node);
    try { d.expression = node.expression ? String(node.expression).substring(0, 120) : null; } catch (e3) { }
    try { d.animated = node.isTimeVarying; } catch (e4) { }
    return d;
}

/* ---- 表达式控件白名单（effect.add 的 control 参数用）---- */
function AEMCP_controlMap() {
    return { "slider": "ADBE Slider Control",
             "angle": "ADBE Angle Control",
             "color": "ADBE Color Control",
             "checkbox": "ADBE Checkbox Control",
             "point": "ADBE Point Control",
             "point3d": "ADBE Point3D Control",
             "3dpoint": "ADBE Point3D Control",
             "layer": "ADBE Layer Control",
             "dropdown": "ADBE Dropdown Control" };
}

function AEMCP_firstParam(fx) {
    var i, p;
    if (!fx || fx.numProperties === undefined) { return null; }
    for (i = 1; i <= fx.numProperties; i++) {
        p = fx.property(i);
        if (p.propertyValueType !== undefined && p.numProperties === undefined) { return p; }
    }
    return null;
}

/* ---- 表达式模板库（都给过真机验证的写法；参数用 {名字} 占位）---- */
function AEMCP_exprTemplates() {
    return {
        "wiggle": { text: "wiggle({freq}, {amp})", defs: { freq: 2, amp: 30 } },
        "seedWiggle": { text: "seedRandom({seed}, true); wiggle({freq}, {amp})", defs: { seed: 1, freq: 2, amp: 30 } },
        "smooth": { text: "smooth({freq}, {amp})", defs: { freq: 5, amp: 20 } },
        "loopOut": { text: "loopOut(\"{mode}\")", defs: { mode: "cycle" } },
        "loopIn": { text: "loopIn(\"{mode}\")", defs: { mode: "cycle" } },
        "posterizeTime": { text: "posterizeTime({fps}); value", defs: { fps: 12 } },
        "timeDelay": { text: "valueAtTime(time - {delay})", defs: { delay: 0.2 } },
        "randomHold": { text: "seedRandom({seed}, true); random({min}, {max})", defs: { seed: 1, min: 0, max: 100 } },
        "bounce1D": { text: "var landed = key(numKeys).time;\nif (time < landed) { value; } else {\n  var t = time - landed;\n  value - Math.abs(Math.cos(t * {freq})) * Math.exp(-{damp} * t) * {amp};\n}",
                      defs: { freq: 12, damp: 6, amp: 15 } },
        "bouncePos": { text: "var landed = key(numKeys).time;\nif (time < landed) { value; } else {\n  var t = time - landed;\n  value + [0, -Math.abs(Math.cos(t * {freq})) * Math.exp(-{damp} * t) * {amp}];\n}",
                       defs: { freq: 12, damp: 6, amp: 60 } },
        "springy": { text: "var landed = key(numKeys).time;\nif (time < landed) { value; } else {\n  var t = time - landed;\n  var d = key(numKeys).value - key(numKeys - 1).value;\n  value + d * {over} * Math.exp(-{damp} * t) * Math.sin(t * {freq});\n}",
                     defs: { over: 0.35, damp: 6, freq: 12 } }
    };
}

function AEMCP_exprFromTemplate(name, args) {
    var T = AEMCP_exprTemplates();
    if (!T[name]) {
        var ks = [], k;
        for (k in T) { if (T.hasOwnProperty(k)) { ks.push(k); } }
        throw new Error("没有这个模板：" + name + "（可用：" + ks.join(" / ") + "）");
    }
    var t = T[name], text = t.text, key, v, guard;
    for (key in t.defs) {
        if (!t.defs.hasOwnProperty(key)) { continue; }
        v = (args && args[key] !== undefined && args[key] !== null) ? args[key] : t.defs[key];
        guard = 0;
        while (text.indexOf("{" + key + "}") >= 0 && guard++ < 20) {
            text = text.replace("{" + key + "}", String(v));
        }
    }
    return text;
}

/* 把一个属性对象拍成能写进表达式的跨层引用串（走 parentProperty 往上爬） */
function AEMCP_exprRef(layerName, prop) {
    var chain = [], cur = prop, guard = 0, up;
    while (cur && guard++ < 8) {
        try { up = cur.parentProperty; } catch (e) { break; }
        if (!up) { break; }
        try { chain.unshift(cur.matchName); } catch (e2) { break; }
        if (up instanceof Layer) { break; }
        cur = up;
    }
    var s = 'thisComp.layer("' + String(layerName).replace(/"/g, '\\"') + '")';
    for (var i = 0; i < chain.length; i++) { s += '.property("' + chain[i] + '")'; }
    return s;
}

/* ---------------------------------------------------------- 8.2.5 P1 访问器 */
function AEMCP_footage(it) {
    if (!(it instanceof FootageItem)) {
        throw new Error("这不是素材项（FootageItem），是 " + (it ? it.typeName : "空") + "；替换/代理/解释只对素材有效");
    }
    return it;
}

function AEMCP_folder(name) {
    var p = app.project, i, it;
    for (i = 1; i <= p.numItems; i++) {
        it = p.item(i);
        if (it instanceof FolderItem && it.name === String(name)) { return it; }
    }
    return p.items.addFolder(String(name));
}

function AEMCP_matGroup(l) {
    if (!l) { throw new Error("缺 layer"); }
    var g = null;
    try { g = l.property("ADBE Material Options Group"); } catch (e) { g = null; }
    if (!g) {
        try { l.threeDLayer = true; g = l.property("ADBE Material Options Group"); } catch (e2) { g = null; }
    }
    if (!g) { throw new Error("这个图层没有材质选项（只有 3D 图层有材质，且已尝试开启 3D 仍失败）"); }
    return g;
}

function AEMCP_camGroup(l) {
    var g = null;
    try { g = l.property("ADBE Camera Options Group"); } catch (e) { g = null; }
    if (!g) { throw new Error("这个图层不是摄像机（没有 ADBE Camera Options Group）"); }
    return g;
}

function AEMCP_lightGroup(l) {
    var g = null;
    try { g = l.property("ADBE Light Options Group"); } catch (e) { g = null; }
    if (!g) { throw new Error("这个图层不是灯光（没有 ADBE Light Options Group）"); }
    return g;
}

/* 三态枚举（Casts/Accepts Shadows）：off/0=false, on/1=true, only/2="only" */
function AEMCP_tri(v, def) {
    if (v === true || v === 1 || v === "1" || String(v).toLowerCase() === "on") { return 1; }
    if (v === "only" || v === 2 || v === "2") { return 2; }
    if (v === false || v === 0 || v === "0" || String(v).toLowerCase() === "off") { return 0; }
    return def;
}

/* 有参才设：kind = num / color / tri / num2(2D) */
function AEMCP_setNamed(group, matchName, a, key, kind) {
    if (a[key] === undefined || a[key] === null) { return false; }
    var p = group.property(matchName);
    if (!p) { throw new Error("属性不存在：" + matchName); }
    var v = a[key];
    if (kind === "num") { p.setValue(AEMCP_num(v, AEMCP_val(p))); }
    else if (kind === "color") { var c = AEMCP_color(v, [1, 1, 1]); p.setValue([c[0], c[1], c[2], 1]); }
    else if (kind === "tri") { p.setValue(AEMCP_tri(v, AEMCP_val(p))); }
    else if (kind === "num2") { var pr = AEMCP_pair(v, [0, 0]); p.setValue(pr); }
    else { p.setValue(v); }
    return true;
}

/* 形状算子：种类 → matchName */
function AEMCP_shapeOpMatch(op) {
    var m = {
        repeater: "ADBE Vector Filter - Repeater",
        trim: "ADBE Vector Filter - Trim",
        offset: "ADBE Vector Filter - Offset",
        merge: "ADBE Vector Filter - Merge",
        roundCorners: "ADBE Vector Filter - RC",
        puckerBloat: "ADBE Vector Filter - PB",
        twist: "ADBE Vector Filter - Twist"
    };
    return m[String(op).toLowerCase()] || null;
}

/* 形状算子：友好参数名 → 该算子的参数 matchName（ADBE 开头则直传） */
function AEMCP_shapeOpParam(kind, key) {
    var k = String(key);
    if (k.indexOf("ADBE ") === 0) { return k; }
    var R = "ADBE Vector Repeater ", T = "ADBE Vector Trim ", O = "ADBE Vector Offset ",
        M = "ADBE Vector Merge ", RC = "ADBE Vector RoundCorner ", PB = "ADBE Vector PuckerBloat ",
        TW = "ADBE Vector Twist ";
    var m = {
        repeater: { copies: R + "Copies", offset: R + "Offset", order: R + "Order", composite: R + "Order" },
        trim: { start: T + "Start", end: T + "End", offset: T + "Offset", type: T + "Type", multiple: T + "Type" },
        offset: { amount: O + "Amount", lineJoin: O + "Line Join", miterLimit: O + "Miter Limit", copies: O + "Copies", copyOffset: O + "Copy Offset" },
        merge: { mode: M + "Type" },
        roundCorners: { radius: RC + "Radius" },
        puckerBloat: { amount: PB + "Amount" },
        twist: { angle: TW + "Angle", center: TW + "Center" }
    };
    var t = m[String(kind).toLowerCase()];
    if (!t) { return null; }
    return t[k] || null;
}

function AEMCP_shapeOpApply(opGroup, kind, params) {
    var applied = [], key, mn, p, v, vv;
    if (!params || typeof params !== "object") { return applied; }
    var MM = { add: 1, subtract: 2, intersect: 3, exclude: 4, merge: 5 };
    for (key in params) {
        if (!params.hasOwnProperty(key)) { continue; }
        if (key === "matchName" || key === "name" || key === "group" || key === "layer" ||
            key === "comp" || key === "index" || key === "operator" || key === "kind") { continue; }
        v = params[key];
        if (v === undefined || v === null) { continue; }
        mn = AEMCP_shapeOpParam(kind, key);
        if (!mn) { applied.push({ key: key, error: "未知参数（不适用于算子 " + kind + "）" }); continue; }
        p = opGroup.property(mn);
        if (!p) { applied.push({ key: key, error: "算子没有这个属性：" + mn }); continue; }
        vv = v;
        if (String(kind).toLowerCase() === "merge" && key === "mode" && typeof v === "string") {
            vv = (MM[String(v).toLowerCase()] !== undefined) ? MM[String(v).toLowerCase()] : v;
        }
        AEMCP_setProp(p, vv);
        applied.push({ key: key, matchName: mn, value: AEMCP_val(p) });
    }
    return applied;
}

function AEMCP_rqStatusName(v) {
    var n = { "3012": "WILL_CONTINUE", "3013": "NEEDS_OUTPUT", "3014": "UNQUEUED",
              "3015": "QUEUED", "3016": "RENDERING", "3017": "USER_STOPPED",
              "3018": "ERR_STOPPED", "3019": "DONE" };
    return n[String(v)] || ("UNKNOWN(" + v + ")");
}

/* 形状层的内容组（默认根，可指定组名） */
function AEMCP_vectorGroup(l, groupName) {
    var root = null;
    try { root = l.property("ADBE Root Vectors Group"); } catch (e) { root = null; }
    if (!root) { throw new Error("这个图层不是形状层（没有 ADBE Root Vectors Group）"); }
    if (groupName === null || groupName === undefined || groupName === "") { return root; }
    var i, g;
    for (i = 1; i <= root.numProperties; i++) {
        g = root.property(i);
        if (g.matchName === "ADBE Vector Group" && String(g.name) === String(groupName)) { return g; }
    }
    throw new Error("形状层里没有这个组：" + groupName);
}

function AEMCP_shapePath(group, ref) {
    var i, p, hits = [];
    for (i = 1; i <= group.numProperties; i++) {
        p = group.property(i);
        if (p.matchName === "ADBE Vector Shape - Group") { hits.push(p); }
    }
    if (!hits.length) { throw new Error("这个组里没有路径（先 ae_path_create 建一个）"); }
    if (ref === null || ref === undefined || ref === "" || ref === 1 || ref === "1") { return hits[0]; }
    if (String(ref).match(/^\d+$/)) {
        var n = parseInt(ref, 10);
        if (n < 1 || n > hits.length) { throw new Error("路径下标越界：" + ref + "（共 " + hits.length + " 条）"); }
        return hits[n - 1];
    }
    for (i = 0; i < hits.length; i++) { if (hits[i].name === String(ref)) { return hits[i]; } }
    throw new Error("找不到路径：" + ref);
}

function AEMCP_shapeOperator(group, opMatchName, ref) {
    var i, p, hits = [];
    for (i = 1; i <= group.numProperties; i++) {
        p = group.property(i);
        if (p.matchName === opMatchName) { hits.push(p); }
    }
    if (!hits.length) { throw new Error("没有这个算子：" + opMatchName + "（先 ae_shape_operator_add 加一个）"); }
    if (ref === null || ref === undefined || ref === "" || ref === 1 || ref === "1") { return hits[0]; }
    if (String(ref).match(/^\d+$/)) {
        var n = parseInt(ref, 10);
        if (n < 1 || n > hits.length) { throw new Error("算子下标越界：" + ref); }
        return hits[n - 1];
    }
    for (i = 0; i < hits.length; i++) { if (hits[i].name === String(ref)) { return hits[i]; } }
    throw new Error("找不到算子：" + ref);
}

/* 文字动画器属性：友好名 → matchName（ADBE 开头则直传） */
function AEMCP_animPropMatch(key) {
    var k = String(key);
    if (k.indexOf("ADBE ") === 0) { return k; }
    var m = {
        position: "ADBE Text Position 3D", pos: "ADBE Text Position 3D",
        opacity: "ADBE Text Opacity", scale: "ADBE Text Scale 3D",
        rotation: "ADBE Text Rotation", fillColor: "ADBE Text Fill Color", fill: "ADBE Text Fill Color"
    };
    return m[k] || null;
}

/* ---------------------------------------------------------- 8.3 操作表 */
function AEMCP_major() {
    var v = parseFloat(String(app.version || "0"));
    return (v === v) ? Math.floor(v) : 0;
}

function AEMCP_coerce(cur, v) {
    if (typeof cur === "boolean") { return AEMCP_bool(v, cur); }
    if (typeof cur === "number") { return AEMCP_num(v, cur); }
    return v;
}

function AEMCP_setFields(obj, a, keys) {
    var out = { before: {}, after: {}, changed: [] }, i, k;
    for (i = 0; i < keys.length; i++) {
        k = keys[i];
        try { out.before[k] = obj[k]; } catch (e0) { out.before[k] = null; }
    }
    for (i = 0; i < keys.length; i++) {
        k = keys[i];
        if (a && a[k] !== undefined) {
            try { obj[k] = AEMCP_coerce(out.before[k], a[k]); } catch (e1) { throw new Error("写 " + k + " 失败：" + AEMCP_es(e1)); }
            out.changed.push(k);
        }
        try { out.after[k] = obj[k]; } catch (e2) { out.after[k] = null; }
    }
    return out;
}

/* ---- P3 模板辅助 ---- */
function AEMCP_tplComp(name, w, h, fps, dur) {
    return app.project.items.addComp(String(name), AEMCP_num(w, 1920), AEMCP_num(h, 1080), 1,
                                     AEMCP_num(dur, 3), AEMCP_num(fps, 30));
}
// 加文字层并设样式（不碰 td.text，避免卡死 18.0 引擎）
function AEMCP_tplText(comp, text, x, y, size, col) {
    var tl = comp.layers.addText(String(text));
    var tp = tl.property("ADBE Transform Group");
    tp.property("ADBE Position").setValue([AEMCP_num(x, 0), AEMCP_num(y, 0)]);
    var src = tl.property("Source Text");
    var td = src.value;
    td.fontSize = AEMCP_num(size, 60);
    td.fillColor = AEMCP_color(col, [1, 1, 1]);
    src.setValue(td);
    return tl;
}
// 双关键帧动画（t0→fromV, t1→toV）
function AEMCP_tplKey(prop, fromV, toV, t0, t1) {
    prop.setValueAtTime(AEMCP_num(t0, 0), fromV);
    prop.setValueAtTime(AEMCP_num(t1, 1), toV);
}
// 枚举取值：数字直通；字符串按 map[[name,value],...] 查，找不到抛错
function AEMCP_enumPick(v, map, field) {
    if (typeof v === "number") { return v; }
    var s = String(v).toLowerCase(), i;
    for (i = 0; i < map.length; i++) {
        if (String(map[i][0]).toLowerCase() === s) { return map[i][1]; }
    }
    var names = [], j;
    for (j = 0; j < map.length; j++) { names.push(map[j][0]); }
    throw new Error(field + " 的取值无效：可用 " + names.join(", ") + " 或枚举数值");
}

/* ---- v0.11：AE 26.5 参考线辅助 ---- */
function AEMCP_guideOwner(a) {
    var l = AEMCP_get(a, "layer", null);
    if (l !== null && l !== undefined && String(l) !== "") {
        return AEMCP_layer(AEMCP_comp(AEMCP_get(a, "comp", "active")), l);
    }
    return AEMCP_comp(AEMCP_get(a, "comp", "active"));
}
function AEMCP_guideBrief(g) {
    var o = { orientation: "horizontal", positionType: "pixel", position: 0, color: null, name: null };
    try {
        if (g.orientationType === GuideOrientationType.VERTICAL) { o.orientation = "vertical"; }
        else { o.orientation = "horizontal"; }
    } catch (e0) { }
    try {
        if (g.positionType === GuidePositionType.PERCENTAGE) { o.positionType = "percentage"; }
        else { o.positionType = "pixel"; }
    } catch (e1) { }
    try { o.position = AEMCP_num(g.position, 0); } catch (e2) { }
    try { if (g.color) { o.color = [g.color[0], g.color[1], g.color[2]]; } } catch (e3) { }
    try { if (g.name !== undefined && g.name !== null && g.name !== "") { o.name = String(g.name); } } catch (e4) { }
    return o;
}
function AEMCP_guideApply(go, a) {
    var ori = AEMCP_get(a, "orientation", null);
    if (ori !== null && ori !== undefined) {
        var ov = String(ori).toLowerCase();
        if (ov === "vertical" || ov === "v") { go.orientationType = GuideOrientationType.VERTICAL; }
        else { go.orientationType = GuideOrientationType.HORIZONTAL; }
    }
    var pt = AEMCP_get(a, "positionType", null);
    if (pt !== null && pt !== undefined) {
        var pv = String(pt).toLowerCase();
        if (pv === "percentage" || pv === "percent" || pv === "%") { go.positionType = GuidePositionType.PERCENTAGE; }
        else { go.positionType = GuidePositionType.PIXEL; }
    }
    var pos = AEMCP_get(a, "position", null);
    if (pos !== null && pos !== undefined) { go.position = AEMCP_num(pos, 0); }
    var col = AEMCP_get(a, "color", null);
    if (col) { var cl = AEMCP_color(col, [0.125, 0.878, 1]); go.color = [cl[0], cl[1], cl[2]]; }
    var nm = AEMCP_get(a, "name", null);
    if (nm !== null && nm !== undefined) { go.name = String(nm); }
    return go;
}
function AEMCP_guideOpts(a) {
    return AEMCP_guideApply(new GuideOptions(), a);
}
function AEMCP_requireGuides() {
    if (typeof GuideOptions === "undefined" || typeof GuideOrientationType === "undefined" || typeof GuidePositionType === "undefined") {
        throw new Error("参考线需要 AE 26.5+（当前 " + app.version + "）：Item.guides/addGuide/getGuideAsObject/setGuide/removeGuide 均为 26.5 新 API");
    }
}

function AEMCP_ops() {
    return {
        /* ---- 读 ---- */
        "status": function (a) {
            var p = app.project, act = p.activeItem;
            var d = { ae: app.version, build: app.buildName, es: $.version,
                      lang: app.isoLanguage, render: app.isRenderEngine,
                      project: { name: p.file ? p.file.name : "(未保存)",
                                 file: p.file ? p.file.fsName : null,
                                 numItems: p.numItems,
                                 itemCount: (function () { try { return p.numItems; } catch (e) { return null; } })() },
                      activeComp: (act instanceof CompItem) ? AEMCP_compBrief(act) : null };
            return d;
        },

        "cap": function (a) {
            var hasLayerById = (typeof app.project.layerByID === "function");
            var v = parseFloat(String(app.version || "0"));
            var major = (v === v) ? Math.floor(v) : 0;
            return { ae: app.version, build: app.buildName, major: major,
                     tier: hasLayerById ? "2022+" : "2021",
                     hasLayerId: hasLayerById, hasLayerById: hasLayerById,
                     note: hasLayerById
                         ? "原生图层 id 可用（Layer.id / app.project.layerByID）"
                         : "无原生图层 id（AE 2022+ 才有）；图层寻址用名字/下标/ae_layer_stamp 戳" };
        },

        "project.info": function (a) {
            var p = app.project, lim = AEMCP_num(AEMCP_get(a, "limit", 200), 200), out = [], i, it, row;
            for (i = 1; i <= p.numItems && out.length < lim; i++) {
                it = p.item(i);
                row = { index: i, id: it.id, name: it.name, type: it.typeName,
                        isComp: (it instanceof CompItem),
                        folder: (it.parentFolder && it.parentFolder !== p.rootFolder) ? it.parentFolder.name : null,
                        layers: (it instanceof CompItem) ? it.numLayers : null,
                        duration: (it instanceof CompItem) ? it.duration : null };
                /* AE 2021 里 AVItem 不是全局构造器（typeof AVItem === "undefined"），
                   只能拿它的两个具体子类判 —— 踩过：project.info 直接抛 ReferenceError。 */
                if (it instanceof CompItem || it instanceof FootageItem) {
                    try { row.width = it.width; row.height = it.height; } catch (e1) { }
                    try { row.pixelAspect = it.pixelAspect; } catch (e2) { }
                    try { row.frameRate = it.frameRate; } catch (e3) { }
                    try { row.missing = it.footageMissing; } catch (e4) { }
                    try { row.usedIn = it.usedIn ? it.usedIn.length : null; } catch (e5) { }
                }
                if (it instanceof FootageItem) {
                    try { row.file = it.file ? it.file.fsName : null; } catch (e6) { }
                    try { row.isSolid = (it.mainSource instanceof SolidSource); } catch (e7) { }
                    try { row.isPlaceholder = (it.mainSource instanceof PlaceholderSource); } catch (e8) { }
                }
                out.push(row);
            }
            return { file: p.file ? p.file.fsName : null, numItems: p.numItems, shown: out.length,
                     activeItem: p.activeItem ? { id: p.activeItem.id, name: p.activeItem.name } : null,
                     items: out };
        },

        "comp.list": function (a) {
            var p = app.project, out = [], i, it;
            for (i = 1; i <= p.numItems; i++) {
                it = p.item(i);
                if (it instanceof CompItem) { out.push(AEMCP_compBrief(it)); }
            }
            return { count: out.length, comps: out };
        },

        "comp.info": function (a) {
            var c = AEMCP_comp(AEMCP_get(a, "comp", "active"));
            var d = AEMCP_compBrief(c), layers = [], i;
            for (i = 1; i <= c.numLayers; i++) { layers.push(AEMCP_layerBrief(c.layer(i))); }
            d.layers = layers;
            return d;
        },

        "layer.info": function (a) {
            var c = AEMCP_comp(AEMCP_get(a, "comp", "active"));
            var l = AEMCP_layer(c, AEMCP_get(a, "layer", null));
            var d = AEMCP_layerBrief(l);
            d.comp = c.name;
            var names = ["position", "scale", "opacity", "rotation", "anchor", "orientation"];
            var props = {};
            for (var i = 0; i < names.length; i++) {
                try { props[names[i]] = AEMCP_val(AEMCP_prop(l, names[i])); }
                catch (e) { props[names[i]] = "n/a"; }
            }
            d.props = props;
            var fx = [], fxg = l.property("ADBE Effect Parade");
            if (fxg) { for (i = 1; i <= fxg.numProperties; i++) { fx.push({ index: i, name: fxg.property(i).name, matchName: fxg.property(i).matchName }); } }
            d.effectList = fx;
            /* 文本层：把文本文档的可见细节一起带出来，否则「字号到底设上没有」没法核对 */
            if (l instanceof TextLayer) {
                var td = null;
                try { td = l.property("ADBE Text Properties").property("ADBE Text Document").value; } catch (e2) { td = null; }
                if (td) {
                    var jw = ["left", "center", "right", "full", "unknown"];
                    d.textDoc = {
                        text: (function () { try { var t = String(td.text); return t.length > 200 ? t.substring(0, 200) : t; } catch (e3) { return null; } })(),
                        fontSize: (function () { try { return td.fontSize; } catch (e4) { return null; } })(),
                        font: (function () { try { return td.font; } catch (e5) { return null; } })(),
                        justification: (function () { try { return jw[td.justification] || td.justification; } catch (e6) { return null; } })(),
                        fillColor: (function () { try { return td.fillColor; } catch (e7) { return null; } })(),
                        applyFill: (function () { try { return td.applyFill; } catch (e8) { return null; } })()
                    };
                }
            }
            return d;
        },

        "effect.list": function (a) {
            var c = AEMCP_comp(AEMCP_get(a, "comp", "active"));
            var l = AEMCP_layer(c, AEMCP_get(a, "layer", null));
            var fxg = l.property("ADBE Effect Parade"), out = [], i, p;
            for (i = 1; i <= fxg.numProperties; i++) {
                p = fxg.property(i);
                out.push({ index: i, name: p.name, matchName: p.matchName,
                           enabled: (function (q) { try { return q.enabled; } catch (e) { return null; } })(p),
                           params: AEMCP_params(p) });
            }
            return { layer: l.name, count: out.length, effects: out };
        },

        "property.get": function (a) {
            var c = AEMCP_comp(AEMCP_get(a, "comp", "active"));
            var l = AEMCP_layer(c, AEMCP_get(a, "layer", null));
            var p = AEMCP_prop(l, AEMCP_get(a, "property", "position"));
            var d = { layer: l.name, property: AEMCP_get(a, "property", "position"), value: AEMCP_val(p) };
            try { d.matchName = p.matchName; } catch (e1) { }
            try { d.numKeys = p.numKeys; } catch (e2) { }
            try { d.expression = (p.expression ? String(p.expression) : null); } catch (e3) { }
            try { d.expressionEnabled = p.expressionEnabled; } catch (e4) { }
            try { d.expressionError = p.expressionError ? String(p.expressionError) : null; } catch (e5) { d.expressionError = null; }
            try { d.animated = p.isTimeVarying; } catch (e6) { }
            /* AE 26.0+：propertyParameters / valueText 是「下拉菜单」属性，无下拉的属性会抛错，逐项 try/catch */
            try { d.propertyParameters = p.propertyParameters; } catch (e7) { d.propertyParameters = null; }
            try { d.valueText = (p.valueText === undefined || p.valueText === null) ? null : String(p.valueText); } catch (e8) { d.valueText = null; }
            return d;
        },

        /* ---- 写：工程结构 ---- */
        "comp.create": function (a) {
            var name = String(AEMCP_get(a, "name", "AEMCP Comp"));
            var w = AEMCP_num(AEMCP_get(a, "width", 1920), 1920);
            var h = AEMCP_num(AEMCP_get(a, "height", 1080), 1080);
            var dur = AEMCP_num(AEMCP_get(a, "duration", 5), 5);
            var fps = AEMCP_num(AEMCP_get(a, "frameRate", 25), 25);
            var pa = AEMCP_num(AEMCP_get(a, "pixelAspect", 1), 1);
            var c = app.project.items.addComp(name, w, h, pa, dur, fps);
            var bg = AEMCP_get(a, "bg", null);
            if (bg) {
                var col = AEMCP_color(bg, [0, 0, 0]);
                c.bgColor = [col[0], col[1], col[2]];
            }
            var mb = AEMCP_get(a, "motionBlur", null);
            if (mb !== null) { c.motionBlur = AEMCP_bool(mb, false); }
            /* 建完顺手在查看器里打开（和 AE 自己「新建合成」一致）：
               openInViewer() 会让这个合成成为 app.project.activeItem，
               于是紧跟着的 ae_layer_* 不写 comp 也能落在它上面。
               注意：app.project.activeItem 本身是只读的，只能靠 openInViewer 间接设。
               open:false 可以关掉这个行为（批量建合成时不想抢查看器）。 */
            var d = AEMCP_compBrief(c);
            if (AEMCP_bool(AEMCP_get(a, "open", true), true)) {
                try { c.openInViewer(); d.opened = true; }
                catch (eOpen) { d.opened = false; }
            } else { d.opened = false; }
            return d;
        },

        "comp.remove": function (a) {
            var c = AEMCP_comp(AEMCP_get(a, "comp", "active"));
            var n = c.name;
            c.remove();
            return { removed: n };
        },

        /* ---- 写：图层 ---- */
        "layer.addText": function (a) {
            var c = AEMCP_comp(AEMCP_get(a, "comp", "active"));
            var txt = String(AEMCP_get(a, "text", "Text"));
            var l = c.layers.addText(txt);
            var src = l.property("ADBE Text Properties").property("ADBE Text Document");
            var td = src.value;
            var size = AEMCP_get(a, "fontSize", null);
            if (size !== null) { td.fontSize = AEMCP_num(size, td.fontSize); }
            var col = AEMCP_get(a, "color", null);
            if (col) { var cl = AEMCP_color(col, [1, 1, 1]); td.fillColor = [cl[0], cl[1], cl[2]]; }
            var just = AEMCP_get(a, "justification", null);
            if (just !== null) {
                var jm = { "left": ParagraphJustification.LEFT_JUSTIFY,
                           "center": ParagraphJustification.CENTER_JUSTIFY,
                           "right": ParagraphJustification.RIGHT_JUSTIFY };
                if (jm[String(just)]) { td.justification = jm[String(just)]; }
            }
            src.setValue(td);
            var nm = AEMCP_get(a, "name", null);
            if (nm !== null) { l.name = String(nm); }
            var pos = AEMCP_get(a, "position", null);
            if (pos) { AEMCP_setProp(AEMCP_prop(l, "position"), pos, null); }
            if (AEMCP_get(a, "inPoint", null) !== null) { l.inPoint = AEMCP_num(AEMCP_get(a, "inPoint", 0), 0); }
            if (AEMCP_get(a, "outPoint", null) !== null) { l.outPoint = AEMCP_num(AEMCP_get(a, "outPoint", 0), 0); }
            return AEMCP_layerBrief(l);
        },

        "layer.addSolid": function (a) {
            var c = AEMCP_comp(AEMCP_get(a, "comp", "active"));
            var col = AEMCP_color(AEMCP_get(a, "color", [1, 1, 1]), [1, 1, 1]);
            var nm = String(AEMCP_get(a, "name", "Solid"));
            var w = AEMCP_num(AEMCP_get(a, "width", c.width), c.width);
            var h = AEMCP_num(AEMCP_get(a, "height", c.height), c.height);
            var dur = AEMCP_num(AEMCP_get(a, "duration", c.duration), c.duration);
            var l = c.layers.addSolid([col[0], col[1], col[2]], nm, w, h, 1, dur);
            var pos = AEMCP_get(a, "position", null);
            if (pos) { AEMCP_setProp(AEMCP_prop(l, "position"), pos, null); }
            return AEMCP_layerBrief(l);
        },

        "layer.addShape": function (a) {
            var c = AEMCP_comp(AEMCP_get(a, "comp", "active"));
            var kind = String(AEMCP_get(a, "kind", "rect")).toLowerCase();
            var l = c.layers.addShape();
            var nm = AEMCP_get(a, "name", null);
            l.name = (nm !== null) ? String(nm) : (kind === "ellipse" ? "Ellipse" : "Rectangle");
            var root = l.property("ADBE Root Vectors Group");
            var grp = root.addProperty("ADBE Vector Group");
            var content = grp.property("ADBE Vectors Group");
            var shapeProp;
            if (kind === "ellipse") {
                shapeProp = content.addProperty("ADBE Vector Shape - Ellipse");
                var es = AEMCP_get(a, "size", null);
                if (es) { AEMCP_setProp(shapeProp.property("ADBE Vector Ellipse Size"), AEMCP_pair(es, [200, 200]), null); }
                var ep = AEMCP_get(a, "shapePosition", null);
                if (ep) { AEMCP_setProp(shapeProp.property("ADBE Vector Ellipse Position"), AEMCP_pair(ep, [0, 0]), null); }
            } else {
                shapeProp = content.addProperty("ADBE Vector Shape - Rect");
                var rs = AEMCP_get(a, "size", null);
                if (rs) { AEMCP_setProp(shapeProp.property("ADBE Vector Rect Size"), AEMCP_pair(rs, [400, 400]), null); }
                var rp = AEMCP_get(a, "shapePosition", null);
                if (rp) { AEMCP_setProp(shapeProp.property("ADBE Vector Rect Position"), AEMCP_pair(rp, [0, 0]), null); }
            }
            var roundness = AEMCP_get(a, "roundness", null);
            if (roundness !== null) {
                try { AEMCP_setProp(shapeProp.property("ADBE Vector Rect Roundness"), AEMCP_num(roundness, 0), null); } catch (e1) { }
            }
            var fill = AEMCP_get(a, "fill", null);
            if (fill !== null) {
                var fc = AEMCP_color(fill, [1, 0, 0]);
                var f = content.addProperty("ADBE Vector Graphic - Fill");
                AEMCP_setProp(f.property("ADBE Vector Fill Color"), fc, null);
            }
            var stroke = AEMCP_get(a, "stroke", null);
            if (stroke) {
                var sc = AEMCP_color((stroke.color !== undefined) ? stroke.color : stroke, [0, 0, 0]);
                var s = content.addProperty("ADBE Vector Graphic - Stroke");
                AEMCP_setProp(s.property("ADBE Vector Stroke Color"), sc, null);
                var sw = AEMCP_get(stroke, "width", null);
                if (sw !== null) { AEMCP_setProp(s.property("ADBE Vector Stroke Width"), AEMCP_num(sw, 2), null); }
            }
            var pos = AEMCP_get(a, "position", null);
            if (pos) { AEMCP_setProp(AEMCP_prop(l, "position"), pos, null); }
            return AEMCP_layerBrief(l);
        },

        "layer.addNull": function (a) {
            var c = AEMCP_comp(AEMCP_get(a, "comp", "active"));
            var l = c.layers.addNull();
            var nm = AEMCP_get(a, "name", null);
            l.name = (nm !== null) ? String(nm) : "Null";
            var pos = AEMCP_get(a, "position", null);
            if (pos) { AEMCP_setProp(AEMCP_prop(l, "position"), pos, null); }
            return AEMCP_layerBrief(l);
        },

        "layer.addCamera": function (a) {
            var c = AEMCP_comp(AEMCP_get(a, "comp", "active"));
            var pos = AEMCP_pair(AEMCP_get(a, "position", null), [c.width / 2, c.height / 2]);
            var l = c.layers.addCamera(String(AEMCP_get(a, "name", "Camera")), pos);
            var zoom = AEMCP_get(a, "zoom", null);
            if (zoom !== null) { AEMCP_setProp(AEMCP_prop(l, "cameraZoom"), AEMCP_num(zoom, 1000), null); }
            return AEMCP_layerBrief(l);
        },

        "layer.addLight": function (a) {
            var c = AEMCP_comp(AEMCP_get(a, "comp", "active"));
            var pos = AEMCP_pair(AEMCP_get(a, "position", null), [c.width / 2, c.height / 2]);
            var l = c.layers.addLight(String(AEMCP_get(a, "name", "Light")), pos);
            var it = AEMCP_get(a, "intensity", null);
            if (it !== null) { AEMCP_setProp(AEMCP_prop(l, "intensity"), AEMCP_num(it, 100), null); }
            return AEMCP_layerBrief(l);
        },

        "layer.set": function (a) {
            var c = AEMCP_comp(AEMCP_get(a, "comp", "active"));
            var l = AEMCP_layer(c, AEMCP_get(a, "layer", null));
            var done = [], i, n;
            if (AEMCP_get(a, "position", null)) { AEMCP_setProp(AEMCP_prop(l, "position"), a.position, null); done.push("position"); }
            if (AEMCP_get(a, "scale", null)) { AEMCP_setProp(AEMCP_prop(l, "scale"), a.scale, null); done.push("scale"); }
            if (AEMCP_get(a, "anchor", null)) { AEMCP_setProp(AEMCP_prop(l, "anchor"), a.anchor, null); done.push("anchor"); }
            if (AEMCP_get(a, "opacity", null) !== null) { AEMCP_setProp(AEMCP_prop(l, "opacity"), AEMCP_num(a.opacity, 100), null); done.push("opacity"); }
            if (AEMCP_get(a, "rotation", null) !== null) { AEMCP_setProp(AEMCP_prop(l, "rotation"), AEMCP_num(a.rotation, 0), null); done.push("rotation"); }
            if (AEMCP_get(a, "orientation", null)) { AEMCP_setProp(AEMCP_prop(l, "orientation"), a.orientation, null); done.push("orientation"); }
            if (AEMCP_get(a, "name", null) !== null) { l.name = String(a.name); done.push("name"); }
            if (AEMCP_get(a, "comment", null) !== null) { l.comment = String(a.comment); done.push("comment"); }
            if (AEMCP_get(a, "enabled", null) !== null) { l.enabled = AEMCP_bool(a.enabled, true); done.push("enabled"); }
            if (AEMCP_get(a, "locked", null) !== null) { l.locked = AEMCP_bool(a.locked, false); done.push("locked"); }
            if (AEMCP_get(a, "solo", null) !== null) { l.solo = AEMCP_bool(a.solo, false); done.push("solo"); }
            if (AEMCP_get(a, "shy", null) !== null) { l.shy = AEMCP_bool(a.shy, false); done.push("shy"); }
            if (AEMCP_get(a, "threeD", null) !== null) { l.threeDLayer = AEMCP_bool(a.threeD, false); done.push("threeD"); }
            if (AEMCP_get(a, "adjustment", null) !== null) { l.adjustmentLayer = AEMCP_bool(a.adjustment, false); done.push("adjustment"); }
            if (AEMCP_get(a, "guide", null) !== null) { l.guideLayer = AEMCP_bool(a.guide, false); done.push("guide"); }
            if (AEMCP_get(a, "inPoint", null) !== null) { l.inPoint = AEMCP_num(a.inPoint, l.inPoint); done.push("inPoint"); }
            if (AEMCP_get(a, "outPoint", null) !== null) { l.outPoint = AEMCP_num(a.outPoint, l.outPoint); done.push("outPoint"); }
            if (AEMCP_get(a, "startTime", null) !== null) { l.startTime = AEMCP_num(a.startTime, 0); done.push("startTime"); }
            if (AEMCP_get(a, "blend", null) !== null) {
                var b = a.blend;
                if (typeof b === "string" && BlendingMode[b] !== undefined) { l.blendingMode = BlendingMode[b]; }
                else { l.blendingMode = AEMCP_num(b, l.blendingMode); }
                done.push("blend");
            }
            if (AEMCP_get(a, "parent", null) !== null) {
                if (a.parent === "" || a.parent === "none" || a.parent === null) { l.parent = null; }
                else { l.parent = AEMCP_layer(c, a.parent); }
                done.push("parent");
            }
            if (AEMCP_get(a, "index", null) !== null) {
                /* 图层顺序：1 = 最上层。AE 移动时按「对象」而不是「下标」定位，
                   所以锚点取 c.layer(to) 这个对象，方向决定 before/after —— 下标在
                   移动过程中会漂，但对象引用不会。 */
                var to = AEMCP_num(a.index, l.index);
                if (to < 1) { to = 1; }
                if (to > c.numLayers) { to = c.numLayers; }
                var cur = l.index;
                if (to === 1) { l.moveToBeginning(); }
                else if (to > cur) { l.moveAfter(c.layer(to)); }
                else { l.moveBefore(c.layer(to)); }
                done.push("index");
            }
            if (done.length === 0) { throw new Error("layer.set 没收到任何要改的字段"); }
            var out = AEMCP_layerBrief(l);
            out.applied = done;
            return out;
        },

        "layer.remove": function (a) {
            var c = AEMCP_comp(AEMCP_get(a, "comp", "active"));
            var names = [], refs = AEMCP_get(a, "layers", null), i;
            if (refs instanceof Array) {
                var targets = [];
                for (i = 0; i < refs.length; i++) { targets.push(AEMCP_layer(c, refs[i])); }
                for (i = 0; i < targets.length; i++) { names.push(targets[i].name); targets[i].remove(); }
            } else {
                var l = AEMCP_layer(c, AEMCP_get(a, "layer", null));
                names.push(l.name);
                l.remove();
            }
            return { removed: names, numLayers: c.numLayers };
        },

        "layer.duplicate": function (a) {
            var c = AEMCP_comp(AEMCP_get(a, "comp", "active"));
            var l = AEMCP_layer(c, AEMCP_get(a, "layer", null));
            var times = Math.max(1, AEMCP_num(AEMCP_get(a, "count", 1), 1));
            var made = [], d;
            for (var i = 0; i < times; i++) {
                d = l.duplicate();
                made.push(AEMCP_layerBrief(d));
            }
            return { source: l.name, count: made.length, duplicates: made };
        },

        "layer.reorder": function (a) {
            var c = AEMCP_comp(AEMCP_get(a, "comp", "active"));
            var l = AEMCP_layer(c, AEMCP_get(a, "layer", null));
            var to = AEMCP_num(AEMCP_get(a, "to", 1), 1);
            var where = String(AEMCP_get(a, "where", "before"));
            var anchor = AEMCP_layer(c, to);
            if (where === "after") { l.moveAfter(anchor); } else { l.moveBefore(anchor); }
            return { layer: l.name, index: l.index, movedTo: (where + " " + anchor.name) };
        },

        "layer.stamp": function (a) {
            var c = AEMCP_comp(AEMCP_get(a, "comp", "active"));
            var l = AEMCP_layer(c, AEMCP_get(a, "layer", null));
            var stamp = "aemcp:" + AEMCP_ms().toString(36) + "-" + Math.floor(Math.random() * 46656).toString(36);
            var old = "";
            try { old = String(l.comment || ""); } catch (e1) { old = ""; }
            var cleaned = old;
            var at = cleaned.indexOf("aemcp:");
            if (at >= 0) { cleaned = cleaned.substring(0, at).replace(/\s+$/, ""); }
            l.comment = (cleaned ? cleaned + " " : "") + stamp;
            var stampOut = { layer: l.name, index: l.index, stamp: stamp, comment: String(l.comment) };
            try { if (l.id !== undefined && l.id !== null) { stampOut.nativeId = l.id; } } catch (e2) { }
            return stampOut;
        },

        "layer.id": function (a) {
            var c = AEMCP_comp(AEMCP_get(a, "comp", "active"));
            if (typeof app.project.layerByID !== "function") {
                throw new Error("当前 AE 没有原生图层 id（需要 AE 2022+）；请用 ae_layer_stamp 打戳寻址");
            }
            var want = AEMCP_get(a, "layer", null), lay, idv, i;
            if (want === null) {
                var out = [];
                for (i = 1; i <= c.numLayers; i++) {
                    lay = c.layer(i);
                    idv = null;
                    try { idv = lay.id; } catch (e3) { idv = null; }
                    out.push({ index: i, name: lay.name, id: idv });
                }
                return { comp: c.name, count: out.length, layers: out };
            }
            lay = AEMCP_layer(c, want);
            idv = null;
            try { idv = lay.id; } catch (e4) { idv = null; }
            return { layer: lay.name, index: lay.index, id: idv };
        },

        "layer.byId": function (a) {
            var id = AEMCP_get(a, "id", null);
            if (id === null) { throw new Error("缺 id"); }
            if (typeof app.project.layerByID !== "function") {
                throw new Error("当前 AE 没有 project.layerByID（需要 AE 2022+）；请用 ae_layer_stamp 打戳寻址");
            }
            var l = app.project.layerByID(AEMCP_num(id, -1));
            if (!l) { return { id: id, found: false, layer: null }; }
            var compName = null;
            try { if (l.containingComp) { compName = l.containingComp.name; } } catch (e5) { }
            return { id: id, found: true, layer: AEMCP_layerBrief(l), comp: compName };
        },

        /* ---- 写：属性 / 关键帧 / 表达式 / 效果 ---- */
        "property.set": function (a) {
            var c = AEMCP_comp(AEMCP_get(a, "comp", "active"));
            var l = AEMCP_layer(c, AEMCP_get(a, "layer", null));
            var ref = AEMCP_get(a, "property", null);
            if (ref === null) { throw new Error("缺 property"); }
            var p = AEMCP_prop(l, ref);
            AEMCP_setProp(p, AEMCP_get(a, "value", 0), null);
            return { layer: l.name, property: ref, value: AEMCP_val(p),
                     numKeys: (function (q) { try { return q.numKeys; } catch (e) { return null; } })(p) };
        },

        "keyframe.set": function (a) {
            var c = AEMCP_comp(AEMCP_get(a, "comp", "active"));
            var l = AEMCP_layer(c, AEMCP_get(a, "layer", null));
            var ref = AEMCP_get(a, "property", "position");
            var p = AEMCP_prop(l, ref);
            var keys = AEMCP_get(a, "keys", null);
            if (!(keys instanceof Array) || keys.length === 0) { throw new Error("keys 必须是 [{t:0,v:[x,y]}, ...]"); }
            if (AEMCP_bool(AEMCP_get(a, "clear", true), true)) {
                for (var k = (p.numKeys || 0); k >= 1; k--) { p.removeKey(k); }
            }
            var made = [], i, t, v;
            for (i = 0; i < keys.length; i++) {
                t = AEMCP_num((keys[i].t !== undefined) ? keys[i].t : keys[i].time, 0);
                v = (keys[i].v !== undefined) ? keys[i].v : keys[i].value;
                AEMCP_setProp(p, v, t);
                made.push({ t: t, v: v });
            }
            var easeInfo = "none";
            var ease = AEMCP_get(a, "ease", null);
            if (ease !== null) { AEMCP_applyEase(p, ease); easeInfo = String(ease); }
            var interp = AEMCP_get(a, "interpolation", null);
            if (interp !== null) { AEMCP_applyInterp(p, String(interp)); easeInfo = easeInfo + " interp=" + interp; }
            return { layer: l.name, property: ref, numKeys: p.numKeys, keys: made, ease: easeInfo };
        },

        "keyframe.clear": function (a) {
            var c = AEMCP_comp(AEMCP_get(a, "comp", "active"));
            var l = AEMCP_layer(c, AEMCP_get(a, "layer", null));
            var p = AEMCP_prop(l, AEMCP_get(a, "property", "position"));
            var n = p.numKeys || 0;
            for (var k = n; k >= 1; k--) { p.removeKey(k); }
            return { layer: l.name, property: AEMCP_get(a, "property", "position"), removed: n };
        },

        "expression.set": function (a) {
            var c = AEMCP_comp(AEMCP_get(a, "comp", "active"));
            var l = AEMCP_layer(c, AEMCP_get(a, "layer", null));
            var ref = AEMCP_get(a, "property", "position");
            var raw = AEMCP_get(a, "expression", null);
            var tpl = AEMCP_get(a, "template", null);
            var link = AEMCP_get(a, "link", null);
            var how = 0;
            if (raw !== null) { how++; }
            if (tpl !== null) { how++; }
            if (link !== null) { how++; }
            if (how === 0) { throw new Error("三选一：expression（原文）/ template（模板名）/ link:{layer,property}（跨层引用）"); }
            if (how > 1) { throw new Error("expression / template / link 只能给一个"); }
            var text = "";
            if (raw !== null) { text = String(raw); }
            else if (tpl !== null) { text = AEMCP_exprFromTemplate(String(tpl), AEMCP_get(a, "templateArgs", null)); }
            else {
                var srcRef = AEMCP_get(link, "layer", null);
                if (srcRef === null) { throw new Error("link 需要 layer（源图层名字或下标）"); }
                var sl = AEMCP_layer(c, srcRef);
                var sp = AEMCP_prop(sl, AEMCP_get(link, "property", "position"));
                text = AEMCP_exprRef(sl.name, sp);
            }
            var list = AEMCP_get(a, "properties", null);
            if (list instanceof Array) {
                var made = [], i, pp;
                for (i = 0; i < list.length; i++) {
                    pp = AEMCP_prop(l, list[i]);
                    pp.expression = text;
                    try { made.push({ property: list[i], value: pp.value, error: pp.expressionError || null }); }
                    catch (e1) { made.push({ property: list[i], error: AEMCP_es(e1) }); }
                }
                return { layer: l.name, expression: text, applied: made };
            }
            var p = AEMCP_prop(l, ref);
            p.expression = text;
            var val = null, err = null;
            try { val = p.value; } catch (e2) { val = null; }
            try { err = p.expressionError || null; } catch (e3) { err = null; }
            return { layer: l.name, property: ref, expression: text, enabled: p.expressionEnabled, error: err, value: val };
        },

        "expression.clear": function (a) {
            var c = AEMCP_comp(AEMCP_get(a, "comp", "active"));
            var l = AEMCP_layer(c, AEMCP_get(a, "layer", null));
            var ref = AEMCP_get(a, "property", "position");
            var p = AEMCP_prop(l, ref);
            var had = null;
            try { had = p.expression ? String(p.expression) : null; } catch (e1) { }
            p.expression = "";
            return { layer: l.name, property: ref, cleared: had };
        },

        "effect.add": function (a) {
            var c = AEMCP_comp(AEMCP_get(a, "comp", "active"));
            var l = AEMCP_layer(c, AEMCP_get(a, "layer", null));
            var ctl = AEMCP_get(a, "control", null);
            var mn = "";
            if (ctl !== null) {
                /* 表达式控件本质就是效果，所以走同一个入口；这里做白名单校验并回传表达式引用名 */
                if (AEMCP_get(a, "matchName", null) !== null) {
                    throw new Error("control 与 matchName 只能给一个：control 是给表达式控件的快捷写法");
                }
                var cmap = AEMCP_controlMap(), ckey = String(ctl).toLowerCase();
                if (!cmap[ckey]) { throw new Error("control 只认：" + AEMCP_keys(cmap).join(" / ")); }
                mn = cmap[ckey];
                ctl = ckey;
            } else {
                mn = String(AEMCP_get(a, "matchName", ""));
                if (!mn) { throw new Error("缺 matchName（例：ADBE Fill / ADBE Gaussian Blur 2）或 control（表达式控件）"); }
            }
            var parade = l.property("ADBE Effect Parade");
            var fx = parade.addProperty(mn);
            var nm = AEMCP_get(a, "name", null);
            if (nm !== null) { fx.name = String(nm); }
            var params = AEMCP_get(a, "params", null);
            if (params) {
                for (var k in params) {
                    if (!params.hasOwnProperty(k)) { continue; }
                    var target = null, i;
                    for (i = 1; i <= fx.numProperties; i++) {
                        if (fx.property(i).name === k || fx.property(i).matchName === k) { target = fx.property(i); break; }
                    }
                    if (target) { AEMCP_setProp(target, params[k], null); }
                }
            }
            var d = { layer: l.name, effect: fx.name, matchName: fx.matchName, index: fx.propertyIndex, params: AEMCP_params(fx) };
            if (ctl !== null) {
                var prm = AEMCP_firstParam(fx);
                var vv = AEMCP_get(a, "value", null);
                if (prm && vv !== null) { AEMCP_setProp(prm, vv, null); }
                d.control = ctl;
                d.param = prm ? { name: prm.name, matchName: prm.matchName, value: AEMCP_val(prm) } : null;
                d.ref = 'effect("' + fx.name + '")("' + (prm ? prm.name : "参数名") + '")';
                d.hint = "表达式里这样引用：" + d.ref + "；别的图层引用写 thisComp.layer(\"" + l.name + "\")." + d.ref;
            }
            return d;
        },

        "effect.set": function (a) {
            var c = AEMCP_comp(AEMCP_get(a, "comp", "active"));
            var l = AEMCP_layer(c, AEMCP_get(a, "layer", null));
            var want = AEMCP_get(a, "effect", null);
            var parade = l.property("ADBE Effect Parade"), fx = null, i;
            if (typeof want === "number" || /^\d+$/.test(String(want))) { fx = parade.property(AEMCP_num(want, 1)); }
            else {
                for (i = 1; i <= parade.numProperties; i++) {
                    if (parade.property(i).name === String(want) || parade.property(i).matchName === String(want)) { fx = parade.property(i); break; }
                }
            }
            if (!fx) { throw new Error("这个图层没有效果：" + want); }
            var changes = AEMCP_get(a, "params", AEMCP_get(a, "set", null));
            if (!changes) { throw new Error("缺 params（例：{\"ADBE Fill-0002\":[1,0,0]}）"); }
            var done = [];
            for (var k in changes) {
                if (!changes.hasOwnProperty(k)) { continue; }
                var target = null;
                for (i = 1; i <= fx.numProperties; i++) {
                    if (fx.property(i).name === k || fx.property(i).matchName === k) { target = fx.property(i); break; }
                }
                if (!target) { done.push(k + "=缺参数"); continue; }
                AEMCP_setProp(target, changes[k], null);
                done.push(k);
            }
            return { layer: l.name, effect: fx.name, applied: done, params: AEMCP_params(fx) };
        },

        "effect.remove": function (a) {
            var c = AEMCP_comp(AEMCP_get(a, "comp", "active"));
            var l = AEMCP_layer(c, AEMCP_get(a, "layer", null));
            var want = AEMCP_get(a, "effect", null);
            var parade = l.property("ADBE Effect Parade"), i;
            for (i = 1; i <= parade.numProperties; i++) {
                if (parade.property(i).name === String(want) || parade.property(i).matchName === String(want)) {
                    var nm = parade.property(i).name;
                    parade.property(i).remove();
                    return { layer: l.name, removed: nm, left: parade.numProperties };
                }
            }
            throw new Error("这个图层没有效果：" + want);
        },

        /* ============================================================
           P0 扩展操作（AE 2021 可做、旧 32 个 op 覆盖不到的能力）
           ------------------------------------------------------------
           蒙版 / 时间线与标记 / 图层种类 / 关键帧进阶 / 表达式诊断 /
           效果与诊断 / 工程与项。
           纪律：读操作返回纯数据；写操作只碰参数点名的对象。
           ============================================================ */

        /* ---- 蒙版 ---- */
        "mask.add": function (a) {
            var c = AEMCP_comp(AEMCP_get(a, "comp", "active"));
            var l = AEMCP_layer(c, AEMCP_get(a, "layer", null));
            var g = AEMCP_maskParade(l);
            var m = g.addProperty("ADBE Mask Atom");
            var d = { layer: l.name, index: m.propertyIndex, name: m.name, masks: g.numProperties };
            var mode = AEMCP_get(a, "mode", null);
            if (mode !== null) { d.mode = AEMCP_maskModeSet(m, mode); }
            var shp = AEMCP_get(a, "shape", null);
            if (shp !== null) {
                m.property("ADBE Mask Shape").setValue(AEMCP_shapeMake(shp, c.width, c.height));
                d.shape = (typeof shp === "string") ? shp : "custom";
            }
            d.inverted = AEMCP_maskBoolSet(m, "inverted", AEMCP_get(a, "inverted", null));
            d.feather = AEMCP_maskPropSet(m, "ADBE Mask Feather", AEMCP_get(a, "feather", null), "pair");
            d.opacity = AEMCP_maskPropSet(m, "ADBE Mask Opacity", AEMCP_get(a, "opacity", null), "num");
            d.expansion = AEMCP_maskPropSet(m, "ADBE Mask Expansion", AEMCP_get(a, "expansion", null), "num");
            return d;
        },

        "mask.list": function (a) {
            var c = AEMCP_comp(AEMCP_get(a, "comp", "active"));
            var l = AEMCP_layer(c, AEMCP_get(a, "layer", null));
            var g = AEMCP_maskParade(l), out = [], i;
            for (i = 1; i <= g.numProperties; i++) { out.push(AEMCP_maskBrief(g.property(i), i)); }
            return { layer: l.name, count: out.length, masks: out };
        },

        "mask.remove": function (a) {
            var c = AEMCP_comp(AEMCP_get(a, "comp", "active"));
            var l = AEMCP_layer(c, AEMCP_get(a, "layer", null));
            var m = AEMCP_mask(l, AEMCP_get(a, "mask", null));
            var n = m.name, left = AEMCP_maskParade(l).numProperties - 1;
            m.remove();
            return { layer: l.name, removed: n, left: left };
        },

        "mask.pathGet": function (a) {
            var c = AEMCP_comp(AEMCP_get(a, "comp", "active"));
            var l = AEMCP_layer(c, AEMCP_get(a, "layer", null));
            var m = AEMCP_mask(l, AEMCP_get(a, "mask", null));
            var p = m.property("ADBE Mask Shape");
            var at = AEMCP_get(a, "atTime", null);
            var sh = (at === null) ? p.value : p.valueAtTime(AEMCP_num(at, 0), false);
            var d = AEMCP_shapeToObj(sh);
            d.layer = l.name; d.mask = m.name;
            d.numKeys = (function (q) { try { return q.numKeys; } catch (e) { return null; } })(p);
            return d;
        },

        "mask.pathSet": function (a) {
            var c = AEMCP_comp(AEMCP_get(a, "comp", "active"));
            var l = AEMCP_layer(c, AEMCP_get(a, "layer", null));
            var m = AEMCP_mask(l, AEMCP_get(a, "mask", null));
            var p = m.property("ADBE Mask Shape");
            var sh = AEMCP_shapeMake(AEMCP_get(a, "shape", null), c.width, c.height);
            var at = AEMCP_get(a, "atTime", null);
            if (at === null) { p.setValue(sh); } else { p.setValueAtTime(AEMCP_num(at, 0), sh); }
            var o = AEMCP_shapeToObj(sh);
            return { layer: l.name, mask: m.name, atTime: (at === null) ? null : AEMCP_num(at, 0),
                     vertices: o.vertices.length, numKeys: (function (q) { try { return q.numKeys; } catch (e) { return null; } })(p) };
        },

        "mask.keyframes": function (a) {
            var c = AEMCP_comp(AEMCP_get(a, "comp", "active"));
            var l = AEMCP_layer(c, AEMCP_get(a, "layer", null));
            var m = AEMCP_mask(l, AEMCP_get(a, "mask", null));
            var which = String(AEMCP_get(a, "property", "path")).toLowerCase();
            var map = { "path": "ADBE Mask Shape", "feather": "ADBE Mask Feather",
                        "opacity": "ADBE Mask Opacity", "expansion": "ADBE Mask Expansion" };
            if (!map[which]) { throw new Error("蒙版属性只认 path / feather / opacity / expansion"); }
            var p = m.property(map[which]);
            var keys = AEMCP_get(a, "keys", null);
            if (keys === null) {
                return { layer: l.name, mask: m.name, property: which, count: p.numKeys,
                         keys: AEMCP_maskKeyList(p, which) };
            }
            if (!(keys instanceof Array)) { throw new Error("keys 要是数组：[{t,v},...]"); }
            var i, k, v;
            for (i = p.numKeys; i >= 1; i--) { p.removeKey(i); }
            var tmp = (which === "path") ? new Shape() : (function () { try { return p.value; } catch (e) { return 0; } })();
            for (i = 0; i < keys.length; i++) {
                k = keys[i];
                /* 注意：这里必须用 if/else，不能写嵌套三元 —— ExtendScript 对 a ? f() : (b ? g() : h())
                   这种跨行嵌套三元会错误结合，把后一个分支的值当结果（实测踩过：蒙版路径被当成 Array）。 */
                if (which === "path") {
                    v = AEMCP_shapeMake(k.v, c.width, c.height);
                } else if (which === "feather") {
                    v = AEMCP_pair(k.v, [0, 0]);
                } else {
                    v = AEMCP_num(k.v, 0);
                }
                p.setValueAtTime(AEMCP_num(k.t, 0), v);
            }
            var ease = AEMCP_get(a, "ease", null), interp = AEMCP_get(a, "interpolation", null);
            if (ease !== null) { AEMCP_applyEase(p, ease); }
            if (interp !== null) { AEMCP_applyInterp(p, interp); }
            return { layer: l.name, mask: m.name, property: which, count: p.numKeys,
                     keys: AEMCP_maskKeyList(p, which) };
        },

        /* ---- 时间线与标记 ---- */
        "time.get": function (a) {
            var c = AEMCP_comp(AEMCP_get(a, "comp", "active"));
            return { comp: c.name, time: c.time, cti: c.time,
                     duration: c.duration, frameRate: c.frameRate, frameDuration: c.frameDuration,
                     displayStartTime: c.displayStartTime,
                     workAreaStart: c.workAreaStart, workAreaDuration: c.workAreaDuration,
                     numLayers: c.numLayers };
        },

        "time.set": function (a) {
            var c = AEMCP_comp(AEMCP_get(a, "comp", "active"));
            var t = AEMCP_num(AEMCP_get(a, "time", 0), 0);
            c.time = t;
            return { comp: c.name, time: c.time, note: "只是把时间指针挪过去，不改任何关键帧" };
        },

        "workarea.set": function (a) {
            var c = AEMCP_comp(AEMCP_get(a, "comp", "active"));
            var st = AEMCP_get(a, "start", null), du = AEMCP_get(a, "duration", null),
                en = AEMCP_get(a, "end", null), out = { comp: c.name };
            if (st !== null) { c.workAreaStart = AEMCP_num(st, c.workAreaStart); out.start = c.workAreaStart; }
            if (du !== null) { c.workAreaDuration = AEMCP_num(du, c.workAreaDuration); }
            else if (en !== null) { c.workAreaDuration = AEMCP_num(en, c.duration) - c.workAreaStart; }
            out.duration = c.workAreaDuration;
            out.start = c.workAreaStart;
            out.workAreaStart = c.workAreaStart;
            out.workAreaDuration = c.workAreaDuration;
            out.range = [c.workAreaStart, c.workAreaStart + c.workAreaDuration];
            return out;
        },

        "marker.add": function (a) {
            var c = AEMCP_comp(AEMCP_get(a, "comp", "active"));
            var lyr = AEMCP_get(a, "layer", null);
            var mp = AEMCP_markerProp(c, lyr);
            var t = AEMCP_num(AEMCP_get(a, "time", c.time), c.time);
            var cm = String(AEMCP_get(a, "comment", ""));
            var mv = new MarkerValue(cm);
            AEMCP_markerApply(mv, a);
            mp.setValueAtTime(t, mv);
            return { comp: c.name, layer: lyr ? AEMCP_layer(c, lyr).name : null,
                     time: t, comment: cm, onLayer: !!lyr,
                     count: mp.numKeys, numKeys: mp.numKeys, index: AEMCP_markerIndexAt(mp, t) };
        },

        "marker.list": function (a) {
            var c = AEMCP_comp(AEMCP_get(a, "comp", "active"));
            var lyr = AEMCP_get(a, "layer", null);
            var mp = AEMCP_markerProp(c, lyr), out = [], i;
            for (i = 1; i <= mp.numKeys; i++) { out.push(AEMCP_markerBrief(mp.keyValue(i), i, mp.keyTime(i))); }
            return { comp: c.name, layer: lyr ? AEMCP_layer(c, lyr).name : null,
                     count: out.length, markers: out };
        },

        "marker.remove": function (a) {
            var c = AEMCP_comp(AEMCP_get(a, "comp", "active"));
            var lyr = AEMCP_get(a, "layer", null);
            var mp = AEMCP_markerProp(c, lyr);
            var idx = AEMCP_get(a, "index", null);
            var i;
            if (idx === null) {
                var t = AEMCP_num(AEMCP_get(a, "time", c.time), c.time);
                idx = AEMCP_markerIndexAt(mp, t);
                if (!idx) { throw new Error("这个时间点上没有标记：" + t); }
            }
            i = AEMCP_num(idx, 0);
            if (i < 1 || i > mp.numKeys) { throw new Error("标记下标越界：共 " + mp.numKeys + " 个"); }
            var cm = "";
            try { cm = String(mp.keyValue(i).comment); } catch (e) { }
            mp.removeKey(i);
            return { comp: c.name, removedIndex: i, comment: cm, left: mp.numKeys };
        },

        "marker.nearest": function (a) {
            var c = AEMCP_comp(AEMCP_get(a, "comp", "active"));
            var lyr = AEMCP_get(a, "layer", null);
            var mp = AEMCP_markerProp(c, lyr);
            var t = AEMCP_num(AEMCP_get(a, "time", c.time), c.time);
            var dir = String(AEMCP_get(a, "dir", "nearest")).toLowerCase();
            var hit = AEMCP_markerFind(mp, t, dir);
            if (!hit) { return { comp: c.name, from: t, dir: dir, found: false }; }
            hit.comp = c.name; hit.from = t; hit.dir = dir; hit.found = true;
            hit.delta = hit.time - t;
            return hit;
        },

        "marker.snap": function (a) {
            var c = AEMCP_comp(AEMCP_get(a, "comp", "active"));
            var lyr = AEMCP_get(a, "layer", null);
            var mp = AEMCP_markerProp(c, lyr);
            var t = AEMCP_num(AEMCP_get(a, "time", c.time), c.time);
            var dir = String(AEMCP_get(a, "dir", "nearest")).toLowerCase();
            var hit = AEMCP_markerFind(mp, t, dir);
            if (!hit) { return { comp: c.name, from: t, moved: false, note: "这个方向上没有标记" }; }
            var setIt = AEMCP_bool(AEMCP_get(a, "set", true), true);
            var before = c.time;
            if (setIt) { c.time = hit.time; }
            return { comp: c.name, from: t, to: hit.time, comment: hit.comment,
                     moved: true, applied: setIt, compTimeBefore: before, compTimeAfter: c.time };
        },

        /* ---- 图层种类 ---- */
        "layer.addAdjustment": function (a) {
            var c = AEMCP_comp(AEMCP_get(a, "comp", "active"));
            var name = String(AEMCP_get(a, "name", "调整层"));
            var l = c.layers.addSolid([0, 0, 0], name, c.width, c.height, c.pixelAspect, c.duration);
            l.adjustmentLayer = true;
            var pos = AEMCP_get(a, "position", null);
            if (pos !== null) { AEMCP_setProp(AEMCP_prop(l, "position"), pos, null); }
            var d = AEMCP_layerBrief(l);
            d.note = "调整层：只影响它下面的图层";
            return d;
        },

        "layer.addAV": function (a) {
            var c = AEMCP_comp(AEMCP_get(a, "comp", "active"));
            var ref = AEMCP_get(a, "item", null);
            if (ref === null) { throw new Error("缺 item：要放进来的是哪个项目（名字或 @id:N）"); }
            var it = AEMCP_item(app.project, ref);
            if (it === app.project.rootFolder) { throw new Error("文件夹不能当图层放进来"); }
            var dur = AEMCP_get(a, "duration", null);
            var l = (dur === null) ? c.layers.add(it) : c.layers.add(it, AEMCP_num(dur, it.duration));
            var d = AEMCP_layerBrief(l);
            d.source = it.name;
            d.sourceType = it.typeName;
            d.sourceMissing = AEMCP_missingOf(it);
            return d;
        },

        "layer.precompose": function (a) {
            var c = AEMCP_comp(AEMCP_get(a, "comp", "active"));
            var refs = AEMCP_get(a, "layers", null), idx = [], i, l;
            if (refs === null || !(refs instanceof Array)) { throw new Error("layers 要是数组，如 [1,2] 或 [\"文字\",\"纯色\"]"); }
            for (i = 0; i < refs.length; i++) { l = AEMCP_layer(c, refs[i]); idx.push(l.index); }
            var name = String(AEMCP_get(a, "name", c.name + " 预合成"));
            var move = AEMCP_bool(AEMCP_get(a, "moveAllAttributes", true), true);
            var nc = c.layers.precompose(idx, name, move);
            return { source: c.name, precomp: nc.name, id: nc.id, layers: nc.numLayers,
                     duration: nc.duration, movedAllAttributes: move,
                     note: "被预合成的层从原合成里消失了，取而代之是一个预合成层" };
        },

        /* ---- 关键帧进阶 ---- */
        "keyframe.get": function (a) {
            var c = AEMCP_comp(AEMCP_get(a, "comp", "active"));
            var l = AEMCP_layer(c, AEMCP_get(a, "layer", null));
            var p = AEMCP_prop(l, AEMCP_get(a, "property", "position"));
            return { layer: l.name, property: AEMCP_get(a, "property", "position"),
                     matchName: (function (q) { try { return q.matchName; } catch (e) { return null; } })(p),
                     numKeys: p.numKeys, keys: AEMCP_keyList(p),
                     expression: (function (q) { try { return q.expression ? String(q.expression) : null; } catch (e) { return null; } })() };
        },

        "keyframe.ease": function (a) {
            var c = AEMCP_comp(AEMCP_get(a, "comp", "active"));
            var l = AEMCP_layer(c, AEMCP_get(a, "layer", null));
            var p = AEMCP_prop(l, AEMCP_get(a, "property", "position"));
            var ease = AEMCP_get(a, "ease", null);
            if (ease === null) { ease = [0, 33]; }
            var n = AEMCP_applyEase(p, ease);
            var interp = AEMCP_get(a, "interpolation", null);
            if (interp !== null) { AEMCP_applyInterp(p, interp); }
            return { layer: l.name, property: AEMCP_get(a, "property", "position"),
                     keys: n, ease: ease, interpolation: interp,
                     keysDetail: AEMCP_keyList(p) };
        },

        "keyframe.offset": function (a) {
            var c = AEMCP_comp(AEMCP_get(a, "comp", "active"));
            var l = AEMCP_layer(c, AEMCP_get(a, "layer", null));
            var p = AEMCP_prop(l, AEMCP_get(a, "property", "position"));
            var dl = AEMCP_num(AEMCP_get(a, "delta", 0), 0);
            var list = AEMCP_keysRead(p), i, n = list.length;
            if (n === 0) { throw new Error("这个属性没有关键帧，offset 没东西可推"); }
            for (i = 0; i < n; i++) { list[i].t = list[i].t + dl; }
            AEMCP_keysWrite(p, list);
            return { layer: l.name, property: AEMCP_get(a, "property", "position"),
                     delta: dl, keys: n, first: p.keyTime(1), last: p.keyTime(n),
                     firstKey: p.keyTime(1), lastKey: p.keyTime(n) };
        },

        "keyframe.scaleTiming": function (a) {
            var c = AEMCP_comp(AEMCP_get(a, "comp", "active"));
            var l = AEMCP_layer(c, AEMCP_get(a, "layer", null));
            var p = AEMCP_prop(l, AEMCP_get(a, "property", "position"));
            var f = AEMCP_num(AEMCP_get(a, "factor", 1), 1);
            if (f <= 0) { throw new Error("factor 要大于 0（1 = 不变，0.5 = 压缩一半时长，2 = 拉长一倍）"); }
            var list = AEMCP_keysRead(p), i, n = list.length, pivot;
            if (n === 0) { throw new Error("这个属性没有关键帧，scaleTiming 没东西可缩"); }
            var pv = AEMCP_get(a, "pivot", null);
            pivot = (pv === null) ? list[0].t : AEMCP_num(pv, list[0].t);
            for (i = 0; i < n; i++) { list[i].t = pivot + (list[i].t - pivot) * f; }
            AEMCP_keysWrite(p, list);
            return { layer: l.name, property: AEMCP_get(a, "property", "position"),
                     factor: f, pivot: pivot, keys: n, first: p.keyTime(1), last: p.keyTime(n),
                     firstKey: p.keyTime(1), lastKey: p.keyTime(n) };
        },

        "keyframe.reverse": function (a) {
            var c = AEMCP_comp(AEMCP_get(a, "comp", "active"));
            var l = AEMCP_layer(c, AEMCP_get(a, "layer", null));
            var p = AEMCP_prop(l, AEMCP_get(a, "property", "position"));
            var list = AEMCP_keysRead(p), i, j, n = list.length, rev = [];
            if (n < 2) { throw new Error("少于 2 个关键帧翻不出花样"); }
            /* 与 AE「时间反转关键帧」同义：时间点不动，值的先后顺序倒过来 */
            for (i = 0; i < n; i++) {
                j = n - 1 - i;
                rev.push({ t: list[i].t, v: list[j].v, inT: list[j].inT, outT: list[j].outT,
                           inE: list[j].inE, outE: list[j].outE });
            }
            AEMCP_keysWrite(p, rev);
            return { layer: l.name, property: AEMCP_get(a, "property", "position"),
                     keys: n, range: [p.keyTime(1), p.keyTime(n)],
                     note: "时间点不动，值顺序倒过来（同 AE 的时间反转关键帧）" };
        },

        "keyframe.copy": function (a) {
            var c = AEMCP_comp(AEMCP_get(a, "comp", "active"));
            var from = AEMCP_layer(c, AEMCP_get(a, "layer", null));
            var fp = AEMCP_prop(from, AEMCP_get(a, "property", "position"));
            var tl = AEMCP_get(a, "toLayer", null);
            var to = (tl === null) ? from : AEMCP_layer(c, tl);
            var tp = AEMCP_prop(to, AEMCP_get(a, "toProperty", AEMCP_get(a, "property", "position")));
            var list = AEMCP_keysRead(fp);
            if (list.length === 0) { throw new Error("源属性没有关键帧可复制"); }
            var off = AEMCP_get(a, "offset", null);
            var dl = (off === null) ? 0 : AEMCP_num(off, 0) - list[0].t;
            var i;
            if (dl !== 0) { for (i = 0; i < list.length; i++) { list[i].t = list[i].t + dl; } }
            AEMCP_keysWrite(tp, list);
            return { from: from.name, fromProperty: AEMCP_get(a, "property", "position"),
                     to: to.name, toProperty: AEMCP_get(a, "toProperty", AEMCP_get(a, "property", "position")),
                     keys: list.length, offset: dl };
        },

        /* ---- 表达式诊断 ---- */
        "expression.validate": function (a) {
            var p = app.project, lim = AEMCP_num(AEMCP_get(a, "limit", 500), 500);
            var only = AEMCP_get(a, "comp", null);
            var bad = [], ok = 0, i, j, k, it, c, l, g, pr, ex, err, scanned = 0;
            for (i = 1; i <= p.numItems && scanned < lim; i++) {
                it = p.item(i);
                if (!(it instanceof CompItem)) { continue; }
                if (only !== null && it.name !== String(only) && String(it.id) !== String(only).replace("@id:", "")) { continue; }
                c = it;
                for (j = 1; j <= c.numLayers; j++) {
                    l = c.layer(j);
                    for (k = 1; k <= l.numProperties; k++) {
                        pr = AEMCP_exprScan(l.property(k), bad, c.name, l.name, lim, scanned);
                        ok += pr.ok; scanned += pr.scanned;
                        if (bad.length >= 50) { break; }
                    }
                }
            }
            return { scanned: scanned, ok: ok, badCount: bad.length, expressionErrors: bad.length, bad: bad };
        },

        /* ---- 效果与诊断 ---- */
        "effect.copy": function (a) {
            var c = AEMCP_comp(AEMCP_get(a, "comp", "active"));
            var src = AEMCP_layer(c, AEMCP_get(a, "layer", null));
            var want = AEMCP_get(a, "effect", null);
            if (want === null) { throw new Error("缺 effect：要复制哪个效果"); }
            var sp = AEMCP_effectFind(src, want);
            var tl = AEMCP_get(a, "toLayer", null);
            var dst = (tl === null) ? src : AEMCP_layer(c, tl);
            var dn = AEMCP_get(a, "name", null);
            var np = dst.property("ADBE Effect Parade").addProperty(sp.matchName);
            if (dn !== null) { np.name = String(dn); }
            var copied = [], i, s, d;
            for (i = 1; i <= sp.numProperties; i++) {
                try {
                    s = sp.property(i);
                    if (s.propertyValueType === undefined) { continue; }
                    d = null;
                    for (var q = 1; q <= np.numProperties; q++) {
                        if (np.property(q).matchName === s.matchName) { d = np.property(q); break; }
                    }
                    if (!d) { continue; }
                    AEMCP_setProp(d, AEMCP_val(s), null);
                    copied.push(s.name);
                } catch (e1) { }
            }
            return { from: src.name, effect: sp.name, matchName: sp.matchName,
                     to: dst.name, newName: np.name, paramsCopied: copied.length, copied: copied };
        },

        "effect.reorder": function (a) {
            var c = AEMCP_comp(AEMCP_get(a, "comp", "active"));
            var l = AEMCP_layer(c, AEMCP_get(a, "layer", null));
            var g = l.property("ADBE Effect Parade");
            var sp = AEMCP_effectFind(l, AEMCP_get(a, "effect", null));
            var to = AEMCP_num(AEMCP_get(a, "to", 1), 1);
            if (to < 1 || to > g.numProperties) {
                throw new Error("to 越界：这一层只有 " + g.numProperties + " 个效果（to 从 1 开始，最大 " + g.numProperties + "）");
            }
            var before = sp.propertyIndex, nm = String(sp.name), i, order = [], after = null;
            /* moveTo 之后原来的属性对象就失效了（AE 的老毛病），名字要先存下来，位置回头重新取 */
            sp.moveTo(to);
            sp = null;
            for (i = 1; i <= g.numProperties; i++) { order.push(g.property(i).name); }
            try { after = AEMCP_effectFind(l, nm).propertyIndex; } catch (e2) { after = null; }
            return { layer: l.name, effect: nm, from: before, to: to, index: after, order: order };
        },

        "property.tree": function (a) {
            var c = AEMCP_comp(AEMCP_get(a, "comp", "active"));
            var l = AEMCP_layer(c, AEMCP_get(a, "layer", null));
            var start = AEMCP_get(a, "property", null);
            var maxDepth = AEMCP_num(AEMCP_get(a, "depth", 3), 3);
            var root = (start === null) ? l : AEMCP_prop(l, start);
            return { layer: l.name, from: (start === null) ? "(图层根)" : String(start),
                     depth: maxDepth, tree: AEMCP_propTree(root, maxDepth, 0) };
        },

        /* ---- 工程与项 ---- */
        "comp.modify": function (a) {
            var c = AEMCP_comp(AEMCP_get(a, "comp", "active"));
            var d = { comp: c.name, before: AEMCP_compBrief(c), changed: [] };
            var w = AEMCP_get(a, "width", null), h = AEMCP_get(a, "height", null);
            var dur = AEMCP_get(a, "duration", null), fps = AEMCP_get(a, "frameRate", null);
            var pa = AEMCP_get(a, "pixelAspect", null), bg = AEMCP_get(a, "bg", null);
            var mb = AEMCP_get(a, "motionBlur", null), nm = AEMCP_get(a, "name", null);
            var wa = AEMCP_get(a, "workArea", null), ts = AEMCP_get(a, "displayStartTime", null);
            if (nm !== null) { c.name = String(nm); d.changed.push("name"); }
            if (w !== null) { c.width = Math.round(AEMCP_num(w, c.width)); d.changed.push("width"); }
            if (h !== null) { c.height = Math.round(AEMCP_num(h, c.height)); d.changed.push("height"); }
            if (pa !== null) { c.pixelAspect = AEMCP_num(pa, c.pixelAspect); d.changed.push("pixelAspect"); }
            if (dur !== null) { c.duration = AEMCP_num(dur, c.duration); d.changed.push("duration"); }
            if (fps !== null) { c.frameRate = AEMCP_num(fps, c.frameRate); d.changed.push("frameRate"); }
            if (bg !== null) { var col = AEMCP_color(bg, [0, 0, 0]); c.bgColor = [col[0], col[1], col[2]]; d.changed.push("bgColor"); }
            if (mb !== null) { c.motionBlur = AEMCP_bool(mb, c.motionBlur); d.changed.push("motionBlur"); }
            if (ts !== null) { c.displayStartTime = AEMCP_num(ts, c.displayStartTime); d.changed.push("displayStartTime"); }
            if (wa !== null && wa instanceof Array) {
                c.workAreaStart = AEMCP_num(wa[0], c.workAreaStart);
                if (wa.length > 1) { c.workAreaDuration = AEMCP_num(wa[1], c.workAreaDuration); }
                d.changed.push("workArea");
            }
            d.after = AEMCP_compBrief(c);
            /* 顶层也放一份关键字段，模型不用先钻 after */
            d.width = d.after.width; d.height = d.after.height;
            d.duration = d.after.duration; d.frameRate = d.after.frameRate;
            d.pixelAspect = d.after.pixelAspect; d.bg = d.after.bg;
            d.numLayers = d.after.numLayers; d.name = d.after.name;
            return d;
        },

        "comp.duplicate": function (a) {
            var c = AEMCP_comp(AEMCP_get(a, "comp", "active"));
            var nc = c.duplicate();
            var nm = AEMCP_get(a, "name", null);
            if (nm !== null) { nc.name = String(nm); }
            var d = AEMCP_compBrief(nc);
            d.source = c.name;
            return d;
        },

        "comp.check": function (a) {
            var c = AEMCP_comp(AEMCP_get(a, "comp", "active"));
            var problems = [], i, l, it, p, errs = 0, missing = [], noSource = [];
            var exprBad = [], maskCount = 0, keyCount = 0, fxCount = 0;
            var proj = app.project, j;
            for (j = 1; j <= proj.numItems; j++) {
                it = proj.item(j);
                if (it instanceof FootageItem && AEMCP_missingOf(it)) {
                    missing.push({ id: it.id, name: it.name, type: it.typeName });
                }
            }
            for (i = 1; i <= c.numLayers; i++) {
                l = c.layer(i);
                try { fxCount += l.property("ADBE Effect Parade").numProperties; } catch (e0) { }
                try { maskCount += l.property("ADBE Mask Parade").numProperties; } catch (e1) { }
                try {
                    if (l.source === null) { noSource.push(l.name); }
                } catch (e2) { }
                var r = AEMCP_exprScan(l, exprBad, c.name, l.name, 50, 0);
                errs += (r.bad || 0);
                keyCount += AEMCP_keyCount(l);
                try {
                    if (l.outPoint !== undefined && l.inPoint !== undefined && l.outPoint <= l.inPoint) {
                        problems.push("图层「" + l.name + "」的出入点反了（out<=in），它在时间轴上不可见");
                    }
                } catch (e3) { }
            }
            if (missing.length) { problems.push("工程里有 " + missing.length + " 个素材离线（footageMissing）"); }
            if (noSource.length) { problems.push("这些图层没有源（null/调整层/文字层除外要留意）：" + noSource.join("、")); }
            if (exprBad.length) { problems.push("表达式报错 " + exprBad.length + " 处"); }
            var empty = [];
            for (i = 1; i <= c.numLayers; i++) {
                l = c.layer(i);
                if (l.outPoint - l.inPoint <= 0.0001) { empty.push(l.name); }
            }
            if (empty.length) { problems.push("零长度图层：" + empty.join("、")); }
            return { comp: c.name, layers: c.numLayers, effects: fxCount, masks: maskCount,
                     keyframes: keyCount, expressionErrors: exprBad.length, expressionErrorList: exprBad,
                     missingFootage: missing, zeroLengthLayers: empty,
                     problems: problems, ok: (problems.length === 0) };
        },

        "item.activate": function (a) {
            var p = app.project;
            var it = AEMCP_item(p, AEMCP_get(a, "item", "active"));
            var d = { id: it.id, name: it.name, type: it.typeName, isComp: (it instanceof CompItem) };
            /* app.project.activeItem 是只读的：唯一能把某个合成变成「活动合成」的办法
               是 openInViewer()。素材项没有这个接口，只能如实回报。 */
            if (it instanceof CompItem) {
                try { it.openInViewer(); d.opened = true; d.active = (p.activeItem === it); }
                catch (eOpen) { d.opened = false; d.active = false; }
            } else {
                d.opened = false; d.active = false;
                d.note = "「" + it.typeName + "」不是合成，没法设成活动合成（只有合成能 openInViewer）";
            }
            return d;
        },

        "item.rename": function (a) {
            var p = app.project;
            var it = AEMCP_item(p, AEMCP_get(a, "item", "active"));
            var nm = AEMCP_get(a, "name", null);
            if (nm === null) { throw new Error("缺 name：要改成什么名字"); }
            var old = it.name;
            it.name = String(nm);
            return { id: it.id, type: it.typeName, from: old, to: it.name };
        },

        "item.remove": function (a) {
            var p = app.project;
            var it = AEMCP_item(p, AEMCP_get(a, "item", "active"));
            if (it instanceof CompItem) {
                throw new Error("这是合成：合成请用 ae_comp_remove（语义一致，避免两个工具做同一件事）");
            }
            if (it === p.rootFolder) { throw new Error("根文件夹删不掉"); }
            var d = { id: it.id, name: it.name, type: it.typeName };
            it.remove();
            return { removed: d, numItems: p.numItems };
        },

        /* ---- 收尾 / 诊断 ---- */
        "undo.purge": function (a) {
            app.purge(PurgeTarget.UNDO_CACHES);
            return { purged: "UNDO_CACHES" };
        },

        "render.queueAdd": function (a) {
            var c = AEMCP_comp(AEMCP_get(a, "comp", "active"));
            var item = app.project.renderQueue.items.add(c);
            var out = null;
            var path = AEMCP_get(a, "outputPath", null);
            if (path) {
                var tpl = AEMCP_get(a, "template", null);
                if (tpl) { item.applyTemplate(String(tpl)); }
                item.outputModule(1).file = new File(String(path));
                out = String(path);
            }
            return { comp: c.name, index: app.project.renderQueue.numItems,
                     outputFile: out, note: "只入队，不渲染（渲染会占住 AE）" };
        },

        /* ==================== P1-A 3D / 材质 / 相机 / 灯光 ==================== */
        "threeD.info": function (a) {
            var c = AEMCP_comp(AEMCP_get(a, "comp", "active"));
            var d = { comp: c.name, renderer: null, renderers: [], threeDLayers: [] };
            try { d.renderer = c.renderer; } catch (e0) { }
            try {
                var rs = c.renderers;
                for (var i = 0; i < rs.length; i++) { d.renderers.push(rs[i]); }
            } catch (e1) { }
            for (var j = 1; j <= c.numLayers; j++) {
                var l = c.layer(j), t3 = false;
                try { t3 = l.threeDLayer; } catch (e2) { }
                if (t3) {
                    var b = { index: l.index, name: l.name };
                    try { b.camera = (l.property("ADBE Camera Options Group") !== null); } catch (e3) { b.camera = false; }
                    try { b.light = (l.property("ADBE Light Options Group") !== null); } catch (e4) { b.light = false; }
                    d.threeDLayers.push(b);
                }
            }
            return d;
        },

        "material.set": function (a) {
            var c = AEMCP_comp(AEMCP_get(a, "comp", "active"));
            var l = AEMCP_layer(c, AEMCP_get(a, "layer", null));
            var g = AEMCP_matGroup(l);
            var changed = [];
            var specs = [
                ["lightTransmission", "ADBE Light Transmission", "num"],
                ["ambient", "ADBE Ambient Coefficient", "num"],
                ["diffuse", "ADBE Diffuse Coefficient", "num"],
                ["specular", "ADBE Specular Coefficient", "num"],
                ["shininess", "ADBE Shininess Coefficient", "num"],
                ["metal", "ADBE Metal Coefficient", "num"],
                ["castsShadows", "Casts Shadows", "tri"],
                ["acceptsShadows", "Accepts Shadows", "tri"]
            ];
            var i;
            for (i = 0; i < specs.length; i++) {
                if (AEMCP_setNamed(g, specs[i][1], a, specs[i][0], specs[i][2])) { changed.push(specs[i][0]); }
            }
            if (a.acceptsLights !== undefined && a.acceptsLights !== null) {
                var al = g.property("Accepts Lights");
                if (!al) { throw new Error("属性不存在：Accepts Lights"); }
                al.setValue(AEMCP_bool(a.acceptsLights, true) ? 1 : 0);
                changed.push("acceptsLights");
            }
            return { layer: l.name, changed: changed, threeD: l.threeDLayer };
        },

        "camera.set": function (a) {
            var c = AEMCP_comp(AEMCP_get(a, "comp", "active"));
            var l = AEMCP_layer(c, AEMCP_get(a, "layer", null));
            var g = AEMCP_camGroup(l);
            var changed = [];
            var specs = [
                ["zoom", "ADBE Camera Zoom", "num"],
                ["depthOfField", "ADBE Camera Depth of Field", "num"],
                ["focusDistance", "ADBE Camera Focus Distance", "num"],
                ["aperture", "ADBE Camera Aperture", "num"],
                ["blurLevel", "ADBE Camera Blur Level", "num"]
            ];
            var irisSpecs = [
                ["irisShape", "ADBE Iris Shape", "num"],
                ["irisAspectRatio", "ADBE Iris Aspect Ratio", "num"],
                ["irisRotation", "ADBE Iris Rotation", "num"],
                ["irisRoundness", "ADBE Iris Roundness", "num"],
                ["irisDiffractionFringe", "ADBE Iris Diffraction Fringe", "num"],
                ["irisHighlightGain", "ADBE Iris Highlight Gain", "num"],
                ["irisHighlightThreshold", "ADBE Iris Highlight Threshold", "num"],
                ["irisHighlightSaturation", "ADBE Iris Hightlight Saturation", "num"]
            ];
            var i;
            for (i = 0; i < specs.length; i++) {
                if (AEMCP_setNamed(g, specs[i][1], a, specs[i][0], specs[i][2])) { changed.push(specs[i][0]); }
            }
            for (i = 0; i < irisSpecs.length; i++) {
                try {
                    if (AEMCP_setNamed(g, irisSpecs[i][1], a, irisSpecs[i][0], irisSpecs[i][2])) { changed.push(irisSpecs[i][0]); }
                } catch (eIris) { }
            }
            return { layer: l.name, changed: changed };
        },

        "light.set": function (a) {
            var c = AEMCP_comp(AEMCP_get(a, "comp", "active"));
            var l = AEMCP_layer(c, AEMCP_get(a, "layer", null));
            var g = AEMCP_lightGroup(l);
            var changed = [];
            var specs = [
                ["intensity", "ADBE Light Intensity", "num"],
                ["color", "ADBE Light Color", "color"],
                ["coneAngle", "ADBE Light Cone Angle", "num"],
                ["coneFeather", "ADBE Light Cone Feather 2", "num"],
                ["falloff", "ADBE Light Falloff Type", "num"],
                ["radius", "ADBE Light Falloff Start", "num"],
                ["falloffDistance", "ADBE Light Falloff Distance", "num"],
                ["shadowDarkness", "ADBE Light Shadow Darkness", "num"],
                ["shadowDiffusion", "ADBE Light Shadow Diffusion", "num"]
            ];
            var i;
            for (i = 0; i < specs.length; i++) {
                if (AEMCP_setNamed(g, specs[i][1], a, specs[i][0], specs[i][2])) { changed.push(specs[i][0]); }
            }
            if (a.lightType !== undefined && a.lightType !== null) {
                var LT = { parallel: 4412, spot: 4413, point: 4414, ambient: 4415 };
                var v = a.lightType;
                if (typeof v === "string" && LT[String(v).toLowerCase()] !== undefined) { v = LT[String(v).toLowerCase()]; }
                l.lightType = AEMCP_num(v, 4413);
                changed.push("lightType");
            }
            return { layer: l.name, changed: changed };
        },

        "comp.rendererSet": function (a) {
            var c = AEMCP_comp(AEMCP_get(a, "comp", "active"));
            var want = AEMCP_get(a, "renderer", null);
            if (want === null) { throw new Error("缺 renderer（先 ae_3d_info 看 comp.renderers 可用列表）"); }
            var avail = [];
            try { var rs = c.renderers; for (var i = 0; i < rs.length; i++) { avail.push(rs[i]); } } catch (e0) { }
            var s = String(want), target = s, k;
            for (k = 0; k < avail.length; k++) {
                if (avail[k] === s || avail[k] === "ADBE " + s) { target = avail[k]; break; }
            }
            c.renderer = target;
            return { comp: c.name, renderer: c.renderer, available: avail };
        },

        /* ==================== P1-B 素材 / 解释 / 代理 / 归类 ==================== */
        "footage.import": function (a) {
            if (AEMCP_get(a, "mode", null) === "placeholder") {
                var ph = app.project.importPlaceholder(
                    String(AEMCP_get(a, "name", "占位符")),
                    AEMCP_num(AEMCP_get(a, "width", 1920), 1920),
                    AEMCP_num(AEMCP_get(a, "height", 1080), 1080),
                    AEMCP_num(AEMCP_get(a, "fps", 30), 30),
                    AEMCP_num(AEMCP_get(a, "duration", 10), 10));
                return { id: ph.id, name: ph.name, type: ph.typeName, placeholder: true };
            }
            var path = AEMCP_get(a, "path", null);
            if (path === null) { throw new Error("缺 path：要导入的文件完整路径"); }
            var f = new File(String(path));
            if (!f.exists) { throw new Error("文件不存在：" + path); }
            var io = new ImportOptions(f);
            if (a.sequence !== undefined && a.sequence !== null) { io.sequence = AEMCP_bool(a.sequence, false); }
            if (a.forceAlphabetical !== undefined && a.forceAlphabetical !== null) { io.forceAlphabetical = AEMCP_bool(a.forceAlphabetical, false); }
            if (a.importAs !== undefined && a.importAs !== null) {
                var IA = { comp_cropped_layers: ImportAsType.COMP_CROPPED_LAYERS, compCroppedLayers: ImportAsType.COMP_CROPPED_LAYERS,
                           footage: ImportAsType.FOOTAGE, comp: ImportAsType.COMP, project: ImportAsType.PROJECT };
                var v = a.importAs;
                if (typeof v === "string" && IA[String(v).toLowerCase()] !== undefined) { io.importAs = IA[String(v).toLowerCase()]; }
                else if (typeof v === "number") { io.importAs = v; }
            }
            var it = app.project.importFile(io);
            return { id: it.id, name: it.name, type: it.typeName, path: path, sequence: io.sequence };
        },

        "footage.importFolder": function (a) {
            var dir = AEMCP_get(a, "folder", null);
            if (dir === null) { throw new Error("缺 folder：要导入的目录路径"); }
            var fd = new Folder(String(dir));
            if (!fd.exists) { throw new Error("目录不存在：" + dir); }
            var exts = " jpg jpeg png tif tiff tga bmp gif psd ai eps svg mov mp4 avi mxf mpg mpeg wmv m4v wav aif aiff mp3 aac flac ";
            var files = fd.getFiles(), imported = [], skipped = [];
            var sequence = AEMCP_bool(AEMCP_get(a, "sequence", false), false);
            for (var i = 0; i < files.length; i++) {
                var f = files[i];
                if (!(f instanceof File)) { continue; }
                var ext = String(f.name).toLowerCase().split(".").pop();
                if (ext === f.name) { ext = ""; }
                if (exts.indexOf(" " + ext + " ") < 0) { skipped.push(f.name); continue; }
                try {
                    var io = new ImportOptions(f);
                    io.sequence = sequence;
                    var it = app.project.importFile(io);
                    imported.push({ id: it.id, name: it.name, type: it.typeName });
                } catch (e) { skipped.push(f.name); }
            }
            return { imported: imported, importedCount: imported.length, skipped: skipped };
        },

        "footage.replace": function (a) {
            var p = app.project;
            var fixExpr = AEMCP_bool(AEMCP_get(a, "fixExpressions", false), false);
            if (a.layer !== undefined && a.layer !== null) {
                var c = AEMCP_comp(AEMCP_get(a, "comp", "active"));
                var l = AEMCP_layer(c, a.layer);
                var path = AEMCP_get(a, "path", null);
                if (path === null) { throw new Error("缺 path：替换成哪个文件"); }
                var nf = new File(String(path));
                if (!nf.exists) { throw new Error("文件不存在：" + path); }
                var newFt = app.project.importFile(new ImportOptions(nf));
                var oldSrc = (l.source ? l.source.name : null);
                l.replaceSource(newFt, fixExpr);
                return { layer: l.name, from: oldSrc, to: newFt.name };
            }
            var it = AEMCP_footage(AEMCP_item(p, AEMCP_get(a, "item", "active")));
            var rmode = String(AEMCP_get(a, "mode", "file"));
            if (rmode === "placeholder") {
                var oldP = it.name;
                it.replaceWithPlaceholder(String(AEMCP_get(a, "name", oldP)),
                                          AEMCP_num(AEMCP_get(a, "width", 1920), 1920),
                                          AEMCP_num(AEMCP_get(a, "height", 1080), 1080),
                                          AEMCP_num(AEMCP_get(a, "fps", 30), 30),
                                          AEMCP_num(AEMCP_get(a, "duration", 10), 10));
                return { id: it.id, from: oldP, to: it.name, mode: rmode };
            }
            if (rmode === "solid") {
                var oldS = it.name;
                var sc = AEMCP_color(AEMCP_get(a, "color", [0, 0, 0]), [0, 0, 0]);
                it.replaceWithSolid([sc[0], sc[1], sc[2]], String(AEMCP_get(a, "name", oldS)),
                                    AEMCP_num(AEMCP_get(a, "width", 1920), 1920),
                                    AEMCP_num(AEMCP_get(a, "height", 1080), 1080),
                                    AEMCP_num(AEMCP_get(a, "pixelAspect", 1), 1));
                return { id: it.id, from: oldS, to: it.name, mode: rmode };
            }
            var path2 = AEMCP_get(a, "path", null);
            if (path2 === null) { throw new Error("缺 path：替换成哪个文件"); }
            var nf2 = new File(String(path2));
            if (!nf2.exists) { throw new Error("文件不存在：" + path2); }
            var old = it.name;
            it.replace(nf2);
            return { id: it.id, from: old, to: it.name };
        },

        "footage.missing": function (a) {
            var p = app.project, out = [], i, it;
            for (i = 1; i <= p.numItems; i++) {
                it = p.item(i);
                if (it instanceof FootageItem && AEMCP_missingOf(it)) {
                    out.push({ id: it.id, name: it.name, type: it.typeName });
                }
            }
            return { missing: out, count: out.length };
        },

        "interpretation.set": function (a) {
            var p = app.project;
            var it = AEMCP_footage(AEMCP_item(p, AEMCP_get(a, "item", "active")));
            var ms = it.mainSource;
            if (AEMCP_bool(AEMCP_get(a, "guess", false), false)) {
                var g = { alphaMode: null, pulldown: null };
                try { ms.guessAlphaMode(); g.alphaMode = ms.alphaMode; } catch (e0) { g.alphaMode = null; }
                try { ms.guessPulldown(PulldownMethod.PULLDOWN_3_2); g.pulldown = "ok"; } catch (e1) { g.pulldown = null; }
                return { item: it.name, guessed: g };
            }
            var changed = [], isStill = false;
            try { isStill = ms.isStill; } catch (e0) { }
            if (a.conformFrameRate !== undefined && a.conformFrameRate !== null) {
                if (isStill) { throw new Error("静帧素材不能设 conformFrameRate（mainSource.isStill=true）"); }
                ms.conformFrameRate = AEMCP_num(a.conformFrameRate, ms.conformFrameRate);
                changed.push("conformFrameRate");
            }
            if (a.alphaMode !== undefined && a.alphaMode !== null) {
                var AM = { ignore: AlphaMode.IGNORE, straight: AlphaMode.STRAIGHT, premultiplied: AlphaMode.PREMULTIPLIED };
                var v = a.alphaMode;
                if (typeof v === "string" && AM[String(v).toLowerCase()] !== undefined) { v = AM[String(v).toLowerCase()]; }
                ms.alphaMode = v;
                changed.push("alphaMode");
            }
            if (a.invertAlpha !== undefined && a.invertAlpha !== null) { ms.invertAlpha = AEMCP_bool(a.invertAlpha, false); changed.push("invertAlpha"); }
            if (a.fieldSeparationType !== undefined && a.fieldSeparationType !== null) {
                var FS = { off: FieldSeparationType.OFF, upper: FieldSeparationType.UPPER_FIELD_FIRST, lower: FieldSeparationType.LOWER_FIELD_FIRST };
                var fv = a.fieldSeparationType;
                if (typeof fv === "string" && FS[String(fv).toLowerCase()] !== undefined) { fv = FS[String(fv).toLowerCase()]; }
                ms.fieldSeparationType = fv;
                changed.push("fieldSeparationType");
            }
            if (a.removePulldown !== undefined && a.removePulldown !== null) { ms.removePulldown = AEMCP_num(a.removePulldown, ms.removePulldown); changed.push("removePulldown"); }
            if (a.loop !== undefined && a.loop !== null) { ms.loop = AEMCP_num(a.loop, ms.loop); changed.push("loop"); }
            if (a.pixelAspect !== undefined && a.pixelAspect !== null) { ms.pixelAspect = AEMCP_num(a.pixelAspect, ms.pixelAspect); changed.push("pixelAspect"); }
            if (a.premulColor !== undefined && a.premulColor !== null) { var pc = AEMCP_color(a.premulColor, [0, 0, 0]); ms.premulColor = [pc[0], pc[1], pc[2]]; changed.push("premulColor"); }
            if (!changed.length) { throw new Error("没有可设置的解释参数（conformFrameRate/alphaMode/invertAlpha/fieldSeparationType/removePulldown/loop/pixelAspect/premulColor）"); }
            return { item: it.name, changed: changed };
        },

        "proxy.set": function (a) {
            var p = app.project;
            var it = AEMCP_item(p, AEMCP_get(a, "item", "active"));
            var d = { id: it.id, name: it.name };
            var path = AEMCP_get(a, "path", null);
            var sequence = AEMCP_bool(AEMCP_get(a, "sequence", false), false);
            if (path !== null) {
                var f = new File(String(path));
                if (!f.exists) { throw new Error("文件不存在：" + path); }
                if (sequence) { it.setProxyWithSequence(f, AEMCP_bool(AEMCP_get(a, "forceAlphabetical", false), false)); }
                else { it.setProxy(f); }
                try { d.proxy = it.proxySource ? it.proxySource.name : null; } catch (e0) { d.proxy = null; }
            } else if (a.solid !== undefined && a.solid !== null) {
                var col = AEMCP_color(a.solid, [0, 0, 0]);
                it.setProxyWithSolid([col[0], col[1], col[2]], String(AEMCP_get(a, "name", it.name + " Proxy")),
                                     AEMCP_num(AEMCP_get(a, "width", 1920), 1920),
                                     AEMCP_num(AEMCP_get(a, "height", 1080), 1080),
                                     AEMCP_num(AEMCP_get(a, "pixelAspect", 1), 1));
                try { d.proxy = it.proxySource ? it.proxySource.name : null; } catch (e1) { d.proxy = null; }
            } else {
                throw new Error("要么给 path（文件代理），要么给 solid（纯色代理，[r,g,b]）");
            }
            try { d.useProxy = it.useProxy; } catch (e2) { d.useProxy = null; }
            return d;
        },

        "proxy.remove": function (a) {
            var p = app.project;
            var it = AEMCP_item(p, AEMCP_get(a, "item", "active"));
            it.setProxyToNone();
            return { id: it.id, name: it.name, useProxy: it.useProxy };
        },

        "item.organize": function (a) {
            var p = app.project;
            if (a.item !== undefined && a.item !== null) {
                var it = AEMCP_item(p, a.item);
                var folderName = AEMCP_get(a, "folder", null);
                if (folderName === null) { throw new Error("缺 folder：移到哪个文件夹（名字，不存在会自动建）"); }
                var fld = AEMCP_folder(folderName);
                it.parentFolder = fld;
                return { moved: [{ id: it.id, name: it.name, folder: fld.name }], folder: fld.name };
            }
            if (AEMCP_bool(AEMCP_get(a, "byType", false), false)) {
                var map = { comp: "Comps", solid: "Solids", video: "Video", image: "Images", audio: "Audio", footage: "Footage" };
                var moved = [], usedFolders = {}, i, item, kind, f2, k2;
                for (i = 1; i <= p.numItems; i++) {
                    item = p.item(i);
                    try { if (item.parentFolder !== p.rootFolder) { continue; } } catch (e1) { continue; }
                    if (item === p.rootFolder) { continue; }
                    kind = null;
                    if (item instanceof CompItem) { kind = "comp"; }
                    else if (item instanceof FolderItem) { continue; }
                    else if (item instanceof FootageItem) {
                        var ms = item.mainSource;
                        try {
                            var isSolidSrc = (ms.color !== undefined);
                            var hasV = ms.hasVideo, hasA = ms.hasAudio, isImg = ms.isStill;
                            if (isSolidSrc) { kind = "solid"; }
                            else if (hasA && !hasV) { kind = "audio"; }
                            else if (hasV && isImg) { kind = "image"; }
                            else if (hasV) { kind = "video"; }
                            else { kind = "footage"; }
                        } catch (e2) { kind = "footage"; }
                    }
                    if (!kind) { continue; }
                    var fn = map[kind] || "Footage";
                    f2 = AEMCP_folder(fn);
                    usedFolders[fn] = true;
                    item.parentFolder = f2;
                    moved.push({ id: item.id, name: item.name, folder: fn });
                }
                var folders = [];
                for (k2 in usedFolders) { if (usedFolders.hasOwnProperty(k2)) { folders.push(k2); } }
                return { moved: moved, folders: folders };
            }
            throw new Error("要么给 item+folder 移动单条，要么 byType=true 按类型归类顶层条目");
        },

        /* ==================== P1-C 路径 / 形状算子 ==================== */
        "path.create": function (a) {
            var c = AEMCP_comp(AEMCP_get(a, "comp", "active"));
            var l = AEMCP_layer(c, AEMCP_get(a, "layer", null));
            var group = AEMCP_vectorGroup(l, AEMCP_get(a, "group", null));
            var verts = AEMCP_get(a, "vertices", null);
            if (verts === null || !(verts instanceof Array) || verts.length < 2) {
                throw new Error("缺 vertices：顶点数组 [[x,y],[x,y],...]，至少 2 个点");
            }
            var sh = new Shape(), i, n = verts.length;
            var vArr = [], inArr = [], outArr = [];
            for (i = 0; i < n; i++) { vArr.push([AEMCP_num(verts[i][0], 0), AEMCP_num(verts[i][1], 0)]); }
            var inT = AEMCP_get(a, "inTangents", null);
            var outT = AEMCP_get(a, "outTangents", null);
            for (i = 0; i < n; i++) {
                inArr.push((inT && inT[i]) ? [AEMCP_num(inT[i][0], 0), AEMCP_num(inT[i][1], 0)] : [0, 0]);
                outArr.push((outT && outT[i]) ? [AEMCP_num(outT[i][0], 0), AEMCP_num(outT[i][1], 0)] : [0, 0]);
            }
            sh.vertices = vArr; sh.inTangents = inArr; sh.outTangents = outArr;
            sh.closed = AEMCP_bool(AEMCP_get(a, "closed", true), true);
            var pg = group.addProperty("ADBE Vector Shape - Group");
            pg.property("ADBE Vector Shape").setValue(sh);
            var nm = AEMCP_get(a, "name", null);
            if (nm !== null) { try { pg.name = String(nm); } catch (e0) { } }
            return { layer: l.name, path: pg.name, closed: sh.closed, vertexCount: n,
                     note: "顶点坐标是图层空间（非合成空间）" };
        },

        "path.get": function (a) {
            var c = AEMCP_comp(AEMCP_get(a, "comp", "active"));
            var l = AEMCP_layer(c, AEMCP_get(a, "layer", null));
            var group = AEMCP_vectorGroup(l, AEMCP_get(a, "group", null));
            var pg = AEMCP_shapePath(group, AEMCP_get(a, "path", 1));
            var sh = pg.property("ADBE Vector Shape").value;
            return { layer: l.name, path: pg.name, closed: sh.closed,
                     vertices: sh.vertices, inTangents: sh.inTangents, outTangents: sh.outTangents,
                     vertexCount: sh.vertices.length };
        },

        "path.set": function (a) {
            var c = AEMCP_comp(AEMCP_get(a, "comp", "active"));
            var l = AEMCP_layer(c, AEMCP_get(a, "layer", null));
            var group = AEMCP_vectorGroup(l, AEMCP_get(a, "group", null));
            var pg = AEMCP_shapePath(group, AEMCP_get(a, "path", 1));
            var sp = pg.property("ADBE Vector Shape");
            var old = sp.value;
            var verts = AEMCP_get(a, "vertices", null);
            if (verts === null || !(verts instanceof Array) || verts.length < 2) {
                throw new Error("缺 vertices：顶点数组 [[x,y],...]");
            }
            var sh = new Shape(), i, n = verts.length;
            var vArr = [], inArr = [], outArr = [];
            for (i = 0; i < n; i++) { vArr.push([AEMCP_num(verts[i][0], 0), AEMCP_num(verts[i][1], 0)]); }
            var inT = AEMCP_get(a, "inTangents", null);
            var outT = AEMCP_get(a, "outTangents", null);
            for (i = 0; i < n; i++) {
                inArr.push((inT && inT[i]) ? [AEMCP_num(inT[i][0], 0), AEMCP_num(inT[i][1], 0)] : [0, 0]);
                outArr.push((outT && outT[i]) ? [AEMCP_num(outT[i][0], 0), AEMCP_num(outT[i][1], 0)] : [0, 0]);
            }
            sh.vertices = vArr; sh.inTangents = inArr; sh.outTangents = outArr;
            sh.closed = AEMCP_bool(AEMCP_get(a, "closed", old.closed), old.closed);
            sp.setValue(sh);
            return { layer: l.name, path: pg.name, vertexCount: sp.value.vertices.length,
                     closed: sp.value.closed, note: "改关键帧路径点数须与相邻帧一致，否则 AE 按顶点一致性规则处理" };
        },

        "shape.operatorAdd": function (a) {
            var c = AEMCP_comp(AEMCP_get(a, "comp", "active"));
            var l = AEMCP_layer(c, AEMCP_get(a, "layer", null));
            var op = AEMCP_get(a, "operator", null);
            if (op === null) { throw new Error("缺 operator：repeater/trim/offset/merge/roundCorners/puckerBloat/twist"); }
            var mn = AEMCP_shapeOpMatch(op);
            if (!mn) { throw new Error("未知算子：" + op + "（支持 repeater/trim/offset/merge/roundCorners/puckerBloat/twist）"); }
            var group = AEMCP_vectorGroup(l, AEMCP_get(a, "group", null));
            var og = group.addProperty(mn);
            var nm = AEMCP_get(a, "name", null);
            if (nm !== null) { try { og.name = String(nm); } catch (e0) { } }
            var applied = AEMCP_shapeOpApply(og, String(op).toLowerCase(), AEMCP_get(a, "params", null));
            var plist = [], k;
            for (k = 1; k <= og.numProperties; k++) {
                var pp = og.property(k);
                if (pp.numProperties === undefined || pp.propertyValueType !== undefined) {
                    plist.push({ name: pp.name, matchName: pp.matchName, value: AEMCP_val(pp) });
                }
            }
            return { layer: l.name, operator: op, matchName: mn, name: og.name,
                     applied: applied, parameters: plist };
        },

        "shape.operatorSet": function (a) {
            var c = AEMCP_comp(AEMCP_get(a, "comp", "active"));
            var l = AEMCP_layer(c, AEMCP_get(a, "layer", null));
            var op = AEMCP_get(a, "operator", null);
            if (op === null) { throw new Error("缺 operator：repeater/trim/offset/merge/roundCorners/puckerBloat/twist"); }
            var mn = AEMCP_shapeOpMatch(op);
            if (!mn) { throw new Error("未知算子：" + op); }
            var group = AEMCP_vectorGroup(l, AEMCP_get(a, "group", null));
            var og = AEMCP_shapeOperator(group, mn, AEMCP_get(a, "index", null));
            var applied = AEMCP_shapeOpApply(og, String(op).toLowerCase(), AEMCP_get(a, "params", null));
            if (!applied.length) { throw new Error("缺 params：要改哪些参数（copies/offset/start/end/amount/radius/angle/mode 等）"); }
            return { layer: l.name, operator: op, name: og.name, applied: applied };
        },

        /* ==================== P1-D 渲染队列 ==================== */
        "rq.list": function (a) {
            var rq = app.project.renderQueue, out = [], i, j, it, om, st;
            for (i = 1; i <= rq.numItems; i++) {
                it = rq.item(i);
                st = null;
                try { st = it.status; } catch (e0) { }
                var oms = [];
                for (j = 1; j <= it.numOutputModules; j++) {
                    om = it.outputModule(j);
                    oms.push({ index: j, file: om.file ? om.file.fsName : null });
                }
                out.push({ index: i, comp: (it.comp ? it.comp.name : null), status: AEMCP_rqStatusName(st),
                           statusCode: st, render: (it.render === true), outputModules: oms });
            }
            return { items: out, count: rq.numItems };
        },

        "rq.itemSet": function (a) {
            var rq = app.project.renderQueue;
            var idx = AEMCP_num(AEMCP_get(a, "index", 1), 1);
            if (idx < 1 || idx > rq.numItems) { throw new Error("渲染队列下标越界：" + idx + "（队列有 " + rq.numItems + " 项）"); }
            var it = rq.item(idx);
            var d = { index: idx, comp: (it.comp ? it.comp.name : null), changed: [] };
            if (a.render !== undefined && a.render !== null) { it.render = AEMCP_bool(a.render, false); d.changed.push("render"); }
            if (a.timeSpanStart !== undefined && a.timeSpanStart !== null) { it.timeSpanStart = AEMCP_num(a.timeSpanStart, 0); d.changed.push("timeSpanStart"); }
            if (a.timeSpanDuration !== undefined && a.timeSpanDuration !== null) { it.timeSpanDuration = AEMCP_num(a.timeSpanDuration, 0); d.changed.push("timeSpanDuration"); }
            var omIdx = AEMCP_num(AEMCP_get(a, "outputModule", 1), 1);
            var om = it.outputModule(omIdx);
            var template = AEMCP_get(a, "template", null);
            if (template !== null) { om.applyTemplate(String(template)); d.changed.push("template"); }
            var path = AEMCP_get(a, "outputPath", null);
            if (path !== null) { om.file = new File(String(path)); d.changed.push("outputPath"); }
            d.outputFile = om.file ? om.file.fsName : null;
            return d;
        },

        "rq.remove": function (a) {
            var rq = app.project.renderQueue, removed = [];
            if (AEMCP_bool(AEMCP_get(a, "all", false), false)) {
                while (rq.numItems > 0) {
                    removed.push(rq.item(1).comp ? rq.item(1).comp.name : "(空)");
                    rq.item(1).remove();
                }
            } else {
                var idx = AEMCP_num(AEMCP_get(a, "index", 1), 1);
                if (idx < 1 || idx > rq.numItems) { throw new Error("渲染队列下标越界：" + idx); }
                removed.push(rq.item(idx).comp ? rq.item(idx).comp.name : "(空)");
                rq.item(idx).remove();
            }
            return { removed: removed, numItems: rq.numItems };
        },

        "rq.templates": function (a) {
            var rq = app.project.renderQueue, omTemplates = [], rqTemplates = [], i;
            if (rq.numItems > 0) {
                var it = rq.item(1), om = it.outputModule(1);
                try { for (i = 0; i < om.templates.length; i++) { omTemplates.push(om.templates[i]); } } catch (e0) { }
                try { for (i = 0; i < it.templates.length; i++) { rqTemplates.push(it.templates[i]); } } catch (e1) { }
            }
            return { outputModuleTemplates: omTemplates, renderSettingsTemplates: rqTemplates,
                     note: "队列为空时模板列表不可读：先加一项（ae_render_queue_item_set 或渲染队列加合成）再看" };
        },

        "rq.frame": function (a) {
            var c = AEMCP_comp(AEMCP_get(a, "comp", "active"));
            var t = AEMCP_num(AEMCP_get(a, "time", 0), 0);
            var path = AEMCP_get(a, "path", null);
            if (path === null) { throw new Error("缺 path：PNG 输出完整路径（纯 ASCII 更稳）"); }
            var f = new File(String(path));
            var parent = f.parent;
            if (!parent.exists) { parent.create(); }
            var d = { comp: c.name, time: t, path: path };
            app.beginSuppressDialogs();
            try { c.saveFrameToPng(t, f); }
            catch (e) { app.endSuppressDialogs(false); throw e; }
            app.endSuppressDialogs(false);
            var waited = 0;
            while (waited < 10000) {
                if (f.exists) { break; }
                $.sleep(100);
                waited += 100;
            }
            d.written = f.exists;
            d.size = f.exists ? f.length : 0;
            return d;
        },

        "rq.control": function (a) {
            var action = String(AEMCP_get(a, "action", "")).toLowerCase();
            var rq = app.project.renderQueue;
            if (action === "pause") { rq.pauseRendering(true); return { action: "pause", note: "已调用 pauseRendering(true)（只在渲染进行中生效，true=暂停）" }; }
            if (action === "resume") { rq.pauseRendering(false); return { action: "resume", note: "已调用 pauseRendering(false)（恢复渲染）" }; }
            if (action === "stop") { rq.stopRendering(); return { action: "stop", note: "已调用 stopRendering()（只在渲染进行中生效）" }; }
            if (action === "render" || action === "start") {
                throw new Error("不支持直接 render()：render() 会阻塞 AE 主线程直到渲染完成，脚本无法中途回报进度。"
                    + "请用 ae_render_queue_item_set 设好队列后在 AE 界面点「渲染」，或命令行 aerender。");
            }
            throw new Error("未知 action：" + action + "（支持 pause/stop）");
        },

        /* ==================== P1-E 文字动画器 ==================== */
        "text.animatorAdd": function (a) {
            var c = AEMCP_comp(AEMCP_get(a, "comp", "active"));
            var l = AEMCP_layer(c, AEMCP_get(a, "layer", null));
            var td = null;
            try { td = l.property("ADBE Text Properties").property("ADBE Text Document"); } catch (e0) { td = null; }
            if (!td) { throw new Error("这个图层不是文字层（没有 ADBE Text Document）"); }
            var anims = l.property("ADBE Text Properties").property("ADBE Text Animators");
            var anim = anims.addProperty("ADBE Text Animator");
            var nm = AEMCP_get(a, "name", null);
            if (nm !== null) { try { anim.name = String(nm); } catch (e1) { } }
            var sels = anim.property("ADBE Text Selectors");
            var selInfo = null;
            if (AEMCP_bool(AEMCP_get(a, "selector", true), true) && sels.numProperties === 0) {
                var sel = sels.addProperty("ADBE Text Selector");
                selInfo = { name: sel.name, matchName: sel.matchName };
            }
            var props = anim.property("ADBE Text Animator Properties");
            var propList = AEMCP_get(a, "properties", null);
            var added = [];
            if (propList instanceof Array) {
                for (var i = 0; i < propList.length; i++) {
                    var mn = AEMCP_animPropMatch(propList[i]);
                    if (!mn) { added.push({ key: propList[i], error: "未知动画器属性（position/opacity/scale/rotation/fillColor，或 ADBE 开头 matchName）" }); continue; }
                    var pp = props.addProperty(mn);
                    added.push({ key: propList[i], matchName: mn, name: pp.name });
                }
            }
            return { layer: l.name, animator: anim.name, selector: selInfo, addedProperties: added,
                     note: "新增动画器默认带一个范围选择器；用 ae_text_selector_set 调起止/高级参数" };
        },

        "text.selectorSet": function (a) {
            var c = AEMCP_comp(AEMCP_get(a, "comp", "active"));
            var l = AEMCP_layer(c, AEMCP_get(a, "layer", null));
            var td = null;
            try { td = l.property("ADBE Text Properties").property("ADBE Text Document"); } catch (e0) { td = null; }
            if (!td) { throw new Error("这个图层不是文字层"); }
            var anims = l.property("ADBE Text Properties").property("ADBE Text Animators");
            var animRef = AEMCP_get(a, "animator", 1), anim = null, i, j;
            if (String(animRef).match(/^\d+$/)) {
                var ai = parseInt(animRef, 10);
                if (ai < 1 || ai > anims.numProperties) { throw new Error("动画器下标越界：" + animRef + "（共 " + anims.numProperties + " 个）"); }
                anim = anims.property(ai);
            } else {
                for (i = 1; i <= anims.numProperties; i++) { if (anims.property(i).name === String(animRef)) { anim = anims.property(i); break; } }
                if (!anim) { throw new Error("找不到动画器：" + animRef); }
            }
            var sels = anim.property("ADBE Text Selectors");
            var selRef = AEMCP_get(a, "selector", 1), sel = null;
            if (String(selRef).match(/^\d+$/)) {
                var si = parseInt(selRef, 10);
                if (si < 1 || si > sels.numProperties) { throw new Error("选择器下标越界：" + selRef); }
                sel = sels.property(si);
            } else {
                for (i = 1; i <= sels.numProperties; i++) { if (sels.property(i).name === String(selRef)) { sel = sels.property(i); break; } }
                if (!sel) { throw new Error("找不到选择器：" + selRef); }
            }
            var changed = [];
            var specs = [
                ["start", "ADBE Text Percent Start", "num"],
                ["end", "ADBE Text Percent End", "num"],
                ["offset", "ADBE Text Percent Offset", "num"]
            ];
            for (i = 0; i < specs.length; i++) {
                if (AEMCP_setNamed(sel, specs[i][1], a, specs[i][0], specs[i][2])) { changed.push(specs[i][0]); }
            }
            var adv = null;
            try { adv = sel.property("ADBE Text Range Advanced"); } catch (e1) { adv = null; }
            if (adv) {
                var advSpecs = [
                    ["units", "ADBE Text Range Units", "num"],
                    ["mode", "ADBE Text Selector Mode", "num"],
                    ["amount", "ADBE Text Selector Max Amount", "num"],
                    ["smoothness", "ADBE Text Selector Smoothness", "num"],
                    ["easeHigh", "ADBE Text Levels Max Ease", "num"],
                    ["easeLow", "ADBE Text Levels Min Ease", "num"]
                ];
                for (i = 0; i < advSpecs.length; i++) {
                    if (AEMCP_setNamed(adv, advSpecs[i][1], a, advSpecs[i][0], advSpecs[i][2])) { changed.push(advSpecs[i][0]); }
                }
            }
            if (!changed.length) { throw new Error("没有可设置的参数（start/end/offset/units/mode/amount/smoothness/easeHigh/easeLow）"); }
            return { layer: l.name, animator: anim.name, selector: sel.name, changed: changed };
        },

        "text.animatorList": function (a) {
            var c = AEMCP_comp(AEMCP_get(a, "comp", "active"));
            var l = AEMCP_layer(c, AEMCP_get(a, "layer", null));
            var td = null;
            try { td = l.property("ADBE Text Properties").property("ADBE Text Document"); } catch (e0) { td = null; }
            if (!td) { throw new Error("这个图层不是文字层"); }
            var anims = l.property("ADBE Text Properties").property("ADBE Text Animators");
            var out = [], i, j, k;
            for (i = 1; i <= anims.numProperties; i++) {
                var anim = anims.property(i);
                var sels = anim.property("ADBE Text Selectors");
                var selList = [];
                for (j = 1; j <= sels.numProperties; j++) {
                    var sp = sels.property(j);
                    selList.push({ name: sp.name, matchName: sp.matchName });
                }
                var props = anim.property("ADBE Text Animator Properties");
                var propList = [];
                for (k = 1; k <= props.numProperties; k++) {
                    propList.push({ name: props.property(k).name, matchName: props.property(k).matchName });
                }
                out.push({ index: i, name: anim.name, matchName: anim.matchName,
                           selectors: selList, animatorProperties: propList });
            }
            return { layer: l.name, animators: out, count: anims.numProperties };
        },

        /* ---- v0.8 缺口补齐：应用/工程管理 ---- */
        "project.save": function (a) {
            var p = app.project, mode = String(AEMCP_get(a, "mode", "save"));
            if (mode === "save") {
                if (!p.file) { throw new Error("工程还没保存过（file 是 null）：用 mode=saveWithDialog 弹保存框，或先在 AE 里另存一次"); }
                p.save();
            } else if (mode === "saveWithDialog") {
                p.saveWithDialog();
            } else if (mode === "close") {
                var sv = String(AEMCP_get(a, "save", "prompt"));
                var opt = CloseOptions.PROMPT_TO_SAVE_CHANGES;
                if (sv === "no") { opt = CloseOptions.DO_NOT_SAVE_CHANGES; }
                else if (sv === "yes") { opt = CloseOptions.SAVE_CHANGES; }
                p.close(opt);
            } else {
                throw new Error("mode 必须是 save / saveWithDialog / close");
            }
            return { file: p.file ? p.file.fsName : null,
                     dirty: (function () { try { return p.dirty ? true : false; } catch (e) { return null; } })() };
        },

        "project.settings": function (a) {
            var p = app.project;
            var r = AEMCP_setFields(p, a, ["bitsPerChannel", "expressionEngine", "gpuAccelType",
                                            "linearBlending", "linearizeWorkingSpace",
                                            "transparencyGridThumbnails", "toolType"]);
            return { changed: r.changed, before: r.before, after: r.after };
        },

        "project.colorspace": function (a) {
            var p = app.project;
            var r = AEMCP_setFields(p, a, ["workingSpace", "workingGamma", "compensateForSceneReferredProfiles"]);
            var profiles = null;
            try { profiles = p.listColorProfiles(); } catch (e0) { profiles = null; }
            return { changed: r.changed, before: r.before, after: r.after, profiles: profiles };
        },

        "project.timecode": function (a) {
            var p = app.project;
            var r = AEMCP_setFields(p, a, ["displayStartFrame", "timeDisplayType", "framesCountType",
                                            "framesUseFeetFrames", "feetFramesFilmType",
                                            "footageTimecodeDisplayStartType"]);
            return { changed: r.changed, before: r.before, after: r.after };
        },

        "project.font": function (a) {
            var p = app.project, used = null, available = (typeof p.usedFonts !== "undefined");
            if (available) {
                try { used = p.usedFonts; } catch (e0) { used = null; }
            }
            var fromF = (a && a.replace) ? (a.replace.from || a.from) : a.from;
            var toF = (a && a.replace) ? (a.replace.to || a.to) : a.to;
            if (fromF && toF) {
                if (!available) { throw new Error("字体替换需要 AE 24.5+（当前 " + app.version + "）；usedFonts/replaceFont/replaceFonts 均为 24.5+ API"); }
                var c = AEMCP_get(a, "comp", null);
                if (c) { AEMCP_comp(c).replaceFonts(String(fromF), String(toF)); }
                else { p.replaceFont(String(fromF), String(toF)); }
            }
            return { usedFonts: used, note: available ? null : "usedFonts/replaceFont 需要 AE 24.5+（当前 " + app.version + "）", replaced: (fromF && toF) ? { from: fromF, to: toF } : null };
        },

        /* ==== v1.1：AE 25.1+ 字体检查（hasGlyphsFor / getCTScriptForString） ==== */
        "font.check": function (a) {
            if (typeof app.fonts === "undefined" || typeof app.fonts.getFontsByPostScriptName !== "function") {
                throw new Error("字体检查需要 AE 25.1+（当前 " + app.version + "）：hasGlyphsFor/getCTScriptForString 均为 25.1 新 API");
            }
            var mode = String(AEMCP_get(a, "mode", "hasGlyphs"));
            if (mode === "hasGlyphs") {
                var psn = AEMCP_get(a, "font", null);
                var txt = AEMCP_get(a, "text", null);
                if (!psn) { throw new Error("hasGlyphs 需要 font（字体 PostScript 名，如 ArialMT）"); }
                if (!txt) { throw new Error("hasGlyphs 需要 text（要检查的字符串）"); }
                var arr = null;
                try { arr = app.fonts.getFontsByPostScriptName(String(psn)); } catch (e1) { arr = null; }
                var fo = (arr && arr.length > 0) ? arr[0] : null;
                if (!fo) { throw new Error("找不到字体：" + psn + "（PostScript 名要精确；不匹配会返回空数组）"); }
                return { mode: mode, font: String(psn), text: String(txt), hasGlyphs: (fo.hasGlyphsFor(String(txt)) ? true : false) };
            }
            if (mode === "ctScript") {
                var s = AEMCP_get(a, "text", null);
                if (!s) { throw new Error("ctScript 需要 text（要判脚本的字符串）"); }
                var pref = AEMCP_get(a, "preferredScript", null);
                var scriptMap = [["roman", 12212], ["japanese", 12213], ["trad_chinese", 12214], ["korean", 12215],
                                 ["arabic", 12216], ["hebrew", 12217], ["greek", 12218], ["cyrillic", 12219],
                                 ["simp_chinese", 12237]];
                var prefV = (pref === null || pref === undefined) ? 12212 : AEMCP_enumPick(pref, scriptMap, "preferredScript");
                var r = app.fonts.getCTScriptForString(String(s), prefV);
                var out = [], i;
                for (i = 0; i < r.length; i++) { out.push({ chars: r[i].chars, ctScript: r[i].ctScript }); }
                return { mode: mode, text: String(s), ranges: out };
            }
            throw new Error("mode 必须是 hasGlyphs / ctScript");
        },

        "project.xmp": function (a) {
            var p = app.project;
            if (a && a.xmp !== undefined) { p.xmpPacket = String(a.xmp); }
            var out = null;
            try { out = p.xmpPacket; } catch (e0) { out = null; }
            return { xmpPacket: out };
        },

        "project.consolidate": function (a) {
            var p = app.project, mode = String(AEMCP_get(a, "mode", "consolidate")), n;
            if (mode === "consolidate") { n = p.consolidateFootage(); }
            else if (mode === "removeUnused") { n = p.removeUnusedFootage(); }
            else { throw new Error("mode 必须是 consolidate / removeUnused"); }
            return { mode: mode, removed: AEMCP_num(n, 0) };
        },

        "project.reduce": function (a) {
            var p = app.project, items = AEMCP_get(a, "items", []),
                comps = AEMCP_get(a, "comps", []), keep = [], i;
            for (i = 0; i < items.length; i++) { keep.push(AEMCP_item(p, items[i])); }
            for (i = 0; i < comps.length; i++) { keep.push(AEMCP_item(p, comps[i])); }
            if (keep.length === 0) { throw new Error("items 或 comps 至少要给一个要保留的项"); }
            p.reduceProject(keep);
            return { kept: keep.length, note: "破坏性操作：只保留传入的项，其余全删，建议先 checkpoint.save" };
        },

        "project.autofix": function (a) {
            var p = app.project, from = String(AEMCP_get(a, "from", "")),
                to = String(AEMCP_get(a, "to", ""));
            if (!from) { throw new Error("缺 from（要修正的旧表达式文本/旧名）"); }
            p.autoFixExpressions(from, to);
            return { from: from, to: to, note: "autoFixExpressions(oldText, newText) 返回 Nothing，已把失效表达式里的旧文本替换为新文本" };
        },

        "app.cache": function (a) {
            var mode = String(AEMCP_get(a, "mode", "purge"));
            if (mode === "purge") {
                var t = AEMCP_get(a, "target", "all");
                var tg = PurgeTarget.ALL_CACHES;
                if (typeof t === "number") { tg = t; }
                else if (t === "all") { tg = PurgeTarget.ALL_CACHES; }
                else { throw new Error("target 支持 'all'（PurgeTarget.ALL_CACHES）或 PurgeTarget 枚举数值（子目标名随 AE 版本而异，请传数值）"); }
                app.purge(tg);
                return { mode: mode, target: (typeof t === "number") ? t : "all" };
            }
            if (mode === "memory") {
                app.setMemoryUsageLimits(AEMCP_num(AEMCP_get(a, "imageCachePercent", 50), 50),
                                         AEMCP_num(AEMCP_get(a, "memoryPercent", 50), 50));
                return { mode: mode, imageCachePercent: AEMCP_num(AEMCP_get(a, "imageCachePercent", 50), 50),
                         memoryPercent: AEMCP_num(AEMCP_get(a, "memoryPercent", 50), 50) };
            }
            if (mode === "disableRendering") {
                var dr = AEMCP_bool(AEMCP_get(a, "disable", true), true);
                app.disableRendering = dr;
                return { mode: mode, disable: dr };
            }
            throw new Error("mode 必须是 purge / memory / disableRendering");
        },

        /* ==== P3 Batch B：项目项 / 素材 ==== */
        "item.set": function (a) {
            var p = app.project;
            var it = AEMCP_item(p, AEMCP_get(a, "item", "active"));
            var r = AEMCP_setFields(it, a, ["comment", "label", "selected"]);
            return { id: it.id, name: it.name, changed: r.changed, before: r.before, after: r.after };
        },

        "footage.reload": function (a) {
            var p = app.project;
            var it = AEMCP_item(p, AEMCP_get(a, "item", "active"));
            var ms = null;
            try { ms = it.mainSource; } catch (e0) { ms = null; }
            if (!ms) { throw new Error("这一项没有 mainSource（不是素材）：" + it.name); }
            if (typeof ms.reload !== "function") { throw new Error("这个源的 reload 不可用"); }
            ms.reload();
            return { id: it.id, name: it.name, reloaded: true };
        },

        /* ==== P3 Batch C：合成 ==== */
        "comp.motionBlur": function (a) {
            var c = AEMCP_comp(AEMCP_get(a, "comp", "active"));
            var r = AEMCP_setFields(c, a, ["motionBlur", "motionBlurSamples", "shutterAngle", "shutterPhase"]);
            return { comp: c.name, changed: r.changed, before: r.before, after: r.after };
        },

        "comp.exportMogrt": function (a) {
            var c = AEMCP_comp(AEMCP_get(a, "comp", "active"));
            var path = AEMCP_get(a, "path", null);
            var name = AEMCP_get(a, "templateName", null);
            var over = AEMCP_bool(AEMCP_get(a, "overwrite", false), false);
            var id = c.id, compName = c.name;
            var cc = 0;
            try { cc = c.motionGraphicsTemplateControllerCount; } catch (e00) { cc = 0; }
            if (cc === 0) {
                throw new Error("合成“" + compName + "”没有 EGP 可控参数（controllerCount=0），AE 会静默拒绝导出；请先用 ae_mogrt_param 的 mode=add/addAs 添加至少一个可控属性（滑块/颜色/复选框/源文本）再导出");
            }
            if (!app.project.file) {
                throw new Error("导出 MOGRT 前必须先保存工程（app.project.file 为空时 AE 18.0 会卡死/静默失败）；请先用 ae_project_save mode=save 保存一次");
            }
            // AE 18.0 的第二个参数是「目标目录」，文件名来自 motionGraphicsTemplateName。
            // path 可传目录或完整 .mogrt 文件路径（自动取父目录 + 文件名）。
            var dir = null, fileBase = null;
            if (path !== null && path !== undefined) {
                var p = String(path);
                var slash = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
                var base = (slash >= 0) ? p.substring(slash + 1) : p;
                dir = (slash >= 0) ? p.substring(0, slash + 1) : "";
                if (/\.mogrt$/i.test(base)) { base = base.substring(0, base.length - 6); }
                if (base !== "" && name === null) { name = base; }
            }
            if (name === null || name === undefined || String(name) === "") { name = compName; }
            var nm = String(name);
            if (/\.mogrt$/i.test(nm)) { nm = nm.substring(0, nm.length - 6); }
            try { c.motionGraphicsTemplateName = nm; } catch (e0) { }
            var ok = false, err = null;
            app.beginSuppressDialogs();
            try {
                if (dir !== null && dir !== "") { ok = c.exportAsMotionGraphicsTemplate(over, dir); }
                else { ok = c.exportAsMotionGraphicsTemplate(over); }
            } catch (e1) { err = AEMCP_es(e1); }
            app.endSuppressDialogs(false);
            var brief = null;
            try {
                var i;
                for (i = 1; i <= app.project.numItems; i++) {
                    if (app.project.item(i).id === id) { brief = AEMCP_compBrief(app.project.item(i)); break; }
                }
            } catch (e2) { }
            var outFile = null;
            if (ok && dir !== null && dir !== "") { outFile = dir + nm + ".mogrt"; }
            return { name: compName, id: id, dir: dir,
                     templateName: nm,
                     file: outFile, overwrite: over, ok: !!ok, error: err, controllerCount: cc, comp: brief };
        },

        "comp.mogrtParam": function (a) {
            var c = AEMCP_comp(AEMCP_get(a, "comp", "active"));
            var l = AEMCP_layer(c, AEMCP_get(a, "layer", null));
            var p = AEMCP_prop(l, AEMCP_get(a, "property", null));
            // 若解析到的是效果组（PropertyGroup），自动下钻取第一个可加入 EGP 的值属性（滑块/颜色/复选框等）
            var canDirect = false;
            try { canDirect = !!p.canAddToMotionGraphicsTemplate(c); } catch (e0) { canDirect = false; }
            if (!canDirect) {
                var np = 0;
                try { np = p.numProperties; } catch (e1) { np = 0; }
                if (np > 0) {
                    for (var ci = 1; ci <= np; ci++) {
                        var child = p.property(ci);
                        var childCan = false;
                        try { childCan = !!child.canAddToMotionGraphicsTemplate(c); } catch (e2) { childCan = false; }
                        if (childCan) { p = child; break; }
                    }
                }
            }
            var mode = String(AEMCP_get(a, "mode", "check"));
            var name = AEMCP_get(a, "name", null);
            app.beginSuppressDialogs();
            try {
                if (mode === "check") {
                    return { layer: l.name, property: p.name, canAdd: !!p.canAddToMotionGraphicsTemplate(c) };
                }
                if (mode === "add") {
                    return { layer: l.name, property: p.name, added: !!p.addToMotionGraphicsTemplate(c) };
                }
                if (mode === "addAs") {
                    if (name === null || name === undefined) { throw new Error("addAs 需要 name（自定义 EGP 显示名）"); }
                    return { layer: l.name, property: p.name, added: !!p.addToMotionGraphicsTemplateAs(c, String(name)), name: String(name) };
                }
                throw new Error("mode 必须是 check / add / addAs");
            } finally {
                app.endSuppressDialogs(false);
            }
        },

        /* ==== P3 Batch D：图层 ==== */
        "layer.switch": function (a) {
            var c = AEMCP_comp(AEMCP_get(a, "comp", "active"));
            var l = AEMCP_layer(c, AEMCP_get(a, "layer", null));
            var plain = ["stretch", "label", "collapseTransformation", "preserveTransparency", "guideLayer", "effectsActive", "environmentLayer"];
            var r = AEMCP_setFields(l, a, plain);
            var before = {}, after = {}, changed = [], i, k;
            for (i = 0; i < r.changed.length; i++) { changed.push(r.changed[i]); }
            for (i = 0; i < plain.length; i++) { k = plain[i]; before[k] = r.before[k]; after[k] = r.after[k]; }
            var enums = [
                ["quality", [["best", 4612], ["draft", 4614], ["wireframe", 4615]]],
                ["samplingQuality", [["bilinear", 4812], ["bicubic", 4813]]],
                ["frameBlendingType", [["frame_mixing", 4012], ["pixel_motion", 4013]]],
                ["autoOrient", [["no_auto_orient", 4212], ["path", 4213], ["camera", 4214], ["time", 4215]]]
            ];
            for (i = 0; i < enums.length; i++) {
                var e = enums[i], field = e[0], map = e[1];
                try { before[field] = l[field]; } catch (e0) { before[field] = null; }
                if (a && a[field] !== undefined) {
                    try { l[field] = AEMCP_enumPick(a[field], map, field); }
                    catch (e1) { throw new Error("写 " + field + " 失败：" + AEMCP_es(e1)); }
                    changed.push(field);
                }
                try { after[field] = l[field]; } catch (e2) { after[field] = null; }
            }
            return { layer: l.name, changed: changed, before: before, after: after };
        },

        "layer.timeRemap": function (a) {
            var c = AEMCP_comp(AEMCP_get(a, "comp", "active"));
            var l = AEMCP_layer(c, AEMCP_get(a, "layer", null));
            var v = AEMCP_get(a, "enabled", null);
            var before = null, after = null;
            var canSet = false;
            try { canSet = !!l.canSetTimeRemapEnabled; } catch (e0) { canSet = false; }
            try { before = l.timeRemapEnabled; } catch (e1) { before = null; }
            if (v !== null && v !== undefined) {
                if (canSet !== true) {
                    throw new Error("图层“" + l.name + "”不能设置时间重映射（canSetTimeRemapEnabled=false）；只有带时长源的图层（素材/合成）支持，纯色/文字/灯光/摄像机不支持");
                }
                l.timeRemapEnabled = AEMCP_bool(v, false);
            }
            try { after = l.timeRemapEnabled; } catch (e2) { after = null; }
            return { layer: l.name, before: before, after: after, canSet: canSet };
        },

        /* ==== P3 Batch E：关键帧 / 属性 / 蒙版 ==== */
        "keyframe.edit": function (a) {
            var c = AEMCP_comp(AEMCP_get(a, "comp", "active"));
            var l = AEMCP_layer(c, AEMCP_get(a, "layer", null));
            var p = AEMCP_prop(l, AEMCP_get(a, "property", null));
            var mode = String(AEMCP_get(a, "mode", "addKey"));
            var key = AEMCP_num(AEMCP_get(a, "key", null), -1);
            if (mode === "addKey") {
                var t = AEMCP_num(AEMCP_get(a, "time", 0), 0);
                var idx = p.addKey(t);
                return { property: p.name, mode: mode, time: t, keyIndex: idx, numKeys: p.numKeys };
            }
            if (mode === "removeKey") {
                if (key < 1) { throw new Error("removeKey 需要 key（关键帧下标，1 基）"); }
                p.removeKey(key);
                return { property: p.name, mode: mode, removed: key, numKeys: p.numKeys };
            }
            if (mode === "setValueAtKey") {
                if (key < 1) { throw new Error("setValueAtKey 需要 key（关键帧下标）"); }
                var v = AEMCP_get(a, "value", null);
                if (v === null || v === undefined) { throw new Error("setValueAtKey 需要 value"); }
                p.setValueAtKey(key, AEMCP_coerceForProp(p, v));
                return { property: p.name, mode: mode, key: key };
            }
            if (mode === "keyLabel" || mode === "setLabelAtKey") {
                if (key < 1) { throw new Error(mode + " 需要 key"); }
                if (typeof p.keyLabel === "undefined") { throw new Error("关键帧标签需要 AE 22.6+，当前 " + app.version + " 不支持"); }
                if (mode === "keyLabel") { return { property: p.name, key: key, label: p.keyLabel(key) }; }
                p.setLabelAtKey(key, AEMCP_num(AEMCP_get(a, "label", 0), 0));
                return { property: p.name, mode: mode, key: key, label: AEMCP_num(AEMCP_get(a, "label", 0), 0) };
            }
            if (mode === "keySelected" || mode === "setSelectedAtKey") {
                if (key < 1) { throw new Error(mode + " 需要 key"); }
                if (mode === "keySelected") { return { property: p.name, key: key, selected: p.keySelected(key) }; }
                p.setSelectedAtKey(key, AEMCP_bool(AEMCP_get(a, "selected", true), true));
                return { property: p.name, mode: mode, key: key };
            }
            if (mode === "keyRoving" || mode === "setRovingAtKey") {
                if (key < 1) { throw new Error(mode + " 需要 key"); }
                if (mode === "keyRoving") { return { property: p.name, key: key, roving: p.keyRoving(key) }; }
                p.setRovingAtKey(key, AEMCP_bool(AEMCP_get(a, "roving", false), false));
                return { property: p.name, mode: mode, key: key };
            }
            throw new Error("mode 必须是 addKey / removeKey / setValueAtKey / keyLabel / setLabelAtKey / keySelected / setSelectedAtKey / keyRoving / setRovingAtKey");
        },

        "keyframe.tangent": function (a) {
            var c = AEMCP_comp(AEMCP_get(a, "comp", "active"));
            var l = AEMCP_layer(c, AEMCP_get(a, "layer", null));
            var p = AEMCP_prop(l, AEMCP_get(a, "property", null));
            var mode = String(AEMCP_get(a, "mode", "keySpatialAutoBezier"));
            var key = AEMCP_num(AEMCP_get(a, "key", null), -1);
            if (key < 1) { throw new Error(mode + " 需要 key（关键帧下标）"); }
            var b = AEMCP_bool(AEMCP_get(a, "value", true), true);
            if (mode === "keySpatialAutoBezier") {
                var bf = p.keySpatialAutoBezier(key);
                p.setSpatialAutoBezierAtKey(key, b);
                return { property: p.name, key: key, before: bf, after: p.keySpatialAutoBezier(key) };
            }
            if (mode === "keySpatialContinuous") {
                var bf2 = p.keySpatialContinuous(key);
                p.setSpatialContinuousAtKey(key, b);
                return { property: p.name, key: key, before: bf2, after: p.keySpatialContinuous(key) };
            }
            if (mode === "keyTemporalAutoBezier") {
                var bf3 = p.keyTemporalAutoBezier(key);
                p.setTemporalAutoBezierAtKey(key, b);
                return { property: p.name, key: key, before: bf3, after: p.keyTemporalAutoBezier(key) };
            }
            if (mode === "keyTemporalContinuous") {
                var bf4 = p.keyTemporalContinuous(key);
                p.setTemporalContinuousAtKey(key, b);
                return { property: p.name, key: key, before: bf4, after: p.keyTemporalContinuous(key) };
            }
            if (mode === "setSpatialTangents") {
                var inn = AEMCP_pair(AEMCP_get(a, "inTangents", null), [0, 0]);
                var out = AEMCP_pair(AEMCP_get(a, "outTangents", null), [0, 0]);
                p.setSpatialTangentsAtKey(key, inn, out);
                return { property: p.name, key: key, inTangents: inn, outTangents: out };
            }
            throw new Error("mode 必须是 keySpatialAutoBezier / keySpatialContinuous / keyTemporalAutoBezier / keyTemporalContinuous / setSpatialTangents");
        },

        "property.separate": function (a) {
            var c = AEMCP_comp(AEMCP_get(a, "comp", "active"));
            var l = AEMCP_layer(c, AEMCP_get(a, "layer", null));
            var p = AEMCP_prop(l, AEMCP_get(a, "property", null));
            var v = AEMCP_get(a, "separated", null);
            var before = null, after = null;
            try { before = p.dimensionsSeparated; } catch (e0) { before = null; }
            if (v !== null && v !== undefined) { p.dimensionsSeparated = AEMCP_bool(v, false); }
            try { after = p.dimensionsSeparated; } catch (e1) { after = null; }
            return { property: p.name, before: before, after: after };
        },

        "mask.set": function (a) {
            var c = AEMCP_comp(AEMCP_get(a, "comp", "active"));
            var l = AEMCP_layer(c, AEMCP_get(a, "layer", null));
            var m = AEMCP_mask(l, AEMCP_get(a, "mask", null));
            var before = {}, after = {}, changed = [];
            if (a && a.color !== undefined) {
                try { before.color = m.color; } catch (e0) { before.color = null; }
                m.color = AEMCP_color(a.color, [1, 1, 1]);
                changed.push("color");
                try { after.color = m.color; } catch (e1) { after.color = null; }
            }
            var r = AEMCP_setFields(m, a, ["locked", "rotoBezier", "maskMotionBlur", "maskFeatherFalloff"]);
            var i, k;
            for (i = 0; i < r.changed.length; i++) { changed.push(r.changed[i]); }
            var extra = ["locked", "rotoBezier", "maskMotionBlur", "maskFeatherFalloff"];
            for (i = 0; i < extra.length; i++) { k = extra[i]; before[k] = r.before[k]; after[k] = r.after[k]; }
            return { mask: m.name, changed: changed, before: before, after: after };
        },

        /* ==== P3 Batch F：文本 ==== */
        "text.set": function (a) {
            var c = AEMCP_comp(AEMCP_get(a, "comp", "active"));
            var l = AEMCP_layer(c, AEMCP_get(a, "layer", null));
            var srcProp = null;
            try { srcProp = l.property("Source Text"); } catch (e0) { srcProp = null; }
            if (!srcProp) { throw new Error("图层不是文字层（找不到 Source Text）"); }
            var td = null;
            try { td = srcProp.value; } catch (e1) { td = null; }
            if (!td) { throw new Error("读不到 TextDocument"); }
            var writeable = ["font", "fontSize", "applyFill", "fillColor", "applyStroke", "strokeColor",
                             "strokeWidth", "strokeOverFill", "leading", "autoLeading", "tracking",
                             "justification", "baselineShift", "horizontalScale", "verticalScale",
                             "pointText", "boxText", "boxTextSize",
                             /* AE 24.0+ 文本样式（allCaps/smallCaps/superscript/subscript 是只读，走 CharacterRange，这里不收） */
                             "noBreak", "ligature", "fauxBold", "fauxItalic", "autoHyphenate", "everyLineComposer",
                             "spaceAfter", "spaceBefore", "startIndent", "endIndent",
                             "leadingType", "autoKernType", "digitSet", "lineOrientation", "baselineDirection"];
            /* 24.0+ 枚举友好名 → 数值（数值来自真机探针，枚举名见注释） */
            var textEnums = {
                leadingType: [["roman", 10812], ["japanese", 10813]],              /* LeadingType.ROMAN/JAPANESE_LEADING_TYPE */
                autoKernType: [["none", 11412], ["metric", 11413], ["optical", 11414]], /* AutoKernType.NO_AUTO_KERN/METRIC_KERN/OPTICAL_KERN */
                digitSet: [["default", 12012], ["arabic", 12013], ["hindi", 12014], ["farsi", 12015], ["arabic_rtl", 12016]], /* DigitSet.* */
                lineOrientation: [["horizontal", 13212], ["vertical_rl", 13213], ["vertical_lr", 13214]], /* LineOrientation.* */
                baselineDirection: [["stream", 11612], ["vertical_rotated", 11613], ["vertical_cross", 11614]] /* BaselineDirection.* */
            };
            var boolMap = { applyFill: 1, applyStroke: 1, strokeOverFill: 1, autoLeading: 1, pointText: 1, boxText: 1,
                            noBreak: 1, ligature: 1, fauxBold: 1, fauxItalic: 1, autoHyphenate: 1, everyLineComposer: 1 };
            var before = {}, after = {}, changed = [], i, k, v;
            for (i = 0; i < writeable.length; i++) {
                k = writeable[i];
                try { before[k] = td[k]; } catch (e2) { before[k] = null; }
            }
            for (i = 0; i < writeable.length; i++) {
                k = writeable[i];
                if (a && a[k] !== undefined) {
                    v = a[k];
                    try {
                        if (k === "fillColor" || k === "strokeColor") { td[k] = AEMCP_color(v, [1, 1, 1]); }
                        else if (k === "boxTextSize") { td[k] = AEMCP_pair(v, [0, 0]); }
                        else if (textEnums[k]) { td[k] = AEMCP_enumPick(v, textEnums[k], k); }
                        else if (boolMap[k]) { td[k] = AEMCP_bool(v, false); }
                        else if (k === "font") { td[k] = String(v); }
                        else { td[k] = AEMCP_num(v, 0); }
                        changed.push(k);
                    } catch (e3) { throw new Error("写文本字段 " + k + " 失败：" + AEMCP_es(e3)); }
                }
            }
            try { srcProp.setValue(td); } catch (e4) { throw new Error("文本写回失败：" + AEMCP_es(e4)); }
            for (i = 0; i < writeable.length; i++) { k = writeable[i]; try { after[k] = td[k]; } catch (e5) { after[k] = null; } }
            return { layer: l.name, changed: changed, before: before, after: after };
        },

        /* ==== P3 Batch G：查看器 / 设置 ==== */
        "viewer": function (a) {
            var mode = String(AEMCP_get(a, "mode", "info"));
            var v = null;
            try { v = app.activeViewer; } catch (e0) { v = null; }
            if (!v) { throw new Error("没有活动查看器（先打开一个合成）"); }
            if (mode === "info") {
                var views = v.views, list = [], i;
                for (i = 0; i < views.length; i++) {
                    list.push({ index: i, active: (v.activeViewIndex === i), type: views[i].type, maximized: views[i].maximized });
                }
                return { active: v.activeViewIndex, count: views.length, views: list };
            }
            if (mode === "setActive") {
                var idx = AEMCP_num(AEMCP_get(a, "index", 0), 0);
                v.activeViewIndex = idx;
                return { active: v.activeViewIndex };
            }
            if (mode === "maximize") {
                var mx = AEMCP_bool(AEMCP_get(a, "maximized", true), true);
                var vi = AEMCP_num(AEMCP_get(a, "index", v.activeViewIndex), v.activeViewIndex);
                var vw = v.views[vi];
                if (!vw) { throw new Error("view index 无效"); }
                vw.maximized = mx;
                return { index: vi, maximized: mx };
            }
            if (mode === "options") {
                var vi2 = AEMCP_num(AEMCP_get(a, "index", v.activeViewIndex), v.activeViewIndex);
                var vw2 = v.views[vi2];
                if (!vw2) { throw new Error("view index 无效"); }
                var opt = vw2.options;
                var r = AEMCP_setFields(opt, a, ["zoom", "checkerboards", "channels", "exposure", "fastPreview", "guidesVisibility", "rulers"]);
                return { index: vi2, changed: r.changed, before: r.before, after: r.after };
            }
            throw new Error("mode 必须是 info / setActive / maximize / options");
        },

        "settings": function (a) {
            var mode = String(AEMCP_get(a, "mode", "get"));
            var section = String(AEMCP_get(a, "section", "AEMCP"));
            var key = String(AEMCP_get(a, "key", ""));
            if (!key) { throw new Error("缺 key"); }
            if (mode === "get") {
                var has = app.settings.haveSetting(section, key);
                var val = has ? app.settings.getSetting(section, key) : null;
                return { section: section, key: key, has: has, value: (val === null || val === undefined) ? null : String(val) };
            }
            if (mode === "set") {
                var v2 = AEMCP_get(a, "value", null);
                if (v2 === null || v2 === undefined) { throw new Error("set 需要 value"); }
                app.settings.saveSetting(section, key, String(v2));
                return { section: section, key: key, saved: true, note: "只写当前会话内存；落盘请 mode=saveToDisk" };
            }
            if (mode === "saveToDisk") {
                app.preferences.saveToDisk();
                return { savedToDisk: true };
            }
            if (mode === "pref") {
                var op = String(AEMCP_get(a, "op", "get"));
                var type = String(AEMCP_get(a, "type", "string"));
                if (op === "get") {
                    if (type === "string") { return { section: section, key: key, value: app.preferences.getPrefAsString(section, key) }; }
                    if (type === "bool") { return { section: section, key: key, value: app.preferences.getPrefAsBool(section, key) }; }
                    if (type === "float") { return { section: section, key: key, value: app.preferences.getPrefAsFloat(section, key) }; }
                    if (type === "long") { return { section: section, key: key, value: app.preferences.getPrefAsLong(section, key) }; }
                    throw new Error("type 必须是 string / bool / float / long");
                }
                if (op === "set") {
                    var v3 = AEMCP_get(a, "value", null);
                    if (v3 === null || v3 === undefined) { throw new Error("pref set 需要 value"); }
                    if (type === "string") { app.preferences.savePrefAsString(section, key, String(v3)); }
                    else if (type === "bool") { app.preferences.savePrefAsBool(section, key, AEMCP_bool(v3, false)); }
                    else if (type === "float") { app.preferences.savePrefAsFloat(section, key, AEMCP_num(v3, 0)); }
                    else if (type === "long") { app.preferences.savePrefAsLong(section, key, AEMCP_num(v3, 0)); }
                    else { throw new Error("type 必须是 string / bool / float / long"); }
                    return { section: section, key: key, saved: true, note: "只写内存；落盘请 mode=saveToDisk" };
                }
                if (op === "saveToDisk") { app.preferences.saveToDisk(); return { savedToDisk: true }; }
                throw new Error("op 必须是 get / set / saveToDisk");
            }
            throw new Error("mode 必须是 get / set / saveToDisk / pref");
        },

        /* ==== P3 Batch H：模板 / 编排 ==== */
        "preset.apply": function (a) {
            var c = AEMCP_comp(AEMCP_get(a, "comp", "active"));
            var l = AEMCP_layer(c, AEMCP_get(a, "layer", null));
            var path = AEMCP_get(a, "path", null);
            if (path === null || path === undefined) { throw new Error("缺 path：.ffx 动画预设文件路径"); }
            var f = new File(String(path));
            if (!f.exists) { throw new Error("预设文件不存在：" + String(path)); }
            l.applyPreset(f);
            return { layer: l.name, applied: String(path), note: "applyPreset 撤销可能崩溃，回滚请用 checkpoint.revert" };
        },

        "tpl.lowerThird": function (a) {
            var style = String(AEMCP_get(a, "style", "minimal"));
            var title = String(AEMCP_get(a, "title", "主标题"));
            var subtitle = String(AEMCP_get(a, "subtitle", "副标题"));
            var w = AEMCP_num(AEMCP_get(a, "width", 1920), 1920);
            var h = AEMCP_num(AEMCP_get(a, "height", 1080), 1080);
            var fps = AEMCP_num(AEMCP_get(a, "fps", 30), 30);
            var dur = AEMCP_num(AEMCP_get(a, "duration", 3), 3);
            var c = app.project.items.addComp("下三分之一_" + style, w, h, 1, dur, fps);
            var col = [0, 0, 0];
            var s = style.toLowerCase();
            if (s === "modern") { col = [0.05, 0.1, 0.25]; }
            else if (s === "corporate") { col = [0.1, 0.1, 0.1]; }
            else if (s === "news") { col = [0.8, 0.1, 0.1]; }
            else if (s === "social") { col = [0.2, 0.05, 0.4]; }
            var barW = AEMCP_num(AEMCP_get(a, "barWidth", 700), 700);
            var barH = AEMCP_num(AEMCP_get(a, "barHeight", 160), 160);
            var bar = c.layers.addSolid(col, "底条", barW, barH, 1, dur);
            var bt = bar.property("ADBE Transform Group");
            bt.property("ADBE Position").setValue([w / 2, h - 180]);
            bt.property("ADBE Opacity").setValue(85);
            var ttl = AEMCP_tplText(c, title, w / 2, h - 200, 64, [1, 1, 1]);
            var sub = AEMCP_tplText(c, subtitle, w / 2, h - 140, 36, [0.85, 0.85, 0.85]);
            AEMCP_tplKey(bt.property("ADBE Position"), [-barW / 2, h - 180], [w / 2, h - 180], 0, 0.5);
            AEMCP_tplKey(ttl.property("ADBE Transform Group").property("ADBE Position"), [-200, h - 200], [w / 2, h - 200], 0, 0.5);
            AEMCP_tplKey(sub.property("ADBE Transform Group").property("ADBE Position"), [-200, h - 140], [w / 2, h - 140], 0, 0.5);
            return AEMCP_compBrief(c);
        },

        "tpl.titleCard": function (a) {
            var style = String(AEMCP_get(a, "style", "minimal"));
            var title = String(AEMCP_get(a, "title", "标题"));
            var subtitle = String(AEMCP_get(a, "subtitle", "副标题"));
            var w = AEMCP_num(AEMCP_get(a, "width", 1920), 1920);
            var h = AEMCP_num(AEMCP_get(a, "height", 1080), 1080);
            var fps = AEMCP_num(AEMCP_get(a, "fps", 30), 30);
            var dur = AEMCP_num(AEMCP_get(a, "duration", 3), 3);
            var c = app.project.items.addComp("标题卡_" + style, w, h, 1, dur, fps);
            var col = [0.05, 0.05, 0.08];
            var s = style.toLowerCase();
            if (s === "cinematic") { col = [0.02, 0.03, 0.05]; }
            else if (s === "documentary") { col = [0.08, 0.08, 0.06]; }
            else if (s === "social") { col = [0.15, 0.05, 0.3]; }
            var bg = c.layers.addSolid(col, "背景", w, h, 1, dur);
            var ttl = AEMCP_tplText(c, title, w / 2, h / 2 + 10, 96, [1, 1, 1]);
            var sub = AEMCP_tplText(c, subtitle, w / 2, h / 2 - 70, 40, [0.8, 0.8, 0.8]);
            AEMCP_tplKey(ttl.property("ADBE Transform Group").property("ADBE Opacity"), 0, 100, 0, 0.5);
            AEMCP_tplKey(ttl.property("ADBE Transform Group").property("ADBE Scale"), [80, 80], [100, 100], 0, 0.5);
            AEMCP_tplKey(sub.property("ADBE Transform Group").property("ADBE Opacity"), 0, 100, 0.2, 0.7);
            return AEMCP_compBrief(c);
        },

        "tpl.transition": function (a) {
            var style = String(AEMCP_get(a, "style", "wipe"));
            var w = AEMCP_num(AEMCP_get(a, "width", 1920), 1920);
            var h = AEMCP_num(AEMCP_get(a, "height", 1080), 1080);
            var fps = AEMCP_num(AEMCP_get(a, "fps", 30), 30);
            var dur = AEMCP_num(AEMCP_get(a, "duration", 1), 1);
            var c = app.project.items.addComp("转场_" + style, w, h, 1, dur, fps);
            var s = c.layers.addSolid([1, 1, 1], "转场块", w, h, 1, dur);
            var tp = s.property("ADBE Transform Group");
            var pos = tp.property("ADBE Position");
            var opc = tp.property("ADBE Opacity");
            var sc = tp.property("ADBE Scale");
            var k = style.toLowerCase();
            if (k === "dissolve") {
                AEMCP_tplKey(opc, 0, 100, 0, dur / 2);
                AEMCP_tplKey(opc, 100, 0, dur / 2, dur);
            } else if (k === "slide" || k === "push") {
                AEMCP_tplKey(pos, [w + w / 2, h / 2], [w / 2, h / 2], 0, dur);
            } else if (k === "zoom") {
                AEMCP_tplKey(sc, [0, 0], [100, 100], 0, dur);
            } else { // wipe
                AEMCP_tplKey(pos, [-w / 2, h / 2], [w + w / 2, h / 2], 0, dur);
            }
            return AEMCP_compBrief(c);
        },

        "tpl.logoReveal": function (a) {
            var style = String(AEMCP_get(a, "style", "fade"));
            var logo = String(AEMCP_get(a, "logo", "LOGO"));
            var tagline = String(AEMCP_get(a, "tagline", ""));
            var w = AEMCP_num(AEMCP_get(a, "width", 1920), 1920);
            var h = AEMCP_num(AEMCP_get(a, "height", 1080), 1080);
            var fps = AEMCP_num(AEMCP_get(a, "fps", 30), 30);
            var dur = AEMCP_num(AEMCP_get(a, "duration", 2), 2);
            var c = app.project.items.addComp("标志揭示_" + style, w, h, 1, dur, fps);
            var bg = c.layers.addSolid([0.03, 0.03, 0.03], "背景", w, h, 1, dur);
            var shp = c.layers.addShape();
            var cp = shp.property("ADBE Root Vectors Group");
            var grp = cp.addProperty("ADBE Vector Group");
            var rect = grp.property("ADBE Vectors Group").addProperty("ADBE Vector Shape - Rect");
            rect.property("ADBE Vector Rect Size").setValue([300, 300]);
            rect.property("ADBE Vector Rect Position").setValue([0, 0]);
            var fillOp = grp.property("ADBE Vectors Group").addProperty("ADBE Vector Graphic - Fill");
            fillOp.property("ADBE Vector Fill Color").setValue([0.2, 0.4, 0.9]);
            var stp = shp.property("ADBE Transform Group");
            stp.property("ADBE Position").setValue([w / 2, h / 2]);
            var txt = AEMCP_tplText(c, logo, w / 2, h / 2, 60, [1, 1, 1]);
            var k = style.toLowerCase();
            var opcP = stp.property("ADBE Opacity");
            var scP = stp.property("ADBE Scale");
            var rotP = stp.property("ADBE Rotation");
            if (k === "scale") { AEMCP_tplKey(scP, [0, 0], [100, 100], 0, 0.6); }
            else if (k === "slide") { AEMCP_tplKey(stp.property("ADBE Position"), [w / 2 - 600, h / 2], [w / 2, h / 2], 0, 0.6); }
            else if (k === "spin") { AEMCP_tplKey(rotP, -180, 0, 0, 0.6); AEMCP_tplKey(scP, [0, 0], [100, 100], 0, 0.6); }
            else if (k === "glitch") { AEMCP_tplKey(opcP, 0, 100, 0, 0.1); AEMCP_tplKey(opcP, 100, 30, 0.1, 0.15); AEMCP_tplKey(opcP, 30, 100, 0.15, 0.5); }
            else { AEMCP_tplKey(opcP, 0, 100, 0, 0.6); } // fade
            AEMCP_tplKey(txt.property("ADBE Transform Group").property("ADBE Opacity"), 0, 100, 0.2, 0.8);
            if (tagline !== "") {
                var tag = AEMCP_tplText(c, tagline, w / 2, h / 2 - 200, 32, [0.7, 0.7, 0.7]);
                AEMCP_tplKey(tag.property("ADBE Transform Group").property("ADBE Opacity"), 0, 100, 0.4, 1);
            }
            return AEMCP_compBrief(c);
        },

        "batch.run": function (a) {
            var steps = AEMCP_get(a, "steps", null);
            if (!(steps instanceof Array) || steps.length === 0) { throw new Error("steps 要是 [{op,args},...] 非空数组"); }
            var table = AEMCP_ops(), results = [], i;
            for (i = 0; i < steps.length; i++) {
                var s = steps[i], op = (s && s.op) ? String(s.op) : "", args = (s && s.args !== undefined) ? s.args : {};
                if (!table[op]) { results.push({ index: i, op: op, ok: false, error: "未知 op：" + op }); break; }
                try {
                    results.push({ index: i, op: op, ok: true, data: table[op](args) });
                } catch (e) {
                    results.push({ index: i, op: op, ok: false, error: AEMCP_es(e) });
                    break;
                }
            }
            return { done: results.length, total: steps.length, results: results };
        },

        "checkpoint.save": function (a) {
            var mode = String(AEMCP_get(a, "mode", "save"));
            var dir = new Folder(Folder.userData.fsName + "/ae-mcp/checkpoints");
            if (!dir.exists) { dir.create(); }
            if (mode === "list") {
                var fs = dir.getFiles("*.aep"), list = [], i;
                for (i = 0; i < fs.length; i++) { list.push({ name: fs[i].name, path: fs[i].fsName }); }
                return { mode: mode, count: list.length, checkpoints: list };
            }
            if (mode === "save") {
                var name = String(AEMCP_get(a, "name", "chk-" + AEMCP_ms()));
                var f = new File(dir.fsName + "/" + name + ".aep");
                app.project.save(f);
                return { mode: mode, id: name, path: f.fsName };
            }
            throw new Error("mode 必须是 save / list");
        },

        "checkpoint.revert": function (a) {
            var path = AEMCP_get(a, "path", null);
            if (path === null || path === undefined) { throw new Error("缺 path：要恢复的 .aep 检查点（checkpoint.save list 里拿）"); }
            var f = new File(String(path));
            if (!f.exists) { throw new Error("检查点不存在：" + String(path)); }
            try {
                if (app.project.dirty) {
                    var dir = new Folder(Folder.userData.fsName + "/ae-mcp/checkpoints");
                    if (!dir.exists) { dir.create(); }
                    var backup = new File(dir.fsName + "/before-revert-" + AEMCP_ms() + ".aep");
                    app.project.save(backup);
                }
            } catch (e0) { }
            app.openFast(f);
            return { opened: String(path) };
        },

        "undo.tip": function (a) {
            return {
                undoShortcut: "Ctrl+Z（Mac 为 Cmd+Z）",
                notes: [
                    "每个 ae_* 写操作都包在独立 undo 组里，Ctrl+Z 可逐步回退。",
                    "applyPreset 的撤销可能崩溃，回滚请用 checkpoint.save / checkpoint.revert。",
                    "渲染队列 render() 会阻塞 AE 主线程，脚本层已不提供 render 触发，请在 AE 里手动点渲染。"
                ]
            };
        },

        "eval.check": function (a) {
            var expr = String(AEMCP_get(a, "expression", "1+1"));
            var r = eval(expr);
            return { expression: expr, result: AEMCP_es(r), type: typeof r };
        },

        /* ==== v0.11：AE 26.5 参考线 + 25.4 重启 ==== */
        "guide.list": function (a) {
            AEMCP_requireGuides();
            var owner = AEMCP_guideOwner(a);
            var n = 0, list = [], i, nm = "?";
            try { nm = owner.name; } catch (e0) { }
            try { n = owner.guides.length; } catch (e1) { n = 0; }
            for (i = 0; i < n; i++) {
                try { list.push(AEMCP_guideBrief(owner.getGuideAsObject(i))); }
                catch (e2) { list.push({ index: i, error: AEMCP_es(e2) }); }
            }
            return { owner: nm, count: n, guides: list };
        },

        "guide.add": function (a) {
            AEMCP_requireGuides();
            var owner = AEMCP_guideOwner(a);
            var idx = owner.addGuide(AEMCP_guideOpts(a));
            var brief = null;
            try { brief = AEMCP_guideBrief(owner.getGuideAsObject(idx)); } catch (e0) { brief = null; }
            return { index: idx, guide: brief };
        },

        "guide.set": function (a) {
            AEMCP_requireGuides();
            var owner = AEMCP_guideOwner(a);
            var idx = AEMCP_num(AEMCP_get(a, "index", 0), 0);
            var go = owner.getGuideAsObject(idx);
            AEMCP_guideApply(go, a);
            owner.setGuide(idx, go);
            return { index: idx, guide: AEMCP_guideBrief(owner.getGuideAsObject(idx)) };
        },

        "guide.remove": function (a) {
            AEMCP_requireGuides();
            var owner = AEMCP_guideOwner(a);
            var idx = AEMCP_num(AEMCP_get(a, "index", 0), 0);
            owner.removeGuide(idx);
            return { removed: idx };
        },

        "app.restart": function (a) {
            if (typeof app.restart !== "function") {
                throw new Error("重启需要 AE 25.4+（当前 " + app.version + "）：app.restart 为 25.4 新 API");
            }
            var confirm = AEMCP_bool(AEMCP_get(a, "confirm", false), false);
            if (!confirm) { throw new Error("重启 AE 会断开桥（面板随进程消失）。确认要重启请传 confirm:true。"); }
            app.scheduleTask("app.restart();", 1500, false);
            return { restarting: true, note: "AE 约 1.5 秒后重启，桥随面板消失，重启后请重新打开面板。", version: app.version };
        },

        /* ==== v1.1：AE 26.3 参数化网格 + 26.0 变量字体轴 ==== */
        "layer.mesh": function (a) {
            var c = AEMCP_comp(AEMCP_get(a, "comp", "active"));
            if (typeof c.layers.addParametricMesh !== "function") {
                throw new Error("参数化网格需要 AE 26.3+（当前 " + app.version + "）：addParametricMesh 为 26.3 新 API");
            }
            var name = String(AEMCP_get(a, "name", "Mesh"));
            var meshMap = [["cube", 14612], ["sphere", 14613], ["plane", 14614], ["torus", 14615], ["cone", 14616], ["cylinder", 14617]];
            var mt = AEMCP_enumPick(AEMCP_get(a, "meshType", "plane"), meshMap, "meshType");
            var l = c.layers.addParametricMesh(name, mt);
            var d = { name: l.name, meshType: AEMCP_get(a, "meshType", "plane"), type: null };
            try { d.type = l.typeName; } catch (e0) { }
            try { d.threeD = l.threeDLayer; } catch (e1) { }
            return d;
        },

        "text.axisAdd": function (a) {
            var c = AEMCP_comp(AEMCP_get(a, "comp", "active"));
            var l = AEMCP_layer(c, AEMCP_get(a, "layer", null));
            var tag = String(AEMCP_get(a, "tag", "wght"));
            if (tag.length !== 4) { throw new Error("axisTag 要是 4 字符（如 wght/wdth/slnt/ital/opsz）"); }
            var textProp = null;
            try { textProp = l.property("ADBE Text Properties"); } catch (e0) { textProp = null; }
            if (!textProp) { throw new Error("图层不是文字层（找不到 ADBE Text Properties）"); }
            var animators = null;
            try { animators = textProp.property("ADBE Text Animators"); } catch (e1) { animators = null; }
            if (!animators) { throw new Error("找不到 Animators 组"); }
            var animator = animators.addProperty("ADBE Text Animator");
            var animatorProps = animator.property("ADBE Text Animator Properties");
            if (!animatorProps || typeof animatorProps.addVariableFontAxis !== "function") {
                throw new Error("addVariableFontAxis 需要 AE 26.0+（当前 " + app.version + "）");
            }
            var axisProp = animatorProps.addVariableFontAxis(tag);
            var val = AEMCP_get(a, "value", null);
            if (val !== null && val !== undefined) { axisProp.setValue(AEMCP_num(val, 0)); }
            var d = { layer: l.name, tag: tag, property: null, matchName: null, value: null };
            try { d.property = axisProp.name; } catch (e2) { }
            try { d.matchName = axisProp.matchName; } catch (e3) { }
            try { d.value = axisProp.value; } catch (e4) { }
            return d;
        },

        /* ==== v1.1：自建功能 —— 进场动画（关键帧 + 缓动） ==== */
        "anim.entrance": function (a) {
            var c = AEMCP_comp(AEMCP_get(a, "comp", "active"));
            var l = AEMCP_layer(c, AEMCP_get(a, "layer", null));
            var preset = String(AEMCP_get(a, "preset", "fadeUp"));
            var t0 = AEMCP_num(AEMCP_get(a, "startTime", 0), 0);
            var dur = AEMCP_num(AEMCP_get(a, "duration", 0.5), 0.5);
            var dist = AEMCP_num(AEMCP_get(a, "distance", 60), 60);
            var tg = l.property("ADBE Transform Group");
            var pos = tg.property("ADBE Position");
            var opa = tg.property("ADBE Opacity");
            var sca = tg.property("ADBE Scale");
            var pv = pos.value, ov = opa.value, sv = sca.value;
            var changed = [], ease = [0, 50], expr;
            if (preset === "fadeUp") {
                pos.setValueAtTime(t0, [pv[0], pv[1] + dist]);
                pos.setValueAtTime(t0 + dur, pv);
                AEMCP_applyEase(pos, ease);
                opa.setValueAtTime(t0, 0);
                opa.setValueAtTime(t0 + dur, ov);
                AEMCP_applyEase(opa, ease);
                changed = ["position", "opacity"];
            } else if (preset === "slideLeft") {
                pos.setValueAtTime(t0, [pv[0] + dist, pv[1]]);
                pos.setValueAtTime(t0 + dur, pv);
                AEMCP_applyEase(pos, ease);
                changed = ["position"];
            } else if (preset === "slideRight") {
                pos.setValueAtTime(t0, [pv[0] - dist, pv[1]]);
                pos.setValueAtTime(t0 + dur, pv);
                AEMCP_applyEase(pos, ease);
                changed = ["position"];
            } else if (preset === "scaleIn") {
                sca.setValueAtTime(t0, [0, 0]);
                sca.setValueAtTime(t0 + dur, sv);
                AEMCP_applyEase(sca, ease);
                opa.setValueAtTime(t0, 0);
                opa.setValueAtTime(t0 + dur, ov);
                AEMCP_applyEase(opa, ease);
                changed = ["scale", "opacity"];
            } else if (preset === "bounce") {
                var freq = AEMCP_num(AEMCP_get(a, "frequency", 5), 5);
                var damp = AEMCP_num(AEMCP_get(a, "damping", 1.6), 1.6);
                var amp = AEMCP_num(AEMCP_get(a, "amplitude", 120), 120);
                expr = "var landed = " + t0 + " + " + dur + ";\n" +
                       "var v = value;\n" +
                       "if (time < landed) { v; } else {\n" +
                       "  var t = time - landed;\n" +
                       "  v + [0, -Math.abs(Math.cos(t * " + freq + ")) * Math.exp(-" + damp + " * t) * " + amp + "];\n" +
                       "}";
                pos.expression = expr;
                opa.setValueAtTime(t0, 0);
                opa.setValueAtTime(t0 + dur, ov);
                AEMCP_applyEase(opa, ease);
                changed = ["position(表达式回弹)", "opacity"];
            } else {
                throw new Error("preset 只认 fadeUp / slideLeft / slideRight / scaleIn / bounce");
            }
            return { layer: l.name, preset: preset, changed: changed, startTime: t0, duration: dur };
        },

        /* ==== v1.3：自建复合功能（循环/抖动/计数/缓动/打字机/逐字交错） ==== */
        "anim.loop": function (a) {
            var c = AEMCP_comp(AEMCP_get(a, "comp", "active"));
            var l = AEMCP_layer(c, AEMCP_get(a, "layer", null));
            var propName = AEMCP_get(a, "property", "position");
            var p = AEMCP_prop(l, propName);
            var mode = String(AEMCP_get(a, "mode", "cycle"));
            var expr;
            if (mode === "pingpong") { expr = 'loopOut("pingpong")'; }
            else if (mode === "continue") { expr = 'loopOut("continue")'; }
            else if (mode === "offset") { expr = 'loopOut("offset")'; }
            else { expr = 'loopOut("cycle")'; }
            p.expression = expr;
            return { layer: l.name, property: propName, mode: mode, expression: expr };
        },

        "fx.shake": function (a) {
            var c = AEMCP_comp(AEMCP_get(a, "comp", "active"));
            var l = AEMCP_layer(c, AEMCP_get(a, "layer", null));
            var freq = AEMCP_num(AEMCP_get(a, "frequency", 5), 5);
            var amp = AEMCP_num(AEMCP_get(a, "amplitude", 20), 20);
            var propName = AEMCP_get(a, "property", "position");
            var p = AEMCP_prop(l, propName);
            var expr = "wiggle(" + freq + ", " + amp + ")";
            p.expression = expr;
            return { layer: l.name, property: propName, expression: expr };
        },

        "text.counter": function (a) {
            var c = AEMCP_comp(AEMCP_get(a, "comp", "active"));
            var l = AEMCP_layer(c, AEMCP_get(a, "layer", null));
            var start = AEMCP_num(AEMCP_get(a, "start", 0), 0);
            var end = AEMCP_num(AEMCP_get(a, "end", 100), 100);
            var t0 = AEMCP_num(AEMCP_get(a, "startTime", 0), 0);
            var dur = AEMCP_num(AEMCP_get(a, "duration", 2), 2);
            var dec = AEMCP_num(AEMCP_get(a, "decimals", 0), 0);
            var prefix = String(AEMCP_get(a, "prefix", ""));
            var suffix = String(AEMCP_get(a, "suffix", ""));
            var src = l.property("Source Text");
            var expr = "var v = linear(time, " + t0 + ", " + (t0 + dur) + ", " + start + ", " + end + ");\n" +
                       "var m = Math.pow(10, " + dec + ");\n" +
                       "var r = Math.round(v * m) / m;\n" +
                       JSON.stringify(prefix) + " + String(r) + " + JSON.stringify(suffix);
            src.expression = expr;
            return { layer: l.name, start: start, end: end, decimals: dec, expression: expr };
        },

        "ease.presets": function (a) {
            var c = AEMCP_comp(AEMCP_get(a, "comp", "active"));
            var l = AEMCP_layer(c, AEMCP_get(a, "layer", null));
            var propName = AEMCP_get(a, "property", "position");
            var p = AEMCP_prop(l, propName);
            var preset = String(AEMCP_get(a, "preset", "easeInOut"));
            var n = p.numKeys;
            if (n < 2) { throw new Error("属性至少要 2 个关键帧才能缓动（当前 " + n + " 个）"); }
            var inInf = 0.1, outInf = 0.1;
            if (preset === "easeIn") { inInf = 100; }
            else if (preset === "easeOut") { outInf = 100; }
            else if (preset === "easeInOut") { inInf = 100; outInf = 100; }
            else if (preset === "linear") { inInf = 0.1; outInf = 0.1; }
            else { throw new Error("preset 只认 linear / easeIn / easeOut / easeInOut"); }
            var dim = 1, vv, i, d;
            try { vv = p.value; if (vv instanceof Array) { dim = vv.length; } } catch (e0) { dim = 1; }
            for (i = 1; i <= n; i++) {
                var inA = [], outA = [];
                for (d = 0; d < dim; d++) { inA.push(new KeyframeEase(0, inInf)); outA.push(new KeyframeEase(0, outInf)); }
                try { p.setTemporalEaseAtKey(i, inA, outA); }
                catch (e1) { try { p.setTemporalEaseAtKey(i, [inA[0]], [outA[0]]); } catch (e2) { } }
            }
            return { layer: l.name, property: propName, preset: preset, keyframes: n };
        },

        "text.typewriter": function (a) {
            var c = AEMCP_comp(AEMCP_get(a, "comp", "active"));
            var l = AEMCP_layer(c, AEMCP_get(a, "layer", null));
            var t0 = AEMCP_num(AEMCP_get(a, "startTime", 0), 0);
            var dur = AEMCP_num(AEMCP_get(a, "duration", 1), 1);
            var anims = l.property("ADBE Text Properties").property("ADBE Text Animators");
            var anim = anims.addProperty("ADBE Text Animator");
            var props = anim.property("ADBE Text Animator Properties");
            props.addProperty("ADBE Text Opacity").setValue(0);
            var sels = anim.property("ADBE Text Selectors");
            var sel = sels.addProperty("ADBE Text Selector");
            var adv = null;
            try { adv = sel.property("ADBE Text Range Advanced"); } catch (e0) { adv = null; }
            if (adv) { try { adv.property("ADBE Text Selector Smoothness").setValue(100); } catch (e1) { } }
            var endP = sel.property("ADBE Text Percent End");
            endP.setValue(100);
            var startP = sel.property("ADBE Text Percent Start");
            startP.setValueAtTime(t0, 0);
            startP.setValueAtTime(t0 + dur, 100);
            return { layer: l.name, startTime: t0, duration: dur };
        },

        "text.stagger": function (a) {
            var c = AEMCP_comp(AEMCP_get(a, "comp", "active"));
            var l = AEMCP_layer(c, AEMCP_get(a, "layer", null));
            var t0 = AEMCP_num(AEMCP_get(a, "startTime", 0), 0);
            var dur = AEMCP_num(AEMCP_get(a, "duration", 0.8), 0.8);
            var dist = AEMCP_num(AEMCP_get(a, "distance", 50), 50);
            var anims = l.property("ADBE Text Properties").property("ADBE Text Animators");
            var anim = anims.addProperty("ADBE Text Animator");
            var props = anim.property("ADBE Text Animator Properties");
            props.addProperty("ADBE Text Opacity").setValue(0);
            props.addProperty("ADBE Text Position 3D").setValue([0, -dist, 0]);
            var sels = anim.property("ADBE Text Selectors");
            var sel = sels.addProperty("ADBE Text Selector");
            var adv = null;
            try { adv = sel.property("ADBE Text Range Advanced"); } catch (e0) { adv = null; }
            if (adv) { try { adv.property("ADBE Text Selector Smoothness").setValue(100); } catch (e1) { } }
            var endP = sel.property("ADBE Text Percent End");
            endP.setValue(100);
            var startP = sel.property("ADBE Text Percent Start");
            startP.setValueAtTime(t0, 0);
            startP.setValueAtTime(t0 + dur, 100);
            return { layer: l.name, startTime: t0, duration: dur, distance: dist };
        },

        /* ==== v1.2：executeCommand 逃生舱（菜单命令） ==== */
        "command": function (a) {
            var mode = String(AEMCP_get(a, "mode", "exec"));
            if (typeof app.executeCommand !== "function") {
                throw new Error("executeCommand 不可用（当前 " + app.version + "；AE 2022+ 可能已移除该方法）");
            }
            if (mode === "find") {
                var nm = AEMCP_get(a, "name", null);
                if (!nm) { throw new Error("find 需要 name（本地化菜单名：中文 AE 要用中文名，如「新建蒙版」）"); }
                if (typeof app.findMenuCommandId !== "function") { throw new Error("findMenuCommandId 不可用"); }
                var fid = 0;
                try { fid = app.findMenuCommandId(String(nm)); } catch (e0) { fid = 0; }
                return { mode: "find", name: String(nm), id: (fid || 0) };
            }
            if (mode === "exec") {
                var id = AEMCP_get(a, "id", null);
                if (id === null || id === undefined) {
                    var nm2 = AEMCP_get(a, "name", null);
                    if (!nm2) { throw new Error("exec 需要 id（命令编号）或 name（本地化菜单名）"); }
                    if (typeof app.findMenuCommandId !== "function") { throw new Error("findMenuCommandId 不可用"); }
                    id = app.findMenuCommandId(String(nm2));
                    if (!id || id === 0) { throw new Error("找不到命令「" + nm2 + "」（findMenuCommandId 要本地化菜单名）"); }
                }
                app.executeCommand(AEMCP_num(id, 0));
                return { mode: "exec", id: AEMCP_num(id, 0), note: "命令已执行。部分命令需要活动合成 + 选中图层才生效，脚本无法验证其 UI 效果。" };
            }
            throw new Error("mode 必须是 find / exec");
        },

        "op.list": function (a) {
            return { ops: AEMCP_keys(AEMCP_ops()), count: AEMCP_keys(AEMCP_ops()).length };
        }
    };
}

/* 缓动 / 插值：关键帧的「手感」全靠这两下。维度要按属性自身的值长来配 ——
   位置是 2D 就要两个 KeyframeEase，给一个宿主会报错或给错。 */
function AEMCP_applyEase(prop, ease) {
    var n = prop.numKeys, i, d, dim = 1, vv;
    try { vv = prop.value; if (vv instanceof Array) { dim = vv.length; } } catch (e0) { dim = 1; }
    var sp = 0, inf = 33;
    if (typeof ease === "number") { sp = ease; }
    else if (ease instanceof Array) { sp = AEMCP_num(ease[0], 0); inf = AEMCP_num(ease[1], 33); }
    else if (ease && typeof ease === "object") {
        if (ease.speed !== undefined) { sp = AEMCP_num(ease.speed, 0); inf = AEMCP_num(ease.influence, 33); }
        else if (ease.in !== undefined) { sp = AEMCP_num(ease.in[0], 0); inf = AEMCP_num(ease.in[1], 33); }
    }
    var inA = [], outA = [];
    for (d = 0; d < dim; d++) { inA.push(new KeyframeEase(sp, inf)); outA.push(new KeyframeEase(sp, inf)); }
    for (i = 1; i <= n; i++) {
        try { prop.setInterpolationTypeAtKey(i, KeyframeInterpolationType.BEZIER, KeyframeInterpolationType.BEZIER); } catch (e1) { }
        try { prop.setTemporalEaseAtKey(i, inA, outA); }
        catch (e2) { try { prop.setTemporalEaseAtKey(i, [inA[0]], [outA[0]]); } catch (e3) { } }
    }
    return n;
}

function AEMCP_applyInterp(prop, kind) {
    var k = String(kind).toLowerCase(), t = null, n = prop.numKeys, i;
    if (k === "linear") { t = KeyframeInterpolationType.LINEAR; }
    else if (k === "hold") { t = KeyframeInterpolationType.HOLD; }
    else if (k === "bezier") { t = KeyframeInterpolationType.BEZIER; }
    else { throw new Error("interpolation 只认 linear / bezier / hold"); }
    for (i = 1; i <= n; i++) { prop.setInterpolationTypeAtKey(i, t, t); }
    return n;
}

/* ============================================================ 9. 桥入口
   面板只调这一个函数。args 是 JSON 文本（面板侧保证 ASCII 转义后塞进来）。 */
function AEMCP_op(name, argsJson) {
    var t0 = AEMCP_ms(), args = null, data = null, table;
    try { args = AEMCP_pj(argsJson || "{}"); }
    catch (pe) { return AEMCP_j({ ok: false, op: String(name), error: "参数不是合法 JSON：" + AEMCP_clean(pe) }); }
    try { table = AEMCP_ops(); }
    catch (te) { return AEMCP_j({ ok: false, op: String(name), error: "操作表加载失败：" + AEMCP_clean(te) }); }
    if (!table[String(name)]) {
        return AEMCP_j({ ok: false, op: String(name),
                         error: "未知操作 " + name + "（可用：" + AEMCP_keys(table).join(", ") + "）" });
    }
    var mutating = (String(name).indexOf("status") !== 0 &&
                    String(name).indexOf("cap") !== 0 &&
                    String(name).indexOf("project.info") !== 0 &&
                    String(name).indexOf("comp.list") !== 0 &&
                    String(name).indexOf("comp.info") !== 0 &&
                    String(name).indexOf("layer.info") !== 0 &&
                    String(name).indexOf("layer.id") !== 0 &&
                    String(name).indexOf("layer.byId") !== 0 &&
                    String(name).indexOf("effect.list") !== 0 &&
                    String(name).indexOf("property.get") !== 0 &&
                    String(name).indexOf("op.list") !== 0 &&
                    String(name).indexOf("effect.list") !== 0 &&
                    String(name).indexOf("mask.list") !== 0 &&
                    String(name).indexOf("mask.pathGet") !== 0 &&
                    String(name).indexOf("time.get") !== 0 &&
                    String(name).indexOf("marker.list") !== 0 &&
                    String(name).indexOf("marker.nearest") !== 0 &&
                    String(name).indexOf("keyframe.get") !== 0 &&
                    String(name).indexOf("expression.validate") !== 0 &&
                    String(name).indexOf("property.tree") !== 0 &&
                    String(name).indexOf("comp.check") !== 0 &&
                    String(name).indexOf("eval.check") !== 0 &&
                    String(name).indexOf("threeD.info") !== 0 &&
                    String(name).indexOf("footage.missing") !== 0 &&
                    String(name).indexOf("path.get") !== 0 &&
                    String(name).indexOf("rq.list") !== 0 &&
                    String(name).indexOf("rq.templates") !== 0 &&
                    String(name).indexOf("text.animatorList") !== 0 &&
                    String(name).indexOf("undo.tip") !== 0 &&
                    String(name).indexOf("checkpoint.save") !== 0 &&
                    String(name).indexOf("checkpoint.revert") !== 0 &&
                    String(name).indexOf("settings") !== 0 &&
                    String(name).indexOf("viewer") !== 0);
    var opened = false;
    if (mutating) {
        try { app.beginUndoGroup("AEMCP " + name); opened = true; } catch (ue) { opened = false; }
    }
    try {
        data = table[String(name)](args);
    } catch (e) {
        if (opened) { try { app.endUndoGroup(); } catch (e2) { } }
        return AEMCP_j({ ok: false, op: String(name), error: AEMCP_clean(AEMCP_es(e)) });
    }
    if (opened) { try { app.endUndoGroup(); } catch (e3) { } }
    return AEMCP_j({ ok: true, op: String(name), ms: AEMCP_ms() - t0,
                     data: (data === undefined) ? null : data });
}
