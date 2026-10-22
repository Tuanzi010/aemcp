/* ============================================================================
   AEMCP/js/mcp.js —— 面板侧的 MCP 服务实现
   ----------------------------------------------------------------------------
   跑在 CEP 的 Node/CEF 上下文（不是 ExtendScript）。它只说三件事：
     1) JSON-RPC 2.0 的分发（initialize / tools/list / tools/call / ping / 通知）
     2) 工具表：名字 + JSON Schema + 描述（LLM 读的就是这些）
     3) 把每次调用翻成宿主操作，走 window.__AEMCP_HOST.call(op, args)

   为什么 MCP 逻辑放面板而不是外部 stdio 进程：
     AE 2021 不接受外部驱动（AfterFX.exe -r / -s 实测无效），唯一能真跑 ExtendScript
     的就是面板自己。所以「真正的执行者」必须在面板里；外部进程只是个 stdio↔HTTP
     的搬运工（见 AEMCP/mcp/aemcp-mcp.js）。

   没有依赖：只用 ES5 语法，能在 CEF 74 与 Node 12 上直接跑。
   ============================================================================ */
(function () {
    "use strict";

    var VERSION = "1.3.0";
    var DEFAULT_PROTOCOL = "2024-11-05";
    var TEXT_CAP = 40000;         /* 单次返回给模型的文本上限，超了截断并说明 */

    function errText(e) {
        if (e === null || e === undefined) { return "(未知错误)"; }
        if (typeof e === "string") { return e; }
        try { if (e.message) { return String(e.message); } } catch (x) { }
        try { return String(e); } catch (x2) { return "(无法打印的错误对象)"; }
    }

    /* ------------------------------------------------------------- 宿主通道 */
    function hostCall(op, args) {
        var h = window.__AEMCP_HOST;
        if (!h || typeof h.call !== "function") {
            return Promise.reject(new Error("宿主通道未就绪：面板还没完成初始化"));
        }
        return h.call(op, args || {}).then(function (r) {
            if (!r) { throw new Error("宿主无返回（面板可能刚重载）"); }
            if (!r.ok) { throw new Error(r.error || "宿主执行失败"); }
            return r.data;
        });
    }

    function hostEval(script) {
        var h = window.__AEMCP_HOST;
        if (!h || typeof h.evalScript !== "function") {
            return Promise.reject(new Error("宿主通道未就绪"));
        }
        return h.evalScript(String(script)).then(function (r) {
            if (!r || !r.ok) { throw new Error((r && r.error) || "ExtendScript 返回失败"); }
            return { result: r.result, ms: r.ms };
        });
    }

    /* 把宿主操作直接摊成一个工具 —— 绝大多数工具都是这么来的 */
    function opTool(op) {
        return function (args) { return hostCall(op, args || {}); };
    }

    /* --------------------------------------------------------------- 工具表 */
    var S = {                              /* 复用的小片段 */
        comp: { type: "string", description: "合成名，或 @id:12 这种 id，省略=当前活动合成" },
        layer: { type: ["string", "number"], description: "图层名、下标（1=最上层）或 layer.stamp 写的 aemcp:xxx 戳" },
        prop: { type: "string", description: "属性：友好名（position/scale/opacity/rotation/anchor）或 ADBE matchName，也支持 Effects.<效果>.<参数>" }
    };

    var TOOLS = {
        ae_status: {
            title: "AE 状态",
            description: "读宿主概况：AE 版本、ExtendScript 版本、语言、工程文件与项目项数、当前活动合成。任何操作前想确认「现在 AE 里是什么状态」就先调它。",
            schema: { type: "object", properties: {}, additionalProperties: false },
            run: opTool("status")
        },
        ae_project: {
            title: "工程清单",
            description: "列出工程里的项目（合成/素材/文件夹）：index、id、名字、类型、层级、尺寸、时长、帧率、是否离线（missing）、被谁引用。id 可以喂给其他工具的 comp/item 参数（写作 @id:N）。",
            schema: { type: "object", properties: { limit: { type: "number", description: "最多返回多少项，默认 200" } }, additionalProperties: false },
            run: opTool("project.info")
        },
        ae_comp_list: {
            title: "列出合成",
            description: "只列合成：id、名字、尺寸、帧率、时长、图层数、工作区、背景色。",
            schema: { type: "object", properties: {}, additionalProperties: false },
            run: opTool("comp.list")
        },
        ae_comp_info: {
            title: "合成详情",
            description: "一个合成的完整信息 + 它的图层清单（每层：下标、名字、类型、出入点、混合模式、父级、效果数、文本内容）。",
            schema: { type: "object", properties: { comp: S.comp }, additionalProperties: false },
            run: opTool("comp.info")
        },
        ae_comp_create: {
            title: "新建合成",
            description: "建一个合成。默认 1920x1080 / 5 秒 / 25fps。建完会在查看器里打开它（于是它成为当前活动合成，后面那些省略 comp 的图层工具就落在它上面）；open:false 可以关掉这个行为。会返回 id 与名字。",
            schema: {
                type: "object",
                properties: {
                    name: { type: "string", description: "合成名" },
                    width: { type: "number", description: "宽，默认 1920" },
                    height: { type: "number", description: "高，默认 1080" },
                    duration: { type: "number", description: "时长（秒），默认 5" },
                    frameRate: { type: "number", description: "帧率，默认 25" },
                    pixelAspect: { type: "number", description: "像素比，默认 1" },
                    bg: { type: "array", items: { type: "number" }, description: "背景色 [r,g,b]，0..1 或 0..255 或 \"#rrggbb\"" },
                    motionBlur: { type: "boolean", description: "是否开运动模糊" },
                    open: { type: "boolean", description: "建完是否在查看器里打开（默认 true；关掉它这个合成就不会成为活动合成）" }
                },
                additionalProperties: false
            },
            run: opTool("comp.create")
        },
        ae_comp_remove: {
            title: "删除合成",
            description: "从工程里删掉一个合成（不可撤销时请让用户用 Ctrl+Z）。",
            schema: { type: "object", properties: { comp: S.comp }, required: ["comp"], additionalProperties: false },
            run: opTool("comp.remove")
        },
        ae_layer_text: {
            title: "加文本层",
            description: "给合成加一个文本层，可同时设字号、颜色、对齐、位置、名字。返回该层信息（含新的 index）。",
            schema: {
                type: "object",
                properties: {
                    comp: S.comp,
                    text: { type: "string", description: "文本内容（支持中文）" },
                    fontSize: { type: "number", description: "字号（像素）" },
                    color: { type: "array", items: { type: "number" }, description: "填充色 [r,g,b]" },
                    justification: { type: "string", enum: ["left", "center", "right"], description: "段落对齐" },
                    position: { type: "array", items: { type: "number" }, description: "[x,y] 位置" },
                    name: { type: "string", description: "图层名" },
                    inPoint: { type: "number", description: "入点（秒）" },
                    outPoint: { type: "number", description: "出点（秒）" }
                },
                required: ["text"],
                additionalProperties: false
            },
            run: opTool("layer.addText")
        },
        ae_layer_solid: {
            title: "加纯色层",
            description: "加纯色层（solid）。不给宽高就取合成尺寸。注意：纯色层会在工程里落成一个素材。",
            schema: {
                type: "object",
                properties: {
                    comp: S.comp,
                    color: { type: "array", items: { type: "number" }, description: "颜色 [r,g,b]" },
                    name: { type: "string" }, width: { type: "number" }, height: { type: "number" },
                    duration: { type: "number" }, position: { type: "array", items: { type: "number" } }
                },
                additionalProperties: false
            },
            run: opTool("layer.addSolid")
        },
        ae_layer_shape: {
            title: "加形状层",
            description: "加形状层：kind=rect 或 ellipse，可设 size（宽高）、fill（填充色）、stroke（描边色+线宽）、position、roundness。",
            schema: {
                type: "object",
                properties: {
                    comp: S.comp,
                    kind: { type: "string", enum: ["rect", "ellipse"], description: "形状类型，默认 rect" },
                    size: { type: "array", items: { type: "number" }, description: "[宽,高]" },
                    fill: { type: "array", items: { type: "number" }, description: "填充色 [r,g,b]，null=不要填充" },
                    stroke: {
                        type: "object",
                        properties: { color: { type: "array", items: { type: "number" } }, width: { type: "number" } },
                        additionalProperties: false
                    },
                    roundness: { type: "number", description: "圆角半径（仅 rect）" },
                    shapePosition: { type: "array", items: { type: "number" }, description: "形状在层内的偏移 [x,y]" },
                    position: { type: "array", items: { type: "number" }, description: "图层位置 [x,y]" },
                    name: { type: "string" }
                },
                additionalProperties: false
            },
            run: opTool("layer.addShape")
        },
        ae_layer_null: {
            title: "加空对象",
            description: "加空对象（null），父级控制常用。",
            schema: { type: "object", properties: { comp: S.comp, name: { type: "string" }, position: { type: "array", items: { type: "number" } } }, additionalProperties: false },
            run: opTool("layer.addNull")
        },
        ae_layer_camera: {
            title: "加摄像机",
            description: "加 3D 摄像机，可设位置与焦距 zoom。",
            schema: { type: "object", properties: { comp: S.comp, name: { type: "string" }, position: { type: "array", items: { type: "number" } }, zoom: { type: "number" } }, additionalProperties: false },
            run: opTool("layer.addCamera")
        },
        ae_layer_info: {
            title: "图层详情",
            description: "一个图层的全部可见信息：入出点、混合模式、父级、效果列表、位置/缩放/不透明度/旋转/锚点的当前值、效果清单、文本内容。",
            schema: { type: "object", properties: { comp: S.comp, layer: S.layer }, required: ["layer"], additionalProperties: false },
            run: opTool("layer.info")
        },
        ae_layer_set: {
            title: "改图层属性",
            description: "批量修改图层：position / scale / anchor / opacity / rotation / orientation / name / comment / enabled / locked / solo / shy / threeD / adjustment / guide / inPoint / outPoint / startTime / blend（如 ADD、SCREEN、MULTIPLY）/ parent（图层名或 null）/ index（1=最上层）。只传要改的字段。",
            schema: {
                type: "object",
                properties: {
                    comp: S.comp, layer: S.layer,
                    position: { type: "array", items: { type: "number" } },
                    scale: { type: "array", items: { type: "number" } },
                    anchor: { type: "array", items: { type: "number" } },
                    opacity: { type: "number" },
                    rotation: { type: "number" },
                    orientation: { type: "array", items: { type: "number" } },
                    name: { type: "string" }, comment: { type: "string" },
                    enabled: { type: "boolean" }, locked: { type: "boolean" },
                    solo: { type: "boolean" }, shy: { type: "boolean" },
                    threeD: { type: "boolean" }, adjustment: { type: "boolean" }, guide: { type: "boolean" },
                    inPoint: { type: "number" }, outPoint: { type: "number" }, startTime: { type: "number" },
                    blend: { type: ["string", "number"], description: "混合模式名（ADD/SCREEN/MULTIPLY/NORMAL…）或枚举数字" },
                    parent: { type: ["string", "number", "null"] },
                    index: { type: "number", description: "移到第几层（1=最上层）" }
                },
                required: ["layer"],
                additionalProperties: false
            },
            run: opTool("layer.set")
        },
        ae_layer_remove: {
            title: "删图层",
            description: "删一个图层，或用 layers:[...] 一次删多个。",
            schema: {
                type: "object",
                properties: { comp: S.comp, layer: S.layer, layers: { type: "array", items: { type: ["string", "number"] } } },
                additionalProperties: false
            },
            run: opTool("layer.remove")
        },
        ae_layer_duplicate: {
            title: "复制图层",
            description: "复制图层 count 次。",
            schema: { type: "object", properties: { comp: S.comp, layer: S.layer, count: { type: "number" } }, required: ["layer"], additionalProperties: false },
            run: opTool("layer.duplicate")
        },
        ae_layer_stamp: {
            title: "给图层打戳",
            description: "给图层写一个稳定身份戳 aemcp:xxxx（存在 layer.comment 里）。AE 2021 没有 Layer.id，图层下标会随增删漂移 —— 需要跨多次调用盯住同一层时，先打戳，之后用这个戳当 layer 参数。",
            schema: { type: "object", properties: { comp: S.comp, layer: S.layer }, required: ["layer"], additionalProperties: false },
            run: opTool("layer.stamp")
        },
        ae_property_get: {
            title: "读属性",
            description: "读图层的某个属性值，附带 matchName、关键帧数、表达式原文、表达式启用状态、表达式报错（expressionError）、propertyParameters/valueText（AE 26.0+ 的下拉菜单参数/值文本，无下拉的属性这两项为 null）。想看整棵属性树用 ae_property_tree，想看每个关键帧的缓动用 ae_keyframe_get。",
            schema: { type: "object", properties: { comp: S.comp, layer: S.layer, property: S.prop }, required: ["layer"], additionalProperties: false },
            run: opTool("property.get")
        },
        ae_property_set: {
            title: "写属性",
            description: "给属性赋值（position/scale/opacity/rotation/anchor 或任意 ADBE matchName、Effects.<效果>.<参数>）。",
            schema: {
                type: "object",
                properties: { comp: S.comp, layer: S.layer, property: S.prop, value: { description: "数值 / [x,y] / [r,g,b] / 字符串" } },
                required: ["layer", "property", "value"],
                additionalProperties: false
            },
            run: opTool("property.set")
        },
        ae_keyframe_set: {
            title: "设关键帧",
            description: "给属性设一组关键帧 keys=[{t:秒, v:值}]。默认先清掉原有同属性关键帧。ease 可用数字（速度）或 [速度,影响]（影响默认 33），interpolation 可选 linear/bezier/hold。",
            schema: {
                type: "object",
                properties: {
                    comp: S.comp, layer: S.layer, property: S.prop,
                    keys: {
                        type: "array",
                        items: { type: "object", properties: { t: { type: "number" }, v: {} }, required: ["t"] },
                        description: "[{t:0,v:[100,100]},{t:1,v:[500,100]}]"
                    },
                    ease: { description: "数字速度，或 [速度,影响]，或 {speed,influence}" },
                    interpolation: { type: "string", enum: ["linear", "bezier", "hold"] },
                    clear: { type: "boolean", description: "是否先清原有键，默认 true" }
                },
                required: ["layer", "keys"],
                additionalProperties: false
            },
            run: opTool("keyframe.set")
        },
        ae_keyframe_clear: {
            title: "清关键帧",
            description: "清掉某个属性上的所有关键帧。",
            schema: { type: "object", properties: { comp: S.comp, layer: S.layer, property: S.prop }, required: ["layer"], additionalProperties: false },
            run: opTool("keyframe.clear")
        },
        ae_expression_set: {
            title: "写表达式",
            description: "给属性写表达式，写完立刻求值一次并返回当前值与错误。三种给法任选一种：expression（自己写原文）、template（内置模板名 + templateArgs 参数）、link（跨层引用另一个图层上的属性，自动生成正确引用串）。也可用 properties:[...] 一次给多个属性套同一个表达式。",
            schema: {
                type: "object",
                properties: {
                    comp: S.comp, layer: S.layer, property: S.prop,
                    expression: { type: "string", description: "表达式原文，如 \"wiggle(2,30)\" 或 \"loopOut(\\\"cycle\\\")\"" },
                    template: { type: "string", description: "内置模板名：wiggle / seedWiggle / smooth / loopOut / loopIn / posterizeTime / timeDelay / randomHold / bounce1D / bouncePos / springy" },
                    templateArgs: { type: "object", description: "模板参数，如 {\"freq\":3,\"amp\":40}；省略用模板默认值" },
                    link: {
                        type: "object",
                        description: "跨层链接：{\"layer\":\"目标图层名\",\"property\":\"position\"}",
                        properties: {
                            layer: { type: ["string", "number"], description: "源图层：名字或下标" },
                            property: { type: "string", description: "源属性（友好名或 matchName），默认 position" }
                        }
                    },
                    properties: { type: "array", items: { type: "string" }, description: "要一起套的属性列表（同层多个属性共用一个表达式）" }
                },
                required: ["layer"],
                additionalProperties: false
            },
            run: opTool("expression.set")
        },
        ae_expression_clear: {
            title: "清表达式",
            description: "清掉属性上的表达式。",
            schema: { type: "object", properties: { comp: S.comp, layer: S.layer, property: S.prop }, required: ["layer"], additionalProperties: false },
            run: opTool("expression.clear")
        },
        ae_effect_add: {
            title: "加效果",
            description: "给图层加效果：matchName 例 ADBE Fill / ADBE Gaussian Blur 2 / ADBE Drop Shadow / ADBE Tint / ADBE Blur。加表达式控件（滑块/角度/颜色/复选框/点/图层）不用写 matchName，用 control=slider|angle|color|checkbox|point|point3d|layer|dropdown 更方便 —— 加完会直接回传表达式引用串。",
            schema: {
                type: "object",
                properties: {
                    comp: S.comp, layer: S.layer,
                    control: { type: "string", enum: ["slider", "angle", "color", "checkbox", "point", "point3d", "layer", "dropdown"], description: "加表达式控件（与 matchName 二选一）" },
                    value: { description: "控件初值（配合 control 用）" },
                    matchName: { type: "string", description: "效果 matchName，例 ADBE Gaussian Blur 2" },
                    name: { type: "string", description: "效果的显示名（想给控件起个好名字就写它）" },
                    params: { type: "object", description: "参数初值，如 {\"ADBE Gaussian Blur 2-0001\": 20} 或 {\"模糊度\": 20}" }
                },
                required: ["layer"],
                additionalProperties: false
            },
            run: opTool("effect.add")
        },
        ae_effect_set: {
            title: "改效果参数",
            description: "改已有效果的参数：effect 用效果名/序号/matchName 指，params 是 {参数名或matchName: 值}。",
            schema: {
                type: "object",
                properties: {
                    comp: S.comp, layer: S.layer,
                    effect: { type: ["string", "number"], description: "效果名 / 序号 / matchName" },
                    params: { type: "object", description: "{\"模糊度\": 30} 这种参数表" }
                },
                required: ["layer", "effect", "params"],
                additionalProperties: false
            },
            run: opTool("effect.set")
        },
        ae_effect_remove: {
            title: "删效果",
            description: "按名字或 matchName 删掉图层上的一个效果。",
            schema: { type: "object", properties: { comp: S.comp, layer: S.layer, effect: { type: ["string", "number"] } }, required: ["layer", "effect"], additionalProperties: false },
            run: opTool("effect.remove")
        },
        ae_render_queue_add: {
            title: "加入渲染队列",
            description: "把合成加进渲染队列（只入队，不渲染 —— 渲染会占住 AE UI）。可给输出路径与输出模板名。",
            schema: {
                type: "object",
                properties: { comp: S.comp, outputPath: { type: "string", description: "输出文件全路径" }, template: { type: "string", description: "输出模板名，如 \"PNG 序列\"" } },
                additionalProperties: false
            },
            run: opTool("render.queueAdd")
        },
        ae_exec: {
            title: "执行 ExtendScript",
            description: "直接跑一段 ExtendScript（ES3），返回最后一条表达式的值。逃生舱：上面的结构化工具都能干的事就优先用它们；需要宿主特殊 API、循环建一堆东西、或读一个没有专门工具的状态时用这个。脚本在 AE 主线程上跑，别写死循环。",
            schema: { type: "object", properties: { script: { type: "string", description: "要执行的 ExtendScript 源码" } }, required: ["script"], additionalProperties: false },
            run: function (args) {
                return hostEval(args.script).then(function (r) {
                    return { result: r.result, ms: r.ms };
                });
            }
        },
        ae_probe: {
            title: "跑兼容性探针",
            description: "重跑内置探针（AEMCP_probe），返回逐条能力判据的原始行协议文本。诊断用：桥出问题、换 AE 版本、怀疑某个 API 不可用时跑它。",
            schema: { type: "object", properties: {}, additionalProperties: false },
            run: function () {
                return hostEval("AEMCP_probe()").then(function (r) {
                    var txt = String(r.result || "");
                    var lines = txt.split("\n").length;
                    return { lines: lines, ms: r.ms, raw: txt };
                });
            }
        },
        /* ============ P0 扩展：蒙版（6）============ */
        ae_mask_add: {
            title: "加蒙版",
            description: "给图层加一个蒙版。shape 可写 \"rect\" / \"ellipse\" / [[x,y],...] / {preset,center,size}，省略就用 AE 的默认矩形。蒙版的四个属性（路径/羽化/不透明度/扩展）都是普通属性，可以再打关键帧或用 ae_property_set 走点号路径改。",
            schema: {
                type: "object",
                properties: {
                    comp: S.comp, layer: S.layer,
                    shape: { description: "路径：\"rect\" / \"ellipse\" / [[x,y],...] / {preset:\"rect\",center:[x,y],size:[w,h]}" },
                    mode: { type: "string", enum: ["none", "add", "subtract", "intersect", "lighten", "darken", "difference"], description: "蒙版模式，默认 add" },
                    inverted: { type: "boolean", description: "是否反转" },
                    feather: { type: "array", items: { type: "number" }, description: "羽化 [x,y]" },
                    opacity: { type: "number", description: "蒙版不透明度 0..100" },
                    expansion: { type: "number", description: "扩展（像素）" }
                },
                required: ["layer"],
                additionalProperties: false
            },
            run: opTool("mask.add")
        },
        ae_mask_list: {
            title: "列蒙版",
            description: "列出一个图层上的所有蒙版：名字、模式、是否反转、路径顶点数、四个属性的当前值与关键帧数。",
            schema: { type: "object", properties: { comp: S.comp, layer: S.layer }, required: ["layer"], additionalProperties: false },
            run: opTool("mask.list")
        },
        ae_mask_remove: {
            title: "删蒙版",
            description: "按名字或下标删掉图层上的一个蒙版。",
            schema: { type: "object", properties: { comp: S.comp, layer: S.layer, mask: S.mask }, required: ["layer"], additionalProperties: false },
            run: opTool("mask.remove")
        },
        ae_mask_path_get: {
            title: "读蒙版路径",
            description: "把蒙版路径读成顶点/切线数组（顶点是图层坐标）。atTime 给了就读那个时间点的路径（路径打了关键帧时才有意义）。",
            schema: {
                type: "object",
                properties: { comp: S.comp, layer: S.layer, mask: S.mask, atTime: { type: "number", description: "读取时间点（秒），省略=当前时间" } },
                required: ["layer"],
                additionalProperties: false
            },
            run: opTool("mask.pathGet")
        },
        ae_mask_path_set: {
            title: "写蒙版路径",
            description: "写回蒙版路径，写法与 ae_mask_add 的 shape 相同。atTime 给了就写在该时间点的关键帧上。向量形状要变形时，两个关键帧的顶点数必须一致。",
            schema: {
                type: "object",
                properties: {
                    comp: S.comp, layer: S.layer, mask: S.mask,
                    shape: { description: "\"rect\" / \"ellipse\" / [[x,y],...] / {vertices,inTangents,outTangents,closed} / {preset,center,size}" },
                    atTime: { type: "number", description: "写在哪个时间点（秒），省略=当前时间（会覆盖静态值）" }
                },
                required: ["layer", "shape"],
                additionalProperties: false
            },
            run: opTool("mask.pathSet")
        },
        ae_mask_keyframes: {
            title: "蒙版关键帧",
            description: "读或写蒙版属性上的关键帧。property=path 时 keys=[{t,v}] 的 v 是路径（写法同 shape）——这就是「蒙版变形」；property=feather/opacity/expansion 时 v 是数值（feather 是 [x,y]）。不给 keys 就是读。",
            schema: {
                type: "object",
                properties: {
                    comp: S.comp, layer: S.layer, mask: S.mask,
                    property: { type: "string", enum: ["path", "feather", "opacity", "expansion"], description: "要操作的蒙版属性，默认 path" },
                    keys: { type: "array", items: { type: "object" }, description: "要写的关键帧 [{t:秒, v:路径或数值}]；省略=只读" },
                    ease: { description: "缓动：数字（速度）或 [速度,影响]" },
                    interpolation: { type: "string", enum: ["linear", "bezier", "hold"] }
                },
                required: ["layer"],
                additionalProperties: false
            },
            run: opTool("mask.keyframes")
        },

        /* ============ P0 扩展：时间线与标记（8）============ */
        ae_time_get: {
            title: "读时间与工作区",
            description: "读合成的时间指针、时长、帧率、起始时间、工作区。想确认「现在播放头在哪」用它。",
            schema: { type: "object", properties: { comp: S.comp }, additionalProperties: false },
            run: opTool("time.get")
        },
        ae_time_set: {
            title: "移动时间指针",
            description: "把合成的时间指针挪到某一秒。只动播放头，不改任何关键帧。",
            schema: { type: "object", properties: { comp: S.comp, time: { type: "number", description: "目标时间（秒）" } }, required: ["time"], additionalProperties: false },
            run: opTool("time.set")
        },
        ae_workarea_set: {
            title: "设工作区",
            description: "设合成的工作区（渲染/预览的范围）。给 start + duration，或 start + end。",
            schema: {
                type: "object",
                properties: {
                    comp: S.comp,
                    start: { type: "number", description: "工作区起点（秒）" },
                    duration: { type: "number", description: "工作区时长（秒）" },
                    end: { type: "number", description: "工作区终点（秒），给了就一直算 duration" }
                },
                additionalProperties: false
            },
            run: opTool("workarea.set")
        },
        ae_marker_add: {
            title: "加标记",
            description: "在合成（或某个图层）上加标记，可带注释、章节、URL、时长、颜色标签。省略 layer 就是合成标记。",
            schema: {
                type: "object",
                properties: {
                    comp: S.comp, layer: S.layer,
                    time: { type: "number", description: "时间点（秒），省略=当前时间" },
                    comment: { type: "string", description: "标记注释（最常用）" },
                    chapter: { type: "string", description: "章节链接" },
                    url: { type: "string", description: "关联 URL" },
                    frameTarget: { type: "string", description: "帧目标" },
                    cuePointName: { type: "string", description: "Flash 提示点名" },
                    duration: { type: "number", description: "标记时长（秒）" },
                    label: { type: "number", description: "标签色 0–16（0=无色）" },
                    protectedRegion: { type: "boolean", description: "合成标记的保护区域（AE 16+）" }
                },
                additionalProperties: false
            },
            run: opTool("marker.add")
        },
        ae_marker_list: {
            title: "列标记",
            description: "列出合成（或图层）上的所有标记：下标、时间、注释、时长、标签色等。",
            schema: { type: "object", properties: { comp: S.comp, layer: S.layer }, additionalProperties: false },
            run: opTool("marker.list")
        },
        ae_marker_remove: {
            title: "删标记",
            description: "按下标或时间点删掉一个标记。",
            schema: {
                type: "object",
                properties: { comp: S.comp, layer: S.layer, index: { type: "number", description: "标记下标（1 起）" }, time: { type: "number", description: "标记时间（秒），与 index 二选一" } },
                additionalProperties: false
            },
            run: opTool("marker.remove")
        },
        ae_marker_nearest: {
            title: "找最近的标记",
            description: "从某个时间点出发找标记：dir=nearest（最近）/ next（往前找）/ prev（往回找）。只读，不移动播放头。想直接跳过去用 ae_marker_snap。",
            schema: {
                type: "object",
                properties: {
                    comp: S.comp, layer: S.layer,
                    time: { type: "number", description: "出发点（秒），省略=当前时间" },
                    dir: { type: "string", enum: ["nearest", "next", "prev"], description: "方向，默认 nearest" }
                },
                additionalProperties: false
            },
            run: opTool("marker.nearest")
        },
        ae_marker_snap: {
            title: "吸附到标记",
            description: "把合成时间指针跳到指定的标记上（next/prev/nearest）。set=false 就只算不跳（等于 ae_marker_nearest，但语义是「准备跳」）。",
            schema: {
                type: "object",
                properties: {
                    comp: S.comp, layer: S.layer,
                    time: { type: "number", description: "出发点（秒），省略=当前时间" },
                    dir: { type: "string", enum: ["nearest", "next", "prev"], description: "方向，默认 nearest" },
                    set: { type: "boolean", description: "是否真的移动播放头，默认 true" }
                },
                additionalProperties: false
            },
            run: opTool("marker.snap")
        },

        /* ============ P0 扩展：图层种类（5）============ */
        ae_layer_adjustment: {
            title: "加调整层",
            description: "加一个合成大小的调整层（只影响它下面的图层）。等价于「纯色 + 打开 adjustmentLayer」；如果只是想切换已有图层的调整层属性，用 ae_layer_set 的 adjustment。",
            schema: {
                type: "object",
                properties: { comp: S.comp, name: { type: "string" }, position: { type: "array", items: { type: "number" } } },
                additionalProperties: false
            },
            run: opTool("layer.addAdjustment")
        },
        ae_layer_light: {
            title: "加灯光",
            description: "加 3D 灯光层，可设位置与强度。默认点光，参数与 ae_layer_camera 对称。（宿主侧这能力一直有，之前没做成工具，现在补上。）",
            schema: {
                type: "object",
                properties: {
                    comp: S.comp, name: { type: "string" },
                    position: { type: "array", items: { type: "number" }, description: "[x,y] 或 [x,y,z]" },
                    intensity: { type: "number", description: "灯光强度，默认 100" }
                },
                additionalProperties: false
            },
            run: opTool("layer.addLight")
        },
        ae_layer_av: {
            title: "把素材/合成放成图层",
            description: "把工程里已有的素材或合成放进目标合成当一个图层（等于在项目面板里拖进合成）。item 用名字或 @id:N。",
            schema: {
                type: "object",
                properties: {
                    comp: S.comp,
                    item: { type: "string", description: "要放进来的素材/合成：名字或 @id:N" },
                    duration: { type: "number", description: "图层时长（秒），省略=源本身时长" }
                },
                required: ["item"],
                additionalProperties: false
            },
            run: opTool("layer.addAV")
        },
        ae_layer_precompose: {
            title: "预合成",
            description: "把指定图层预合成成一个新合成。layers 是图层数组（名字或下标）。原图层会从当前合成消失，取而代之是一个预合成层。",
            schema: {
                type: "object",
                properties: {
                    comp: S.comp,
                    layers: { type: "array", items: { type: ["string", "number"] }, description: "要预合成的图层：[1,2] 或 [\"文字\",\"纯色\"]" },
                    name: { type: "string", description: "新合成名，默认「原名 预合成」" },
                    moveAllAttributes: { type: "boolean", description: "把效果/蒙版/变换一并搬走，默认 true" }
                },
                required: ["layers"],
                additionalProperties: false
            },
            run: opTool("layer.precompose")
        },
        ae_layer_reorder: {
            title: "挪动图层顺序",
            description: "把图层挪到另一个图层的 before/after 位置（用「放在谁旁边」表达，比 ae_layer_set 的 index 更稳，不会因为移动过程中下标漂移而错位）。",
            schema: {
                type: "object",
                properties: {
                    comp: S.comp, layer: S.layer,
                    to: { type: ["string", "number"], description: "参照图层：名字或下标" },
                    where: { type: "string", enum: ["before", "after"], description: "放在它前面还是后面，默认 before" }
                },
                required: ["layer", "to"],
                additionalProperties: false
            },
            run: opTool("layer.reorder")
        },

        /* ============ P0 扩展：关键帧进阶（6）============ */
        ae_keyframe_get: {
            title: "读关键帧",
            description: "把一个属性上的关键帧全读出来：时间、值、出入插值（linear/bezier/hold）、出入缓动（[速度,影响]）。只想知道有几个键就用 ae_property_get。",
            schema: { type: "object", properties: { comp: S.comp, layer: S.layer, property: S.prop }, required: ["layer"], additionalProperties: false },
            run: opTool("keyframe.get")
        },
        ae_keyframe_ease: {
            title: "改已有键的缓动",
            description: "给**已经存在**的关键帧统一改缓动/插值，不动时间与值。要给新键顺带设缓动，直接用 ae_keyframe_set 的 ease/interpolation 更省一次调用。",
            schema: {
                type: "object",
                properties: {
                    comp: S.comp, layer: S.layer, property: S.prop,
                    ease: { description: "缓动：数字（速度）或 [速度,影响]（影响默认 33）" },
                    interpolation: { type: "string", enum: ["linear", "bezier", "hold"], description: "插值类型" }
                },
                required: ["layer"],
                additionalProperties: false
            },
            run: opTool("keyframe.ease")
        },
        ae_keyframe_offset: {
            title: "整体平移关键帧",
            description: "把一个属性上的所有关键帧在时间轴上整体前后推 delta 秒（保持间距与值）。",
            schema: {
                type: "object",
                properties: { comp: S.comp, layer: S.layer, property: S.prop, delta: { type: "number", description: "平移秒数，可为负" } },
                required: ["layer", "delta"],
                additionalProperties: false
            },
            run: opTool("keyframe.offset")
        },
        ae_keyframe_scale_timing: {
            title: "缩放关键帧节奏",
            description: "以某个时间点为轴把整组关键帧的时间间距缩/放：factor<1 更紧凑，>1 更慢。值不变。",
            schema: {
                type: "object",
                properties: {
                    comp: S.comp, layer: S.layer, property: S.prop,
                    factor: { type: "number", description: "时间倍率，1=不变，0.5=时长减半，2=拉长一倍" },
                    pivot: { type: "number", description: "轴心时间（秒），省略=第一个关键帧" }
                },
                required: ["layer", "factor"],
                additionalProperties: false
            },
            run: opTool("keyframe.scaleTiming")
        },
        ae_keyframe_reverse: {
            title: "反转关键帧",
            description: "时间点不动，把关键帧的值的先后顺序倒过来（同 AE 的「时间反转关键帧」）。做倒放动画用。",
            schema: { type: "object", properties: { comp: S.comp, layer: S.layer, property: S.prop }, required: ["layer"], additionalProperties: false },
            run: opTool("keyframe.reverse")
        },
        ae_keyframe_copy: {
            title: "复制关键帧",
            description: "把一个属性上的关键帧整组复制到另一个属性（可以跨图层，例如把位置的关键帧搬到缩放上）。offset 给了就把目标组对齐到那个时间点。",
            schema: {
                type: "object",
                properties: {
                    comp: S.comp, layer: S.layer, property: S.prop,
                    toLayer: { type: ["string", "number"], description: "目标图层，省略=同层" },
                    toProperty: { type: "string", description: "目标属性，省略=同属性" },
                    offset: { type: "number", description: "目标第一个键的时间点（秒），省略=保持原时间" }
                },
                required: ["layer"],
                additionalProperties: false
            },
            run: opTool("keyframe.copy")
        },

        /* ============ P0 扩展：表达式诊断（1）============ */
        ae_expression_validate: {
            title: "体检表达式",
            description: "只读：把工程里每个表达式都求值一次，把报错的挑出来（合成/图层/属性/错误文本/表达式片段）。想整体体检一个合成用 ae_comp_check。",
            schema: {
                type: "object",
                properties: {
                    comp: { type: "string", description: "只查这个合成，省略=全部合成" },
                    limit: { type: "number", description: "最多扫多少个属性，默认 500" }
                },
                additionalProperties: false
            },
            run: opTool("expression.validate")
        },

        /* ============ P0 扩展：效果与诊断（4）============ */
        ae_effect_list: {
            title: "列效果",
            description: "列出一个图层上的效果：下标、名字、matchName、是否启用、参数表。看参数细节也可以用 ae_property_tree 深挖。",
            schema: { type: "object", properties: { comp: S.comp, layer: S.layer }, required: ["layer"], additionalProperties: false },
            run: opTool("effect.list")
        },
        ae_effect_copy: {
            title: "复制效果",
            description: "把一个图层上的效果（连参数值）复制到另一个图层。省略 toLayer 就是在同层再叠一份。想从零加效果用 ae_effect_add。",
            schema: {
                type: "object",
                properties: {
                    comp: S.comp, layer: S.layer,
                    effect: { type: ["string", "number"], description: "效果名、下标或 matchName" },
                    toLayer: { type: ["string", "number"], description: "目标图层，省略=同层" },
                    name: { type: "string", description: "复制后的效果名" }
                },
                required: ["layer", "effect"],
                additionalProperties: false
            },
            run: opTool("effect.copy")
        },
        ae_effect_reorder: {
            title: "调整效果顺序",
            description: "把某个效果挪到效果栈里的第 to 位（1=最上面）。效果顺序会影响渲染结果。",
            schema: {
                type: "object",
                properties: {
                    comp: S.comp, layer: S.layer,
                    effect: { type: ["string", "number"], description: "效果名、下标或 matchName" },
                    to: { type: "number", description: "目标位置，1=最上面" }
                },
                required: ["layer", "effect", "to"],
                additionalProperties: false
            },
            run: opTool("effect.reorder")
        },
        ae_property_tree: {
            title: "属性树",
            description: "把一个图层（或某个属性组）的属性树按 matchName 递归 dump 出来，用来查「这个效果/形状的某个参数到底叫什么」。只要一个值用 ae_property_get。",
            schema: {
                type: "object",
                properties: {
                    comp: S.comp, layer: S.layer,
                    property: { type: "string", description: "从哪个属性开始 dump，省略=整个图层" },
                    depth: { type: "number", description: "递归深度，默认 3" }
                },
                required: ["layer"],
                additionalProperties: false
            },
            run: opTool("property.tree")
        },

        /* ============ P0 扩展：工程与项（6）============ */
        ae_comp_modify: {
            title: "改合成设置",
            description: "改已有合成的设置：尺寸、时长、帧率、像素比、背景色、运动模糊、起始时间、工作区、名字。只传要改的字段（改尺寸会实际改变合成内容的大小）。",
            schema: {
                type: "object",
                properties: {
                    comp: S.comp,
                    name: { type: "string" },
                    width: { type: "number" }, height: { type: "number" },
                    duration: { type: "number", description: "时长（秒）" },
                    frameRate: { type: "number", description: "帧率" },
                    pixelAspect: { type: "number" },
                    bg: { type: "array", items: { type: "number" }, description: "背景色 [r,g,b]" },
                    motionBlur: { type: "boolean" },
                    displayStartTime: { type: "number", description: "合成起始时间（秒）" },
                    workArea: { type: "array", items: { type: "number" }, description: "[起点, 时长]" }
                },
                additionalProperties: false
            },
            run: opTool("comp.modify")
        },
        ae_comp_duplicate: {
            title: "复制合成",
            description: "整份复制一个合成（含所有图层、效果、蒙版、关键帧），可顺便改名。",
            schema: { type: "object", properties: { comp: S.comp, name: { type: "string", description: "副本的名字" } }, additionalProperties: false },
            run: opTool("comp.duplicate")
        },
        ae_comp_check: {
            title: "合成体检",
            description: "扫一个合成的问题：零长度图层、出入点反常、素材离线、表达式报错、图层没有源，并给出效果/蒙版/关键帧总数。改完一堆东西后想知道有没有搞坏，跑它。",
            schema: { type: "object", properties: { comp: S.comp }, additionalProperties: false },
            run: opTool("comp.check")
        },
        ae_item_activate: {
            title: "激活项目项",
            description: "把某个合成在查看器里打开、从而成为当前活动合成（AE 里 activeItem 是只读的，openInViewer 是唯一办法）。item 用名字或 @id:N；省略=回当前活动项的信息。素材/文件夹没法激活，会如实告诉你。",
            schema: { type: "object", properties: { item: { type: "string", description: "项目项名字或 @id:N" } }, additionalProperties: false },
            run: opTool("item.activate")
        },
        ae_item_rename: {
            title: "重命名项目项",
            description: "改项目项（合成/素材/文件夹）的名字。改图层名请用 ae_layer_set 的 name。",
            schema: { type: "object", properties: { item: { type: "string", description: "项目项名字或 @id:N" }, name: { type: "string", description: "新名字" } }, required: ["item", "name"], additionalProperties: false },
            run: opTool("item.rename")
        },
        ae_item_remove: {
            title: "删除项目项",
            description: "从工程里删掉素材或文件夹（合成请用 ae_comp_remove，两个工具分工不重叠）。",
            schema: { type: "object", properties: { item: { type: "string", description: "项目项名字或 @id:N" } }, required: ["item"], additionalProperties: false },
            run: opTool("item.remove")
        },

        /* ============ P1-A 3D / 材质 / 相机 / 灯光（5）============ */
        ae_3d_info: {
            title: "3D 概览",
            description: "读合成的 3D 概况：当前渲染器、本机可用的渲染器列表、所有 3D 图层（含是否摄像机/灯光）。想设渲染器先跑它看 comp.renderers 里到底有哪些可用值。",
            schema: { type: "object", properties: { comp: S.comp }, additionalProperties: false },
            run: opTool("threeD.info")
        },
        ae_material_options_set: {
            title: "改 3D 材质",
            description: "改一个 3D 图层的材质选项：透光/环境/漫反射/镜面反射/高光强度/金属质感、投射阴影（off/on/only）、接受阴影、接受灯光。只有 3D 图层有材质（不是 3D 图层会自动打开 3D）。castsShadows/acceptsShadows 三态：off=0、on=1、only=2；acceptsLights 只 0/1。",
            schema: {
                type: "object",
                properties: {
                    comp: S.comp, layer: S.layer,
                    lightTransmission: { type: "number", description: "透光率 0..100" },
                    ambient: { type: "number", description: "环境 0..100" },
                    diffuse: { type: "number", description: "漫反射 0..100" },
                    specular: { type: "number", description: "镜面反射强度 0..100" },
                    shininess: { type: "number", description: "高光强度 0..100" },
                    metal: { type: "number", description: "金属质感 0..100" },
                    castsShadows: { type: ["boolean", "number", "string"], description: "off/on/only（或 0/1/2）" },
                    acceptsShadows: { type: ["boolean", "number", "string"], description: "off/on/only（或 0/1/2）" },
                    acceptsLights: { type: "boolean", description: "是否接受灯光" }
                },
                required: ["layer"],
                additionalProperties: false
            },
            run: opTool("material.set")
        },
        ae_camera_options_set: {
            title: "改摄像机",
            description: "改摄像机图层的镜头参数：缩放/焦距、景深开关、焦点距离、光圈、模糊级别、光圈形状/旋转/圆度/纵横比/衍射条纹/高光增益/高光阈值/高光饱和度。目标是普通图层会报错（必须是摄像机）。",
            schema: {
                type: "object",
                properties: {
                    comp: S.comp, layer: S.layer,
                    zoom: { type: "number", description: "缩放/焦距（像素）" },
                    depthOfField: { type: "boolean", description: "是否开景深（0/1）" },
                    focusDistance: { type: "number", description: "焦点距离（像素）" },
                    aperture: { type: "number", description: "光圈" },
                    blurLevel: { type: "number", description: "模糊级别 0..100" },
                    irisShape: { type: "number", description: "光圈形状" },
                    irisRotation: { type: "number", description: "光圈旋转" },
                    irisRoundness: { type: "number", description: "光圈圆度" },
                    irisAspectRatio: { type: "number", description: "光圈纵横比" },
                    irisDiffractionFringe: { type: "number", description: "衍射条纹" },
                    irisHighlightGain: { type: "number", description: "高光增益" },
                    irisHighlightThreshold: { type: "number", description: "高光阈值" },
                    irisHighlightSaturation: { type: "number", description: "高光饱和度" }
                },
                required: ["layer"],
                additionalProperties: false
            },
            run: opTool("camera.set")
        },
        ae_light_options_set: {
            title: "改灯光",
            description: "改灯光图层的参数：强度、颜色、锥角、锥形羽化、衰减类型、半径、衰减距离、阴影暗度、阴影扩散，或整灯类型（parallel/spot/point/ambient）。目标是普通图层会报错。",
            schema: {
                type: "object",
                properties: {
                    comp: S.comp, layer: S.layer,
                    intensity: { type: "number", description: "强度 0..250" },
                    color: { type: "array", items: { type: "number" }, description: "颜色 [r,g,b]，0..1 或 0..255" },
                    coneAngle: { type: "number", description: "锥角（度）" },
                    coneFeather: { type: "number", description: "锥形羽化 0..100" },
                    falloff: { type: "number", description: "衰减类型：1=无 2=平滑 3=反向平方" },
                    radius: { type: "number", description: "半径（衰减起始）" },
                    falloffDistance: { type: "number", description: "衰减距离" },
                    shadowDarkness: { type: "number", description: "阴影暗度 0..100" },
                    shadowDiffusion: { type: "number", description: "阴影扩散（像素）" },
                    lightType: { type: ["string", "number"], description: "parallel/spot/point/ambient" }
                },
                required: ["layer"],
                additionalProperties: false
            },
            run: opTool("light.set")
        },
        ae_comp_renderer_set: {
            title: "切换合成渲染器",
            description: "切换合成的 3D 渲染器（如经典 3D / Cinema 4D）。renderer 给名字，工具会去匹配 comp.renderers 里最接近的；先 ae_3d_info 看可用列表。",
            schema: {
                type: "object",
                properties: { comp: S.comp, renderer: { type: "string", description: "渲染器名（见 ae_3d_info 的 renderers）" } },
                required: ["renderer"],
                additionalProperties: false
            },
            run: opTool("comp.rendererSet")
        },

        /* ============ P1-B 素材 / 解释 / 代理 / 归类（8）============ */
        ae_footage_import: {
            title: "导入素材",
            description: "把一个文件导入工程：可设是否按序列导入（sequence）、是否强制字母顺序（forceAlphabetical）、导入成什么（importAs：footage/comp/comp_cropped_layers/project）。返回新项目的 id。",
            schema: {
                type: "object",
                properties: {
                    path: { type: "string", description: "文件完整路径" },
                    sequence: { type: "boolean", description: "是否作为图像序列导入" },
                    forceAlphabetical: { type: "boolean", description: "是否强制字母顺序" },
                    importAs: { type: "string", description: "footage | comp | comp_cropped_layers | project" }
                },
                required: ["path"],
                additionalProperties: false
            },
            run: opTool("footage.import")
        },
        ae_footage_import_folder: {
            title: "导入整个文件夹",
            description: "把目录里的图片/视频/音频文件批量导入工程（只收常见媒体扩展名，其余跳过）。sequence=true 会把连续编号的文件按序列导入。",
            schema: {
                type: "object",
                properties: {
                    folder: { type: "string", description: "目录完整路径" },
                    sequence: { type: "boolean", description: "连续编号文件按序列导入，默认 false" }
                },
                required: ["folder"],
                additionalProperties: false
            },
            run: opTool("footage.importFolder")
        },
        ae_footage_replace: {
            title: "替换素材",
            description: "替换项目里某个素材（给 item+path）或某个图层用的源（给 comp+layer+path）为另一个文件。给 layer 时用 replaceSource（保留图层与效果/关键帧），可选 fixExpressions 修表达式里的引用。",
            schema: {
                type: "object",
                properties: {
                    item: { type: "string", description: "项目项名字或 @id:N（替换项目素材时用）" },
                    comp: S.comp, layer: S.layer,
                    path: { type: "string", description: "替换成哪个文件" },
                    fixExpressions: { type: "boolean", description: "替换图层源时是否尝试修表达式引用" }
                },
                required: ["path"],
                additionalProperties: false
            },
            run: opTool("footage.replace")
        },
        ae_footage_missing: {
            title: "查离线素材",
            description: "列出工程里所有离线的素材（mainSource.isStill=false 且 footageMissing=true），返回 id/名字/类型。",
            schema: { type: "object", properties: {}, additionalProperties: false },
            run: opTool("footage.missing")
        },
        ae_interpretation_set: {
            title: "改素材解释",
            description: "改一个素材的解释参数：帧率、alpha 通道类型、反转 alpha、场分离、去 pulldown、循环次数、像素比、预乘颜色。静帧素材不能设 conformFrameRate（会报错，工具会转成可读信息）。",
            schema: {
                type: "object",
                properties: {
                    item: { type: "string", description: "项目项名字或 @id:N" },
                    conformFrameRate: { type: "number", description: "符合帧率（fps）" },
                    alphaMode: { type: "string", description: "ignore | straight | premultiplied" },
                    invertAlpha: { type: "boolean" },
                    fieldSeparationType: { type: "string", description: "off | upper | lower" },
                    removePulldown: { type: "number", description: "去 pulldown：WSSWW=1 SSWWW=2 等" },
                    loop: { type: "number", description: "循环次数（素材时长倍数）" },
                    pixelAspect: { type: "number", description: "像素比" },
                    premulColor: { type: "array", items: { type: "number" }, description: "预乘颜色 [r,g,b]" }
                },
                required: ["item"],
                additionalProperties: false
            },
            run: opTool("interpretation.set")
        },
        ae_proxy_set: {
            title: "设代理",
            description: "给素材设代理：path=文件代理（sequence=true 按序列），或 solid=[r,g,b] 纯色代理（配 name/width/height/pixelAspect）。",
            schema: {
                type: "object",
                properties: {
                    item: { type: "string", description: "项目项名字或 @id:N" },
                    path: { type: "string", description: "代理文件路径" },
                    sequence: { type: "boolean", description: "path 是否按序列导入代理" },
                    forceAlphabetical: { type: "boolean" },
                    solid: { type: "array", items: { type: "number" }, description: "纯色代理颜色 [r,g,b]" },
                    name: { type: "string" }, width: { type: "number" }, height: { type: "number" }, pixelAspect: { type: "number" }
                },
                required: ["item"],
                additionalProperties: false
            },
            run: opTool("proxy.set")
        },
        ae_proxy_remove: {
            title: "移除代理",
            description: "移除一个素材的代理（setProxyToNone）。",
            schema: { type: "object", properties: { item: { type: "string", description: "项目项名字或 @id:N" } }, required: ["item"], additionalProperties: false },
            run: opTool("proxy.remove")
        },
        ae_item_organize: {
            title: "归类项目项",
            description: "整理工程面板：item+folder 把单个项目项移进指定文件夹（不存在会建）；byType=true 把顶层条目按类型归进 Comps/Solids/Video/Images/Audio/Footage 文件夹。",
            schema: {
                type: "object",
                properties: {
                    item: { type: "string", description: "项目项名字或 @id:N" },
                    folder: { type: "string", description: "目标文件夹名（不存在会建）" },
                    byType: { type: "boolean", description: "true=按类型归类所有顶层条目" }
                },
                additionalProperties: false
            },
            run: opTool("item.organize")
        },

        /* ============ P1-C 路径 / 形状算子（5）============ */
        ae_path_create: {
            title: "建形状路径",
            description: "在形状层里新建一条贝塞尔路径：给顶点数组（[[x,y],...]，图层空间坐标）与可选入/出切线、是否闭合。至少 2 个点。",
            schema: {
                type: "object",
                properties: {
                    comp: S.comp, layer: S.layer,
                    group: { type: "string", description: "形状组名，省略=根组" },
                    vertices: { type: "array", description: "顶点数组 [[x,y],[x,y],...]" },
                    inTangents: { type: "array", description: "入切线数组 [[x,y],...]，与顶点等长" },
                    outTangents: { type: "array", description: "出切线数组 [[x,y],...]，与顶点等长" },
                    closed: { type: "boolean", description: "是否闭合，默认 true" },
                    name: { type: "string", description: "路径名" }
                },
                required: ["layer", "vertices"],
                additionalProperties: false
            },
            run: opTool("path.create")
        },
        ae_path_get: {
            title: "读路径",
            description: "读一条形状路径的顶点/入切线/出切线/闭合状态。path 用下标或路径名（省略=第一条）。",
            schema: {
                type: "object",
                properties: { comp: S.comp, layer: S.layer, group: { type: "string" }, path: { type: ["number", "string"], description: "路径下标或名字，省略=第一条" } },
                required: ["layer"],
                additionalProperties: false
            },
            run: opTool("path.get")
        },
        ae_path_set: {
            title: "改路径",
            description: "改一条形状路径的顶点（与可选切线/闭合）。改关键帧路径时顶点数须与相邻关键帧一致，否则 AE 按顶点一致性规则处理插值。",
            schema: {
                type: "object",
                properties: {
                    comp: S.comp, layer: S.layer, group: { type: "string" }, path: { type: ["number", "string"] },
                    vertices: { type: "array", description: "顶点数组 [[x,y],...]" },
                    inTangents: { type: "array" }, outTangents: { type: "array" },
                    closed: { type: "boolean" }
                },
                required: ["layer", "vertices"],
                additionalProperties: false
            },
            run: opTool("path.set")
        },
        ae_shape_operator_add: {
            title: "加形状算子",
            description: "给形状层加一个路径算子：repeater（副本/偏移/顺序）、trim（裁剪起止）、offset（偏移路径）、merge（合并模式 add/subtract/intersect/exclude/merge）、roundCorners（圆角半径）、puckerBloat（膨胀/收缩）、twist（扭曲角度）。params 里给要设的算子参数（copies/offset/start/end/amount/radius/angle/mode/lineJoin 等，也可直接给 ADBE matchName）。",
            schema: {
                type: "object",
                properties: {
                    comp: S.comp, layer: S.layer,
                    group: { type: "string", description: "形状组名，省略=根组" },
                    operator: { type: "string", description: "repeater | trim | offset | merge | roundCorners | puckerBloat | twist" },
                    name: { type: "string" },
                    params: { type: "object", description: "算子参数对象，键为友好名或 ADBE matchName" }
                },
                required: ["layer", "operator"],
                additionalProperties: false
            },
            run: opTool("shape.operatorAdd")
        },
        ae_shape_operator_set: {
            title: "改形状算子",
            description: "改已存在的形状算子参数。operator 给种类，index 给第几个同类算子（省略=第一个），params 给要改的参数。",
            schema: {
                type: "object",
                properties: {
                    comp: S.comp, layer: S.layer,
                    group: { type: "string" },
                    operator: { type: "string", description: "repeater | trim | offset | merge | roundCorners | puckerBloat | twist" },
                    index: { type: "number", description: "第几个同类算子，省略=1" },
                    params: { type: "object", description: "要改的参数对象" }
                },
                required: ["layer", "operator", "params"],
                additionalProperties: false
            },
            run: opTool("shape.operatorSet")
        },

        /* ============ P1-D 渲染队列（6）============ */
        ae_render_queue_list: {
            title: "列渲染队列",
            description: "列出渲染队列里的每一项：下标、合成名、状态（QUEUED/RENDERING/DONE 等）、是否勾选 render、输出文件。",
            schema: { type: "object", properties: {}, additionalProperties: false },
            run: opTool("rq.list")
        },
        ae_render_queue_item_set: {
            title: "配置渲染队列项",
            description: "配置渲染队列里某一项：勾选 render、时间跨度、输出模块模板、输出文件路径。template 是输出模块模板名（见 ae_render_templates）。",
            schema: {
                type: "object",
                properties: {
                    index: { type: "number", description: "队列项下标，1 起，省略=1" },
                    render: { type: "boolean", description: "是否勾选渲染" },
                    timeSpanStart: { type: "number", description: "渲染起点（秒）" },
                    timeSpanDuration: { type: "number", description: "渲染时长（秒）" },
                    outputModule: { type: "number", description: "输出模块下标，省略=1" },
                    template: { type: "string", description: "输出模块模板名" },
                    outputPath: { type: "string", description: "输出文件完整路径" }
                },
                additionalProperties: false
            },
            run: opTool("rq.itemSet")
        },
        ae_render_queue_remove: {
            title: "移除渲染队列项",
            description: "从渲染队列移除一项（index）或全部（all=true）。",
            schema: {
                type: "object",
                properties: { index: { type: "number" }, all: { type: "boolean" } },
                additionalProperties: false
            },
            run: opTool("rq.remove")
        },
        ae_render_templates: {
            title: "列渲染模板",
            description: "列出输出模块模板名与渲染设置模板名（队列为空时读不到，先加一项再看）。",
            schema: { type: "object", properties: {}, additionalProperties: false },
            run: opTool("rq.templates")
        },
        ae_render_frame: {
            title: "导单帧 PNG",
            description: "把合成在某个时间点导出成单张 PNG（saveFrameToPng）。会抑制保存对话框、异步等文件落盘。path 用纯 ASCII 路径更稳。",
            schema: {
                type: "object",
                properties: {
                    comp: S.comp,
                    time: { type: "number", description: "时间点（秒），默认 0" },
                    path: { type: "string", description: "PNG 输出完整路径" }
                },
                required: ["path"],
                additionalProperties: false
            },
            run: opTool("rq.frame")
        },
        ae_render_queue_control: {
            title: "控制渲染",
            description: "控制正在进行的渲染：action=pause 暂停、action=resume 恢复、action=stop 停止。不支持 action=render（render() 会阻塞 AE 主线程无法回报进度，请设好队列后在 AE 界面点渲染或用 aerender）。",
            schema: {
                type: "object",
                properties: { action: { type: "string", description: "pause | resume | stop" } },
                required: ["action"],
                additionalProperties: false
            },
            run: opTool("rq.control")
        },

        /* ============ P1-E 文本动画器（3）============ */
        ae_text_animator_add: {
            title: "加文本动画器",
            description: "给文字层加一个文本动画器（ADBE Text Animator）：默认带一个范围选择器，可加动画器属性（position/opacity/scale/rotation/fillColor，或 ADBE matchName）。用 ae_text_selector_set 再调选择器起止与高级参数。",
            schema: {
                type: "object",
                properties: {
                    comp: S.comp, layer: S.layer,
                    name: { type: "string", description: "动画器名" },
                    selector: { type: "boolean", description: "是否加默认范围选择器，默认 true" },
                    properties: { type: "array", description: "动画器属性名数组：position/opacity/scale/rotation/fillColor" }
                },
                required: ["layer"],
                additionalProperties: false
            },
            run: opTool("text.animatorAdd")
        },
        ae_text_selector_set: {
            title: "改文本选择器",
            description: "改文字动画器里某个范围选择器的起止/偏移与高级参数：start/end/offset（百分比单位）、units（百分比/索引）、mode（add/subtract/intersect/...）、amount、smoothness、easeHigh/easeLow。animator/selector 用下标或名字。",
            schema: {
                type: "object",
                properties: {
                    comp: S.comp, layer: S.layer,
                    animator: { type: ["number", "string"], description: "动画器下标或名字，省略=1" },
                    selector: { type: ["number", "string"], description: "选择器下标或名字，省略=1" },
                    start: { type: "number", description: "起始 0..100" },
                    end: { type: "number", description: "结束 0..100" },
                    offset: { type: "number", description: "偏移 -100..100" },
                    units: { type: "number", description: "单位：1=百分比 2=索引" },
                    mode: { type: "number", description: "模式：1=add 2=subtract 3=intersect 4=min 5=max 6=difference" },
                    amount: { type: "number", description: "数量 -100..100" },
                    smoothness: { type: "number", description: "平滑度" },
                    easeHigh: { type: "number", description: "缓和高" },
                    easeLow: { type: "number", description: "缓和低" }
                },
                required: ["layer"],
                additionalProperties: false
            },
            run: opTool("text.selectorSet")
        },
        ae_text_animator_list: {
            title: "列文本动画器",
            description: "列一个文字层的所有动画器：下标、名字、选择器清单、动画器属性清单（name+matchName）。",
            schema: { type: "object", properties: { comp: S.comp, layer: S.layer }, required: ["layer"], additionalProperties: false },
            run: opTool("text.animatorList")
        },
        ae_capabilities: {
            title: "能力探测",
            description: "读当前 AE 的功能分层：版本、major 版本号、tier（2021 或 2022+）、是否支持原生图层 id（Layer.id / app.project.layerByID，AE 2022+ 才有）。客户端据此判断哪些工具可用。任何工具在任何版本都能调本工具。",
            schema: { type: "object", properties: {}, additionalProperties: false },
            run: opTool("cap")
        },
        ae_layer_id: {
            title: "读图层原生 id",
            description: "读图层的原生数字 id（AE 2022+ 才有 Layer.id）。给 layer 返回单个 {layer,index,id}；省略 layer 则列出整个合成所有图层的 id（{comp,count,layers[]}）。AE 2021 无此 API，本工具不注册，请改用 ae_layer_stamp 打戳寻址。",
            min: 22,
            schema: { type: "object", properties: { comp: S.comp, layer: S.layer }, required: [], additionalProperties: false },
            run: opTool("layer.id")
        },
        ae_layer_by_id: {
            title: "按原生 id 找图层",
            description: "用原生数字 id 反查图层（AE 2022+ 才有 app.project.layerByID）。返回图层简报与所在合成名；找不到返回 found:false。AE 2021 无此 API，本工具不注册。",
            min: 22,
            schema: { type: "object", properties: { id: { type: ["string", "number"], description: "图层原生数字 id" } }, required: ["id"], additionalProperties: false },
            run: opTool("layer.byId")
        },

        /* ===================== P3 Batch A：工程管理 ===================== */
        ae_project_save: {
            title: "保存/关闭工程",
            description: "mode=save 保存到原路径（未保存过则报错）；mode=saveWithDialog 弹保存框；mode=close 关闭工程（save=prompt/no/yes 决定是否保存）。返回 file 与 dirty 状态。",
            schema: { type: "object", properties: { mode: { type: "string", enum: ["save", "saveWithDialog", "close"], description: "save/saveWithDialog/close" }, save: { type: "string", enum: ["prompt", "no", "yes"], description: "close 时：prompt 询问 / no 不保存 / yes 保存" } }, required: [], additionalProperties: false },
            run: opTool("project.save")
        },
        ae_project_settings: {
            title: "工程设置",
            description: "改工程级设置：bitsPerChannel(8/16/32)、expressionEngine、gpuAccelType、linearBlending、linearizeWorkingSpace、transparencyGridThumbnails、toolType。只写给的字段。",
            schema: { type: "object", properties: { bitsPerChannel: { type: "number" }, expressionEngine: { type: "string" }, gpuAccelType: { type: ["string", "number"] }, linearBlending: { type: "boolean" }, linearizeWorkingSpace: { type: "boolean" }, transparencyGridThumbnails: { type: "boolean" }, toolType: { type: ["string", "number"] } }, required: [], additionalProperties: false },
            run: opTool("project.settings")
        },
        ae_project_colorspace: {
            title: "工程色彩空间",
            description: "改 workingSpace / workingGamma / compensateForSceneReferredProfiles；并返回 listColorProfiles() 可用配置列表。",
            schema: { type: "object", properties: { workingSpace: { type: "string" }, workingGamma: { type: "number" }, compensateForSceneReferredProfiles: { type: "boolean" } }, required: [], additionalProperties: false },
            run: opTool("project.colorspace")
        },
        ae_project_timecode: {
            title: "工程时间码/帧显示",
            description: "改 displayStartFrame / timeDisplayType / framesCountType / framesUseFeetFrames / feetFramesFilmType / footageTimecodeDisplayStartType。",
            schema: { type: "object", properties: { displayStartFrame: { type: "number" }, timeDisplayType: { type: ["string", "number"] }, framesCountType: { type: ["string", "number"] }, framesUseFeetFrames: { type: "boolean" }, feetFramesFilmType: { type: ["string", "number"] }, footageTimecodeDisplayStartType: { type: ["string", "number"] } }, required: [], additionalProperties: false },
            run: opTool("project.timecode")
        },
        ae_project_font: {
            title: "工程字体",
            description: "读 usedFonts；给 from+to 时全局替换字体（replaceFont），给 comp 时只替换该合成（replaceFonts）。",
            schema: { type: "object", properties: { from: { type: "string", description: "要替换的字体名" }, to: { type: "string", description: "替换成这个字体名" }, comp: S.comp }, required: [], additionalProperties: false },
            run: opTool("project.font")
        },
        ae_font_check: {
            title: "字体检查",
            description: "AE 25.1+ 字体能力：mode=hasGlyphs 判某字体（PostScript 名，如 ArialMT）是否含某字符串的字形；mode=ctScript 判字符串属于哪个复杂脚本文本（返回字符区间 + CTScript 枚举值）。AE 2024 及更早无此 API，本工具不注册。",
            min: 25,
            schema: { type: "object", properties: { mode: { type: "string", enum: ["hasGlyphs", "ctScript"], description: "hasGlyphs=查字形覆盖 / ctScript=查脚本归属" }, font: { type: "string", description: "字体 PostScript 名（hasGlyphs 用）" }, text: { type: "string", description: "要检查的字符串" }, preferredScript: { type: ["string", "number"], description: "ctScript 的偏好脚本（roman/japanese/simp_chinese 等，或 CTScript 数值，默认 roman）" } }, required: ["mode", "text"], additionalProperties: false },
            run: opTool("font.check")
        },
        ae_project_xmp: {
            title: "工程 XMP 元数据",
            description: "读 xmpPacket；给 xmp 时写入。",
            schema: { type: "object", properties: { xmp: { type: "string", description: "要写入的 XMP 字符串" } }, required: [], additionalProperties: false },
            run: opTool("project.xmp")
        },
        ae_project_consolidate: {
            title: "工程素材整理/清理",
            description: "mode=consolidate 把所有素材收进项目文件夹（返回移动数）；mode=removeUnused 删除未使用素材（返回删除数）。",
            schema: { type: "object", properties: { mode: { type: "string", enum: ["consolidate", "removeUnused"] } }, required: [], additionalProperties: false },
            run: opTool("project.consolidate")
        },
        ae_project_reduce: {
            title: "精简工程（破坏性）",
            description: "只保留 items/comps 里列出的项，其余全部删除（reduceProject）。破坏性、不可撤销，建议先用 ae_checkpoint 备份。",
            schema: { type: "object", properties: { items: { type: "array", items: { type: "string" }, description: "要保留的项目项（名字/@id:N/数字）" }, comps: { type: "array", items: { type: "string" }, description: "要保留的合成" } }, required: [], additionalProperties: false },
            run: opTool("project.reduce")
        },
        ae_project_autofix: {
            title: "批量修正失效表达式",
            description: "autoFixExpressions(from, to)：把失效表达式里的旧文本/旧名替换成新文本。",
            schema: { type: "object", properties: { from: { type: "string", description: "要修正的旧表达式文本/旧名" }, to: { type: "string", description: "替换成的新文本" } }, required: ["from"], additionalProperties: false },
            run: opTool("project.autofix")
        },
        ae_app_cache: {
            title: "AE 内存/缓存/渲染开关",
            description: "mode=purge 清缓存（target=all 或 PurgeTarget 数值）；mode=memory 设 setMemoryUsageLimits(imageCachePercent,memoryPercent)；mode=disableRendering 暂停/恢复渲染（disable=true/false）。",
            schema: { type: "object", properties: { mode: { type: "string", enum: ["purge", "memory", "disableRendering"] }, target: { type: ["string", "number"], description: "purge：all 或 PurgeTarget 数值" }, imageCachePercent: { type: "number" }, memoryPercent: { type: "number" }, disable: { type: "boolean" } }, required: ["mode"], additionalProperties: false },
            run: opTool("app.cache")
        },

        /* ===================== P3 Batch B：项目项/素材 ===================== */
        ae_item_set: {
            title: "设置工程项",
            description: "改工程项的 comment（备注）/ label（标签 0-16）/ selected（选中态）。",
            schema: { type: "object", properties: { item: { type: ["string", "number"], description: "项目项：名字/@id:N/数字，省略=活动项" }, comment: { type: "string" }, label: { type: "number" }, selected: { type: "boolean" } }, required: [], additionalProperties: false },
            run: opTool("item.set")
        },
        ae_footage_reload: {
            title: "重载素材",
            description: "调用 mainSource.reload() 重新载入素材源（外部文件被改后同步）。",
            schema: { type: "object", properties: { item: { type: ["string", "number"], description: "素材项：名字/@id:N/数字，省略=活动项" } }, required: [], additionalProperties: false },
            run: opTool("footage.reload")
        },

        /* ===================== P3 Batch C：合成 ===================== */
        ae_comp_motion_blur: {
            title: "合成运动模糊设置",
            description: "改 motionBlur / motionBlurSamples / shutterAngle / shutterPhase。",
            schema: { type: "object", properties: { comp: S.comp, motionBlur: { type: "boolean" }, motionBlurSamples: { type: "number" }, shutterAngle: { type: "number" }, shutterPhase: { type: "number" } }, required: [], additionalProperties: false },
            run: opTool("comp.motionBlur")
        },
        ae_export_mogrt: {
            title: "导出 MOGRT 模板",
            description: "exportAsMotionGraphicsTemplate 导出动态图形模板（AE 15.0+，2021 已满足）。前置：①工程必须先保存（ae_project_save mode=save）；②合成里至少一个 EGP 可控参数（ae_mogrt_param mode=add 添加）。path 传目录或完整 .mogrt 路径（自动取父目录），文件名=templateName.mogrt（缺省用合成名）。",
            schema: { type: "object", properties: { comp: S.comp, path: { type: "string", description: "导出目录或 .mogrt 完整路径（取父目录）" }, templateName: { type: "string", description: "模板名，也是 .mogrt 文件名（缺省合成名）" }, overwrite: { type: "boolean", description: "已存在是否覆盖" } }, required: [], additionalProperties: false },
            run: opTool("comp.exportMogrt")
        },
        ae_mogrt_param: {
            title: "MOGRT 参数管理",
            description: "把属性加进动态图形模板：mode=check 查 canAdd；mode=add 用默认名加；mode=addAs 自定义名加（需 name）。property 须是 Checkbox/Color/Numerical Slider/Source Text 四类之一。",
            schema: { type: "object", properties: { comp: S.comp, layer: S.layer, property: S.prop, mode: { type: "string", enum: ["check", "add", "addAs"] }, name: { type: "string", description: "addAs 的自定义显示名" } }, required: ["property"], additionalProperties: false },
            run: opTool("comp.mogrtParam")
        },

        /* ===================== P3 Batch D：图层 ===================== */
        ae_layer_switch: {
            title: "图层开关与质量",
            description: "改图层 stretch/label/collapseTransformation/preserveTransparency/guideLayer/effectsActive/environmentLayer，以及 quality(draft/wireframe/best)、samplingQuality(bilinear/bicubic)、frameBlendingType(frame_mixing/pixel_motion)、autoOrient(no_auto_orient/path/camera/time)。注意 frameBlending 本身只读。",
            schema: { type: "object", properties: { comp: S.comp, layer: S.layer, stretch: { type: "number" }, label: { type: "number" }, collapseTransformation: { type: "boolean" }, preserveTransparency: { type: "boolean" }, guideLayer: { type: "boolean" }, effectsActive: { type: "boolean" }, environmentLayer: { type: "boolean" }, quality: { type: "string" }, samplingQuality: { type: "string" }, frameBlendingType: { type: "string" }, autoOrient: { type: "string" } }, required: [], additionalProperties: false },
            run: opTool("layer.switch")
        },
        ae_layer_time_remap: {
            title: "图层时间重映射开关",
            description: "读/写 timeRemapEnabled。给 enabled 时设为该值。",
            schema: { type: "object", properties: { comp: S.comp, layer: S.layer, enabled: { type: "boolean" } }, required: [], additionalProperties: false },
            run: opTool("layer.timeRemap")
        },

        /* ===================== P3 Batch E：关键帧/属性/蒙版 ===================== */
        ae_keyframe_edit: {
            title: "关键帧增删改",
            description: "mode=addKey(time) 加帧；removeKey(key) 删帧；setValueAtKey(key,value)；keyLabel(key)/setLabelAtKey(key,label)（AE 22.6+）；keySelected(key)/setSelectedAtKey(key,selected)；keyRoving(key)/setRovingAtKey(key,roving)。key 为 1 基下标。",
            schema: { type: "object", properties: { comp: S.comp, layer: S.layer, property: S.prop, mode: { type: "string", enum: ["addKey", "removeKey", "setValueAtKey", "keyLabel", "setLabelAtKey", "keySelected", "setSelectedAtKey", "keyRoving", "setRovingAtKey"] }, key: { type: "number", description: "1 基关键帧下标" }, time: { type: "number", description: "addKey 的时间点" }, value: { type: ["number", "array", "string"], description: "setValueAtKey 的新值" }, label: { type: "number", description: "setLabelAtKey 的标签值" }, selected: { type: "boolean" }, roving: { type: "boolean" } }, required: ["mode"], additionalProperties: false },
            run: opTool("keyframe.edit")
        },
        ae_keyframe_tangent: {
            title: "关键帧切线/插值",
            description: "mode=keySpatialAutoBezier / keySpatialContinuous / keyTemporalAutoBezier / keyTemporalContinuous（value=true/false 开关）；setSpatialTangents(inTangents,outTangents) 设空间切线。需要 key（1 基）。",
            schema: { type: "object", properties: { comp: S.comp, layer: S.layer, property: S.prop, mode: { type: "string", enum: ["keySpatialAutoBezier", "keySpatialContinuous", "keyTemporalAutoBezier", "keyTemporalContinuous", "setSpatialTangents"] }, key: { type: "number" }, value: { type: "boolean" }, inTangents: { type: "array", items: { type: "number" } }, outTangents: { type: "array", items: { type: "number" } } }, required: ["mode", "key"], additionalProperties: false },
            run: opTool("keyframe.tangent")
        },
        ae_property_separate: {
            title: "属性尺寸分离",
            description: "读/写 dimensionsSeparated（位置/缩放等 X/Y 分离）。给 separated 时设为该值。",
            schema: { type: "object", properties: { comp: S.comp, layer: S.layer, property: S.prop, separated: { type: "boolean" } }, required: ["property"], additionalProperties: false },
            run: opTool("property.separate")
        },
        ae_mask_set: {
            title: "蒙版属性设置",
            description: "改蒙版 color（三吃：0..1 数组/0..255 数组/#hex）、locked、rotoBezier、maskMotionBlur、maskFeatherFalloff。",
            schema: { type: "object", properties: { comp: S.comp, layer: S.layer, mask: { type: ["string", "number"], description: "蒙版名或下标（1 基）" }, color: { type: ["array", "string"] }, locked: { type: "boolean" }, rotoBezier: { type: "boolean" }, maskMotionBlur: { type: "string" }, maskFeatherFalloff: { type: "string" } }, required: ["mask"], additionalProperties: false },
            run: opTool("mask.set")
        },

        /* ===================== P3 Batch F：文本 ===================== */
        ae_text_set: {
            title: "文字层样式",
            description: "改 TextDocument 样式（只改样式、不动文本内容）。基础：font/fontSize/fillColor/applyFill/applyStroke/strokeColor/strokeWidth/strokeOverFill/leading/autoLeading/tracking/justification/baselineShift/horizontalScale/verticalScale/pointText/boxText/boxTextSize。AE 24.0+ 文本样式：noBreak/ligature/fauxBold/fauxItalic/autoHyphenate/everyLineComposer（布尔）、spaceAfter/spaceBefore/startIndent/endIndent（数字）、leadingType(roman/japanese)、autoKernType(none/metric/optical)、digitSet(default/arabic/hindi/farsi/arabic_rtl)、lineOrientation(horizontal/vertical_rl/vertical_lr，24.2+)、baselineDirection(stream/vertical_rotated/vertical_cross)。注意 allCaps/smallCaps/superscript/subscript 是只读（靠 CharacterRange 设）。strokeColor 需 applyStroke=true，boxTextSize 需 boxText=true。",
            schema: { type: "object", properties: { comp: S.comp, layer: S.layer, font: { type: "string" }, fontSize: { type: "number" }, fillColor: { type: ["array", "string"] }, applyFill: { type: "boolean" }, applyStroke: { type: "boolean" }, strokeColor: { type: ["array", "string"] }, strokeWidth: { type: "number" }, strokeOverFill: { type: "boolean" }, leading: { type: "number" }, autoLeading: { type: "boolean" }, tracking: { type: "number" }, justification: { type: ["string", "number"] }, baselineShift: { type: "number" }, horizontalScale: { type: "number" }, verticalScale: { type: "number" }, pointText: { type: "boolean" }, boxText: { type: "boolean" }, boxTextSize: { type: "array", items: { type: "number" } }, noBreak: { type: "boolean" }, ligature: { type: "boolean" }, fauxBold: { type: "boolean" }, fauxItalic: { type: "boolean" }, autoHyphenate: { type: "boolean" }, everyLineComposer: { type: "boolean" }, spaceAfter: { type: "number" }, spaceBefore: { type: "number" }, startIndent: { type: "number" }, endIndent: { type: "number" }, leadingType: { type: "string", enum: ["roman", "japanese"] }, autoKernType: { type: "string", enum: ["none", "metric", "optical"] }, digitSet: { type: "string", enum: ["default", "arabic", "hindi", "farsi", "arabic_rtl"] }, lineOrientation: { type: "string", enum: ["horizontal", "vertical_rl", "vertical_lr"] }, baselineDirection: { type: "string", enum: ["stream", "vertical_rotated", "vertical_cross"] } }, required: [], additionalProperties: false },
            run: opTool("text.set")
        },

        /* ===================== P3 Batch G：查看器/设置 ===================== */
        ae_viewer: {
            title: "查看器控制",
            description: "mode=info 列查看器/视图；setActive(index) 设活动视图；maximize(index,maximized) 最大化；options 改 zoom/checkerboards/channels/exposure/fastPreview/guidesVisibility/rulers。",
            schema: { type: "object", properties: { mode: { type: "string", enum: ["info", "setActive", "maximize", "options"] }, index: { type: "number", description: "视图下标（0 基）" }, maximized: { type: "boolean" }, zoom: { type: "number" }, checkerboards: { type: "boolean" }, channels: { type: ["string", "number"] }, exposure: { type: "number" }, fastPreview: { type: ["string", "number"] }, guidesVisibility: { type: "boolean" }, rulers: { type: "boolean" } }, required: [], additionalProperties: false },
            run: opTool("viewer")
        },
        ae_settings: {
            title: "AE 偏好/设置读写",
            description: "mode=get/set 读写 app.settings（内存，set 后 mode=saveToDisk 落盘）；mode=pref 读写 app.preferences（op=get/set + type=string/bool/float/long）。",
            schema: { type: "object", properties: { mode: { type: "string", enum: ["get", "set", "saveToDisk", "pref"] }, section: { type: "string", description: "分区名，默认 AEMCP" }, key: { type: "string" }, value: { type: "string" }, op: { type: "string", enum: ["get", "set", "saveToDisk"] }, type: { type: "string", enum: ["string", "bool", "float", "long"] } }, required: ["key"], additionalProperties: false },
            run: opTool("settings")
        },

        /* ===================== P3 Batch H：模板/编排 ===================== */
        ae_preset_apply: {
            title: "应用动画预设",
            description: "给图层 applyPreset(.ffx 预设文件)。撤销可能崩溃，回滚请用 ae_checkpoint/ae_revert。",
            schema: { type: "object", properties: { comp: S.comp, layer: S.layer, path: { type: "string", description: ".ffx 预设文件路径" } }, required: ["path"], additionalProperties: false },
            run: opTool("preset.apply")
        },
        ae_tpl_lower_third: {
            title: "生成下三分之一字幕模板",
            description: "纯组合原语生成下三分之一字幕合成（底条+主/副标题+入场动画）。style=minimal/modern/corporate/news/social。",
            schema: { type: "object", properties: { style: { type: "string", enum: ["minimal", "modern", "corporate", "news", "social"] }, title: { type: "string" }, subtitle: { type: "string" }, width: { type: "number" }, height: { type: "number" }, fps: { type: "number" }, duration: { type: "number" }, barWidth: { type: "number" }, barHeight: { type: "number" } }, required: [], additionalProperties: false },
            run: opTool("tpl.lowerThird")
        },
        ae_tpl_title_card: {
            title: "生成标题卡模板",
            description: "生成标题卡合成（背景+大标题+副标题+入场）。style=minimal/cinematic/documentary/social。",
            schema: { type: "object", properties: { style: { type: "string", enum: ["minimal", "cinematic", "documentary", "social"] }, title: { type: "string" }, subtitle: { type: "string" }, width: { type: "number" }, height: { type: "number" }, fps: { type: "number" }, duration: { type: "number" } }, required: [], additionalProperties: false },
            run: opTool("tpl.titleCard")
        },
        ae_tpl_transition: {
            title: "生成转场模板",
            description: "生成转场合成（白色块 + 位置/缩放/透明度动画）。style=wipe/dissolve/push/slide/zoom。",
            schema: { type: "object", properties: { style: { type: "string", enum: ["wipe", "dissolve", "push", "slide", "zoom"] }, width: { type: "number" }, height: { type: "number" }, fps: { type: "number" }, duration: { type: "number" } }, required: [], additionalProperties: false },
            run: opTool("tpl.transition")
        },
        ae_tpl_logo_reveal: {
            title: "生成标志揭示模板",
            description: "生成标志揭示合成（形状块+LOGO 文字+入场动画）。style=fade/scale/slide/spin/glitch。",
            schema: { type: "object", properties: { style: { type: "string", enum: ["fade", "scale", "slide", "spin", "glitch"] }, logo: { type: "string" }, tagline: { type: "string" }, width: { type: "number" }, height: { type: "number" }, fps: { type: "number" }, duration: { type: "number" } }, required: [], additionalProperties: false },
            run: opTool("tpl.logoReveal")
        },
        ae_batch: {
            title: "批量串行执行",
            description: "一次调用串行跑多步 op。steps=[{op,args},...]，每步独立执行，任一步失败即停并返回已执行结果。",
            schema: { type: "object", properties: { steps: { type: "array", items: { type: "object", properties: { op: { type: "string" }, args: { type: "object" } }, required: ["op"], additionalProperties: false }, description: "[{op,args},...]" } }, required: ["steps"], additionalProperties: false },
            run: opTool("batch.run")
        },
        ae_checkpoint: {
            title: "工程检查点",
            description: "mode=save 把当前工程另存为 %userData%/ae-mcp/checkpoints/<name>.aep；mode=list 列已有检查点。配合 ae_revert 做可回滚的大改。",
            schema: { type: "object", properties: { mode: { type: "string", enum: ["save", "list"] }, name: { type: "string", description: "save 时的检查点名（不含扩展名）" } }, required: [], additionalProperties: false },
            run: opTool("checkpoint.save")
        },
        ae_revert: {
            title: "恢复工程检查点",
            description: "打开 path 指定的 .aep 检查点（ae_checkpoint list 里拿）。会先备份当前脏工程再 openFast。",
            schema: { type: "object", properties: { path: { type: "string", description: ".aep 检查点完整路径" } }, required: ["path"], additionalProperties: false },
            run: opTool("checkpoint.revert")
        },
        ae_undo_tip: {
            title: "撤销说明",
            description: "返回 Ctrl+Z 撤销与回滚的说明（applyPreset 撤销可能崩溃、render() 会阻塞等注意事项）。",
            schema: { type: "object", properties: {}, required: [], additionalProperties: false },
            run: opTool("undo.tip")
        },

        /* ==== v0.11：AE 26.5 参考线 + 25.4 重启 ==== */
        ae_guide_list: {
            title: "列参考线",
            description: "列合成或图层的参考线（AE 26.5+ 才有 Item.guides）。返回每条线的方向 horizontal/vertical、位置类型 percentage/pixel、位置、颜色、名称。AE 2025 及更早无此 API，本工具不注册。",
            min: 26,
            schema: { type: "object", properties: { comp: S.comp, layer: S.layer }, required: [], additionalProperties: false },
            run: opTool("guide.list")
        },
        ae_guide_add: {
            title: "加参考线",
            description: "给合成或图层加一条参考线（AE 26.5+）。orientation=horizontal/vertical；positionType=percentage/pixel（决定 position 含义）；position 是位置值（percentage 填 0..100，pixel 填像素）；color=[r,g,b]；name 可选。返回 0 基下标。",
            min: 26,
            schema: {
                type: "object",
                properties: {
                    comp: S.comp, layer: S.layer,
                    orientation: { type: "string", enum: ["horizontal", "vertical"], description: "方向，默认 horizontal" },
                    positionType: { type: "string", enum: ["percentage", "pixel"], description: "位置类型，默认 pixel" },
                    position: { type: "number", description: "位置值（percentage 0..100 / pixel 像素）" },
                    color: { type: "array", items: { type: "number" }, description: "颜色 [r,g,b]，0..1" },
                    name: { type: "string", description: "参考线名称（可选）" }
                },
                required: [],
                additionalProperties: false
            },
            run: opTool("guide.add")
        },
        ae_guide_set: {
            title: "改参考线",
            description: "改合成/图层某条参考线（AE 26.5+）。index 是 0 基下标（ae_guide_list 里拿）。只传要改的字段。",
            min: 26,
            schema: {
                type: "object",
                properties: {
                    comp: S.comp, layer: S.layer,
                    index: { type: "number", description: "0 基下标" },
                    orientation: { type: "string", enum: ["horizontal", "vertical"] },
                    positionType: { type: "string", enum: ["percentage", "pixel"] },
                    position: { type: "number" },
                    color: { type: "array", items: { type: "number" } },
                    name: { type: "string" }
                },
                required: ["index"],
                additionalProperties: false
            },
            run: opTool("guide.set")
        },
        ae_guide_remove: {
            title: "删参考线",
            description: "删合成/图层某条参考线（AE 26.5+）。index 是 0 基下标。",
            min: 26,
            schema: { type: "object", properties: { comp: S.comp, layer: S.layer, index: { type: "number", description: "0 基下标" } }, required: ["index"], additionalProperties: false },
            run: opTool("guide.remove")
        },
        ae_app_restart: {
            title: "重启 AE",
            description: "重启 After Effects（AE 25.4+ 才有 app.restart）。会断开桥（面板随进程消失），必须 confirm:true 才执行，且重启有约 1.5 秒延迟让响应先返回。AE 25.3 及更早无此 API，本工具不注册。",
            min: 25,
            schema: { type: "object", properties: { confirm: { type: "boolean", description: "必须传 true 才真正重启" } }, required: ["confirm"], additionalProperties: false },
            run: opTool("app.restart")
        },

        /* ==== v1.1：AE 26.3 参数化网格 + 26.0 变量字体轴 ==== */
        ae_layer_mesh: {
            title: "建参数化网格层",
            description: "建一个参数化 3D 网格层（AE 26.3+ 才有 LayerCollection.addParametricMesh）。meshType 六选一：plane/sphere/cube/cylinder/cone/torus。AE 2025 及更早无此 API，本工具不注册。",
            min: 26,
            schema: { type: "object", properties: { comp: S.comp, name: { type: "string", description: "图层名，默认 Mesh" }, meshType: { type: "string", enum: ["plane", "sphere", "cube", "cylinder", "cone", "torus"], description: "网格类型" } }, required: [], additionalProperties: false },
            run: opTool("layer.mesh")
        },
        ae_text_axis_add: {
            title: "加变量字体轴",
            description: "给文字层加一个变量字体轴并返回该轴属性（AE 26.0+ 才有 PropertyGroup.addVariableFontAxis）。tag 是 4 字符轴名（wght 字重 / wdth 宽度 / slnt 倾斜 / ital 斜体 / opsz 光学大小）。会给该文字层新建一个文本动画器并把轴挂上去；value 可选给轴设初始值。字体必须是变量字体才有效果。AE 2025 及更早无此 API，本工具不注册。",
            min: 26,
            schema: { type: "object", properties: { comp: S.comp, layer: S.layer, tag: { type: "string", description: "4 字符轴名，如 wght/wdth/slnt/ital/opsz" }, value: { type: "number", description: "轴的初始值（可选）" } }, required: ["layer", "tag"], additionalProperties: false },
            run: opTool("text.axisAdd")
        },

        /* ==== v1.1：自建功能 —— 进场动画 ==== */
        ae_anim_entrance: {
            title: "进场动画",
            description: "给图层加一段进场动画（关键帧 + 缓动，任何 AE 版本都能用）。preset 五选一：fadeUp 从下方淡入、slideLeft 从左滑入、slideRight 从右滑入、scaleIn 缩放淡入、bounce 落地回弹（表达式驱动，特别流畅）。startTime 开始时间（秒）、duration 时长、distance 位移距离；bounce 额外支持 frequency 回弹频率 / damping 阻尼 / amplitude 弹起高度。",
            schema: {
                type: "object",
                properties: {
                    comp: S.comp, layer: S.layer,
                    preset: { type: "string", enum: ["fadeUp", "slideLeft", "slideRight", "scaleIn", "bounce"], description: "动画类型，默认 fadeUp" },
                    startTime: { type: "number", description: "开始时间（秒），默认 0" },
                    duration: { type: "number", description: "时长（秒），默认 0.5" },
                    distance: { type: "number", description: "位移距离（像素），默认 60" },
                    frequency: { type: "number", description: "bounce 回弹频率，默认 5" },
                    damping: { type: "number", description: "bounce 阻尼，默认 1.6" },
                    amplitude: { type: "number", description: "bounce 弹起高度（像素），默认 120" }
                },
                required: ["layer"],
                additionalProperties: false
            },
            run: opTool("anim.entrance")
        },

        /* ==== v1.3：自建复合功能（循环/抖动/计数/缓动/打字机/逐字交错） ==== */
        ae_anim_loop: {
            title: "循环/乒乓动画",
            description: "给属性加 loopOut 表达式循环动画（全版本可用）。mode=cycle 循环 / pingpong 乒乓往返 / continue 从末帧继续 / offset 偏移循环。属性要先有关键帧才有效果。",
            schema: { type: "object", properties: { comp: S.comp, layer: S.layer, property: S.prop, mode: { type: "string", enum: ["cycle", "pingpong", "continue", "offset"], description: "循环方式，默认 cycle" } }, required: ["layer"], additionalProperties: false },
            run: opTool("anim.loop")
        },
        ae_fx_shake: {
            title: "抖动",
            description: "给属性加 wiggle 抖动表达式（全版本可用）。frequency 抖动频率（次/秒）、amplitude 抖动幅度（像素）。默认抖 position，property 可改成 rotation 等。",
            schema: { type: "object", properties: { comp: S.comp, layer: S.layer, property: S.prop, frequency: { type: "number", description: "频率，默认 5" }, amplitude: { type: "number", description: "幅度，默认 20" } }, required: ["layer"], additionalProperties: false },
            run: opTool("fx.shake")
        },
        ae_text_counter: {
            title: "数字滚动计数",
            description: "给文字层的 Source Text 加计数表达式，让数字从 start 滚到 end（全版本可用）。startTime 开始时间、duration 时长、decimals 小数位、prefix/suffix 前后缀（如 $ 或 %）。",
            schema: { type: "object", properties: { comp: S.comp, layer: S.layer, start: { type: "number", description: "起始数，默认 0" }, end: { type: "number", description: "结束数，默认 100" }, startTime: { type: "number", description: "开始时间（秒）" }, duration: { type: "number", description: "时长（秒），默认 2" }, decimals: { type: "number", description: "小数位，默认 0" }, prefix: { type: "string", description: "前缀，如 $" }, suffix: { type: "string", description: "后缀，如 %" } }, required: ["layer", "end"], additionalProperties: false },
            run: opTool("text.counter")
        },
        ae_ease_presets: {
            title: "一键缓动预设",
            description: "给属性的所有关键帧统一套缓动（全版本可用）。preset=linear 线性 / easeIn 缓入 / easeOut 缓出 / easeInOut 缓入缓出（最常用，F9 易缓动）。属性要先有 ≥2 个关键帧。",
            schema: { type: "object", properties: { comp: S.comp, layer: S.layer, property: S.prop, preset: { type: "string", enum: ["linear", "easeIn", "easeOut", "easeInOut"], description: "缓动预设，默认 easeInOut" } }, required: ["layer"], additionalProperties: false },
            run: opTool("ease.presets")
        },
        ae_text_typewriter: {
            title: "打字机效果",
            description: "给文字层加打字机逐字显现效果（全版本可用，用 Text Animator 范围选择器）。startTime 开始时间、duration 时长。字符从左到右逐个淡入。",
            schema: { type: "object", properties: { comp: S.comp, layer: S.layer, startTime: { type: "number", description: "开始时间（秒）" }, duration: { type: "number", description: "时长（秒），默认 1" } }, required: ["layer"], additionalProperties: false },
            run: opTool("text.typewriter")
        },
        ae_text_stagger: {
            title: "文字逐字交错入场",
            description: "给文字层加逐字交错入场动画（全版本可用，Text Animator）：字符从上方淡入、逐个浮现。startTime 开始时间、duration 时长、distance 从上方落下的距离（像素）。",
            schema: { type: "object", properties: { comp: S.comp, layer: S.layer, startTime: { type: "number" }, duration: { type: "number", description: "时长（秒），默认 0.8" }, distance: { type: "number", description: "落下距离（像素），默认 50" } }, required: ["layer"], additionalProperties: false },
            run: opTool("text.stagger")
        },

        /* ==== v1.2：executeCommand 逃生舱（菜单命令） ==== */
        ae_command: {
            title: "执行菜单命令",
            description: "executeCommand 逃生舱：执行脚本 API 没有覆盖的菜单命令。mode=find 用本地化菜单名查命令 ID（中文 AE 要用中文名，如「新建蒙版」→2367）；mode=exec 用命令 ID（或本地化菜单名）执行。常用 ID：2367 新建蒙版、4162 转换为贝塞尔路径、2010 工具栏、2092/2093 缩放。注意：① 部分命令需要活动合成 + 选中图层才生效；② 工具栏工具（钢笔/选择/手形等）不是菜单命令，没有 ID，无法用本工具选中；③ 脚本无法验证命令的 UI 效果。AE 2022+ 可能已移除 executeCommand，届时会报错。",
            schema: { type: "object", properties: { mode: { type: "string", enum: ["find", "exec"], description: "find=查 ID / exec=执行" }, id: { type: "number", description: "命令编号（exec 用）" }, name: { type: "string", description: "本地化菜单名（find 用，或 exec 时替代 id）" } }, required: ["mode"], additionalProperties: false },
            run: opTool("command")
        },
    };

    function toolList() {
        var out = [], k;
        var cap = window.__AEMCP_CAP || null;
        var major = (cap && typeof cap.major === "number") ? cap.major : 0;
        for (k in TOOLS) {
            if (!TOOLS.hasOwnProperty(k)) { continue; }
            if (TOOLS[k].min && major < TOOLS[k].min) { continue; }
            out.push({
                name: k,
                title: TOOLS[k].title,
                description: TOOLS[k].description,
                inputSchema: TOOLS[k].schema
            });
        }
        return out;
    }

    /* ------------------------------------------------------------ JSON-RPC */
    function ok(id, result) { return { jsonrpc: "2.0", id: id, result: result }; }
    function fail(id, code, message) { return { jsonrpc: "2.0", id: id, error: { code: code, message: message } }; }

    function textOf(data) {
        var t;
        if (typeof data === "string") { t = data; }
        else {
            try { t = JSON.stringify(data, null, 2); }
            catch (e) { t = String(data); }
        }
        if (t === undefined) { t = "null"; }
        if (t.length > TEXT_CAP) {
            t = t.substring(0, TEXT_CAP) + "\n…（结果太长，已截断 " + (t.length - TEXT_CAP) + " 字符）";
        }
        return t;
    }

    function callTool(params, id) {
        var name = String((params && params.name) || "");
        var args = (params && params.arguments) || {};
        var t = TOOLS[name];
        if (!t) { return ok(id, { content: [{ type: "text", text: "没有这个工具：" + name }], isError: true }); }
        return Promise.resolve()
            .then(function () { return t.run(args); })
            .then(function (data) {
                return ok(id, { content: [{ type: "text", text: textOf(data) }], isError: false });
            })
            .catch(function (e) {
                return ok(id, { content: [{ type: "text", text: "执行失败：" + errText(e) }], isError: true });
            });
    }

    function handle(req) {
        if (!req || typeof req !== "object") { return fail(null, -32700, "不是 JSON-RPC 请求对象"); }
        if (req.jsonrpc !== undefined && req.jsonrpc !== "2.0") { return fail(req.id === undefined ? null : req.id, -32600, "jsonrpc 必须是 \"2.0\""); }
        var id = (req.id === undefined) ? null : req.id;
        var method = String(req.method || "");
        var params = req.params || {};

        /* 通知（没有 id）：按协议不回任何东西 */
        if (method.indexOf("notifications/") === 0 || method === "initialized") { return null; }

        if (method === "initialize") {
            return ok(id, {
                protocolVersion: (typeof params.protocolVersion === "string" && params.protocolVersion) ? params.protocolVersion : DEFAULT_PROTOCOL,
                capabilities: { tools: { listChanged: false } },
                serverInfo: { name: "aemcp", version: VERSION }
            });
        }
        if (method === "ping") { return ok(id, {}); }
        if (method === "tools/list") { return ok(id, { tools: toolList() }); }
        if (method === "tools/call") { return callTool(params, id); }
        if (method === "resources/list") { return ok(id, { resources: [] }); }
        if (method === "resources/templates/list") { return ok(id, { resourceTemplates: [] }); }
        if (method === "prompts/list") { return ok(id, { prompts: [] }); }
        return fail(id, -32601, "不支持的方法：" + method);
    }

    window.__AEMCP_MCP = {
        VERSION: VERSION,
        handle: handle,
        toolList: toolList,
        toolCount: function () { return toolList().length; },
        names: function () { return toolList().map(function (t) { return t.name; }); }
    };
})();
