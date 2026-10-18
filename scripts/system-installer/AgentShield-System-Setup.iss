; =======================================================================
; AgentShield Setup (machine-wide): one setup for every browser on the PC
;
; 1. Installs AgentShield in Google Chrome, Microsoft Edge and Brave for every user of the PC through
;    browser enterprise policies (no "Load unpacked"; users cannot remove it).
; 2. Installs the AgentShield Windows app (AgentShieldHelper.exe), registered as the browsers' native
;    messaging host and as the handler of agentshield:// links.
; 3. At the end, "Connect this PC" opens the app: the person pastes ONE activation code from the portal
;    (or clicks "Connect this PC" in the portal) and every browser on the PC connects by itself.
; Installing grants no access by itself; the connection is per Windows user. No organization key is
; written; enrollmentCode/deviceKey values left by older versions are removed.
;
; Interactive:  AgentShield-System-Setup.exe
; Silent (GPO startup script / Intune / SCCM):
;   AgentShield-System-Setup.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SERVER=https://agentshield.company.com [/DASHBOARD=https://...] [/BLOCKDEVTOOLS] [/CODE=ASA1....]
; /SERVER is the backend base URL (apiUrl policy; used to find the extension package at /extension-updates/info).
; /DASHBOARD is the portal address. /CODE connects the installing user's PC right away (single-use code).
; A build for the public (individuals) bakes the addresses in, so nobody has to type them:
;   ISCC.exe /DDefaultServer=https://api.example.com /DDefaultDashboard=https://app.example.com scripts\system-installer\AgentShield-System-Setup.iss
; Uninstall: Settings > Apps > AgentShield, or "unins000.exe /VERYSILENT"
;
; Build: powershell -File scripts\helper\build-helper.ps1, then "ISCC.exe scripts\system-installer\AgentShield-System-Setup.iss"
; =======================================================================

#define MyAppName "AgentShield"
#define MyAppVersion "2.4.0"
#define MyAppPublisher "AgentShield"
#ifndef DefaultServer
  #define DefaultServer ""
#endif
#ifndef DefaultDashboard
  #define DefaultDashboard ""
#endif

