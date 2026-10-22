# AE MCP 桥 · com.yg.aemcp

把 Adobe After Effects 变成 **MCP（Model Context Protocol）服务**，让 Claude / Codex / 任何 MCP 客户端
直接读工程、建合成、加图层、调属性、写关键帧与表达式、加效果 —— 而不用你手点。

在 **After Effects 2021（18.0x39）** 上真机开发与验收；面板本体按 CEP 老规范申报，
AE 2021 / 2022 / 2023+ 都能装。

> TG 频道：**次元の仓库_A** — https://t.me/DimensionID

---

## 1. 它长什么样

- 面板：`窗口 > 扩展 > AE MCP 桥`
- 面板一开，就在本机 **127.0.0.1:47821**（被占用顺延 47822…47825）起一个 HTTP + JSON-RPC 桥
- AI 客户端通过两种方式接进来：
  - **stdio**：`node <扩展目录>/mcp/aemcp-mcp.js`（Claude Desktop / Codex / 任何 stdio MCP 客户端）
  - **HTTP**：`POST http://127.0.0.1:47821/rpc`，请求头 `X-AEMCP-Token: <面板上显示的 token>`
- 工具面 **最多 143 个**（见第 6 节；AE 2021 = 133、AE 2022+ = 135、AE 2025+ = 137、AE 2026+ = 143）：状态 / 工程 / 合成 / 图层 / 属性 / 关键帧 / 表达式 / 效果 / 蒙版 / 标记 / 3D 材质相机灯光 / 素材导入与代理 / 路径与形状算子 / 渲染队列 / 文本动画器 / 工程设置与颜色空间 / 字体与 XMP / MOGRT / 图层开关与时间重映射 / 关键帧编辑与切线 / 蒙版与文本样式 / 查看器与偏好设置 / 动画预设与模板 / 检查点与批处理 / 逃生舱 `ae_exec` / 自检 `ae_probe` / 能力探测 `ae_capabilities` / 2022+ 的 `ae_layer_id`、`ae_layer_by_id` / 25.4+ 的 `ae_app_restart` / 25.1+ 的 `ae_font_check` / 26.5+ 的参考线四件套 / 26.3+ 的 `ae_layer_mesh` / 26.0+ 的 `ae_text_axis_add` / 全版本进场动画 `ae_anim_entrance`、菜单命令 `ae_command`、循环 `ae_anim_loop`、抖动 `ae_fx_shake`、计数 `ae_text_counter`、缓动 `ae_ease_presets`、打字机 `ae_text_typewriter`、逐字交错 `ae_text_stagger`

面板可以缩到很小，但**必须保持打开** —— 原因见第 2 节。

---

## 2. 为什么必须有一个面板在跑

AE 2021 **不接受任何外部脚本驱动**，这是本项目实测出来的硬结论（不是猜的）：

| 方式 | 结果 |
| --- | --- |
| `AfterFX.exe -r script.jsx` | 进程起得来（Create 返回 pid），**约 20 秒后自行退出，脚本一次都没执行** |
| `AfterFX.exe -s "$.evalFile(...)"` | 同上，脚本没跑 |
| 不带参数启动 | 正常，约 10 秒出窗口 |

所以整套架构是：

```
MCP 客户端 ──stdio──> aemcp-mcp.js ──HTTP POST /rpc──> 面板(CEP Node 12.3.1)
                                                          │
                                                    cs.evalScript()
                                                          ▼
                                                  host.jsx（ExtendScript 4.5，AE 主线程）
```

真正能执行 ExtendScript 的**只有面板自己**。外部进程进不来，这也顺带保证了：
桥只监听 127.0.0.1、带 token、AE 不开就没人能碰你的工程。

**所以面板得一直开着，而且要是它所在标签组里当前显示的那一个。** 实测（AE 2021 + CEP 10.1）：
面板标签被切到后台、或被从工作区里去掉之后，AE 会把它的 CEP 引擎回收掉，桥（和 `%TEMP%\AEMCP-bridge.json`）
随之消失 —— 这时候 AI 客户端会报「找不到桥」。处理：在 AE 里点一下 `窗口 > 扩展 > AE MCP 桥`
把面板调出来，看着横幅变成「MCP 桥就绪」即可。

> 别拿菜单项反复点：它是**开关**，点第二下就把面板关了。安装器提示的也是这条。

---

## 3. 真机兼容性结论（AE 2021 · AEFT 18.0x39）

环境实测：**CEP 10.1.0** / **CEF Chrome/74.0.3729.157** / 面板内 **Node v12.3.1 x64**（`require` 可用，
http、https、fs、net、child_process、path、os、url、crypto 全部可加载）。

宿主侧 **有**：`js.JSON`、`app.scheduleTask/cancelTask`、`app.beginUndoGroup`、`app.beginSuppressDialogs`、
`app.purge(PurgeTarget.UNDO_CACHES)`、`app.project.itemByID()`、`pref.fileNetwork`、枚举
`KeyframeInterpolationType / PropertyValueType / Shape / PurgeTarget / MaskMode`、
`File` 对象 UTF-8（含中文）读写正常、`comp.addComp`、`layers.addText/addShape/addSolid/addNull/addCamera/addLight`、
文本文档读写（字号/字体/对齐/颜色）、关键帧 `setValueAtTime` + `setTemporalEase`、表达式读写与 `expressionError`、
效果（Fill / Gaussian Blur 2 / Drop Shadow / Tint …）、遮罩、混合模式、父子、渲染队列入队。

宿主侧 **没有**（本项目为此专门绕开）：

