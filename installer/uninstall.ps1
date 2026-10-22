# =============================================================================
#  AE MCP 桥（com.yg.aemcp）— 卸载器
#
#  两种卸载方式：
#    [1] 全部卸载（默认）—— 删扩展目录，所有 AE 都不再加载这个面板
#    [2] 只从指定版本摘除 —— 只把某个 AE 版本从 manifest 的 Host 区间里去掉，
#                            其它版本继续照常使用（卸到只剩 0 个版本时自动变成全部卸载）
#
#  用法：
#    pwsh -File uninstall.ps1                                  全部卸载（会问一次）
#    pwsh -File uninstall.ps1 -Quiet                            全部卸载（不问）
#    pwsh -File uninstall.ps1 -AeVersions 18                    从 AE 2021 摘除（其余版本继续用）
#    pwsh -File uninstall.ps1 -AeVersions 18,24 -Quiet          从多个版本摘除
#    pwsh -File uninstall.ps1 -KeepBackup -KeepTempFiles        全部卸载但留着备份/临时文件
#
#  兼容 Windows PowerShell 5.1（不要用 PS7 语法）。本文件带 UTF-8 BOM。
# =============================================================================

[CmdletBinding()]
param(
    [string] $ExtRoot = (Join-Path $env:APPDATA 'Adobe\CEP\extensions'),
    [switch] $KeepBackup,
    [switch] $KeepTempFiles,
    # all = 全部卸载（默认）；exclude = 只摘掉 -AeVersions 指定的版本
    [ValidateSet('all', 'exclude')]
    [string] $Mode = 'all',
    # 要摘除的 AE 版本（主版本号 / 注册表版本 / 年份都认：18 / 18.0 / 2021）
    [string[]] $AeVersions,
    # 不提问，直接按上面的参数执行
    [switch] $Quiet
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

$EXT_ID      = 'com.yg.aemcp'
$EXT_NAME    = 'AE MCP 桥'
$EXT_DIR     = Join-Path $ExtRoot $EXT_ID
$BAK_ROOT    = Join-Path $env:LOCALAPPDATA 'AEMCP\backup'
$CHANNEL     = '次元の仓库_A'
$CHANNEL_URL = 'https://t.me/DimensionID'

function Banner ($m) {
    Write-Host ''
    Write-Host ('  ' + ('=' * 62)) -ForegroundColor DarkCyan
    Write-Host ('   ' + $m) -ForegroundColor Cyan
    Write-Host ('  ' + ('=' * 62)) -ForegroundColor DarkCyan
}
function Step ($m) { Write-Host ('  [*] ' + $m) -ForegroundColor White }
function Ok   ($m) { Write-Host ('  [OK] ' + $m) -ForegroundColor Green }
function Warn ($m) { Write-Host ('  [!] ' + $m) -ForegroundColor Yellow }
function Note ($m) { Write-Host ('      ' + $m) -ForegroundColor DarkGray }

# --------------------------------------------------------------- 版本区间助手
function Get-MajorOf ($v) {
    if (-not $v) { return 0 }
    if ($v -match '^(\d+)') { return [int]$Matches[1] }
    return 0
}

# AE 对象的真实主版本：优先 ProductVersion（如 18.0 / 24.5），目录扫描键名认不出数字时退回键名。
function Get-AeMajor ($a) {
    if (-not $a) { return 0 }
    $m = Get-MajorOf $a.AeVersion
    if ($m -gt 0) { return $m }
    return Get-MajorOf $a.Version
}

function Get-YearOf ([int]$major, $dir) {
    if ($dir -and $dir -match '(20\d\d)') { return [int]$Matches[1] }
    # 没装在本机时按已知规律推：AE 2019=16 … 2021=18，之后跳过 19/20/21，2022=22 起每年 +1
    if ($major -ge 22) { return (2000 + $major) }
    if ($major -ge 16) { return (2003 + $major) }
    return 0
}

function Get-AeBand ([int]$major) { return ('[{0}.0,{0}.9]' -f $major) }

# 显式 UTF-8 读文本（5.1 的 Get-Content 对无 BOM 文件按 GBK 解码，manifest 里的中文会乱码导致 XML 解析失败）
function Read-Utf8Text ($path) {
    return [System.IO.File]::ReadAllText($path, (New-Object System.Text.UTF8Encoding($false)))
}

function Get-ManifestHosts ($extDir) {
    $mf = Join-Path $extDir 'CSXS\manifest.xml'
    if (-not (Test-Path $mf)) { return @() }
    $raw = Read-Utf8Text $mf
    $out = @()
    foreach ($m in [regex]::Matches($raw, '<Host\b[^>]*Name\s*=\s*"AEFT"[^>]*Version\s*=\s*"([^"]+)"')) { $out += $m.Groups[1].Value }
    foreach ($m in [regex]::Matches($raw, '<Host\b[^>]*Version\s*=\s*"([^"]+)"[^>]*Name\s*=\s*"AEFT"')) { $out += $m.Groups[1].Value }
    return @($out | Select-Object -Unique)
}

function Set-ManifestHosts ($extDir, $bands) {
    $mf = Join-Path $extDir 'CSXS\manifest.xml'
    if (-not (Test-Path $mf)) { throw ('找不到 manifest：' + $mf) }
    $raw = Read-Utf8Text $mf
    $block = (@($bands) | ForEach-Object { '    <Host Name="AEFT" Version="' + $_ + '"/>' }) -join "`r`n"
    $new = [regex]::Replace($raw, '(?s)<HostList>.*?</HostList>', ("<HostList>`r`n" + $block + "`r`n    </HostList>"))
    if ($new -eq $raw) { throw 'manifest 里没有 HostList，改不了版本区间' }
    [System.IO.File]::WriteAllText($mf, $new, (New-Object System.Text.UTF8Encoding($false)))
    $chk = [xml](Read-Utf8Text $mf)
    if ($chk.ExtensionManifest.ExtensionBundleId -ne $EXT_ID) { throw '改写后 manifest 校验失败' }
}

function Get-BandMajors ($band) {
    $b = ([string]$band).Trim()
    $lo = 0; $hi = 0
    if ($b -match '^\[\s*(\d+)(\.\d+)?\s*,\s*(\d+)(\.\d+)?\s*\]$') {
        $lo = [int]$Matches[1]; $hi = [int]$Matches[3]
    } elseif ($b -match '^(\d+)') {
        $lo = [int]$Matches[1]; $hi = $lo
    } else { return @() }
    if ($hi -lt $lo) { return @() }
    # 上界到 99 = 开区间（[17.0,99.9]、挖洞后的 [19.0,99.9] 都算），按到 99 展开
    if ($hi -ge 99) { return @($lo..99) }
    if (($hi - $lo) -gt 60) { return @() }
    return @($lo..$hi)
}

function Get-InstalledAe {
    $found = @{}
    foreach ($root in @('HKLM:\SOFTWARE\Adobe\After Effects',
                        'HKLM:\SOFTWARE\WOW6432Node\Adobe\After Effects',
                        'HKCU:\SOFTWARE\Adobe\After Effects')) {
        if (-not (Test-Path $root)) { continue }
        foreach ($k in @(Get-ChildItem $root -ErrorAction SilentlyContinue)) {
            $p = $null
            try { $p = (Get-ItemProperty $k.PSPath -ErrorAction SilentlyContinue).InstallPath } catch { }
            if (-not $p) { continue }
            $p = $p.TrimEnd('\')
            if ($p -like '*\Support Files') { $p = $p.Substring(0, $p.Length - '\Support Files'.Length) }
            if (-not $found.ContainsKey($k.PSChildName)) { $found[$k.PSChildName] = $p }
        }
    }
    # 目录扫描（绿色版 / 非标准安装 / 装在 C 盘以外的盘）
    #    覆盖所有固定盘，兼容标准与非标准两种目录结构：
    #      标准    <盘>:\Program Files\Adobe\Adobe After Effects 2024\Support Files\AfterFX.exe
    #      非标准  <盘>:\Program Files\AE2025\Adobe After Effects 2025\Support Files\AfterFX.exe
    $scanBases = @()
    foreach ($dv in @([System.IO.DriveInfo]::GetDrives() | Where-Object { $_.DriveType -eq [System.IO.DriveType]::Fixed })) {
        foreach ($sub in @('Program Files', 'Program Files (x86)', 'Adobe')) {
            $scanBases += (Join-Path $dv.Name $sub)
        }
    }
    foreach ($base in @($scanBases | Where-Object { $_ } | Select-Object -Unique)) {
        if (-not (Test-Path $base)) { continue }
        foreach ($d in @(Get-ChildItem -LiteralPath $base -Recurse -Depth 2 -Directory -ErrorAction SilentlyContinue |
                         Where-Object { $_.Name -match 'After Effects' })) {
            if (-not (Test-Path (Join-Path $d.FullName 'Support Files\AfterFX.exe'))) { continue }
            if (-not ($found.Values -contains $d.FullName)) { $found[$d.Name] = $d.FullName }
        }
    }
    $list = @()
    foreach ($ver in @($found.Keys | Sort-Object)) {
        $dir = $found[$ver]
        $exe = Join-Path $dir 'Support Files\AfterFX.exe'
        $aeV = ''
        if (Test-Path $exe) { try { $aeV = (Get-Item $exe).VersionInfo.ProductVersion } catch { } }
        $item = New-Object psobject -Property @{
            Version   = $ver
            Dir       = $dir
            AeVersion = $aeV
            Major     = 0
            Year      = 0
        }
        $item.Major = Get-AeMajor $item
        $item.Year  = (Get-YearOf $item.Major $dir)
        $list += $item
    }
    # 按主版本号升序排，别按键名字母序
    $list = @($list | Sort-Object -Property @{ Expression = { $_.Major } })
    return $list
}

function Test-MajorWant ([int]$major, $want, $aeList) {
    $want = ([string]$want).Trim()
    if (-not $want) { return $false }
    if ($want -match '^20\d\d$') {
        foreach ($a in $aeList) { if ($a.Major -eq $major -and $a.Year -eq [int]$want) { return $true } }
        return ((Get-YearOf $major $null) -eq [int]$want)
    }
    if ($want -match '^\d+$') { return ($major -eq [int]$want) }
    return ($major -eq (Get-MajorOf $want))
}

function Show-Bands ($bands, $aeList) {
    # 把区间翻译成人看得懂的版本清单
    $shown = @{}
    foreach ($b in @($bands)) {
        $majors = @(Get-BandMajors $b)
        if ($majors.Count -eq 0) { Write-Host ('      ' + $b + '  (不认识这条区间)') -ForegroundColor DarkGray; continue }
        if ($majors.Count -gt 12) {
            Write-Host ('      ' + $b + '  = 主版本 ' + $majors[0] + ' ~ ' + $majors[$majors.Count - 1] + '（所有版本）') -ForegroundColor Gray
            continue
        }
        foreach ($m in $majors) {
            if ($shown.ContainsKey($m)) { continue }
            $shown[$m] = $true
            $hit = @($aeList | Where-Object { $_.Major -eq $m })
            $year = 0
            if ($hit.Count -gt 0) { $year = $hit[0].Year } else { $year = Get-YearOf $m $null }
            $name = '主版本 ' + $m
            if ($year -gt 0) { $name = 'After Effects ' + $year }
            if ($hit.Count -gt 0) { Write-Host ('      ' + $b + '  →  ' + $name + '（本机已装）') -ForegroundColor Gray }
            else { Write-Host ('      ' + $b + '  →  ' + $name + '（本机没装）') -ForegroundColor DarkGray }
        }
    }
}

# ===========================================================================
Banner ($EXT_NAME + '  卸载器')
Write-Host ('  TG 频道：' + $CHANNEL) -ForegroundColor Cyan
Write-Host ('           ' + $CHANNEL_URL) -ForegroundColor DarkCyan

if (-not (Test-Path $EXT_DIR)) {
    Warn ('没有装这个扩展：' + $EXT_DIR)
    Write-Host ''
    Write-Host ('  想装：pwsh -File install.ps1') -ForegroundColor DarkGray
    Write-Host ''
    exit 0
}

$aeList = @(Get-InstalledAe)
$bands  = @(Get-ManifestHosts $EXT_DIR)
$enabledMajors = @()
foreach ($b in $bands) { foreach ($m in @(Get-BandMajors $b)) { if ($enabledMajors -notcontains $m) { $enabledMajors += $m } } }
$enabledMajors = @($enabledMajors | Sort-Object)

Write-Host ''
Step '当前安装状态'
Ok ('扩展目录：' + $EXT_DIR)
if ($bands.Count -eq 0) {
    Warn 'manifest 里读不到 AEFT 的 Host 区间'
} elseif ($enabledMajors.Count -gt 12) {
    Write-Host ('  已开放给：所有版本（主版本 ' + $enabledMajors[0] + ' ~ ' + $enabledMajors[$enabledMajors.Count - 1] + '）') -ForegroundColor White
} else {
    Write-Host ('  已开放给 ' + $enabledMajors.Count + ' 个版本：') -ForegroundColor White
    $idx = 0
    foreach ($m in $enabledMajors) {
        $idx++
        $hit = @($aeList | Where-Object { $_.Major -eq $m })
        $year = 0
        if ($hit.Count -gt 0) { $year = $hit[0].Year } else { $year = Get-YearOf $m $null }
        if ($year -gt 0) { $nm = 'After Effects ' + $year } else { $nm = '主版本 ' + $m }
        if ($hit.Count -gt 0) { $mark = '' } else { $mark = '（本机没装）' }
        Write-Host ('     [{0}] {1}    {2} {3}' -f $idx, $nm, (Get-AeBand $m), $mark) -ForegroundColor White
    }
}

# ------------------------------------------------------------------ 决定怎么卸
$removeMajors = @()

# -File 调用时 "18,24" 会当成一个字符串进来，统一拆开
$wantList = @()
foreach ($v in @($AeVersions)) {
    foreach ($t in @(([string]$v) -split '[,;\s]+')) { if ($t) { $wantList += $t } }
}

if ($wantList.Count -gt 0) {
    $Mode = 'exclude'
    foreach ($w in $wantList) {
        $hitM = @($enabledMajors | Where-Object { Test-MajorWant $_ $w $aeList })
        if ($hitM.Count -eq 0) { Warn ('这个版本本来就没开放：' + $w) }
        foreach ($m in $hitM) { if ($removeMajors -notcontains $m) { $removeMajors += $m } }
    }
} elseif (-not $Quiet) {
    Write-Host ''
    Write-Host '  怎么卸？' -ForegroundColor White
    Write-Host '    直接回车 = 全部卸载（所有 AE 都不再加载）' -ForegroundColor Gray
    Write-Host '    填编号（如 1 或 1,3）= 只摘掉这些版本，其它保留' -ForegroundColor Gray
    $a1 = ''
    try { $a1 = Read-Host '  > ' } catch { $a1 = '' }
    $a1 = $a1.Trim()
    if ($a1) {
        $Mode = 'exclude'
        foreach ($tok in @($a1 -split '[,;\s]+' | Where-Object { $_ })) {
            if ($tok -match '^\d+$' -and [int]$tok -ge 1 -and [int]$tok -le $enabledMajors.Count) {
                $m = $enabledMajors[[int]$tok - 1]
                if ($removeMajors -notcontains $m) { $removeMajors += $m }
            } else {
                $hitM = @($enabledMajors | Where-Object { Test-MajorWant $_ $tok $aeList })
                if ($hitM.Count -eq 0) { Warn ('认不出 / 本来就没开放：' + $tok) }
                foreach ($m in $hitM) { if ($removeMajors -notcontains $m) { $removeMajors += $m } }
            }
        }
    }
}

# ------------------------------------------------------------------ 摘除模式
$keepMajors = @($enabledMajors | Where-Object { $removeMajors -notcontains $_ })

if ($Mode -eq 'exclude' -and $removeMajors.Count -gt 0 -and $keepMajors.Count -gt 0) {
    Write-Host ''
    Step '从指定版本摘除（扩展本体保留）…'

    # 关掉面板引擎（manifest 是 AE 启动时读的，改完得重启 AE；顺手把进程收了免得文件被占）
    $killed = 0
    try {
        $procs = @(Get-CimInstance Win32_Process -Filter "Name='CEPHtmlEngine.exe'" -ErrorAction SilentlyContinue |
                   Where-Object { $_.CommandLine -and $_.CommandLine -match [regex]::Escape($EXT_ID) })
        foreach ($p in $procs) { try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop; $killed++ } catch { } }
    } catch { }
    if ($killed -gt 0) { Ok ('已结束 ' + $killed + ' 个面板进程') } else { Note '没有正在跑的面板进程' }

    # 摘除 = 在原有区间上「挖洞」，而不是把区间拆成一个主版本一条。
    # 装的时候可能用的是「全部 AE 版本」([17.0,99.9])，按主版本展开会写出几十条 Host ——
    # 那种 manifest 本机没验证过，所以保留原区间的形状，只在被摘掉的主版本处断开：
    # [17.0,99.9] 摘掉 18 → [17.0,17.9] + [19.0,99.9]
    $oldBands = @(Get-ManifestHosts $EXT_DIR)
    $newBands = @()
    foreach ($b in $oldBands) {
        $mm = [regex]::Match([string]$b, '^\[(\d+)\.\d+,(\d+)\.\d+\]$')
        if (-not $mm.Success) { $newBands += $b; continue }
        $lo = [int]$mm.Groups[1].Value
        $hi = [int]$mm.Groups[2].Value
        if ($lo -le 0 -or $hi -lt $lo) { $newBands += $b; continue }
        $segs = @([pscustomobject]@{ Lo = $lo; Hi = $hi })
        foreach ($rm in @($removeMajors | Sort-Object)) {
            $next = @()
            foreach ($s in $segs) {
                if ($rm -lt $s.Lo -or $rm -gt $s.Hi) { $next += $s; continue }
                if ($rm -gt $s.Lo) { $next += [pscustomobject]@{ Lo = $s.Lo; Hi = ($rm - 1) } }
                if ($rm -lt $s.Hi) { $next += [pscustomobject]@{ Lo = ($rm + 1); Hi = $s.Hi } }
            }
            $segs = $next
        }
        foreach ($s in $segs) { $newBands += ('[{0}.0,{1}.9]' -f $s.Lo, $s.Hi) }
    }
    try {
        Set-ManifestHosts $EXT_DIR $newBands
        Ok ('manifest Host 已改成：' + ($newBands -join '  +  '))
    } catch {
        Warn ('改 manifest 失败：' + $_.Exception.Message)
        exit 1
    }

    $cacheRoot = Join-Path $env:LOCALAPPDATA 'Temp\cep_cache'
    $n = 0
    if (Test-Path $cacheRoot) {
        foreach ($d in @(Get-ChildItem -LiteralPath $cacheRoot -Directory -Filter ('*' + $EXT_ID + '*') -ErrorAction SilentlyContinue)) {
            Remove-Item -LiteralPath $d.FullName -Recurse -Force -ErrorAction SilentlyContinue
            $n++
        }
    }
    Ok ('清掉 ' + $n + ' 个 CEP 缓存目录')

    Banner '已从指定版本摘除'
    Write-Host '  已摘除：' -ForegroundColor White
    foreach ($m in $removeMajors) {
        $hit = @($aeList | Where-Object { $_.Major -eq $m })
        $year = 0
        if ($hit.Count -gt 0) { $year = $hit[0].Year } else { $year = Get-YearOf $m $null }
        if ($year -gt 0) { Write-Host ('    - After Effects ' + $year + '（主版本 ' + $m + '）') -ForegroundColor Gray }
        else { Write-Host ('    - 主版本 ' + $m) -ForegroundColor Gray }
    }
    Write-Host '  仍可继续使用：' -ForegroundColor White
    foreach ($m in $keepMajors) {
        $hit = @($aeList | Where-Object { $_.Major -eq $m })
        $year = 0
        if ($hit.Count -gt 0) { $year = $hit[0].Year } else { $year = Get-YearOf $m $null }
        if ($year -gt 0) { Write-Host ('    - After Effects ' + $year) -ForegroundColor Gray }
        else { Write-Host ('    - 主版本 ' + $m) -ForegroundColor Gray }
    }
    Write-Host ''
    Write-Host ('  TG 频道：' + $CHANNEL + '   ' + $CHANNEL_URL) -ForegroundColor DarkCyan
    Write-Host '  重启 After Effects 后生效（被摘掉的版本里，窗口 > 扩展 里不会再出现这个面板）。' -ForegroundColor DarkGray
    Write-Host ('  想装回来：pwsh -File install.ps1 -AeVersions ' + ($removeMajors -join ',')) -ForegroundColor DarkGray
    Write-Host ''
    exit 0
}

if ($Mode -eq 'exclude' -and $removeMajors.Count -gt 0 -and $keepMajors.Count -eq 0) {
    Write-Host ''
    Note '要摘的版本覆盖了全部开放版本 —— 直接按「全部卸载」处理。'
}
if ($Mode -eq 'exclude' -and $removeMajors.Count -eq 0) {
    Warn '没选中任何版本，什么也没动。'
    Write-Host ''
    exit 0
}

# ------------------------------------------------------------------ 全部卸载
# ---- 1. 关掉面板引擎 -------------------------------------------------------
Step '关闭本扩展的面板进程…'
$killed = 0
try {
    $procs = @(Get-CimInstance Win32_Process -Filter "Name='CEPHtmlEngine.exe'" -ErrorAction SilentlyContinue |
               Where-Object { $_.CommandLine -and $_.CommandLine -match [regex]::Escape($EXT_ID) })
    foreach ($p in $procs) {
        try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop; $killed++ } catch { }
    }
} catch { }
if ($killed -gt 0) { Ok ('已结束 ' + $killed + ' 个 CEP 引擎进程') } else { Note '没有正在跑的面板进程（或它没开着）' }

