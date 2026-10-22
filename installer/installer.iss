; ============================================================================
;  installer.iss — 「AE MCP 桥」单文件中文安装向导（Inno Setup 7）
;
;  产物：AEMCP-Setup.exe（双击即用，中文向导，自动检测本机全部 AE 版本，
;        勾选要装给哪些 AE，随后调用 install.ps1 完成实际安装）。
;
;  与 PrismDrift（AEGP .aex 装进 Plug-ins，需管理员、单选）不同：
;    AEMCP 是 CEP 扩展，装到用户级 %APPDATA%\Adobe\CEP\extensions\，
;    全版本共用一份；「装给哪些 AE」= 改写 manifest 的 Host 区间。
;    所以这里不需要管理员，且 AE 版本用多选（复选框）。
;
;  一键打包：build-setup.cmd（先铺 payload，再调 ISCC 出 exe）。
;
;  检测策略（四层，与 install.ps1 一致，任一命中即收录，按目录去重）：
;    1) App Paths：HKLM\...\App Paths\AfterFX.exe
;    2) Adobe 版本键：HKLM\SOFTWARE\Adobe\{After Effects,Adobe After Effects}\<版本>
;    3) 卸载键：DisplayName 含 "After Effects"
;    4) 文件系统：所有本地盘 × {Program Files, Program Files (x86), <盘>\Adobe}
;       向下两层找名字含 "After Effects" 的目录（兼容 D:\Program Files\AE2025\… 非标准安装）
; ============================================================================

#define MyAppName "AE MCP 桥"
#define MyAppVersion "1.3.0"
#define MyAppPublisher "DimensionID"
#define MyAppURL "https://t.me/DimensionID"

