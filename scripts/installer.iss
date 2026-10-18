; =======================================================================
; AgentShield Enterprise Inno Setup Script
; Generates standard, signed-structure Windows installer (.exe)
; Installs without requiring Administrator elevation (PrivilegesRequired=lowest)
; =======================================================================

#define MyAppName "AgentShield AI Security"
#define MyAppVersion "1.2.0"
#define MyAppPublisher "AgentShield Enterprise"
#define MyAppURL "https://github.com/agentshield"
#define MyAppExeName "AgentShield AI Browser.bat"

[Setup]
AppId={{5A8C9E7B-2341-4B9F-83C1-90E95D628B10}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}
DefaultDirName={localappdata}\AgentShield
DisableDirPage=no
DisableProgramGroupPage=yes
DefaultGroupName={#MyAppName}
OutputDir=..\dist-installer
OutputBaseFilename=AgentShield-Setup
SetupIconFile=..\extension\icons\icon.ico
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
UninstallDisplayIcon={app}\extension\icons\icon.ico
UninstallDisplayName={#MyAppName}
ArchitecturesInstallIn64BitMode=x64compatible
CloseApplications=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"
Name: "startmenuicon"; Description: "Create Start Menu shortcut"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
; Copy all extension files except raw node_modules and ts source
Source: "..\extension\*"; DestDir: "{app}\extension"; Flags: recursesubdirs createallsubdirs ignoreversion; Excludes: "node_modules,node_modules\*,*.ts,tsconfig.json,package-lock.json,client-config.json,_metadata,_metadata\*,rules.json"
Source: "..\extension\icons\icon.ico"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{autodesktop}\Protected AI Browser (AgentShield)"; Filename: "{app}\{#MyAppExeName}"; IconFilename: "{app}\icon.ico"; Tasks: desktopicon
Name: "{autoprograms}\{#MyAppName}\Protected AI Browser"; Filename: "{app}\{#MyAppExeName}"; IconFilename: "{app}\icon.ico"; Tasks: startmenuicon
Name: "{autoprograms}\{#MyAppName}\Uninstall AgentShield"; Filename: "{uninstallexe}"

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "Open the Extensions page to finish setup"; Flags: nowait postinstall skipifsilent shellexec

[Code]
var
  ConfigPage: TInputQueryWizardPage;

function CleanServerUrl(const S: String): String;
begin
  Result := Trim(S);
  StringChangeEx(Result, '"', '', True);
  StringChangeEx(Result, ' ', '', True);
  while Copy(Result, Length(Result), 1) = '/' do
    Result := Copy(Result, 1, Length(Result) - 1);
end;

procedure InitializeWizard;
begin
  // Only the server address is configured here (optional). Access is granted per user: after
  // installing, each user pastes an activation code from the dashboard (My activation) in the popup.
  ConfigPage := CreateInputQueryPage(
    wpSelectDir,
    'Connect to your organization',
    'Enter the AgentShield server address from your IT team (optional).',
    'Leave it empty if you do not have one; the address then comes from your activation code. ' +
    'After installing, generate an activation code in the AgentShield dashboard (My activation), ' +
    'click the AgentShield icon, paste the code and click "Connect and verify".');

  ConfigPage.Add('AgentShield server address (e.g. https://agentshield.company.com):', False);

  // Silent installs: AgentShield-Setup.exe /VERYSILENT [/SERVER=https://agentshield.company.com]
  ConfigPage.Values[0] := ExpandConstant('{param:SERVER|}');
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  Url: String;
begin
  Result := True;
  if CurPageID = ConfigPage.ID then
  begin
    Url := Lowercase(CleanServerUrl(ConfigPage.Values[0]));
    if (Url <> '') and (Pos('https://', Url) <> 1) and (Pos('http://', Url) <> 1) then
    begin
      MsgBox('The server address must start with https:// (or leave it empty).', mbError, MB_OK);
      Result := False;
    end;
  end;
end;

function GetBrowserPath: String;
var
  ChromePath: String;
  EdgePath: String;
begin
  // Check Chrome 64-bit & 32-bit & LocalAppData
  ChromePath := ExpandConstant('{pf}\Google\Chrome\Application\chrome.exe');
  if not FileExists(ChromePath) then
    ChromePath := ExpandConstant('{pf32}\Google\Chrome\Application\chrome.exe');
  if not FileExists(ChromePath) then
    ChromePath := ExpandConstant('{localappdata}\Google\Chrome\Application\chrome.exe');

  // Check Edge
  EdgePath := ExpandConstant('{pf32}\Microsoft\Edge\Application\msedge.exe');
  if not FileExists(EdgePath) then
    EdgePath := ExpandConstant('{pf}\Microsoft\Edge\Application\msedge.exe');

  if FileExists(ChromePath) then
    Result := ChromePath
  else if FileExists(EdgePath) then
    Result := EdgePath
  else
    Result := 'chrome.exe';
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  AppDir: String;
  ExtDir: String;
  BatchFile: String;
  ConfigFile: String;
  BatchContent: String;
  ConfigContent: String;
  BrowserExe: String;
  ServerUrl: String;
begin
  if CurStep = ssPostInstall then
  begin
    AppDir := ExpandConstant('{app}');
    ExtDir := AppDir + '\extension';
    BatchFile := AppDir + '\{#MyAppExeName}';
    ConfigFile := ExtDir + '\client-config.json';

    ServerUrl := CleanServerUrl(ConfigPage.Values[0]);

    // 1. client-config.json holds only the server address (no key). Remove one left by an
    //    older version (it contained an enrollment code) and write a new one only if needed.
    DeleteFile(ConfigFile);
    if ServerUrl <> '' then
    begin
      ConfigContent := '{' + #13#10 +
        '  "apiUrl": "' + ServerUrl + '"' + #13#10 +
        '}';
      SaveStringToFile(ConfigFile, ConfigContent, False);
    end;

    // 2. Helper that opens the Extensions page and the folder for the one-time "Load unpacked"
    //    (recent Chrome versions ignore the --load-extension command-line flag)
    BrowserExe := GetBrowserPath;
    BatchContent := '@echo off' + #13#10 +
      'start "" "' + ExtDir + '"' + #13#10 +
      'start "" "' + BrowserExe + '" "chrome://extensions"' + #13#10 +
      'echo Turn on Developer mode, click Load unpacked, and select: ' + ExtDir + #13#10 +
      'echo Then generate an activation code in the dashboard (My activation^), click the AgentShield' + #13#10 +
      'echo icon, paste the code and click "Connect and verify". AI sites stay blocked until then.' + #13#10 +
      'pause' + #13#10;
    SaveStringToFile(BatchFile, BatchContent, False);
  end;
end;
