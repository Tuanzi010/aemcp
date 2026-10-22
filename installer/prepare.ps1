# =============================================================================
#  prepare.ps1 — 打包前的准备（build-setup.cmd 调用）
#    1) 给 install.ps1 / uninstall.ps1 补 UTF-8 BOM（Windows PowerShell 5.1 读中文必需）
#    2) 校验 install.ps1 的 $VERSION 与 installer.iss 的 MyAppVersion 一致
#    3) 铺 payload（复用 Tools\aemcp-pack.ps1 -NoZip 的构建门 + payload 铺设）
# =============================================================================
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

$Here  = Split-Path -Parent $MyInvocation.MyCommand.Path   # AEMCP-Installer\
$Root  = Split-Path -Parent $Here                          # 仓库根

function Step ($m) { Write-Host ('  [*] ' + $m) -ForegroundColor White }
function Ok   ($m) { Write-Host ('  [OK] ' + $m) -ForegroundColor Green }
function Bad  ($m) { Write-Host ('  [X] ' + $m) -ForegroundColor Red; exit 1 }

# ------------------------------------------------------------------ 1. BOM
Step '补 UTF-8 BOM（install.ps1 / uninstall.ps1）'
foreach ($n in @('install.ps1', 'uninstall.ps1')) {
    $p = Join-Path $Here $n
    if (-not (Test-Path -LiteralPath $p)) { Bad ('缺少 ' + $n) }
    $raw = [IO.File]::ReadAllBytes($p)
    $hasBom = ($raw.Length -ge 3 -and $raw[0] -eq 0xEF -and $raw[1] -eq 0xBB -and $raw[2] -eq 0xBF)
    if (-not $hasBom) {
        $txt = [Text.Encoding]::UTF8.GetString($raw)
        [IO.File]::WriteAllText($p, $txt, (New-Object System.Text.UTF8Encoding($true)))
        Ok ('已补 BOM：' + $n)
    } else {
        Ok ('已有 BOM：' + $n)
    }
}
# 硬门槛：补完必须真有 BOM
foreach ($n in @('install.ps1', 'uninstall.ps1')) {
    $p = Join-Path $Here $n
    $raw = [IO.File]::ReadAllBytes($p)
    if (-not ($raw.Length -ge 3 -and $raw[0] -eq 0xEF -and $raw[1] -eq 0xBB -and $raw[2] -eq 0xBF)) {
        Bad ($n + ' 仍无 BOM，中止（5.1 会按 GBK 解码中文导致语法错）')
    }
}

# ------------------------------------------------------------------ 2. 版本一致
Step '校验版本一致（install.ps1 $VERSION == installer.iss MyAppVersion）'
$iss = Join-Path $Here 'installer.iss'
$vPs = $null
$m = Select-String -Path (Join-Path $Here 'install.ps1') -Pattern "\`$VERSION\s+=\s+'([\d\.]+)'" | Select-Object -First 1
if ($m) { $vPs = $m.Matches[0].Groups[1].Value }
$vIss = $null
$m2 = Select-String -Path $iss -Pattern 'MyAppVersion\s+"([\d\.]+)"' | Select-Object -First 1
if ($m2) { $vIss = $m2.Matches[0].Groups[1].Value }
Write-Host ('      install.ps1=' + $vPs + '   installer.iss=' + $vIss) -ForegroundColor DarkGray
if (-not $vPs -or -not $vIss -or $vPs -ne $vIss) { Bad '版本不一致，先对齐再打包。' }
Ok ('版本一致：' + $vPs)

# ------------------------------------------------------------------ 3. 铺 payload
Step '铺 payload（构建门 + 复制扩展文件）'
& pwsh -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root 'Tools\aemcp-pack.ps1') -NoZip
if ($LASTEXITCODE -ne 0) { Bad '铺 payload 失败（见上方构建门输出）' }
Ok 'payload 已就绪'

Write-Host ''
Ok '准备完成。可以开始 ISCC 编译。'