# ---- 2. 删扩展目录 ---------------------------------------------------------
Step '删除扩展目录…'
if (Test-Path $EXT_DIR) {
    try {
        Remove-Item -LiteralPath $EXT_DIR -Recurse -Force -ErrorAction Stop
        Ok ('已删除 ' + $EXT_DIR)
    } catch {
        Warn ('删不掉：' + $_.Exception.Message)
        Note '多半是 AE 还开着：先完全退出 After Effects，再跑一次本脚本。'
    }
} else {
    Note ('本来就没有：' + $EXT_DIR)
}

# ---- 3. 清 CEP 磁盘缓存 ----------------------------------------------------
Step '清理 CEP 磁盘缓存…'
$cacheRoot = Join-Path $env:LOCALAPPDATA 'Temp\cep_cache'
$n = 0
if (Test-Path $cacheRoot) {
    foreach ($d in @(Get-ChildItem -LiteralPath $cacheRoot -Directory -Filter ('*' + $EXT_ID + '*') -ErrorAction SilentlyContinue)) {
        Remove-Item -LiteralPath $d.FullName -Recurse -Force -ErrorAction SilentlyContinue
        $n++
    }
}
Ok ('清掉 ' + $n + ' 个缓存目录（' + $cacheRoot + '）')

# ---- 4. 清临时文件 ---------------------------------------------------------
if (-not $KeepTempFiles) {
    Step '清理临时文件…'
    $n = 0
    foreach ($pat in @('AEMCP-bridge.json', 'AEMCP-probe.json', 'AEMCP-host-payload.txt', 'AEMCP-host.log', 'AEMCP-write-test.txt')) {
        $f = Join-Path $env:TEMP $pat
        if (Test-Path $f) { Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue; $n++ }
    }
    Ok ('清掉 ' + $n + ' 个临时文件')
} else {
    Note '按要求保留临时文件。'
}