[Setup]
AppId={{8E4C2B71-6F0D-4C9A-9B3E-2A51D7C4E913}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={autopf}\AgentShield
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableReadyPage=no
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=..\..\dist-installer
OutputBaseFilename=AgentShield-System-Setup
SetupIconFile=..\..\extension\icons\icon.ico
UninstallDisplayIcon={app}\icon.ico
UninstallDisplayName={#MyAppName} (browser protection)
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
CloseApplications=no
SetupLogging=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
Source: "Install-AgentShield.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\..\extension\icons\icon.ico"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\..\dist-installer\helper\AgentShieldHelper.exe"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{commonprograms}\Connect AgentShield"; Filename: "{app}\AgentShieldHelper.exe"; Parameters: "--connect-ui"; IconFilename: "{app}\icon.ico"; Comment: "Connect this PC's browsers to your AgentShield account"

[Registry]
; agentshield://connect?code=... links from the portal's "Connect this PC" button open the app (it asks before connecting)
Root: HKLM; Subkey: "Software\Classes\agentshield"; ValueType: string; ValueName: ""; ValueData: "URL:AgentShield"; Flags: uninsdeletekey
Root: HKLM; Subkey: "Software\Classes\agentshield"; ValueType: string; ValueName: "URL Protocol"; ValueData: ""
Root: HKLM; Subkey: "Software\Classes\agentshield\DefaultIcon"; ValueType: string; ValueName: ""; ValueData: "{app}\icon.ico"
Root: HKLM; Subkey: "Software\Classes\agentshield\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\AgentShieldHelper.exe"" ""%1"""

[Run]
Filename: "{app}\AgentShieldHelper.exe"; Parameters: "--connect-ui"; Description: "Connect this PC to my AgentShield account now"; \
  Flags: postinstall nowait skipifsilent runasoriginaluser

[UninstallRun]
Filename: "{app}\AgentShieldHelper.exe"; Parameters: "--disconnect"; Flags: runhidden waituntilterminated; RunOnceId: "DisconnectAgentShieldPc"
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\Install-AgentShield.ps1"" -Uninstall"; \
  Flags: runhidden waituntilterminated; RunOnceId: "RemoveAgentShieldPolicies"

[UninstallDelete]
Type: files; Name: "{app}\com.agentshield.helper.json"

[Code]
var
  ServerPage: TInputQueryWizardPage;
  OptionsPage: TInputOptionWizardPage;

function CommandLineValue(const Name: String): String;
var
  I: Integer;
  Prefix: String;
begin
  Result := '';
  Prefix := '/' + Uppercase(Name) + '=';
  for I := 1 to ParamCount do
    if Pos(Prefix, Uppercase(ParamStr(I))) = 1 then
      Result := Copy(ParamStr(I), Length(Prefix) + 1, MaxInt);
end;

function CommandLineFlag(const Name: String): Boolean;
var
  I: Integer;
begin
  Result := False;
  for I := 1 to ParamCount do
    if Uppercase(ParamStr(I)) = '/' + Uppercase(Name) then
      Result := True;
end;

function CleanUrl(const S: String): String;
begin
  Result := Trim(S);
  StringChangeEx(Result, '"', '', True);
  StringChangeEx(Result, ' ', '', True);
  while Copy(Result, Length(Result), 1) = '/' do
    Result := Copy(Result, 1, Length(Result) - 1);
end;

function IsWebAddress(const S: String): Boolean;
begin
  Result := ((Pos('https://', Lowercase(S)) = 1) and (Length(S) > 8)) or
            ((Pos('http://', Lowercase(S)) = 1) and (Length(S) > 7));
end;

// A public build has the addresses baked in (/DDefaultServer=...), so the person is never asked for them.
function BuiltInServer: Boolean;
begin
  Result := IsWebAddress('{#DefaultServer}');
end;

procedure InitializeWizard;
begin
  ServerPage := CreateInputQueryPage(wpWelcome,
    'Connect to your organization',
    'Enter the address of your AgentShield server.',
    'Copy it from the silent-install command in the AgentShield portal (the /SERVER= value). ' +
    'AgentShield will be installed in Chrome, Edge and Brave for every user of this computer. ' +
    'Each user then connects the PC once with a code from the portal.');
  ServerPage.Add('AgentShield server address (e.g. https://agentshield.company.com):', False);
  ServerPage.Add('Portal address (optional):', False);
  ServerPage.Values[0] := CommandLineValue('SERVER');
  ServerPage.Values[1] := CommandLineValue('DASHBOARD');
  if ServerPage.Values[0] = '' then ServerPage.Values[0] := '{#DefaultServer}';
  if ServerPage.Values[1] = '' then ServerPage.Values[1] := '{#DefaultDashboard}';

  OptionsPage := CreateInputOptionPage(ServerPage.ID,
    'Options', 'Optional hardening',
    'Developer tools let a technical user switch off in-page checks. Blocking them affects every user and website.',
    False, False);
  OptionsPage.Add('Block browser developer tools (recommended for non-technical staff)');
  OptionsPage.Values[0] := CommandLineFlag('BLOCKDEVTOOLS');
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  // Individuals get a build with the server built in: no address and no IT options to think about
  Result := BuiltInServer and (CommandLineValue('SERVER') = '') and ((PageID = ServerPage.ID) or (PageID = OptionsPage.ID));
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if CurPageID = ServerPage.ID then
  begin
    if not IsWebAddress(CleanUrl(ServerPage.Values[0])) then
    begin
      MsgBox('Enter the AgentShield server address, starting with https:// (the /SERVER= value from the portal).', mbError, MB_OK);
      Result := False;
    end
    else if (CleanUrl(ServerPage.Values[1]) <> '') and not IsWebAddress(CleanUrl(ServerPage.Values[1])) then
    begin
      MsgBox('The portal address must start with https:// (or leave it empty).', mbError, MB_OK);
      Result := False;
    end;
  end;
end;

// Applies the browser policies before files are copied, so a wrong address or an unreachable
// server stops setup with a clear message (and a non-zero exit code in silent mode).
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Server, Dashboard, Params, LogPath: String;
  ResultCode: Integer;
begin
  Result := '';
  Server := CleanUrl(ServerPage.Values[0]);
  Dashboard := CleanUrl(ServerPage.Values[1]);
  // The server address is needed to find the extension package (ID and update URL).
  if not IsWebAddress(Server) then
  begin
    Result := 'No valid server address. Run setup with /SERVER=https://your-agentshield-server or enter it in the wizard.';
    exit;
  end;
  if (Dashboard <> '') and not IsWebAddress(Dashboard) then
  begin
    Result := 'The /DASHBOARD address is not valid. It must start with https://';
    exit;
  end;

  ExtractTemporaryFile('Install-AgentShield.ps1');
  Params := '-NoProfile -ExecutionPolicy Bypass -File "' + ExpandConstant('{tmp}\Install-AgentShield.ps1') +
            '" -ServerUrl "' + Server + '" -HelperPath "' + ExpandConstant('{app}\AgentShieldHelper.exe') + '"';
  if Dashboard <> '' then
    Params := Params + ' -DashboardUrl "' + Dashboard + '"';
  if OptionsPage.Values[0] then
    Params := Params + ' -BlockDeveloperTools';

  if not Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'), Params, '', SW_HIDE,
              ewWaitUntilTerminated, ResultCode) then
  begin
    Result := 'Could not start PowerShell: ' + SysErrorMessage(ResultCode);
    exit;
  end;

  LogPath := ExpandConstant('{commonappdata}\AgentShield\install.log');
  if ResultCode <> 0 then
    Result := 'AgentShield could not be set up. Details: ' + LogPath + #13#10#13#10 +
              'Common causes: the server address is wrong, or this PC cannot reach the AgentShield server.';
end;

// Silent installs with /CODE=ASA1.... connect the installing user's PC right away.
procedure CurStepChanged(CurStep: TSetupStep);
var
  Code: String;
  ResultCode: Integer;
begin
  if CurStep = ssPostInstall then
  begin
    Code := Trim(CommandLineValue('CODE'));
    if Code <> '' then
    begin
      if not ExecAsOriginalUser(ExpandConstant('{app}\AgentShieldHelper.exe'), '--connect "' + Code + '"', '',
                                SW_HIDE, ewWaitUntilTerminated, ResultCode) or (ResultCode <> 0) then
        Log('Connecting this PC with /CODE failed (exit code ' + IntToStr(ResultCode) + '). The user can connect it from "Connect AgentShield".');
    end;
  end;
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if CurPageID = wpFinished then
    WizardForm.FinishedLabel.Caption :=
      'AgentShield is installed in Chrome, Edge and Brave on this computer.' + #13#10#13#10 +
      'Last step: connect this PC to your account once. Leave the box below ticked and click Finish, ' +
      'then paste the activation code from the AgentShield portal (Connect browser > Generate activation code), ' +
      'or click "Connect this PC" in the portal.' + #13#10#13#10 +
      'Every browser on this PC then connects by itself (restart the browsers if the AgentShield icon does not appear). ' +
      'Other Windows users of this PC connect from "Connect AgentShield" in the Start menu.';
end;