[Setup]
AppId={{A7C31D52-9B44-4E18-8C6F-2F5A0E8B3D91}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
DefaultDirName={localappdata}\AEMCP-Setup
DisableProgramGroupPage=yes
DisableDirPage=no
SetupIconFile=installer\aemcp.ico
OutputDir=.
OutputBaseFilename=AEMCP-Setup
Compression=lzma
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
UninstallDisplayName={#MyAppName}
UninstallDisplayIcon={app}\installer\aemcp.ico
VersionInfoVersion={#MyAppVersion}
VersionInfoDescription={#MyAppName} 安装程序
VersionInfoProductName={#MyAppName}
VersionInfoCompany={#MyAppPublisher}

[Languages]
Name: "chinesesimplified"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"

[Files]
Source: "payload\*"; DestDir: "{app}\payload"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "install.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "uninstall.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "README.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "安装.cmd"; DestDir: "{app}"; Flags: ignoreversion
Source: "卸载.cmd"; DestDir: "{app}"; Flags: ignoreversion
Source: "installer\aemcp.ico"; DestDir: "{app}\installer"; Flags: ignoreversion

[Run]
; 装扩展：调用随包的 install.ps1（-Quiet 不提问；勾选的版本经 GetSelectedVersions 传入）
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\install.ps1"" -PayloadDir ""{app}\payload"" -AeVersions {code:GetSelectedVersions} -Quiet"; \
  Flags: runhidden; StatusMsg: "正在把扩展装进 CEP 目录…"
; 安装完成页勾选项（默认勾选）：打开 Telegram 频道
Filename: "{#MyAppURL}"; Description: "关注频道 DimensionID（Telegram）✦"; Flags: shellexec nowait postinstall skipifsilent

[Code]
var
  AePage: TInputOptionWizardPage;
  AeRoots: array of string;    // AE 根目录（含 Support Files\AfterFX.exe）
  AeMajors: array of Integer;  // 主版本号（18 / 25 / 26 …）
  AeVers: array of string;     // 短版本串（18.0 / 25.6 …）
  Detected: Boolean;

// ---------------------------------------------------------------------------
function EndsWith(const S, Suffix: string): Boolean;
begin
  Result := False;
  if Length(S) < Length(Suffix) then
    Exit;
  Result := CompareText(Copy(S, Length(S) - Length(Suffix) + 1, Length(Suffix)), Suffix) = 0;
end;

// ---------------------------------------------------------------------------
//  归一化：给定任意候选路径（exe / Support Files / AE 根目录），
//  返回 AE 根目录（其下存在 Support Files\AfterFX.exe）；无效返回 ''
// ---------------------------------------------------------------------------
function NormalizeAeRoot(const P: string): string;
var
  S: string;
begin
  Result := '';
  S := Trim(P);
  if S = '' then
    Exit;
  if FileExists(S) then
    S := RemoveBackslashUnlessRoot(ExtractFilePath(S));   // AfterFX.exe → Support Files
  if EndsWith(S, '\Support Files') then
    S := Copy(S, 1, Length(S) - Length('\Support Files'));
  if FileExists(AddBackslash(S) + 'Support Files\AfterFX.exe') then
    Result := RemoveBackslashUnlessRoot(S);
end;

// ---------------------------------------------------------------------------
//  读 AfterFX.exe 的版本，返回主版本号（18 / 25 …）与短版本串（18.0）
// ---------------------------------------------------------------------------
procedure ReadExeVersion(const Root: string; var Major: Integer; var Short: string);
var
  ExePath, Ver: string;
  Dot, V: Integer;
begin
  Major := 0;
  Short := '';
  ExePath := AddBackslash(Root) + 'Support Files\AfterFX.exe';
  if not GetVersionNumbersString(ExePath, Ver) then
    Exit;
  Short := Ver;
  Dot := Pos('.', Ver);
  if Dot > 1 then
    V := StrToIntDef(Copy(Ver, 1, Dot - 1), 0)
  else
    V := StrToIntDef(Ver, 0);
  Major := V;
  // 短版本只保留前两段（18.0.0.39 → 18.0）
  Dot := Pos('.', Short);
  if Dot > 0 then
  begin
    V := Pos('.', Copy(Short, Dot + 1, MaxInt));
    if V > 0 then
      Short := Copy(Short, 1, Dot + V);
  end;
end;

// ---------------------------------------------------------------------------
//  收录一个候选（按根目录去重）
// ---------------------------------------------------------------------------
procedure AddCandidate(const Dir: string);
var
  Root: string;
  I, M: Integer;
  Vs: string;
begin
  Root := NormalizeAeRoot(Dir);
  if Root = '' then
    Exit;
  for I := 0 to GetArrayLength(AeRoots) - 1 do
    if CompareText(AeRoots[I], Root) = 0 then
      Exit;
  ReadExeVersion(Root, M, Vs);
  SetArrayLength(AeRoots, GetArrayLength(AeRoots) + 1);
  SetArrayLength(AeMajors, GetArrayLength(AeMajors) + 1);
  SetArrayLength(AeVers, GetArrayLength(AeVers) + 1);
  AeRoots[GetArrayLength(AeRoots) - 1] := Root;
  AeMajors[GetArrayLength(AeMajors) - 1] := M;
  AeVers[GetArrayLength(AeVers) - 1] := Vs;
end;

// 1) App Paths
procedure DetectAppPaths;
var
  ExePath: string;
begin
  if RegQueryStringValue(HKLM64, 'SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\AfterFX.exe', '', ExePath) then
    AddCandidate(ExtractFilePath(ExePath));
  if RegQueryStringValue(HKLM32, 'SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\AfterFX.exe', '', ExePath) then
    AddCandidate(ExtractFilePath(ExePath));
end;

// 2) Adobe 版本键（两套键名 + 三个常见值名）
procedure DetectAdobeVersionKeys;
var
  Bases: array of string;
  Subkeys: TArrayOfString;
  I, J: Integer;
  Key, Val, Dir: string;
begin
  SetArrayLength(Bases, 2);
  Bases[0] := 'SOFTWARE\Adobe\After Effects';
  Bases[1] := 'SOFTWARE\Adobe\Adobe After Effects';
  for I := 0 to 1 do
  begin
    if RegGetSubkeyNames(HKLM64, Bases[I], Subkeys) then
      for J := 0 to GetArrayLength(Subkeys) - 1 do
      begin
        Key := Bases[I] + '\' + Subkeys[J];
        Dir := '';
        if RegQueryStringValue(HKLM64, Key, 'InstallPath', Val) then Dir := Val;
        if Dir = '' then if RegQueryStringValue(HKLM64, Key, 'ApplicationPath', Val) then Dir := Val;
        if Dir = '' then if RegQueryStringValue(HKLM64, Key, 'InstallDirectory', Val) then Dir := Val;
        if Dir <> '' then
          AddCandidate(Dir);
      end;
  end;
end;

// 3) 卸载键
procedure DetectUninstall;
var
  Subkeys: TArrayOfString;
  I: Integer;
  Key, DisplayName, Loc, Icon, Dir: string;
begin
  if RegGetSubkeyNames(HKLM64, 'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall', Subkeys) then
    for I := 0 to GetArrayLength(Subkeys) - 1 do
    begin
      Key := 'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\' + Subkeys[I];
      if RegQueryStringValue(HKLM64, Key, 'DisplayName', DisplayName) then
        if Pos('After Effects', DisplayName) > 0 then
        begin
          Dir := '';
          if RegQueryStringValue(HKLM64, Key, 'InstallLocation', Loc) then Dir := Loc;
          if Dir = '' then
            if RegQueryStringValue(HKLM64, Key, 'DisplayIcon', Icon) then Dir := Icon;
          if Dir <> '' then
          begin
            if FileExists(Dir) then
              AddCandidate(ExtractFilePath(Dir))
            else
              AddCandidate(Dir);
          end;
        end;
    end;
end;

// 4) 文件系统：所有本地盘 × 常见根，向下两层找名字含 "After Effects" 的目录
procedure ScanDirLevels(const Base: string);
var
  FindRec: TFindRec;
  FindRec2: TFindRec;
  Sub: string;
begin
  if not DirExists(Base) then
    Exit;
  if FindFirst(Base + '\*', FindRec) then
  begin
    repeat
      if (FindRec.Attributes and $10 <> 0) and (FindRec.Name <> '.') and (FindRec.Name <> '..') then
      begin
        Sub := AddBackslash(Base) + FindRec.Name;
        if Pos('After Effects', FindRec.Name) > 0 then
          AddCandidate(Sub)
        else
        begin
          // 第二层：base\X\Y 中名字含 After Effects（兼容 AE2025\Adobe After Effects 2025）
          if DirExists(Sub) then
          begin
            if FindFirst(Sub + '\*', FindRec2) then
            begin
              repeat
                if (FindRec2.Attributes and $10 <> 0) and (FindRec2.Name <> '.') and (FindRec2.Name <> '..') then
                  if Pos('After Effects', FindRec2.Name) > 0 then
                    AddCandidate(AddBackslash(Sub) + FindRec2.Name);
              until not FindNext(FindRec2);
              FindClose(FindRec2);
            end;
          end;
        end;
      end;
    until not FindNext(FindRec);
    FindClose(FindRec);
  end;
end;

procedure DetectFilesystem;
var
  D: Integer;
  Drive: string;
begin
  for D := 67 to 90 do   // C..Z
  begin
    Drive := Chr(D) + ':\';
    if not DirExists(Drive) then
      Continue;
    ScanDirLevels(Drive + 'Program Files');
    ScanDirLevels(Drive + 'Program Files (x86)');
    ScanDirLevels(Drive + 'Adobe');
  end;
end;

procedure RunDetection;
begin
  if Detected then
    Exit;
  Detected := True;
  DetectAppPaths;
  DetectAdobeVersionKeys;
  DetectUninstall;
  DetectFilesystem;
end;

// ---------------------------------------------------------------------------
//  向导初始化：目录页之后插入「选择 AE 版本」多选页（复选框，可多选）
// ---------------------------------------------------------------------------
procedure InitializeWizard;
var
  I: Integer;
  Line: string;
begin
  RunDetection;
  AePage := CreateInputOptionPage(wpSelectDir,
    '检测到的 After Effects 版本',
    '扩展装在用户级 CEP 共享目录（所有 AE 版本共读一份），安装后本机全部 After Effects 都能加载。',
    '检测到以下版本（默认全选，勾选用于确认）：',
    False, True);
  for I := 0 to GetArrayLength(AeRoots) - 1 do
  begin
    Line := 'After Effects ' + AeVers[I] + '   [' + AeRoots[I] + ']';
    AePage.Add(Line);
  end;
  for I := 0 to GetArrayLength(AeRoots) - 1 do
    AePage.Values[I] := True;
end;

// ---------------------------------------------------------------------------
//  离开版本页时校验：至少勾一项
// ---------------------------------------------------------------------------
function NextButtonClick(CurPageID: Integer): Boolean;
var
  I, N: Integer;
begin
  Result := True;
  if Assigned(AePage) and (CurPageID = AePage.ID) then
  begin
    N := 0;
    for I := 0 to GetArrayLength(AeRoots) - 1 do
      if AePage.Values[I] then
        N := N + 1;
    if N = 0 then
    begin
      SuppressibleMsgBox('请至少勾选一个 After Effects 版本。', mbCriticalError, MB_OK, IDOK);
      Result := False;
    end;
  end;
end;

// ---------------------------------------------------------------------------
//  [Run] 参数：把勾选的主版本号拼成 "18,26"
// ---------------------------------------------------------------------------
function GetSelectedVersions(Param: string): string;
var
  I: Integer;
  S: string;
begin
  Result := 'all';
  if not Assigned(AePage) then
    Exit;
  S := '';
  for I := 0 to GetArrayLength(AeMajors) - 1 do
    if AePage.Values[I] and (AeMajors[I] > 0) then
    begin
      if S <> '' then
        S := S + ',';
      S := S + IntToStr(AeMajors[I]);
    end;
  if S = '' then
    S := 'all';
  Result := S;
end;

// ---------------------------------------------------------------------------
//  安装完成后校验扩展真的落地了
// ---------------------------------------------------------------------------
function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Mf: string;
begin
  if CurStep = ssDone then
  begin
    Mf := ExpandConstant('{userappdata}\Adobe\CEP\extensions\com.yg.aemcp\CSXS\manifest.xml');
    if FileExists(Mf) then
      SuppressibleMsgBox('安装完成！' #13#10 #13#10 +
             '扩展目录：' + ExpandConstant('{userappdata}\Adobe\CEP\extensions\com.yg.aemcp') + #13#10 +
             'Host 区间已按所选版本写入 manifest。' #13#10 #13#10 +
             '下一步：启动 AE → 菜单 窗口 > 扩展 > AE MCP 桥。' #13#10 +
             '面板一开，MCP 桥就在 127.0.0.1:47821 起服务。', mbInformation, MB_OK, IDOK)
    else
      SuppressibleMsgBox('扩展似乎没有装成功。' #13#10 #13#10 +
             '可以打开命令行手动执行：' + ExpandConstant('{app}') + '\install.ps1' + #13#10 +
             '或到频道 DimensionID 反馈。', mbCriticalError, MB_OK, IDOK);
  end;
end;

// ---------------------------------------------------------------------------
//  卸载：先跑 uninstall.ps1（此时文件还在），再由 Inno 删除 {app}
// ---------------------------------------------------------------------------
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Rc: Integer;
begin
  if CurUninstallStep = usUninstall then
    Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
      '-NoProfile -ExecutionPolicy Bypass -File "' + ExpandConstant('{app}\uninstall.ps1') + '" -Quiet',
      '', SW_HIDE, ewWaitUntilTerminated, Rc);
end;
