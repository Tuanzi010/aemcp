# AE MCP Bridge · aemcp

Let AI drive After Effects directly — read projects, build comps, add layers, tune animation, and deliver, without a single click.

[![Telegram](https://img.shields.io/badge/Telegram-DimensionID-26A5E4?logo=telegram&logoColor=white)](https://t.me/DimensionID)
[![License](https://img.shields.io/badge/License-Noncommercial-orange)](LICENSE)

**143 tools · AE 2021–2026** · [中文](README.zh-CN.md)

<details open>
<summary>Auto-config: send this to your AI</summary>

```text
Set up the AE MCP bridge (aemcp) so AI can drive After Effects.

First, read-only check: is aemcp installed, which AE version, existing MCP registrations.

Not installed → run AEMCP-Setup.exe and check the AE versions; then in AE open
"Window > Extensions > AE MCP Bridge" until the banner reads "MCP bridge ready".

Installed → open the panel and click "Copy bridge info" for port + token.

Pick one transport (panel must stay open):
· HTTP: POST http://127.0.0.1:<port>/rpc, header X-AEMCP-Token: <token>
· stdio: node <extension dir>/mcp/aemcp-mcp.js
  extension dir defaults to %APPDATA%\Adobe\CEP\extensions\com.yg.aemcp

Finish with ae_status to verify.
```

</details>

aemcp is a panel that runs inside After Effects and exposes the open project over MCP. Once connected, clients like Claude Desktop and Codex can read the project, build comps, add layers, tune keyframes and expressions, and enqueue renders.

## What it does

- **Read the real project**: project, comps, layers, properties, keyframes, render queue, fonts, XMP — read on demand.
- **Run animation operations**: build comps and layers, write keyframes and easing, add expressions and effects, masks and shape paths, presets and templates.
- **Enqueue / frame / template**: enqueue to render queue, export a PNG frame, package a MOGRT template.
- **Recover and roll back**: save/revert checkpoints so a mistake can be undone.
- **Version tiers**: tools are gated by AE version; older versions never see tools they can't run.
- **Won't stall AE**: serial execution + timeout protection + engine-stuck detection.

## Quick start

1. Run `AEMCP-Setup.exe` and check which AE versions to install for
2. In AE open `Window > Extensions > AE MCP Bridge`, wait for the banner to read "MCP bridge ready"
3. Click "Copy bridge info" on the panel and send the three lines to your AI

The panel can be tiny, but it must stay open — it *is* the bridge.

## Connect AI clients

**Claude Desktop** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "aemcp": {
      "command": "node",
      "args": ["C:/Users/<you>/AppData/Roaming/Adobe/CEP/extensions/com.yg.aemcp/mcp/aemcp-mcp.js"]
    }
  }
}
```

**Codex CLI** (`~/.codex/config.toml`):

```toml
[mcp_servers.aemcp]
command = "node"
args = ["C:/Users/<you>/AppData/Roaming/Adobe/CEP/extensions/com.yg.aemcp/mcp/aemcp-mcp.js"]
```

The panel has two copy buttons: **Copy bridge info** (three human-readable lines: port / token / address) and **Copy bridge JSON** (paste straight into config).

## Tools

Basics 29 + masks 6 + timeline 3 + markers 5 + layers 7 + keyframes 10 + expression diagnostics 2 + effects 3 + comps 9 + 3D 5 + footage 13 + paths 5 + render 6 + text 4 + project 10 + viewer 2 + templates 9 + version tiers 2 = **143** (AE 2021 uses 133).

### Basics

| Tool | Does |
| --- | --- |
| `ae_status` | AE overview: version, locale, project file, item count, active comp. Call it first |
| `ae_project` | List comps/footage/folders: index, id, name, type, dimensions, duration, frame rate, offline flag |
| `ae_comp_list` | List comps only: size, frame rate, duration, layer count, background |
| `ae_comp_info` | Full info of one comp + its layer list |
| `ae_comp_create` | Create comp (default 1920x1080 / 5s / 25fps) |
| `ae_comp_remove` | Remove comp |
| `ae_layer_text` | Add text layer with font size, color, alignment, position, name |
| `ae_layer_solid` | Add solid layer |
| `ae_layer_shape` | Add shape layer: rect / ellipse, with size, fill, stroke, roundness |
| `ae_layer_null` | Add null (for parenting control) |
| `ae_layer_camera` | Add 3D camera |
| `ae_layer_info` | All layer info (position/scale/opacity/rotation/anchor, effects, text content and font) |
| `ae_layer_set` | Batch-set layer: position/scale/anchor/opacity/rotation/name/enabled/threeD/inPoint/outPoint/blend/parent… |
| `ae_layer_remove` | Remove layer |
| `ae_layer_duplicate` | Duplicate layer |
| `ae_layer_stamp` | Write a stable identity stamp `aemcp:xxxx` on a layer (AE 2021 has no Layer.id; use this to track layers across calls) |
| `ae_property_get` | Read property value + matchName + keyframe count + expression (with error) |
| `ae_property_set` | Set property value (supports `Effects.<effect>.<param>` path) |
| `ae_keyframe_set` | Set a set of keyframes with ease and linear/bezier/hold |
| `ae_keyframe_clear` | Clear keyframes |
| `ae_expression_set` | Write expression, evaluated back as `expressionError`; raw / templates (wiggle, loopOut, smooth, bouncePos, springy…) / cross-layer refs |
| `ae_expression_clear` | Clear expression |
| `ae_effect_add` | Add effect (`ADBE Fill` / `ADBE Gaussian Blur 2` / `ADBE Drop Shadow` / `ADBE Tint`…), with params or expression controls |
| `ae_effect_set` | Change effect params |
| `ae_effect_remove` | Remove effect |
| `ae_render_queue_add` | Add comp to render queue (enqueue only, no render) |
| `ae_exec` | Escape hatch: run raw ExtendScript |
| `ae_probe` | Re-run compatibility self-check |
| `ae_capabilities` | Read capability tiers: AE version, tier, has Layer.id |

### Masks

| Tool | Does |
| --- | --- |
| `ae_mask_add` | Add mask with mode/shape/inverted/feather/opacity/expansion |
| `ae_mask_list` | List masks (mode, shape, feather, opacity) |
| `ae_mask_remove` | Remove mask |
| `ae_mask_path_get` | Read mask path (vertices/tangents/closed) |
| `ae_mask_path_set` | Write mask path (`"rect"` / `"ellipse"` / point array), with `atTime` for keyframes |
| `ae_mask_keyframes` | Read/write mask props and keyframes (path/feather/opacity/expansion) |

### Timeline / Work area

| Tool | Does |
| --- | --- |
| `ae_time_get` | Current CTI, duration, frame rate, frame count |
| `ae_time_set` | Move CTI to a given second |
| `ae_workarea_set` | Set work area |

### Markers

| Tool | Does |
| --- | --- |
| `ae_marker_add` | Add marker (comp/layer level) with comment/chapter/url/duration/color |
| `ae_marker_list` | List markers |
| `ae_marker_remove` | Remove marker |
| `ae_marker_nearest` | Find nearest marker to a time |
| `ae_marker_snap` | Snap CTI to nearest marker |

### Layers

| Tool | Does |
| --- | --- |
| `ae_layer_adjustment` | Add adjustment layer |
| `ae_layer_light` | Add light layer |
| `ae_layer_av` | Lay footage/comp as a layer |
| `ae_layer_precompose` | Precompose selected layers |
| `ae_layer_reorder` | Move layer by anchor layer |
| `ae_layer_switch` | Stretch/label/quality/frame blending/collapse/preserve transparency/guide/effects/environment/auto-orient |
| `ae_layer_time_remap` | Enable/disable time remapping |

### Keyframes / Properties

| Tool | Does |
| --- | --- |
| `ae_keyframe_get` | Read each keyframe's time, value, easing, interpolation |
| `ae_keyframe_ease` | Batch-edit easing and interpolation |
| `ae_keyframe_offset` | Shift a group of keyframes |
| `ae_keyframe_scale_timing` | Scale timing (slow-mo / fast-forward) |
| `ae_keyframe_reverse` | Reverse keyframe order |
| `ae_keyframe_copy` | Copy keyframes to another property/layer |
| `ae_keyframe_edit` | Add/remove keyframes, setValueAtKey, label (22.6+) |
| `ae_keyframe_tangent` | Spatial/temporal auto-bezier |
| `ae_property_separate` | Separate/combine position dimensions |
| `ae_mask_set` | Mask color/locked/RotoBezier/motion blur/feather falloff |

### Expressions & diagnostics

| Tool | Does |
| --- | --- |
| `ae_expression_validate` | Scan whole comp for expression errors |
| `ae_property_tree` | Property tree overview (find names/matchNames) |

### Effects

| Tool | Does |
| --- | --- |
| `ae_effect_list` | List layer effects |
| `ae_effect_copy` | Copy effect with params to another layer |
| `ae_effect_reorder` | Reorder effects |

### Comps & items

| Tool | Does |
| --- | --- |
| `ae_comp_modify` | Change comp size/duration/frame rate/background/pixel aspect/motion blur/work area |
| `ae_comp_duplicate` | Duplicate comp |
| `ae_comp_check` | Comp health check: offline footage, zero-length layers, expression errors |
| `ae_item_activate` | Set active item |
| `ae_item_rename` | Rename project item |
| `ae_item_remove` | Remove project item |
| `ae_comp_motion_blur` | Motion blur on/off/samples/shutter angle/phase |
| `ae_export_mogrt` | Export motion graphics template (.mogrt) |
| `ae_mogrt_param` | Add/remove property from MOGRT control panel |

### 3D / Material / Camera / Light

| Tool | Does |
| --- | --- |
| `ae_3d_info` | Read 3D overview: renderer, 3D layers |
| `ae_material_options_set` | Set material: light transmission/diffuse/specular/shininess/metal, cast shadows, accept shadows/lights |
| `ae_camera_options_set` | Set camera: zoom/DOF/focus/aperture/blur/iris shape |
| `ae_light_options_set` | Set light: intensity/color/cone angle/feather/falloff/radius/shadows |
| `ae_comp_renderer_set` | Switch 3D renderer (Classic / Cinema 4D) |

### Footage / Proxy / Organize

| Tool | Does |
| --- | --- |
| `ae_footage_import` | Import file with sequence/import-as (footage/comp/placeholder/project) |
| `ae_footage_import_folder` | Batch import media from a directory |
| `ae_footage_replace` | Replace footage or layer source (placeholder/solid, optional expression-ref fix) |
| `ae_footage_missing` | List offline footage |
| `ae_interpretation_set` | Set interpretation: frame rate/alpha/field separation/pulldown/loop/pixel aspect, with guess |
| `ae_proxy_set` | Set proxy (file/solid) |
| `ae_proxy_remove` | Remove proxy |
| `ae_item_organize` | Organize project items |
| `ae_item_set` | Set comment/label/selected |
| `ae_footage_reload` | Reload footage source |
| `ae_project_font` | List project fonts / replace font (24.5+) |

### Paths & shape operators

| Tool | Does |
| --- | --- |
| `ae_path_create` | Create bezier path |
| `ae_path_get` | Read path vertices/tangents/closed |
| `ae_path_set` | Set path vertices and tangents |
| `ae_shape_operator_add` | Add shape operator: repeater/trim/offset/merge/roundCorners/puckerBloat/twist |
| `ae_shape_operator_set` | Set shape operator params |

### Render queue

| Tool | Does |
| --- | --- |
| `ae_render_queue_list` | List render queue (status/output/checked) |
| `ae_render_queue_item_set` | Configure queue item: render/time span/output template/path |
| `ae_render_queue_remove` | Remove queue item |
| `ae_render_templates` | List output-module and render-settings templates |
| `ae_render_frame` | Export single PNG frame |
| `ae_render_queue_control` | Control render: pause/resume/stop |

### Text

| Tool | Does |
| --- | --- |
| `ae_text_set` | Set text style (font/size/fill/stroke/leading/tracking/alignment etc., no text content) |
| `ae_text_animator_add` | Add text animator (with range selector, plus position/opacity/scale props) |
| `ae_text_selector_set` | Set range selector start/end/offset/units/amount/smoothness |
| `ae_text_animator_list` | List animators and selectors |

### Project management

| Tool | Does |
| --- | --- |
| `ae_project_save` | Save / save-as / close project |
| `ae_project_settings` | Bit depth / expression engine / GPU acceleration / linear blending / tool type |
| `ae_project_colorspace` | Working color space / gamma / scene-referred compensation |
| `ae_project_timecode` | Start frame / time display / frame count / feet-frames |
| `ae_project_xmp` | Read/write project XMP metadata |
| `ae_project_consolidate` | Consolidate duplicate footage / remove unused footage |
| `ae_project_reduce` | Reduce project (destructive, checkpoint first) |
| `ae_project_autofix` | Batch-fix expression property-name drift |
| `ae_app_cache` | Purge cache / memory limits / disable-render switch |

### Viewer / Settings

| Tool | Does |
| --- | --- |
| `ae_viewer` | Viewer info / activate / view options (zoom/channels/exposure/guides) |
| `ae_settings` | Read/write app.settings / app.preferences |

### Templates / Orchestration

| Tool | Does |
| --- | --- |
| `ae_preset_apply` | Apply .ffx animation preset |
| `ae_tpl_lower_third` | Generate lower-third template |
| `ae_tpl_title_card` | Generate title-card template |
| `ae_tpl_transition` | Generate transition template |
| `ae_tpl_logo_reveal` | Generate logo-reveal template |
| `ae_batch` | Run multiple steps serially in one call (stop on fail) |
| `ae_checkpoint` | Save/list project checkpoints |
| `ae_revert` | Revert to a checkpoint |
| `ae_undo_tip` | Return manual undo instructions |

### Version tiers

| Tool | Does |
| --- | --- |
| `ae_layer_id` | Read native Layer.id (AE 2022+) |
| `ae_layer_by_id` | Resolve layer by Layer.id (AE 2022+) |

Tool descriptions and parameter schemas are standard MCP format (read via `tools/list`); no extra prompt is needed on the AI side.

## How it works

AE 2021 won't accept any external script drive (tested):

| Approach | Result |
| --- | --- |
| `AfterFX.exe -r script.jsx` | Exits on its own after ~20s, script never ran |
| `AfterFX.exe -s "$.evalFile(...)"` | Same |
| Start without args | Works |

So only the panel itself can execute ExtendScript:

```
MCP client ──stdio──> aemcp-mcp.js ──HTTP──> panel (CEP) ──evalScript──> host.jsx (AE main thread)
```

The bridge listens on 127.0.0.1 only, with a token — if AE isn't open, nobody can touch your project. When the panel tab is sent to the background, AE reclaims its engine and the bridge disappears; bring the panel back up.

### Compatibility

| AE | CEP | Tools | Status |
| --- | --- | --- | --- |
| 2021 (18.0) | 10.1.0 | 133 | ✅ |
| 2024 (24.5) | 11.5.3 | 135 (expected) | ⚠ untested |
| 2025 (25.6) | 12.0.1 | 137 | ✅ |
| 2026 (26.5) | 12.0.1 | 143 | ✅ |

## Bridge & files

| Thing | Where |
| --- | --- |
| Extension | `%APPDATA%\Adobe\CEP\extensions\com.yg.aemcp\` |
| Bridge descriptor (port + token + pid) | `%TEMP%\AEMCP-bridge.json` |
| Self-check result | `%TEMP%\AEMCP-probe.json` |
| AE log | `%TEMP%\AEMCP-host.log` |

HTTP routes: `GET /health`, `GET /ping`, `GET /status`, `GET /ui` (reads the panel DOM to prove it's alive), `POST /exec` (raw ExtendScript), `POST /rpc` (MCP JSON-RPC). `/rpc`, `/exec`, `/ui` all require the `X-AEMCP-Token` header and listen on 127.0.0.1 only.

## Development

```
AEMCP/              extension source (what gets installed into CEP)
  CSXS/             manifest: CSXS 10.0 / AEFT [17.0,99.9]
  index.html        panel UI
  js/panel.js       HTTP bridge + panel logic
  js/mcp.js         MCP service (143 tool definitions and dispatch)
  jsx/host.jsx      ExtendScript execution layer (code that touches app/project)
  mcp/aemcp-mcp.js  stdio ↔ HTTP shim
  lib/              Adobe CEP library
AEMCP-Installer/    installer / uninstaller / payload
Tools/              development and verification scripts
```

Change → `check-extendscript.js` + `node --check` → deploy → reopen panel → run `aemcp-live-test.js`.

## Credits

Three open-source implementations were referenced (all MIT, code written from scratch):

- [Dakkshin/after-effects-mcp](https://github.com/Dakkshin/after-effects-mcp) (MIT) — external MCP server + file polling
- [JUNKDOGE-JOE/after-effects-mcp](https://github.com/JUNKDOGE-JOE/after-effects-mcp) (MIT) — MCP server in CEP Node + HTTP loopback (bridge shape inspired by it)
- [ishu86/after-effects-mcp](https://github.com/ishu86/after-effects-mcp) (MIT) — tool-surface coverage reference

None of their code was copied — structure and ideas only. They are MIT, while this project is non-commercial, so there is no conflict.

This project is free for non-commercial use. Commercial use requires prior authorization from the author (see [LICENSE](LICENSE)).
