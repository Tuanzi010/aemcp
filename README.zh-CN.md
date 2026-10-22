# AE MCP 桥 · aemcp

让 AI 直接操作 After Effects —— 读工程、建合成、加图层、调动画、出片，全程不用手点。

[![Telegram](https://img.shields.io/badge/Telegram-DimensionID-26A5E4?logo=telegram&logoColor=white)](https://t.me/DimensionID)
[![License](https://img.shields.io/badge/License-Noncommercial-orange)](LICENSE)

**143 个工具 · 适配 AE 2021～2026** · [English](README.md)

<details open>
<summary>自动配置：把这个发给你的 AI</summary>

```text
帮我装好 AE MCP 桥（aemcp），让 AI 能操作 After Effects。

先只读检查：aemcp 扩展装没装、AE 版本、客户端已有的 MCP 注册。

没装 → 运行 AEMCP-Setup.exe 勾选 AE 版本安装；装完在 AE 里开
「窗口 > 扩展 > AE MCP 桥」，等横幅变「MCP 桥就绪」。

已装 → 打开面板点「复制桥信息」拿端口和 token。

接入二选一（面板必须保持打开）：
· HTTP：POST http://127.0.0.1:<端口>/rpc，头 X-AEMCP-Token: <token>
· stdio：node <扩展目录>/mcp/aemcp-mcp.js
  扩展目录默认 %APPDATA%\Adobe\CEP\extensions\com.yg.aemcp

最后调 ae_status 验证。
```

</details>

aemcp 是跑在 After Effects 里的一个面板，把正在开的工程接进 MCP。连上之后，Claude Desktop、Codex 这些客户端就能直接读工程、建合成、加图层、调关键帧与表达式、入渲染队列。

## 能做什么

- **读真实工程**：工程、合成、图层、属性、关键帧、渲染队列、字体、XMP，都能按需读。
- **执行动画操作**：建合成与图层、写关键帧与缓动、加表达式与效果、蒙版与形状路径、动画预设与模板。
- **入队 / 导帧 / 打模板**：入渲染队列、导 PNG 单帧、打包 MOGRT 模板。
- **恢复与回滚**：检查点存 / 还原，出错了能退回去。
- **版本分层**：工具按 AE 版本自动分层，老版本看不到用不了的工具。
- **不卡 AE**：串行执行 + 超时保护 + 引擎卡死检测。

## 快速上手

1. 运行 `AEMCP-Setup.exe`，勾选要装给哪些 AE 版本
2. 在 AE 里打开 `窗口 > 扩展 > AE MCP 桥`，等横幅变「MCP 桥就绪」
3. 点面板上的「复制桥信息」，把三行发给 AI

面板可以缩到很小，但必须保持打开——它是桥本身。

## 接到 AI 客户端

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

面板上有两个复制按钮：**复制桥信息**（人读的三行：端口 / token / 地址）、**复制桥 JSON**（直接粘配置）。

## 工具

基础 29 个 + 蒙版 6 + 时间线 3 + 标记 5 + 图层 7 + 关键帧 10 + 表达式诊断 2 + 效果 3 + 合成 9 + 3D 5 + 素材 13 + 路径 5 + 渲染 6 + 文本 4 + 工程 10 + 查看器 2 + 模板 9 + 版本分层 2 = **143 个**（AE 2021 用 133 个）。

### 基础

| 工具 | 作用 |
| --- | --- |
| `ae_status` | AE 概况：版本、语言、工程文件、项数、活动合成。开工前先调它 |
| `ae_project` | 列工程里的合成/素材/文件夹：index、id、名字、类型、尺寸、时长、帧率、是否离线 |
| `ae_comp_list` | 只列合成：尺寸、帧率、时长、图层数、背景色 |
| `ae_comp_info` | 一个合成的完整信息 + 图层清单 |
| `ae_comp_create` | 建合成（默认 1920x1080 / 5 秒 / 25fps） |
| `ae_comp_remove` | 删合成 |
| `ae_layer_text` | 加文本层，可设字号、颜色、对齐、位置、名字 |
| `ae_layer_solid` | 加纯色层 |
| `ae_layer_shape` | 加形状层：rect / ellipse，可设 size、fill、stroke、roundness |
| `ae_layer_null` | 加空对象（父级控制常用） |
| `ae_layer_camera` | 加 3D 摄像机 |
| `ae_layer_info` | 图层全部信息（位置/缩放/不透明度/旋转/锚点、效果清单、文本内容与字体） |
| `ae_layer_set` | 批量改图层：position / scale / anchor / opacity / rotation / name / enabled / threeD / inPoint / outPoint / blend / parent … |
| `ae_layer_remove` | 删图层 |
| `ae_layer_duplicate` | 复制图层 |
| `ae_layer_stamp` | 给图层写稳定身份戳 `aemcp:xxxx`（AE 2021 没有 Layer.id，跨调用盯层靠它） |
| `ae_property_get` | 读属性值 + matchName + 关键帧数 + 表达式原文 / 报错 |
| `ae_property_set` | 给属性赋值（支持 `Effects.<效果>.<参数>` 路径） |
| `ae_keyframe_set` | 设一组关键帧，可配 ease 与 linear/bezier/hold |
| `ae_keyframe_clear` | 清关键帧 |
| `ae_expression_set` | 写表达式，立刻求值回 `expressionError`；支持原文 / 模板（wiggle、loopOut、smooth、bouncePos、springy…）/ 跨层引用 |
| `ae_expression_clear` | 清表达式 |
| `ae_effect_add` | 加效果（`ADBE Fill` / `ADBE Gaussian Blur 2` / `ADBE Drop Shadow` / `ADBE Tint`…），可带参数或表达式控件 |
| `ae_effect_set` | 改效果参数 |
| `ae_effect_remove` | 删效果 |
| `ae_render_queue_add` | 把合成加入渲染队列（只入队不渲染） |
| `ae_exec` | 逃生舱：直接跑一段 ExtendScript |
| `ae_probe` | 重跑兼容性自检 |
| `ae_capabilities` | 读能力分层：AE 版本、tier、是否有 Layer.id |

### 蒙版

| 工具 | 作用 |
| --- | --- |
| `ae_mask_add` | 加蒙版，可设 mode / shape / inverted / feather / opacity / expansion |
| `ae_mask_list` | 列蒙版（模式、形状、羽化、不透明度） |
| `ae_mask_remove` | 删蒙版 |
| `ae_mask_path_get` | 读蒙版路径（顶点/切线/closed） |
| `ae_mask_path_set` | 写蒙版路径（`"rect"` / `"ellipse"` / 点数组），带 `atTime` 打关键帧 |
| `ae_mask_keyframes` | 读/写蒙版属性与关键帧（path / feather / opacity / expansion） |

### 时间线 / 工作区

| 工具 | 作用 |
| --- | --- |
| `ae_time_get` | 当前 CTI、时长、帧率、帧长 |
| `ae_time_set` | 把 CTI 移到指定秒 |
| `ae_workarea_set` | 设工作区 |

### 标记

| 工具 | 作用 |
| --- | --- |
| `ae_marker_add` | 加标记（合成级 / 图层级），可带 comment / chapter / url / 时长 / 颜色 |
| `ae_marker_list` | 列标记 |
| `ae_marker_remove` | 删标记 |
| `ae_marker_nearest` | 找某时间点最近的标记 |
| `ae_marker_snap` | CTI 吸附到最近标记 |

### 图层

| 工具 | 作用 |
| --- | --- |
| `ae_layer_adjustment` | 加调整层 |
| `ae_layer_light` | 加灯光层 |
| `ae_layer_av` | 把素材/合成铺成图层 |
| `ae_layer_precompose` | 预合成指定图层 |
| `ae_layer_reorder` | 按锚点层移动图层 |
| `ae_layer_switch` | 拉伸 / 标签 / 质量 / 帧混合 / 折叠变换 / 保留透明度 / 参考线 / 效果开关 / 环境层 / 自动定向 |
| `ae_layer_time_remap` | 开启 / 关闭时间重映射 |

### 关键帧 / 属性

| 工具 | 作用 |
| --- | --- |
| `ae_keyframe_get` | 读每个关键帧的时间、值、缓动、插值 |
| `ae_keyframe_ease` | 批量改缓动与插值 |
| `ae_keyframe_offset` | 整组关键帧平移 |
| `ae_keyframe_scale_timing` | 时间轴缩放（慢放/快放） |
| `ae_keyframe_reverse` | 反转关键帧顺序 |
| `ae_keyframe_copy` | 复制关键帧到另一属性 / 图层 |
| `ae_keyframe_edit` | 加 / 删关键帧，setValueAtKey，标签（22.6+） |
| `ae_keyframe_tangent` | 空间 / 时间自动贝塞尔 |
| `ae_property_separate` | 分离 / 合并位置维度 |
| `ae_mask_set` | 蒙版颜色 / 锁定 / RotoBezier / 运动模糊 / 羽化衰减 |

### 表达式与诊断

| 工具 | 作用 |
| --- | --- |
| `ae_expression_validate` | 全合成扫描表达式报错 |
| `ae_property_tree` | 属性树一览（找属性名 / matchName） |

### 效果

| 工具 | 作用 |
| --- | --- |
| `ae_effect_list` | 列图层效果 |
| `ae_effect_copy` | 效果连同参数复制到另一图层 |
| `ae_effect_reorder` | 调整效果顺序 |

### 合成与工程项

| 工具 | 作用 |
| --- | --- |
| `ae_comp_modify` | 改合成尺寸/时长/帧率/底色/像素比/运动模糊/工作区 |
| `ae_comp_duplicate` | 复制合成 |
| `ae_comp_check` | 合成体检：离线素材、零长度图层、表达式报错 |
| `ae_item_activate` | 设活动项 |
| `ae_item_rename` | 改工程项名字 |
| `ae_item_remove` | 删工程项 |
| `ae_comp_motion_blur` | 运动模糊开关 / 采样数 / 快门角度 / 相位 |
| `ae_export_mogrt` | 导出动态图形模板（.mogrt） |
| `ae_mogrt_param` | 属性加入 / 移出 MOGRT 控制面板 |

### 3D / 材质 / 相机 / 灯光

| 工具 | 作用 |
| --- | --- |
| `ae_3d_info` | 读 3D 概况：渲染器、3D 图层 |
| `ae_material_options_set` | 改材质：透光/漫反射/镜面/高光/金属、投射阴影、接受阴影/灯光 |
| `ae_camera_options_set` | 改摄像机：缩放/景深/焦点/光圈/模糊/光圈形状 |
| `ae_light_options_set` | 改灯光：强度/颜色/锥角/羽化/衰减/半径/阴影 |
| `ae_comp_renderer_set` | 切换 3D 渲染器（经典 / Cinema 4D） |

### 素材 / 代理 / 归类

| 工具 | 作用 |
| --- | --- |
| `ae_footage_import` | 导入文件，可设序列/导入方式（footage/comp/placeholder/project） |
| `ae_footage_import_folder` | 批量导入目录媒体 |
| `ae_footage_replace` | 替换素材或图层源（可 placeholder / solid，可选修表达式引用） |
| `ae_footage_missing` | 列离线素材 |
| `ae_interpretation_set` | 改解释参数：帧率/alpha/场分离/pulldown/循环/像素比，可 guess 自动猜 |
| `ae_proxy_set` | 设代理（文件 / 纯色） |
| `ae_proxy_remove` | 移除代理 |
| `ae_item_organize` | 归类工程项 |
| `ae_item_set` | 改 comment / label / selected |
| `ae_footage_reload` | 重载素材源 |
| `ae_project_font` | 列工程字体 / 替换字体（24.5+） |

### 路径与形状算子

| 工具 | 作用 |
| --- | --- |
| `ae_path_create` | 建贝塞尔路径 |
| `ae_path_get` | 读路径顶点/切线/闭合 |
| `ae_path_set` | 改路径顶点与切线 |
| `ae_shape_operator_add` | 加形状算子：repeater/trim/offset/merge/roundCorners/puckerBloat/twist |
| `ae_shape_operator_set` | 改形状算子参数 |

### 渲染队列

| 工具 | 作用 |
| --- | --- |
| `ae_render_queue_list` | 列渲染队列（状态/输出/勾选） |
| `ae_render_queue_item_set` | 配置队列项：render / 时间跨度 / 输出模板 / 路径 |
| `ae_render_queue_remove` | 移除队列项 |
| `ae_render_templates` | 列输出模块与渲染设置模板 |
| `ae_render_frame` | 导单帧 PNG |
| `ae_render_queue_control` | 控制渲染：pause / resume / stop |

### 文本

| 工具 | 作用 |
| --- | --- |
| `ae_text_set` | 改文字样式（字体/字号/填充/描边/行距/字距/对齐等，不改文本内容） |
| `ae_text_animator_add` | 加文本动画器（带范围选择器，可加 position/opacity/scale 属性） |
| `ae_text_selector_set` | 改范围选择器起止/偏移/单位/数量/平滑度 |
| `ae_text_animator_list` | 列动画器与选择器 |

### 工程管理

| 工具 | 作用 |
| --- | --- |
| `ae_project_save` | 保存 / 另存 / 关闭工程 |
| `ae_project_settings` | 位深 / 表达式引擎 / GPU 加速 / 线性混合 / 工具类型 |
| `ae_project_colorspace` | 工作色彩空间 / gamma / 场景引用补偿 |
| `ae_project_timecode` | 起始帧 / 时间显示 / 帧计数 / 英尺帧 |
| `ae_project_xmp` | 读写工程 XMP 元数据 |
| `ae_project_consolidate` | 合并重复素材 / 移除未用素材 |
| `ae_project_reduce` | 精简工程（破坏性，先 checkpoint） |
| `ae_project_autofix` | 批量修正表达式旧属性名 |
| `ae_app_cache` | 清缓存 / 内存限制 / 禁用渲染开关 |

### 查看器 / 设置

| 工具 | 作用 |
| --- | --- |
| `ae_viewer` | 查看器信息 / 激活 / 视图选项（缩放/通道/曝光/参考线） |
| `ae_settings` | 读写 app.settings / app.preferences |

### 模板 / 编排

| 工具 | 作用 |
| --- | --- |
| `ae_preset_apply` | 应用 .ffx 动画预设 |
| `ae_tpl_lower_third` | 生成下三分之一字幕模板 |
| `ae_tpl_title_card` | 生成标题卡模板 |
| `ae_tpl_transition` | 生成转场模板 |
| `ae_tpl_logo_reveal` | 生成 Logo 揭示模板 |
| `ae_batch` | 一次调用串跑多步（失败即停） |
| `ae_checkpoint` | 存 / 列工程检查点 |
| `ae_revert` | 恢复到检查点 |
| `ae_undo_tip` | 返回手动撤销说明 |

### 版本分层

| 工具 | 作用 |
| --- | --- |
| `ae_layer_id` | 读原生 Layer.id（AE 2022+） |
| `ae_layer_by_id` | 按 Layer.id 反查图层（AE 2022+） |

工具描述与参数 schema 都是标准 MCP 格式（`tools/list` 直接读），AI 侧不需要额外提示词。

## 工作原理

AE 2021 不接受任何外部脚本驱动（实测）：

| 方式 | 结果 |
| --- | --- |
| `AfterFX.exe -r script.jsx` | 约 20 秒后自行退出，脚本没执行 |
| `AfterFX.exe -s "$.evalFile(...)"` | 同上 |
| 不带参数启动 | 正常 |

所以只有面板自己能执行 ExtendScript：

```
MCP 客户端 ──stdio──> aemcp-mcp.js ──HTTP──> 面板(CEP) ──evalScript──> host.jsx（AE 主线程）
```

桥只监听 127.0.0.1、带 token，AE 不开就没人能碰你的工程。面板标签被切到后台后，AE 会回收它的引擎、桥随之消失——把面板调出来即可。

### 兼容性

| AE | CEP | 工具数 | 状态 |
| --- | --- | --- | --- |
| 2021 (18.0) | 10.1.0 | 133 | ✅ |
| 2024 (24.5) | 11.5.3 | 135（预期） | ⚠ 未测试 |
| 2025 (25.6) | 12.0.1 | 137 | ✅ |
| 2026 (26.5) | 12.0.1 | 143 | ✅ |


## 桥与文件

| 东西 | 位置 |
| --- | --- |
| 扩展 | `%APPDATA%\Adobe\CEP\extensions\com.yg.aemcp\` |
| 桥描述（端口 + token + pid） | `%TEMP%\AEMCP-bridge.json` |
| 自检结果 | `%TEMP%\AEMCP-probe.json` |
| AE 日志 | `%TEMP%\AEMCP-host.log` |

HTTP 路由：`GET /health` `GET /ping`、`GET /status`、`GET /ui`（读面板 DOM 自证）、`POST /exec`（原始 ExtendScript）、`POST /rpc`（MCP JSON-RPC）。`/rpc` `/exec` `/ui` 都要求 `X-AEMCP-Token` 头，只监听 127.0.0.1。

## 开发

```
AEMCP/              扩展源码（= 装到 CEP 的那份）
  CSXS/             manifest：CSXS 10.0 / AEFT [17.0,99.9]
  index.html        面板 UI
  js/panel.js       HTTP 桥 + 面板逻辑
  js/mcp.js         MCP 服务（143 工具定义与分发）
  jsx/host.jsx      ExtendScript 执行层（碰 app/project 的代码）
  mcp/aemcp-mcp.js  stdio ↔ HTTP 搬运工
  lib/              Adobe CEP 库
AEMCP-Installer/    安装器 / 卸载器 / 打包内容
Tools/              开发与验收脚本
```

改代码：改 → `check-extendscript.js` + `node --check` → 部署 → 重开面板 → 实测 `aemcp-live-test.js`。

## 参考

参考了三个开源实现（均 MIT，代码自写）：

- [Dakkshin/after-effects-mcp](https://github.com/Dakkshin/after-effects-mcp)（MIT）—— 外部 MCP server + 文件轮询
- [JUNKDOGE-JOE/after-effects-mcp](https://github.com/JUNKDOGE-JOE/after-effects-mcp)（MIT）—— MCP server 跑在 CEP Node + HTTP loopback（桥形态受它启发）
- [ishu86/after-effects-mcp](https://github.com/ishu86/after-effects-mcp)（MIT）—— 工具面覆盖对照

三者的代码都没有进本项目，只是结构与思路参考；它们以 MIT 发布，本项目为非商用许可，互不冲突。

本项目非商业使用免费，商业使用需联系作者授权（见 [LICENSE](LICENSE)）。
