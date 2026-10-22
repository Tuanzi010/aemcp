# =============================================================================
#  AE MCP 桥（com.yg.aemcp）— 一键安装器
#  Adobe After Effects CEP 扩展 · 把 AE 2021+ 变成可被 AI 直接操控的 MCP 服务
#
#  做的事：
#    1. 检测本机所有 Adobe After Effects 安装（注册表 + 目录扫描）
#    2. 把扩展装到用户级 CEP 目录（免管理员）
#    3. 打开 CEP 未签名扩展开关 PlayerDebugMode（否则面板不会出现在菜单里）
#    4. 打印 MCP 客户端要用的配置片段（Claude Desktop / Codex / 通用 HTTP）
#
#  用法：
#    pwsh -File install.ps1
#    pwsh -File install.ps1 -NoPlayerDebugMode      # 不动注册表
#
#  兼容 Windows PowerShell 5.1（不要用 PS7 语法）。本文件带 UTF-8 BOM：
#  5.1 读无 BOM 的 .ps1 会按 ANSI 解码，中文全变乱码。
# =============================================================================

[CmdletBinding()]
param(
    [string] $PayloadDir = (Join-Path $PSScriptRoot 'payload'),
    [switch] $NoPlayerDebugMode,
    # 装到别的 CEP 扩展根目录（一般不用改；测试 / 便携安装时才用）
    [string] $ExtRoot = (Join-Path $env:APPDATA 'Adobe\CEP\extensions'),
    # 只装给这些 AE 版本（主版本号，如 18 / 18.0 / 24；可多个）。省略 = 装给全部。
    [string[]] $AeVersions,
    # 选中不连续版本时，用一条 [最小,最大] 区间代替「一条一个版本」。
    [switch] $Span,
    # 不提问，直接按 -AeVersions / 全部执行（CI、脚本调用用）。
    [switch] $Quiet
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

# ------------------------------------------------------------------ 常量
$EXT_ID      = 'com.yg.aemcp'
$EXT_PANEL   = 'com.yg.aemcp.panel'
$EXT_NAME    = 'AE MCP 桥'
$VERSION     = '1.3.0'
$CHANNEL     = '次元の仓库_A'
$CHANNEL_URL = 'https://t.me/DimensionID'
$EXT_ROOT    = $ExtRoot
$EXT_DIR     = Join-Path $EXT_ROOT $EXT_ID
# 备份目录必须在 extensions **外面**：CEP 会把 extensions 下每个子目录都当成一个扩展扫，
# 留在里面的备份等于「第二个同 bundleId 的扩展」，会出现改了代码没反应、面板跑旧副本的怪事。
$BAK_ROOT    = Join-Path $env:LOCALAPPDATA 'AEMCP\backup'
$CSXS_MIN    = 5
$CSXS_MAX    = 30

# ------------------------------------------------------------------ 输出助手
function Banner ($m) {
    Write-Host ''
    Write-Host ('  ' + ('=' * 62)) -ForegroundColor DarkCyan
    Write-Host ('   ' + $m) -ForegroundColor Cyan
    Write-Host ('  ' + ('=' * 62)) -ForegroundColor DarkCyan
}
function Step ($m) { Write-Host ('  [*] ' + $m) -ForegroundColor White }
function Ok   ($m) { Write-Host ('  [OK] ' + $m) -ForegroundColor Green }
function Warn ($m) { Write-Host ('  [!] ' + $m) -ForegroundColor Yellow }
function Bad  ($m) { Write-Host ('  [X] ' + $m) -ForegroundColor Red }
function Note ($m) { Write-Host ('      ' + $m) -ForegroundColor DarkGray }

function Get-InteractiveUser {
    try {
        $cs = Get-CimInstance Win32_ComputerSystem -ErrorAction Stop
        if (-not $cs.UserName) { return '' }
        return ($cs.UserName -split '\\')[-1]
    } catch { return '' }
}

function Get-AeRunning {
    try { return @(Get-Process -Name 'AfterFX' -ErrorAction SilentlyContinue).Count } catch { return 0 }
}

# ------------------------------------------------------------------ AE 检测
function Get-CsxsVersion ($cepVersion) {
    # CEP 10.x -> CSXS 9.0 ； CEP 11.x -> CSXS 10.0 ； CEP 12.x -> CSXS 11.0
    if (-not $cepVersion) { return '' }
    $maj = 0
    if ($cepVersion -match '^(\d+)') { $maj = [int]$Matches[1] }
    if ($maj -ge 12) { return '11.0' }
    if ($maj -ge 11) { return '10.0' }
    if ($maj -ge 10) { return '9.0' }
    if ($maj -ge 9)  { return '8.0' }
    if ($maj -ge 8)  { return '7.0' }
    return ''
}

function Get-AeInstalls {
    $found = @{}

    # 1) 注册表（官方安装方式）
    foreach ($root in @(
        'HKLM:\SOFTWARE\Adobe\After Effects',
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

    # 2) 目录扫描（绿色版 / 非标准安装 / 装在 C 盘以外的盘）
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
        # 最多往下看两层目录：<base>\Adobe After Effects 20xx\  或  <base>\<容器>\Adobe After Effects 20xx\
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
        $cep = Join-Path $dir 'Support Files\CEPHtmlEngine\CEPHtmlEngine.exe'
        $aeV = ''; $cepV = ''
        if (Test-Path $exe) { try { $aeV = (Get-Item $exe).VersionInfo.ProductVersion } catch { } }
        if (Test-Path $cep) { try { $cepV = (Get-Item $cep).VersionInfo.FileVersion } catch { } }
        $list += New-Object psobject -Property @{
            Version = $ver; Dir = $dir; Exe = $exe
            AeVersion = $aeV; CepVersion = $cepV
            Csxs = (Get-CsxsVersion $cepV)
        }
    }
    # 按主版本号升序排（18 → 24 → 25 → 26），别按键名字母序（那会把 24 排到 2021 前面）
    $list = @($list | Sort-Object -Property @{ Expression = { Get-MajorOf $_.AeVersion } })
    return $list
}

# ---------------------------------------------------------- 版本区间（Host）
function Get-MajorOf ($v) {
    if (-not $v) { return 0 }
    if ($v -match '^(\d+)') { return [int]$Matches[1] }
    return 0
}

# AE 对象的真实主版本：优先 ProductVersion（如 18.0 / 24.5），目录扫描出来的键名（"Adobe After Effects 2021"）认不出数字，退回键名。
function Get-AeMajor ($a) {
    if (-not $a) { return 0 }
    $m = Get-MajorOf $a.AeVersion
    if ($m -gt 0) { return $m }
    return Get-MajorOf $a.Version
}

function Get-YearOf ($a) {
    # AE 年份不在 ProductVersion 里，只能从注册表键名 / 安装目录名里认（After Effects 2021）
    foreach ($s in @($a.Version, $a.Dir)) {
        if ($s -and $s -match '(20\d\d)') { return [int]$Matches[1] }
    }
    return 0
}

function Test-AeWant ($a, $want) {
    $want = ([string]$want).Trim()
    if (-not $want) { return $false }
    $wMajor = Get-MajorOf $want
    $aMajor = Get-AeMajor $a
    if ($want -match '^20\d\d$') { return ((Get-YearOf $a) -eq [int]$want) }
    if ($want -match '^\d+\.\d+') { return ($a.Version -eq $want -or ($a.Version + '.0') -eq $want) }
    if ($want -match '^\d+$') { return ($aMajor -eq [int]$want) }
    return ($a.Version -like ('*' + $want + '*'))
}

function New-AeTarget ($major) {
    return New-Object psobject -Property @{
        Version    = ('{0}.0' -f $major)
        AeVersion  = ''
        CepVersion = ''
        Dir        = '(本机没检测到)'
        Major      = [int]$major
        Present    = $false
    }
}

function Get-AeBand ($major) {
    return ('[{0}.0,{0}.9]' -f [int]$major)
}

# 显式 UTF-8 读文本（5.1 的 Get-Content 对无 BOM 文件按 GBK 解码，manifest 里的中文会乱码导致 XML 解析失败）
function Read-Utf8Text ($path) {
    return [System.IO.File]::ReadAllText($path, (New-Object System.Text.UTF8Encoding($false)))
}

function Set-ManifestHosts ($extDir, $bands) {
    $mf = Join-Path $extDir 'CSXS\manifest.xml'
    if (-not (Test-Path $mf)) { throw ('找不到 manifest：' + $mf) }
    $raw = Read-Utf8Text $mf
    $block = (@($bands) | ForEach-Object { '    <Host Name="AEFT" Version="' + $_ + '"/>' }) -join "`r`n"
    $new = [regex]::Replace($raw, '(?s)<HostList>.*?</HostList>', ("<HostList>`r`n" + $block + "`r`n    </HostList>"))
    if ($new -eq $raw) { throw 'manifest 里没有 HostList，无法按版本改写' }
    # manifest 保持 UTF-8 无 BOM（CEP 一直吃这个格式）
    [System.IO.File]::WriteAllText($mf, $new, (New-Object System.Text.UTF8Encoding($false)))
    $chk = [xml](Read-Utf8Text $mf)
    if ($chk.ExtensionManifest.ExtensionBundleId -ne $EXT_ID) { throw '改写后 manifest 校验失败' }
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

function Get-BandMajors ($band) {
    # "[18.0,18.9]" -> @(18) ；"14.0" -> @(14) ；"[17.0,99.9]" -> @(17..99)
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

function Show-AeTargets ($list) {
    $i = 0
    foreach ($a in $list) {
        $i++
        $tag = ''
        $maj = Get-MajorOf $a.Version
        if ($a.Present) {
            $y = Get-YearOf $a
            if ($y -gt 0) { $tag = 'AE ' + $y } else { $tag = 'AE ' + $a.Version }
            if ($a.Csxs -and [double]$a.Csxs -le 9.0) { $tag += '   CEP ' + $a.CepVersion + '  ← 直装' }
            elseif ($a.Csxs) { $tag += '   CEP ' + $a.CepVersion + '  ← 也能装（宿主 CSXS ' + $a.Csxs + ' ≥ 9.0）' }
            Write-Host ('    [' + $i + '] ' + $tag + '    主版本 ' + $maj + '    Host ' + (Get-AeBand $maj)) -ForegroundColor White
            Note ('     ' + $a.Dir)
        } else {
            Write-Host ('    [' + $i + '] 本机没检测到：主版本 ' + $maj + '    Host ' + (Get-AeBand $maj)) -ForegroundColor DarkGray
        }
    }
}


# ------------------------------------------------------------------ 装扩展
function Install-Extension ($src) {
    if (-not (Test-Path (Join-Path $src 'CSXS\manifest.xml'))) {
        throw "安装内容不完整（找不到 CSXS\manifest.xml）：$src"
    }
    if (-not (Test-Path $EXT_ROOT)) { New-Item -ItemType Directory -Path $EXT_ROOT -Force | Out-Null }

    if (Test-Path $EXT_DIR) {
        if (-not (Test-Path $BAK_ROOT)) { New-Item -ItemType Directory -Path $BAK_ROOT -Force | Out-Null }
        $bak = Join-Path $BAK_ROOT ($EXT_ID + '.bak-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
        Move-Item -LiteralPath $EXT_DIR -Destination $bak -Force
        Warn ('发现旧版本，已备份到 ' + $bak)

        # extensions 下**绝不能**留任何 .bak-*（第三方安装器留下的要清掉）
        $stray = @(Get-ChildItem -LiteralPath $EXT_ROOT -Directory -Filter ($EXT_ID + '.bak-*') -ErrorAction SilentlyContinue)
        foreach ($o in $stray) { Remove-Item -LiteralPath $o.FullName -Recurse -Force -ErrorAction SilentlyContinue }
        if ($stray.Count -gt 0) { Note ('清掉 ' + $stray.Count + ' 个遗留在 extensions 下的备份目录（CEP 会把它们当成重复扩展）') }

        # 外部备份只留最近 3 个
        $dead = @(Get-ChildItem -LiteralPath $BAK_ROOT -Directory -Filter ($EXT_ID + '.bak-*') -ErrorAction SilentlyContinue |
                  Sort-Object LastWriteTime -Descending | Select-Object -Skip 3)
        foreach ($o in $dead) { Remove-Item -LiteralPath $o.FullName -Recurse -Force -ErrorAction SilentlyContinue }
    }

    New-Item -ItemType Directory -Path $EXT_DIR -Force | Out-Null
    # -Force 才能带上隐藏文件
    foreach ($f in @(Get-ChildItem -LiteralPath $src -Force)) {
        Copy-Item -LiteralPath $f.FullName -Destination $EXT_DIR -Recurse -Force
    }

    # 校验装上去的那份真的是我们要的 bundle
    $mf = Join-Path $EXT_DIR 'CSXS\manifest.xml'
    if (-not (Test-Path $mf)) { throw ('扩展目录里没有 manifest：' + $mf) }
    $xml = [xml](Read-Utf8Text $mf)
    $gotId = $xml.ExtensionManifest.ExtensionBundleId
    if ($gotId -ne $EXT_ID) { throw ('manifest 的 bundleId 不对：' + $gotId) }
    return $xml.ExtensionManifest.ExtensionBundleVersion
}

# ------------------------------------------------------- CEP 未签名扩展开关
function Set-PlayerDebugMode {
    $n = 0
    foreach ($i in $CSXS_MIN..$CSXS_MAX) {
        $k = "HKCU:\Software\Adobe\CSXS.$i"
        if (-not (Test-Path $k)) { New-Item -Path $k -Force | Out-Null }
        Set-ItemProperty -Path $k -Name 'PlayerDebugMode' -Value '1' -Type String
        $lvl = $null
        try { $lvl = (Get-ItemProperty $k -Name 'LogLevel' -ErrorAction SilentlyContinue).LogLevel } catch { }
        if (-not $lvl) { Set-ItemProperty -Path $k -Name 'LogLevel' -Value '1' -Type String }
        $n++
    }
    return $n
}

function Test-PlayerDebugMode {
    $k = 'HKCU:\Software\Adobe\CSXS.11'
    if (-not (Test-Path $k)) { return $false }
    try { return ((Get-ItemProperty $k -Name 'PlayerDebugMode' -ErrorAction SilentlyContinue).PlayerDebugMode -eq '1') }
    catch { return $false }
}

# ------------------------------------------------------------------ 主流程
Banner ($EXT_NAME + '  ' + $VERSION + '  一键安装器')
Note ('TG 频道：' + $CHANNEL + '   ' + $CHANNEL_URL)

# ---- 0. 安装内容 -----------------------------------------------------------
if (-not (Test-Path $PayloadDir)) {
    # 开发模式：脚本就在仓库里，扩展源码在上一层
    $dev = Join-Path (Split-Path -Parent $PSScriptRoot) 'AEMCP'
    if (Test-Path (Join-Path $dev 'CSXS\manifest.xml')) {
        $PayloadDir = $dev
        Note ('payload 目录不存在，改用源码目录：' + $PayloadDir)
    }
}
if (-not (Test-Path (Join-Path $PayloadDir 'CSXS\manifest.xml'))) {
    Bad ('找不到安装内容：' + $PayloadDir)
    Note '请把整个安装包目录一起解压后再运行，别只拿走这一个 .ps1。'
    exit 1
}

# ---- 1. 检测 AE ------------------------------------------------------------
Step '检测本机 Adobe After Effects'
$ae = @(Get-AeInstalls)
if ($ae.Count -eq 0) {
    Warn '没检测到 After Effects。扩展照样装到用户级 CEP 目录，只有 AE 启动后才加载。'
} else {
    Ok ('检测到 ' + $ae.Count + ' 个版本')
}

# ---- 1b. 装给哪些 AE 版本（写进 manifest 的 Host 区间）---------------------
Step '选择要装给哪些 After Effects 版本…'

$targets = @()
# -File 调用时 "18,24" 会当成一个字符串进来，这里统一按逗号/空格拆开
$wantList = @()
$wantWide = $false
foreach ($v in @($AeVersions)) {
    foreach ($t in @(([string]$v) -split '[,;\s]+')) {
        if (-not $t) { continue }
        if ($t -match '^(all|ALL|\*|全部|所有)$') { $wantWide = $true } else { $wantList += $t }
    }
}
if ($wantWide -and $wantList.Count -eq 0) {
    # 全部安装：Host 区间写成 [17.0,99.9]，本机现在装的、以后装的 AE 都能用
} elseif ($wantList.Count -gt 0) {
    # 命令行指定：本机装没装都允许（可以提前给将来要装的版本写好区间）
    foreach ($w in $wantList) {
        $hit = @($ae | Where-Object { Test-AeWant $_ $w })
        if ($hit.Count -eq 0) {
            $maj = Get-MajorOf $w
            if ($maj -le 0) { Warn ('认不出这个版本号：' + $w + '（示例：18 / 18.0 / 2021）'); continue }
            $targets += (New-AeTarget $maj)
        } else {
            foreach ($a in $hit) { $targets += $a }
        }
    }
} elseif ($Quiet -or $ae.Count -eq 0) {
    foreach ($a in $ae) { $targets += $a }
} else {
    Write-Host ''
    Write-Host ('  本机检测到的 After Effects（' + $ae.Count + ' 个）：') -ForegroundColor White
    Write-Host ''
    for ($i = 0; $i -lt $ae.Count; $i++) {
        $a = $ae[$i]
        $yr = Get-YearOf $a
        if ($yr -gt 0) { $nm = 'After Effects ' + $yr } else { $nm = $a.Version }
        if ($a.CepVersion) { $cep = 'CEP ' + $a.CepVersion } else { $cep = 'CEP ?' }
        Write-Host ('     [{0}] {1}    {2}    {3}' -f ($i + 1), $nm, $a.AeVersion, $cep) -ForegroundColor White
    }
    Write-Host ''
    Write-Host ('     [a] 全部安装（上面 ' + $ae.Count + ' 个都装）') -ForegroundColor White
    Write-Host '     [w] 全部 AE 版本（宽区间 [17.0,99.9]，含以后新装的）' -ForegroundColor White
    Write-Host ''
    Note '  填编号（如 1）或多个（如 1,3 或 1 3）/ a / w；直接回车 = 全部安装'
    $ans = ''
    try { $ans = Read-Host '  > ' } catch { $ans = '' }
    $ans = $ans.Trim()
    if (-not $ans -or $ans -eq 'a' -or $ans -eq 'A') {
        foreach ($a in $ae) { $targets += $a }
    } elseif ($ans -eq 'w' -or $ans -eq 'W') {
        $wantWide = $true
    } else {
        foreach ($tok in @($ans -split '[,;\s]+' | Where-Object { $_ })) {
            if ($tok -match '^\d+$' -and [int]$tok -ge 1 -and [int]$tok -le $ae.Count) {
                $targets += $ae[[int]$tok - 1]
            } else {
                $hit = @($ae | Where-Object { Test-AeWant $_ $tok })
                if ($hit.Count -gt 0) { foreach ($a in $hit) { $targets += $a } }
                else {
                    $maj = Get-MajorOf $tok
                    if ($maj -gt 0) { $targets += (New-AeTarget $maj) }
                    else { Warn ('认不出：' + $tok + '（可用编号 1-' + $ae.Count + '、a、w，或版本号如 18 / 2021）') }
                }
            }
        }
    }
}

# 去重 + 排序
$majors = @()
foreach ($t in $targets) {
    $m = Get-AeMajor $t
    if ($m -gt 0 -and ($majors -notcontains $m)) { $majors += $m }
}
$majors = @($majors | Sort-Object)

# Host 区间统一写宽区间 [17.0,99.9]：
# CEP 12（AE 2025/2026）不认「同名 AEFT 的多段精确 Host 区间」——多段会报
# "ExtensionManifest is not valid for this host" 并静默移除扩展（2021 的 CEP 10.1 却认，属版本差异）。
# 宽区间让本机所有 After Effects（现在装的、以后新装的）都能加载，彻底避免「某版本找不到」。
$bands = @('[17.0,99.9]')

Write-Host ''
Ok 'Host 区间：全部 AE 版本 [17.0,99.9]'
Note '  扩展装在用户级共享 CEP 目录，宽区间让所有 After Effects（现在装的、以后新装的）都能加载。'
if ($ae.Count -gt 0) {
    foreach ($a in $ae) {
        $y = Get-YearOf $a
        if ($y -gt 0) { Note ('    After Effects ' + $y + '（' + $a.AeVersion + '）') }
        else { Note ('    ' + $a.Version) }
    }
}

# ---- 2. AE 在跑吗 ----------------------------------------------------------
$running = Get-AeRunning
if ($running -gt 0) {
    Warn ('检测到 ' + $running + ' 个 AfterFX.exe 正在运行。')
    Note '装完请重启 AE 才能看到面板：CEP 只在启动时扫描扩展目录。'
}

# ---- 2b. 关掉正在跑的面板引擎 ----------------------------------------------
# 面板开着时它的文件被 CEPHtmlEngine 占着，直接替换会失败（AE 本身不用关）。
$killed = 0
try {
    $procs = @(Get-CimInstance Win32_Process -Filter "Name='CEPHtmlEngine.exe'" -ErrorAction SilentlyContinue |
               Where-Object { $_.CommandLine -and $_.CommandLine -match [regex]::Escape($EXT_ID) })
    foreach ($p in $procs) {
        try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop; $killed++ } catch { }
    }
} catch { }
if ($killed -gt 0) { Ok ('先关掉 ' + $killed + ' 个正在跑的面板进程（装完重新打开面板即可）') }

# ---- 3. 安装扩展 -----------------------------------------------------------
Step '安装扩展到用户级 CEP 目录…'
try {
    $ver = Install-Extension $PayloadDir
    Ok ($EXT_NAME + ' ' + $ver + '  →  ' + $EXT_DIR)
} catch {
    Bad ('安装失败：' + $_.Exception.Message)
    exit 1
}

# ---- 3b. 按选中的版本写 Host 区间 ------------------------------------------
Step '把版本区间写进已安装的 manifest…'
try {
    Set-ManifestHosts $EXT_DIR $bands
    $nowBands = Get-ManifestHosts $EXT_DIR
    Ok ('manifest Host = ' + ($nowBands -join '  +  '))
} catch {
    Warn ('写 Host 区间失败：' + $_.Exception.Message)
    Note '扩展已经装好，只是版本区间没改（默认 [17.0,99.9] = 所有版本开放）。'
}

# ---- 4. PlayerDebugMode ----------------------------------------------------
if ($NoPlayerDebugMode) {
    Note '按参数要求跳过 PlayerDebugMode。'
    if (-not (Test-PlayerDebugMode)) {
        Warn '当前未开启未签名扩展支持，面板可能不出现在 窗口 > 扩展 里。'
        Note '需要时执行：pwsh -File install.ps1   （或手动在 HKCU\Software\Adobe\CSXS.11 下建 PlayerDebugMode=1）'
    }
} else {
    Step '开启 CEP 未签名扩展支持 (PlayerDebugMode)…'
    try {
        $n = Set-PlayerDebugMode
        Ok ('已为 CSXS.' + $CSXS_MIN + ' ~ CSXS.' + $CSXS_MAX + ' 共 ' + $n + ' 个键写入 PlayerDebugMode=1')
    } catch {
        Warn ('写注册表失败：' + $_.Exception.Message)
        Note '把 CEP 未签名扩展开关卡住的话面板不会出现。'
    }
}

# ---- 5. MCP 客户端配置片段 -------------------------------------------------
$shim = (Join-Path $EXT_DIR 'mcp\aemcp-mcp.js').Replace('\', '/')
Banner '下一步：把 AI 客户端接到 AE'

Write-Host '  1) 启动 AE，菜单：窗口 > 扩展 > AE MCP 桥' -ForegroundColor White
Note '面板一开，它就在本机 127.0.0.1 上起一个 MCP 桥（端口 47821 起，被占用就顺延）。'
Note '面板可以缩到最小，但必须保持打开 —— AE 2021 不接受任何外部脚本驱动，'
Note 'ExtendScript 只能由面板自己执行。'
Write-Host ''
Write-Host '  2) Claude Desktop / 任何 stdio 型 MCP 客户端（claude_desktop_config.json）：' -ForegroundColor White
Write-Host '     {' -ForegroundColor Gray
Write-Host '       "mcpServers": {' -ForegroundColor Gray
Write-Host '         "aemcp": { "command": "node", "args": ["' -NoNewline -ForegroundColor Gray
Write-Host $shim -NoNewline -ForegroundColor Yellow
Write-Host '"] }' -ForegroundColor Gray
Write-Host '       }' -ForegroundColor Gray
Write-Host '     }' -ForegroundColor Gray
Note '（面板上的「复制桥 JSON」按钮会直接给出这段，路径已经填好）'
Write-Host ''
Write-Host '  3) Codex CLI（~/.codex/config.toml）：' -ForegroundColor White
Write-Host '     [mcp_servers.aemcp]' -ForegroundColor Gray
Write-Host '     command = "node"' -ForegroundColor Gray
Write-Host '     args = ["' -NoNewline -ForegroundColor Gray
Write-Host $shim -NoNewline -ForegroundColor Yellow
Write-Host '"]' -ForegroundColor Gray
Write-Host ''
Write-Host '  4) 支持 Streamable HTTP 的客户端：' -ForegroundColor White
Write-Host '     POST http://127.0.0.1:47821/rpc   头：X-AEMCP-Token: <面板上显示的 token>' -ForegroundColor Gray
Note '（token 每次开面板都会重新生成，写在 %TEMP%\AEMCP-bridge.json 里）'
Write-Host ''
Write-Host '  5) 自检（不需要 AI，直接命令行验一遍）：' -ForegroundColor White
Write-Host ('     node "' + $shim + '" --info') -ForegroundColor Gray

Banner '安装完成'
Ok ('扩展目录：' + $EXT_DIR)
if ($running -gt 0) { Warn '记得重启 After Effects。' }
Write-Host ''
Write-Host ('  TG 频道：' + $CHANNEL) -ForegroundColor Cyan
Write-Host ('           ' + $CHANNEL_URL) -ForegroundColor DarkCyan
Write-Host ''
Write-Host ('  卸载：pwsh -File uninstall.ps1     （在同一目录下）') -ForegroundColor DarkGray
Write-Host ('  也可以只从某个版本摘掉：pwsh -File uninstall.ps1 -Mode exclude -AeVersions 18') -ForegroundColor DarkGray
Write-Host ''