| 缺什么 | 影响 | 本项目的做法 |
| --- | --- | --- |
| `layer.id` / `app.project.layerByID()` | AE 2021 之前没有图层 id（2022+ 才有）。图层**下标会随增删漂移** | 工具层用「名字 + 下标」寻址；跨多次调用盯同一层时先 `ae_layer_stamp` 往 `layer.comment` 写一个 `aemcp:xxxx` 戳，之后拿戳当 layer 参数 |
| `Array.prototype.indexOf/forEach/map`、`Object.keys`、`String.prototype.trim` | ExtendScript 是 ES3 | `host.jsx` 自带 polyfill，不依赖这些 |
| `app.undo` | 不能直接调宿主撤销 | 写操作全部包在 `beginUndoGroup/endUndoGroup` 里；需要回退时用宿主菜单命令 |
| `addNull()` 会落成工程素材 + 自动建「纯色」文件夹 | 探针跑完工程里会留垃圾 | 每次写操作前记快照（项目项 id 集合），结束时**只删这次新建的**，并 `purge` undo 缓存；`Item.typeName` 是本地化的（中文返回「文件夹/素材」），判类型只用 `instanceof` |

另外两条设计纪律：

- **执行层在 AE 主线程**：每个 ExtendScript 调用期间 UI 不重绘。所以工具层尽量一次往返干完一件事，
  不搞逐属性往返（这是「不让 AE 卡顿」的硬要求）。
- **绝不动用户的东西**：工具只操作你明确指定的合成/图层；`app.newProject()` 这类会弹模态框、
  能把 ExtendScript 引擎永久阻塞的调用，被明确禁止。

### 3.1 多版本真机验证（2021 / 2024 / 2025 / 2026）

v0.10.0 起 manifest 的 `RequiredRuntime` 从 **CSXS 9.0 → 10.0**（并去掉无用的 `xmlns:xsi` 与已废弃的
`--allow-file-access*` CEF 参数）。实测 CSXS 10.0 在 **CEP 10.1 / 11.5 / 12** 上都能注册加载，而旧的
CSXS 9.0 在 CEP 12（AE 2024+）上会被**静默丢弃**（面板不出现在菜单）。

| AE | CEP | 工具数 | 版本分层 | 状态 |
| --- | --- | --- | --- | --- |
| 2021 (18.0) | 10.1.0 | **125** | tier=2021，无 layer.id | ✅ 真机 |
| 2024 (24.5) | 11.5.3 | 127（预期） | tier=2022+ | ⚠ 宿主崩溃（见下） |
| 2025 (25.6) | 12.0.1 | **127** | tier=2022+，`layer.id`/`usedFonts` 实测可用 | ✅ 真机 |
| 2026 (26.5) | 12.0.1 | **127** | tier=2022+ | ✅ 真机 |

- **AE 2024 打不开 = 宿主自身问题，与插件无关**：启动即弹「崩溃修复选项」、点「继续」静默退出；
  注册表 `HKCU\Software\Adobe\After Effects\24.5` 的 `AppState=1000` 是崩溃标记，且 `24.0` 键指向的
  安装目录跑的是 24.5 的 exe（`24.5` 键 InstallPath 为空）——Creative Cloud 更新残留损坏，**重装 AE 2024 即可**。
- **崩溃修复框**：新装/被强杀的 AE 首次启动弹「崩溃修复选项」，点「**重置首选项**」即正常进入（2025/2026 实测）。

---

## 4. 安装

### 一键（推荐）

解压 `AEMCP-Install-v1.3.0.zip`，双击 **`安装.cmd`**（或 `pwsh -File install.ps1`）。安装器会：

1. 检测本机所有 After Effects 安装（注册表 + 目录扫描），并**让你选装给哪些版本**（全部安装 / 全部 AE 版本 / 手动指定）
2. 把扩展装到 `%APPDATA%\Adobe\CEP\extensions\com.yg.aemcp`（**用户级，免管理员**）
3. 按你选的版本改写 manifest 的 `Host` 区间（只让选中的 AE 加载这个面板）
4. 需要时打开 CEP 未签名扩展开关 `PlayerDebugMode`（否则面板不出现在菜单里）
5. 打印你这份机器上可直接粘贴的 MCP 客户端配置 + 我的 TG 频道

装完 **重启 AE**，菜单里就会有 `窗口 > 扩展 > AE MCP 桥`。

### 装给哪些 AE：三个选项

安装时会列出本机所有 AE，然后给你一张菜单：

```
    要把「AE MCP 桥」装给哪些版本？（只影响这份 manifest 的 Host 区间）
      [1] 全部安装         本机检测到的 1 个版本都装（写成一版本一条区间）
      [2] 全部 AE 版本      区间 [17.0,99.9]：以后新装的 AE 也能直接用
      [3] 手动指定          填编号或版本号，例如： 1    18    18.0    2021    1,3
  直接回车 = [1] 全部安装
```

- **[1] 全部安装**：本机检测到的 AE 全部写进 Host（一个版本一条区间）。以后又装了新版 AE，需要重跑安装器补上。
- **[2] 全部 AE 版本**：Host 写成 `[17.0,99.9]`，**以后装的 AE 不用重装就能用**这个面板。
- **[3] 手动指定**：只挑其中几个。也可以直接填版本号跳过菜单。

命令行等价写法：

```powershell
pwsh -File install.ps1 -AeVersions 18            # 只给 AE 2021（主版本 18）
pwsh -File install.ps1 -AeVersions 18,24         # 给 AE 2021 和 AE 2024
pwsh -File install.ps1 -AeVersions 2021          # 年份写法也认
pwsh -File install.ps1 -AeVersions all           # 全部安装 = [17.0,99.9]
pwsh -File install.ps1 -Quiet                    # 不问，装给全部检测到的版本
pwsh -File install.ps1 -Quiet -AeVersions all    # 完全静默的全部安装（打包机/批处理用）
```

原理：写进 manifest 的 `<Host Name="AEFT" Version="[18.0,18.9]"/>`，CEP 只在匹配的宿主里加载扩展。
不连续的两个版本会各写一条 Host（⚠ 多区间写法本机只验证了「匹配到的版本照常加载」，
不相交区间在 22+ 的机器上是否都生效属于未验证；跨不连续版本建议加 `-Span` 用一条
`[最小,最大]` 区间）。指定一个本机还没装的版本号也可以，等于先把位置留好。