# ---- 5. 备份目录 -----------------------------------------------------------
if (-not $KeepBackup -and (Test-Path $BAK_ROOT)) {
    Step '删除安装备份…'
    Remove-Item -LiteralPath $BAK_ROOT -Recurse -Force -ErrorAction SilentlyContinue
    Ok ('已删除 ' + $BAK_ROOT)
} elseif (Test-Path $BAK_ROOT) {
    Note ('保留备份：' + $BAK_ROOT)
}

Banner '卸载完成'
Write-Host ('  TG 频道：' + $CHANNEL + '   ' + $CHANNEL_URL) -ForegroundColor DarkCyan
Write-Host ''
Write-Host '  没动的东西（要自己收）：' -ForegroundColor White
Write-Host '    - MCP 客户端配置里那条 mcpServers.aemcp / [mcp_servers.aemcp]' -ForegroundColor DarkGray
Write-Host '      （Claude Desktop 的 claude_desktop_config.json、Codex 的 ~/.codex/config.toml）' -ForegroundColor DarkGray
Write-Host '    - PlayerDebugMode 注册表开关（别的 CEP 扩展还要用，所以留着）' -ForegroundColor DarkGray
Write-Host '    - 装扩展时被替换掉的其他文件，一概没碰' -ForegroundColor DarkGray
Write-Host ''
Write-Host '  重启 After Effects 后，窗口 > 扩展 里就不会再有这个面板了。' -ForegroundColor DarkGray
Write-Host ''