### 手动

把 `payload\` 整个目录拷成 `%APPDATA%\Adobe\CEP\extensions\com.yg.aemcp\`，
然后确认注册表 `HKCU\Software\Adobe\CSXS.11`（以及 CSXS.5 ~ CSXS.30）下有
`PlayerDebugMode` = 字符串 `1`。

---

## 5. 接到 AI 客户端

先在 AE 里打开面板（桥才会起来），然后：

**Claude Desktop**（`claude_desktop_config.json`）：

```json
{
  "mcpServers": {
    "aemcp": {
      "command": "node",
      "args": ["C:/Users/<你>/AppData/Roaming/Adobe/CEP/extensions/com.yg.aemcp/mcp/aemcp-mcp.js"]
    }
  }
}
```

**Codex CLI**（`~/.codex/config.toml`）：

```toml
[mcp_servers.aemcp]
command = "node"
args = ["C:/Users/<你>/AppData/Roaming/Adobe/CEP/extensions/com.yg.aemcp/mcp/aemcp-mcp.js"]
```

面板上有两个复制按钮，点一下就能拿到一份填好路径的配置：

| 按钮 | 复制出来的东西 |
| --- | --- |
| **复制桥信息** | 人读的纯文本，就三行（标签对齐、值从同一列起）：`MCP 客户端` + `http://127.0.0.1:<端口>/rpc`、`端口` + 端口号、`桥令牌` + 令牌 |
| **复制桥 JSON** | 可直接粘进 `claude_desktop_config.json` 的 `mcpServers` JSON 片段（路径已填好） |

想看版本、`/health`、桥文件路径这些细节：`%TEMP%\AEMCP-bridge.json` 里有，面板设置区也显示。

路径也可以从 `%TEMP%\AEMCP-bridge.json` 里的信息反推。

**不用 AI 也能自检**：

```bash
node "<扩展目录>/mcp/aemcp-mcp.js" --info     # 打桥位置、工具数、启动状态
curl -H "X-AEMCP-Token: <token>" http://127.0.0.1:47821/health
```

`aemcp-mcp.js` 找桥的顺序：`AEMCP_PORT` + `AEMCP_TOKEN` 环境变量 → `AEMCP_BRIDGE_FILE` 指向的 json →
`%TEMP%\AEMCP-bridge.json`（面板自己写的）。

---

## 6. 工具表（最多 143 个，含版本分层）

| 工具 | 作用 |
| --- | --- |
| `ae_status` | 宿主概况：AE 版本、ExtendScript 版本、语言、工程文件、项数、活动合成。开工前先调它 |
| `ae_project` | 列工程里的合成/素材/文件夹：index、id、名字、类型、层级、尺寸、时长、帧率、是否离线（missing）、被谁引用（id 可当 comp 参数，写作 `@id:N`） |
| `ae_comp_list` | 只列合成：尺寸、帧率、时长、图层数、工作区、背景色 |
| `ae_comp_info` | 一个合成的完整信息 + 图层清单 |
| `ae_comp_create` | 建合成（默认 1920x1080 / 5 秒 / 25fps） |
| `ae_comp_remove` | 删合成 |
| `ae_layer_text` | 加文本层，可同时设字号、颜色、对齐、位置、名字 |
| `ae_layer_solid` | 加纯色层（会在工程里落成素材） |
| `ae_layer_shape` | 加形状层：rect / ellipse，可设 size、fill、stroke、roundness |
| `ae_layer_null` | 加空对象（父级控制常用） |
| `ae_layer_camera` | 加 3D 摄像机，可设位置与焦距 |
| `ae_layer_info` | 图层全部可见信息（含位置/缩放/不透明度/旋转/锚点、效果清单、文本内容与字号字体） |
| `ae_layer_set` | 批量改图层：position / scale / anchor / opacity / rotation / name / enabled / locked / threeD / inPoint / outPoint / blend / parent / index … |
| `ae_layer_remove` | 删一个图层，或一次删多个 |
| `ae_layer_duplicate` | 复制图层 |
| `ae_layer_stamp` | 给图层写稳定身份戳 `aemcp:xxxx`（存在 comment 里）。AE 2021 没有 Layer.id，跨调用盯同一层就靠它 |
| `ae_property_get` | 读属性值 + matchName + 关键帧数 + 表达式原文/启用状态/**表达式报错**（expressionError） |
| `ae_property_set` | 给属性赋值（支持 `Effects.<效果>.<参数>` 路径） |
| `ae_keyframe_set` | 设一组关键帧 `keys=[{t,v}]`，可配 ease 与 linear/bezier/hold |
| `ae_keyframe_clear` | 清掉属性的关键帧 |
| `ae_expression_set` | 写表达式，写完立刻求值并回 `expressionError`。三种给法：`expression` 原文 / `template` 模板（wiggle、loopOut、smooth、bouncePos、springy…）/ `link` 跨层引用；也可 `properties` 一次套多个 |
| `ae_expression_clear` | 清表达式 |
| `ae_effect_add` | 加效果（matchName，如 `ADBE Fill` / `ADBE Gaussian Blur 2` / `ADBE Drop Shadow` / `ADBE Tint`），可带参数；也可 `control=slider/angle/color/…` 直接加表达式控件 |
| `ae_effect_set` | 改已有效果的参数 |
| `ae_effect_remove` | 删效果 |
| `ae_render_queue_add` | 把合成加进渲染队列（**只入队不渲染** —— 渲染会占住 AE UI） |
| `ae_exec` | 逃生舱：直接跑一段 ExtendScript 并返回最后一条表达式的值。结构化工具能干的活优先别用它 |
| `ae_probe` | 重跑内置兼容性自检（逐条能力判据） |
| `ae_capabilities` | 读能力分层：AE 主版本、tier（`2021` / `2022+`）、是否有 `Layer.id` / `layerByID`。客户端开工前先调它决定能用哪些工具 |

### 6.1 P0 扩展（36 个）

**蒙版（6）**

| 工具 | 作用 |
| --- | --- |
| `ae_mask_add` | 加蒙版，可一次设 mode / shape / inverted / feather / opacity / expansion |
| `ae_mask_list` | 列图层上的蒙版（模式、形状、羽化、不透明度） |
| `ae_mask_remove` | 删蒙版 |
| `ae_mask_path_get` | 读蒙版路径（顶点/切线/closed），可指定 `atTime` |
| `ae_mask_path_set` | 写蒙版路径（`"rect"` / `"ellipse"` / 点数组 / `{preset,center,size}`），带 `atTime` 就是打关键帧 |
| `ae_mask_keyframes` | 读/写蒙版属性和关键帧（`path` / `feather` / `opacity` / `expansion`），支持 ease 与插值 |

**时间线与工作区（3）**

| 工具 | 作用 |
| --- | --- |
| `ae_time_get` | 当前 CTI、时长、帧率、帧长、显示起始时间 |
| `ae_time_set` | 把 CTI 移到指定秒 |
| `ae_workarea_set` | 设工作区（`start` + `duration`，或 `end`） |

**标记（5）**

| 工具 | 作用 |
| --- | --- |
| `ae_marker_add` | 加标记：合成级（省略 `layer`）或图层级，可带 comment / chapter / url / frameTarget / 时长 / 颜色标签 |
| `ae_marker_list` | 列标记 |
| `ae_marker_remove` | 按 index 或时间删标记 |
| `ae_marker_nearest` | 找某个时间点最近的标记（可指定方向） |
| `ae_marker_snap` | 把 CTI 吸附到最近的标记（`set:false` 只算不移动） |

**图层种类与整理（5）**

| 工具 | 作用 |
| --- | --- |
| `ae_layer_adjustment` | 加调整层 |
| `ae_layer_light` | 加灯光层（含强度） |
| `ae_layer_av` | 把素材/合成铺成图层（`item` + `duration`） |
| `ae_layer_precompose` | 预合成指定图层（`layers` = 下标或名字数组） |
| `ae_layer_reorder` | 按锚点层移动图层（`to` + `where=before/after`） |

**关键帧进阶（6）**

| 工具 | 作用 |
| --- | --- |
| `ae_keyframe_get` | 读每个关键帧的时间、值、进入/离开缓动、插值类型 |
| `ae_keyframe_ease` | 批量改缓动与插值（linear / bezier / hold） |
| `ae_keyframe_offset` | 整组关键帧平移 `delta` 秒 |
| `ae_keyframe_scale_timing` | 以 `pivot` 为原点把关键帧时间轴缩放 `factor` 倍（做慢放/快放） |
| `ae_keyframe_reverse` | 反转关键帧顺序（时间不动、值对调） |
| `ae_keyframe_copy` | 复制到同层另一个属性或另一个图层，可带 `offset` |

**表达式与诊断（2）**

| 工具 | 作用 |
| --- | --- |
| `ae_expression_validate` | 全合成扫描表达式报错（含图层名与属性路径） |
| `ae_property_tree` | 属性树一览（JSON 树，可限深度），找属性名/matchName 用 |

**效果管理（3）**

| 工具 | 作用 |
| --- | --- |
| `ae_effect_list` | 列图层效果（含参数） |
| `ae_effect_copy` | 把一个效果连同参数复制到另一个图层 |
| `ae_effect_reorder` | 调整效果顺序 |

**合成与工程项（6）**

| 工具 | 作用 |
| --- | --- |
| `ae_comp_modify` | 改合成尺寸/时长/帧率/底色/像素比/运动模糊/显示起始时间/工作区 |
| `ae_comp_duplicate` | 复制合成（可改名） |
| `ae_comp_check` | 合成体检：离线素材、零长度图层、表达式报错、出入点反了 |
| `ae_item_activate` | 把某个项设为活动项（合成会顺便在查看器里打开） |
| `ae_item_rename` | 改工程项名字 |
| `ae_item_remove` | 删工程项（素材/文件夹；合成请用 `ae_comp_remove`） |

### 6.2 P1 扩展（27 个）

**3D / 材质 / 相机 / 灯光（5）**

| 工具 | 作用 |
| --- | --- |
| `ae_3d_info` | 读合成的 3D 概况：当前渲染器、可用渲染器列表、所有 3D 图层 |
| `ae_material_options_set` | 改 3D 图层材质：透光/环境/漫反射/镜面/高光/金属、投射阴影（off/on/only）、接受阴影/灯光 |
| `ae_camera_options_set` | 改摄像机：缩放/景深/焦点/光圈/模糊级别/光圈形状与高光 |
| `ae_light_options_set` | 改灯光：强度/颜色/锥角/羽化/衰减/半径/阴影 |
| `ae_comp_renderer_set` | 切换合成 3D 渲染器（经典 3D / Cinema 4D） |

**素材 / 解释 / 代理 / 归类（8）**

| 工具 | 作用 |
| --- | --- |
| `ae_footage_import` | 导入文件，可设序列/字母顺序/导入方式（footage/comp/comp_cropped_layers/project） |
| `ae_footage_import_folder` | 批量导入目录里的媒体文件 |
| `ae_footage_replace` | 替换项目素材或图层源（给 layer 时保留图层与效果），可选修表达式引用 |
| `ae_footage_missing` | 列离线素材 |
| `ae_interpretation_set` | 改解释参数：帧率/alpha 通道/场分离/pulldown/循环/像素比 |
| `ae_proxy_set` | 设代理：文件代理或纯色代理 |
| `ae_proxy_remove` | 移除代理 |
| `ae_item_organize` | 归类工程项：单条移入文件夹，或按类型归类全部顶层条目 |

**路径与形状算子（5）**

| 工具 | 作用 |
| --- | --- |
| `ae_path_create` | 建贝塞尔路径（顶点 + 可选切线 + 闭合） |
| `ae_path_get` | 读路径顶点/切线/闭合状态 |
| `ae_path_set` | 改路径顶点与切线 |
| `ae_shape_operator_add` | 加形状算子：repeater/trim/offset/merge/roundCorners/puckerBloat/twist |
| `ae_shape_operator_set` | 改已存在的形状算子参数 |

**渲染队列（6）**

| 工具 | 作用 |
| --- | --- |
| `ae_render_queue_list` | 列渲染队列（状态/输出文件/是否勾选） |
| `ae_render_queue_item_set` | 配置队列项：勾选 render、时间跨度、输出模板、输出路径 |
| `ae_render_queue_remove` | 移除队列项 |
| `ae_render_templates` | 列输出模块模板与渲染设置模板 |
| `ae_render_frame` | 导出单帧 PNG（saveFrameToPng） |
| `ae_render_queue_control` | 控制渲染：pause / resume / stop（不提供 render，避免阻塞 AE 主线程） |

**文本动画器（3）**

| 工具 | 作用 |
| --- | --- |
| `ae_text_animator_add` | 加文本动画器（默认带范围选择器，可加 position/opacity/scale/rotation/fillColor 属性） |
| `ae_text_selector_set` | 改范围选择器起止/偏移/单位/模式/数量/平滑度/缓和高低 |
| `ae_text_animator_list` | 列文字层的动画器与选择器清单 |

### 6.3 版本分层（2022+ 增补，AE 2021 上不出现）

这两个工具只在 **AE 2022（major ≥ 22）** 上注册 —— AE 2021 没有 `Layer.id` / `app.project.layerByID()`，
`tools/list` 里不会出现它们（面板探测到 2021 会自动收掉）。想确认本机处于哪一层，调 `ae_capabilities`。

| 工具 | 作用 |
| --- | --- |
| `ae_layer_id` | 读图层的原生 `Layer.id`（稳定、增删图层不漂移）。AE 2021 调它返回说明性报错 |
| `ae_layer_by_id` | 按 `Layer.id` 反查图层（`app.project.layerByID(id)`）。AE 2021 同样返回说明性报错 |

工具数：AE 2021 = **133 个**（125 基础 + 8 个自建全版本工具）；AE 2022+ = **135 个**（再加 `ae_layer_id` / `ae_layer_by_id`）；AE 2025+ = **137 个**（再加 `ae_app_restart`、`ae_font_check`）；AE 2026+ = **143 个**（再加 `ae_guide_*` 四件套、`ae_layer_mesh`、`ae_text_axis_add`）。

### 6.4 P3 扩展（33 个，官方 API 全量缺口补齐）

**工程管理（10）**

| 工具 | 作用 |
| --- | --- |
| `ae_project_save` | 保存 / 另存 / 关闭工程（可带确认） |
| `ae_project_settings` | 位深 / 表达式引擎 / GPU 加速 / 线性混合 / 线性化工作空间 / 透明网格 / 工具类型 |
| `ae_project_colorspace` | 工作色彩空间 / gamma / 场景引用补偿，`listColorProfiles` 读可用配置 |
| `ae_project_timecode` | 起始帧 / 时间显示 / 帧计数 / 英尺帧 / 素材时间码起始 |
| `ae_project_font` | 列出工程已用字体（24.5+），全局 / 单合成替换字体（24.5+） |
| `ae_project_xmp` | 读写工程 XMP 元数据 |
| `ae_project_consolidate` | 合并重复素材 / 移除未用素材 |
| `ae_project_reduce` | 精简工程，只保留指定项（破坏性，建议先 checkpoint） |
| `ae_project_autofix` | 批量修正表达式里的旧属性名（from → to） |
| `ae_app_cache` | 清缓存（purge）/ 内存限制 / 禁用渲染开关 |

**项目项 / 素材（2 新 + 3 扩展）**

| 工具 | 作用 |
| --- | --- |
| `ae_item_set` | 改工程项 comment / label / selected |
| `ae_footage_reload` | 重载素材源（FileSource.reload） |
| `ae_footage_import`（扩展） | 新增 `mode=placeholder` 占位素材 |
| `ae_footage_replace`（扩展） | 新增 `mode=placeholder` / `mode=solid` 替换 |
| `ae_interpretation_set`（扩展） | 新增 `guess=true` 自动猜 alpha / pulldown |

**合成（3）**

| 工具 | 作用 |
| --- | --- |
| `ae_comp_motion_blur` | 运动模糊开关 / 采样数 / 快门角度 / 快门相位 |
| `ae_export_mogrt` | 导出动态图形模板（.mogrt），需先保存工程 + 至少一个 EGP 参数 |
| `ae_mogrt_param` | 把属性加入 / 移出 MOGRT 控制面板（add / addAs / check） |

**图层（2）**

| 工具 | 作用 |
| --- | --- |
| `ae_layer_switch` | 拉伸 / 标签 / 质量 / 采样质量 / 帧混合类型 / 折叠变换 / 保留透明度 / 参考线 / 效果开关 / 环境层 / 自动定向 |
| `ae_layer_time_remap` | 开启 / 关闭时间重映射 |

**关键帧 / 属性 / 蒙版（4）**

| 工具 | 作用 |
| --- | --- |
| `ae_keyframe_edit` | 加 / 删关键帧，setValueAtKey，标签（22.6+），选中，浮动 |
| `ae_keyframe_tangent` | 空间 / 时间自动贝塞尔、连续，setSpatialTangentsAtKey |
| `ae_property_separate` | 分离 / 合并位置维度（dimensionsSeparated） |
| `ae_mask_set` | 蒙版颜色 / 锁定 / RotoBezier / 运动模糊 / 羽化衰减 |

**文本（1）**

| 工具 | 作用 |
| --- | --- |
| `ae_text_set` | 改文字样式（字体/字号/填充/描边/行距/字距/对齐/上下标/缩放等，18.0 安全字段；不改文本内容） |

**查看器 / 设置（2）**

| 工具 | 作用 |
| --- | --- |
| `ae_viewer` | 查看器信息 / 激活 / 最大化 / 视图选项（缩放/通道/棋盘格/曝光/快速预览/参考线） |
| `ae_settings` | 读写 app.settings / app.preferences（saveToDisk 落盘） |

**模板 / 编排（9）**

| 工具 | 作用 |
| --- | --- |
| `ae_preset_apply` | 应用 .ffx 动画预设（撤销可能崩溃，先存工程副本） |
| `ae_tpl_lower_third` | 生成下三分之一字幕模板 |
| `ae_tpl_title_card` | 生成标题卡模板 |
| `ae_tpl_transition` | 生成转场模板 |
| `ae_tpl_logo_reveal` | 生成 Logo 揭示模板 |
| `ae_batch` | 一次调用串跑多步（每步独立 undo，失败即停） |
| `ae_checkpoint` | 存 / 列工程检查点（.aep 副本） |
| `ae_revert` | 恢复到检查点 |
| `ae_undo_tip` | 返回手动撤销操作说明 |


工具描述与参数 schema 都是标准 MCP 格式（`tools/list` 直接读），AI 侧不需要额外提示词。

---

## 7. 桥与文件

| 东西 | 位置 |
| --- | --- |
| 扩展 | `%APPDATA%\Adobe\CEP\extensions\com.yg.aemcp\` |
| 桥描述（端口 + token + pid） | `%TEMP%\AEMCP-bridge.json`（面板起来时写，关闭时删） |
| 面板自检结果 | `%TEMP%\AEMCP-probe.json` + `%TEMP%\AEMCP-host-payload.txt` |
| 宿主日志 | `%TEMP%\AEMCP-host.log` |
| 面板控制台日志 | `%LOCALAPPDATA%\Temp\CEPHtmlEngine10-AEFT-18.0-com.yg.aemcp.panel.log` |

HTTP 路由：`GET /health` `GET /ping`（桥状态与工具数）、`GET /status`（上次自检结果）、
`GET /ui`（把面板此刻渲染出来的 DOM 读回来，用来在看不见面板时自证）、`POST /exec`（原始
ExtendScript）、`POST /rpc`（MCP JSON-RPC 2.0：`initialize` / `tools/list` /
`tools/call` / `ping`）。`POST /rpc`、`POST /exec`、`GET /ui` 都要求 `X-AEMCP-Token` 头
（`/ui` 里有桥令牌那一行，不能白给），只监听 127.0.0.1。

---

## 8. 性能：为什么它不会把 AE 弄卡

ExtendScript 全部跑在 **AE 主线程**上，跑的时候 AE 的 UI 是冻的 —— 这是宿主的规矩，谁都改不了。
所以「不卡」不是靠少写功能，而是靠两条硬约束，写在 `panel.js` 的 `hostRun()` 里：

1. **同一时刻只允许一个 `evalScript` 在飞。** 外部并发请求会在面板侧排队（每 30ms 让一次跑道），
   不会变成「一堆脚本同时怼 AE 主线程」。
2. **单次宿主调用有 60s 上限。** 超了就放行队列、给调用方回一句人话（"AE 可能卡在模态对话框上"），
   并记一笔账 —— 后面的请求不会被一个死掉的调用拖住。
3. **连续超时判「引擎卡死」。** 连续 2 次宿主调用超时，面板会自动把横幅切成红色警告
   「ExtendScript 引擎疑似卡死」并给出恢复指引（结束 AfterFX.exe → 重开 AE → 重开面板）；
   点面板上的「检查引擎」按钮会发一个 `1+1` 探针：引擎活着就自动清标记，死了就坐实。
   任何一次成功调用也会自动清标记。外部客户端可从 `GET /health` 的 `engineStuck` 字段读到它。

记账会出现在三处：面板状态区的 **宿主耗时** 行（**每完成一次调用就刷新**，慢调用标黄、
有排队时显示「排队 N」）、`GET /health` 的 `hostQueue` 段、以及超过 1s 的慢调用会写进面板日志。
面板状态区还有两行一眼看健康：**工具** 行（工具数 + AE 版本分层，如「125 个（AE 18 · 2021）」）
和 **健康** 行（`正常` / `有慢调用` / `有超时` / `引擎疑似卡死`）。

顺手说一句：面板自检（探针）也走同一条 `hostRun()` 队列，不插队、也计进这本账 ——
否则「同一时刻只有一个 ExtendScript 在飞」这条约束就有个后门。

**2026-10-16 本机实测**（AE 18.0x39 + CEP 10.1，40 次读写混跑 + 8 次并发，`node Tools/aemcp-perf-test.js`）：

| 指标 | 实测 |
| --- | --- |
| 单次端到端耗时（客户端 → HTTP → 面板 → AE → 回） | min 2ms · p50 3ms · p90 7ms · **max 45ms** · avg 5ms |
| 40 次串行读写混跑 | 40/40 成功 |
| 8 次并发 | 8/8 拿到结果，且**每个回包都对得上自己的请求**（不串包） |
| 并发之后的 `ae_status` | 3ms（主线程没被拖住） |
| 面板账本 `hostQueue` | `done=104 avgMs=3 maxMs=44 slow=0 timeouts=0` |

另外三条设计上的克制：

- **渲染只入队不渲染**：`ae_render_queue_add` 只往渲染队列里加任务，绝不在这里开渲染 ——
  渲染会占满 AE 的 RAM 缓存，那是用户按「渲染」时该发生的事。
- **探针自产自清**：面板启动时那次自检只建一个 `__AEMCP_PROBE__` 临时合成并在结尾回收，
  记账（`prj.reclaim` / `prj.backToBefore`）保证工程回到开跑前。
- **读操作不进 undo 组**：只有写操作才包 `beginUndoGroup/endUndoGroup`，且**绝不主动 purge** 撤销历史。

想自己复测：`node Tools/aemcp-perf-test.js`（有样板合成、跑完自己删，不脏工程）。

> `ae_exec` 是逃生舱：给它一段重脚本，AE 主线程就会真被占住（超过 60s 会被判超时）。
> 长活儿请拆成多次调用，一段一段来。

---

## 9. 排错

| 现象 | 原因 / 处理 |
| --- | --- |
| 菜单里没有 `AE MCP 桥` | `PlayerDebugMode` 没开，或装完没重启 AE（CEP 只在启动时扫扩展目录）。跑一次 `install.ps1` 再重启 AE |
| 面板开了但 AI 报「找不到桥」 | 面板是不是被关掉了？桥随面板生灭。用 `node aemcp-mcp.js --info` 看它在找哪个路径 |
| 端口被占 | 桥按 47821→47825 顺延，实际端口看面板设置区或 `%TEMP%\AEMCP-bridge.json` |
| 工具报错 `-32002` | token 不对：`%TEMP%\AEMCP-bridge.json` 是**每次开面板重写**的，客户端要用最新的那个 |
| 改了扩展代码没反应 | 删掉 `%LOCALAPPDATA%\Temp\cep_cache\AEFT_18.0_com.yg.aemcp.panel\` 再重开面板 |
| 面板行为怪 / 两份扩展 | `extensions\` 目录下**不能有任何备份子目录**（CEP 把每个子目录都当扩展扫）。安装器会自动清 `com.yg.aemcp.bak-*` |
| 点了菜单半天没反应 / 面板空着 | 扩展目录刚被安装器换过时，CEP 冷启动实测能拖到 100 秒以上才把面板拉起来。**别急着重复点菜单**——菜单项是开关，第二下会把刚开的面板关掉。等桥起来即可（成功后面板横幅会变成「MCP 桥就绪」） |
| 想看桥到底起没起 | `Get-CimInstance Win32_Process -Filter "Name='CEPHtmlEngine.exe'"` 里按命令行找 `com.yg.aemcp`，**3 个进程**（browser + gpu + renderer）就是面板活着 |
| 面板横幅变红「引擎疑似卡死」 | 连续 2 次宿主调用超时触发的自动警告。点「检查引擎」按钮：若显示已恢复则继续用；若仍卡死，按横幅指引结束 `AfterFX.exe` → 重开 AE → 重开面板 |
| 面板改名字了菜单还是旧的 | 菜单标签是 AE 启动时读的，重启 AE 才刷新 |

---

## 10. 卸载

双击 `卸载.cmd`（或 `pwsh -File uninstall.ps1`）：关掉面板进程 → 删扩展目录 → 清 CEP 磁盘缓存 →
清 `%TEMP%` 下的桥/探针文件。**不会**动你的 MCP 客户端配置，也不会动 `PlayerDebugMode`（别的扩展还要用）。

### 只从某个版本卸掉

不想整个删掉、只想让某个 AE 版本不再加载这个面板：

```powershell
pwsh -File uninstall.ps1 -AeVersions 18      # 把 AE 2021 摘掉，其它版本继续用
pwsh -File uninstall.ps1 -AeVersions 18,24   # 摘掉多个版本
pwsh -File uninstall.ps1                     # 交互式：问你是「全部卸载」还是「只摘某些版本」
```

只摘版本时不会删扩展本体，只改 manifest 的 Host 区间（剩下的版本照常可用）；
如果摘完之后一个版本都不剩，就自动按「全部卸载」处理。改完重启 AE 生效。

如果当初是用「全部 AE 版本」装的（Host 是宽区间 `[17.0,99.9]`），摘除是**在区间上挖洞**，
不是把宽区间拆成一堆单版本：`[17.0,99.9]` 摘掉 18 → `[17.0,17.9] + [19.0,99.9]`。
这样 manifest 里最多只有几条 Host，形状和装之前一致。

```powershell
pwsh -File install.ps1 -AeVersions all       # 装给「全部 AE 版本」→ [17.0,99.9]
pwsh -File uninstall.ps1 -AeVersions 18      # 再从宽区间里把 18 摘掉
```

---

## 11. 开发

```
AEMCP/                      扩展源码（= 装到 CEP 的那份）
  CSXS/manifest.xml         CSXS 10.0 / AEFT [17.0,99.9] / enable-nodejs + mixed-context
  index.html                面板 UI
  js/panel.js              面板逻辑：HTTP 桥、桥文件、CEP 能力探测、宿主往返
  js/mcp.js                 MCP 服务：JSON-RPC 2.0 + 最多 143 个工具（2021=133 / 2022+=135 / 2025+=137 / 2026+=143）的定义与分发
  jsx/host.jsx              ExtendScript 侧：op 层（真正碰 app/project 的代码）
  mcp/aemcp-mcp.js         stdio ↔ HTTP 搬运工（零依赖，给 MCP 客户端用）
  lib/CSInterface.js       Adobe 官方 CEP 库
AEMCP-Installer/            安装器 / 卸载器 / 打包内容
Tools/                      开发与验收工具（见下）
```

开发工具（都在 `Tools\`）：

| 脚本 | 用途 |
| --- | --- |
| `check-extendscript.js` | ExtendScript(ES3) 静态门：`node Tools\check-extendscript.js AEMCP\jsx\host.jsx` |
| `aemcp-deploy.ps1` | 同步到 CEP 目录 + 关掉面板引擎 + 清 cep_cache + 校验 bundleId |
| `aemcp-probe-run.ps1` | 一键真机：部署 → 起 AE → 开面板 → 等自检结果 → 打印判据表 |
| `aemcp-live-test.js` | 端到端验收：建合成→文本→关键帧→表达式→效果→复制/打戳/删除→清理（真机跑，32 项） |
| `aemcp-proto-test.js` | 协议层离线测试（33 项）：JSON-RPC 握手、工具 schema、错误码、stdout 纯净性 |
| `aemcp-tools-dump.js` | 从活着的桥拉 `tools/list`，生成文档用工具表 |
| `aemcp-exec.js` | 不走 AI 客户端，直接把 ExtendScript 丢给 AE 跑：`node Tools\aemcp-exec.js --code "app.project.numItems"`（调试逃生舱，读 `%TEMP%\AEMCP-bridge.json` 拿 port/token） |
| `aemcp-perf-test.js` | 性能与「不卡 AE」验收：40 次读写混跑 + 8 次并发 + 面板队列账本（14 项） |
| `aemcp-pack.ps1` | 构建门 + 出安装包 `dist\AEMCP-Install-v<版本>.zip` |
| `ps51-parse-check.ps1` | 用 **Windows PowerShell 5.1** 的解析器检查 `.ps1`（安装脚本要能在 5.1 下跑；PS7 解析通过 ≠ 5.1 能跑） |

改代码的正确姿势：改 → `check-extendscript.js` + `node --check` → 部署 → 重开面板 → 真机跑
`aemcp-live-test.js`。**不要**只改不验：AE 2021 的坑大多只在真机上显形。

验收基线（本机实测）：协议层 33/33、端到端 32/32、性能 14/14（p50 3ms / max 45ms、`slow=0 timeouts=0`）、
探针判据全绿（`layerByID`/`layer.id` 两项按设计预期为缺席，不是失败）。

---

## 12. 参考与致谢

本项目在架构调研阶段参考了两个开源实现（都只作设计输入，代码为本项目自写）：

- [Dakkshin/after-effects-mcp](https://github.com/Dakkshin/after-effects-mcp) —— 外部 MCP server + 文件轮询 + 固定工具集的做法
- [JUNKDOGE-JOE/after-effects-mcp](https://github.com/JUNKDOGE-JOE/after-effects-mcp) —— MCP server 跑在 CEP Node 上下文 + HTTP loopback + stdio shim 的做法（本项目的桥形态受它启发）

本扩展与上述项目无隶属关系。

---

## 13. 已知边界

- **不出图、不渲染**：`ae_render_queue_add` 只入队。真要渲染请在 AE 里点，或另配导出工具（渲染会独占 AE UI）
- **没有原生 AEGP 面**：全部走 ExtendScript，所以拿不到插件级（AEGP）能力
- **AE 2021 没有图层 id**：跨调用寻址靠名字 / 下标 / `ae_layer_stamp` 戳
- **一个 AE 实例一个面板**：同时开多个面板会产生多个桥（端口顺延），客户端接最新那个即可

### 13.1 写 ExtendScript 时会咬人的五条（都在本机真机踩过，改代码前先看）

1. **嵌套三元表达式会错误结合**。`var x = c ? (a ? 1 : 2) : b;` 这种写法在 AE 的 ExtendScript 引擎里有真实的行为错乱（实测：本该拿到 `Shape` 的分支拿到了 `Array`，报错 `无法调用"setValueAtTime"。Array 不是正确的类型`）。**凡是三元里再套三元的，一律拆成 `if/else`**。定位这类 bug 的办法：在 `try/catch` 的 catch 里把 `typeof` 结果塞进返回值（不要写成空 catch，也别让后面的赋值把它覆盖掉），顺着正常 JSON 通道回来看。
2. **`AVItem` 在 AE 2021 里不是全局构造器**（`typeof AVItem === "undefined"`，而 `CompItem` / `FootageItem` / `FolderItem` / `SolidSource` / `TextLayer` / `Layer` 都是 `function`）。所以判「是不是 AVItem」必须写 `it instanceof CompItem || it instanceof FootageItem`；直接 `it instanceof AVItem` 会抛 `ReferenceError: "AVItem"未定义`。
3. **移动/改变之后属性对象立即失效**。`Property.moveTo()`、`addProperty()`、改 `OutputModule` 设置之后，之前拿到的那个对象就废了（再读它报 `ReferenceError: 对象无效`）。要点：**先把名字/索引存进普通变量**，操作后重新 `AEMCP_effectFind` / `property(i)` 取回来。
4. **`Shape.vertices`（及 inTangents/outTangents）是「按值读、按值写」的属性**。每次访问 `.vertices` 都返回一份新数组，所以 `sh.vertices = []; sh.vertices.push([0,0]);` 里的 push 作用在一个被丢弃的临时副本上，`setValue(sh)` 时报 `无法设置"vertices"。值数组不具有至少 1 图素`。**正确写法：先在一个局部数组里拼好全部顶点/切线，再一次性 `sh.vertices = 局部数组` 赋值**（`myShape.vertices = [[0,0],[0,100],[100,100],[100,0]]` 这种直接赋值是可以的）。
5. **`renderQueue.pauseRendering()` 要带 1 个参数**。AE 2021 里签名是 `pauseRendering(pause)`（`true`=暂停 / `false`=继续），不带参抛 `由于调用需要 1 个参数，无法调用"pauseRendering"`。`stopRendering()` 无参。二者都只能在真正渲染进行时（`status === RENDERING` 或 `onStatusChanged`/`app.onError` 回调内）调用，否则会抛「渲染进程未运行」。

另外：`app.project.activeItem` **只读**（写它会报「它是 readOnly 属性」），唯一能让某个合成变成活动合成的办法是 `comp.openInViewer()`。`FootageItem` 设代理后 `proxySource.name` 可能为 `null`（纯色代理没有源文件），判断「代理是否生效」用只读布尔 `useProxy` 而不是 `proxySource.name`。

