; Установщик NetLoom для Windows (NSIS 3, кодировка UTF-8).
; Ставит браузер для текущего пользователя — права администратора не нужны.
; Регистрирует NetLoom в Windows как браузер, чтобы его можно было выбрать браузером по умолчанию.
;
;   makensis -INPUTCHARSET UTF8 -DVERSION=1.0.0 -DSRCDIR=<папка NetLoom> -DBRANDING=<engine/branding> -DOUTFILE=<setup.exe> netloom.nsi

Unicode true
ManifestDPIAware true
SetCompressor /SOLID lzma
SetCompressorDictSize 64
RequestExecutionLevel user

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"

!define APPNAME "NetLoom"
!define EXE "netloom.exe"
!define SMI "Software\Clients\StartMenuInternet\NetLoom"
!define UNINST "Software\Microsoft\Windows\CurrentVersion\Uninstall\NetLoom"
!define DESCR "Приватный браузер со встроенным VPN и блокировкой рекламы"

Name "${APPNAME}"
Caption "Установка ${APPNAME} ${VERSION}"
UninstallCaption "Удаление ${APPNAME}"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\Programs\NetLoom"
InstallDirRegKey HKCU "Software\NetLoom" "InstallDir"
BrandingText "${APPNAME} ${VERSION}"
ShowInstDetails nevershow
ShowUninstDetails nevershow

VIProductVersion "${VERSION}.0"
VIAddVersionKey /LANG=1049 "ProductName" "${APPNAME}"
VIAddVersionKey /LANG=1049 "CompanyName" "${APPNAME}"
VIAddVersionKey /LANG=1049 "FileDescription" "Установка ${APPNAME}"
VIAddVersionKey /LANG=1049 "FileVersion" "${VERSION}"
VIAddVersionKey /LANG=1049 "ProductVersion" "${VERSION}"
VIAddVersionKey /LANG=1049 "LegalCopyright" "NetLoom. MPL 2.0"

!define MUI_ICON "${BRANDING}/firefox.ico"
!define MUI_UNICON "${BRANDING}/firefox.ico"
!define MUI_WELCOMEFINISHPAGE_BITMAP "${BRANDING}/wizWatermark.bmp"
!define MUI_UNWELCOMEFINISHPAGE_BITMAP "${BRANDING}/wizWatermark.bmp"
!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "Установка ${APPNAME}"
!define MUI_WELCOMEPAGE_TEXT "${DESCR}.$\r$\n$\r$\nБраузер установится только для вас, права администратора не нужны.$\r$\n$\r$\nНажмите «Далее», чтобы продолжить."
!define MUI_FINISHPAGE_RUN "$INSTDIR\${EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "Запустить ${APPNAME}"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "Russian"

Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "NetLoom работает только на 64-битной Windows."
    Abort
  ${EndIf}
FunctionEnd

; Не даём ставить поверх запущенного браузера: файлы будут заняты.
; Запущенную программу Windows не даёт открыть на запись — по этому и проверяем.
!macro WaitClosed
  ${If} ${FileExists} "$INSTDIR\${EXE}"
    nl_retry:
    ClearErrors
    FileOpen $0 "$INSTDIR\${EXE}" a
    ${If} ${Errors}
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "NetLoom сейчас открыт. Закройте все окна NetLoom и нажмите «Повтор»." IDRETRY nl_retry
      Quit
    ${EndIf}
    FileClose $0
  ${EndIf}
!macroend

Section "NetLoom" SecMain
  SectionIn RO
  SetShellVarContext current
  !insertmacro WaitClosed

  ; старые файлы движка убираем, чтобы после обновления не осталось лишнего
  RMDir /r "$INSTDIR\browser"
  RMDir /r "$INSTDIR\nlui"
  RMDir /r "$INSTDIR\cores"
  RMDir /r "$INSTDIR\defaults"
  RMDir /r "$INSTDIR\distribution"

  SetOutPath "$INSTDIR"
  File /r "${SRCDIR}/*"
  WriteUninstaller "$INSTDIR\uninstall.exe"

  ; ярлыки
  CreateShortcut "$SMPROGRAMS\${APPNAME}.lnk" "$INSTDIR\${EXE}" "" "$INSTDIR\${EXE}" 0
  CreateShortcut "$DESKTOP\${APPNAME}.lnk" "$INSTDIR\${EXE}" "" "$INSTDIR\${EXE}" 0

  WriteRegStr HKCU "Software\NetLoom" "InstallDir" "$INSTDIR"

  ; ── регистрация браузера в Windows (для выбора браузером по умолчанию) ──
  WriteRegStr HKCU "${SMI}" "" "${APPNAME}"
  WriteRegStr HKCU "${SMI}\DefaultIcon" "" "$INSTDIR\${EXE},0"
  WriteRegStr HKCU "${SMI}\shell\open\command" "" '"$INSTDIR\${EXE}"'
  WriteRegStr HKCU "${SMI}\Capabilities" "ApplicationName" "${APPNAME}"
  WriteRegStr HKCU "${SMI}\Capabilities" "ApplicationDescription" "${DESCR}"
  WriteRegStr HKCU "${SMI}\Capabilities" "ApplicationIcon" "$INSTDIR\${EXE},0"
  WriteRegStr HKCU "${SMI}\Capabilities\StartMenu" "StartMenuInternet" "${APPNAME}"
  !macro Assoc EXT
    WriteRegStr HKCU "${SMI}\Capabilities\FileAssociations" "${EXT}" "NetLoomHTML"
    WriteRegStr HKCU "Software\Classes\${EXT}\OpenWithProgids" "NetLoomHTML" ""
  !macroend
  !insertmacro Assoc ".htm"
  !insertmacro Assoc ".html"
  !insertmacro Assoc ".shtml"
  !insertmacro Assoc ".xht"
  !insertmacro Assoc ".xhtml"
  !insertmacro Assoc ".svg"
  !insertmacro Assoc ".webp"
  !insertmacro Assoc ".avif"
  !insertmacro Assoc ".pdf"
  WriteRegStr HKCU "${SMI}\Capabilities\URLAssociations" "http" "NetLoomURL"
  WriteRegStr HKCU "${SMI}\Capabilities\URLAssociations" "https" "NetLoomURL"
  WriteRegStr HKCU "Software\RegisteredApplications" "${APPNAME}" "${SMI}\Capabilities"

  !macro ProgID ID NAME
    WriteRegStr HKCU "Software\Classes\${ID}" "" "${NAME}"
    WriteRegStr HKCU "Software\Classes\${ID}" "FriendlyTypeName" "${NAME}"
    WriteRegStr HKCU "Software\Classes\${ID}\Application" "ApplicationName" "${APPNAME}"
    WriteRegStr HKCU "Software\Classes\${ID}\Application" "ApplicationIcon" "$INSTDIR\${EXE},0"
    WriteRegStr HKCU "Software\Classes\${ID}\DefaultIcon" "" "$INSTDIR\${EXE},1"
    WriteRegStr HKCU "Software\Classes\${ID}\shell\open\command" "" '"$INSTDIR\${EXE}" -osint -url "%1"'
  !macroend
  !insertmacro ProgID "NetLoomHTML" "Документ NetLoom"
  !insertmacro ProgID "NetLoomURL" "Ссылка NetLoom"
  WriteRegStr HKCU "Software\Classes\NetLoomURL" "URL Protocol" ""

  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\App Paths\${EXE}" "" "$INSTDIR\${EXE}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\App Paths\${EXE}" "Path" "$INSTDIR"

  ; ── «Программы и компоненты» ──
  WriteRegStr HKCU "${UNINST}" "DisplayName" "${APPNAME}"
  WriteRegStr HKCU "${UNINST}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINST}" "Publisher" "${APPNAME}"
  WriteRegStr HKCU "${UNINST}" "DisplayIcon" "$INSTDIR\${EXE},0"
  WriteRegStr HKCU "${UNINST}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINST}" "URLInfoAbout" "https://github.com/uproxe/NetLoom"
  WriteRegStr HKCU "${UNINST}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegStr HKCU "${UNINST}" "QuietUninstallString" '"$INSTDIR\uninstall.exe" /S'
  WriteRegDWORD HKCU "${UNINST}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST}" "NoRepair" 1

  ; сообщить Проводнику, что появились новые связи файлов
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
SectionEnd

Section "Uninstall"
  SetShellVarContext current
  !insertmacro WaitClosed

  Delete "$SMPROGRAMS\${APPNAME}.lnk"
  Delete "$DESKTOP\${APPNAME}.lnk"

  DeleteRegKey HKCU "${SMI}"
  DeleteRegValue HKCU "Software\RegisteredApplications" "${APPNAME}"
  DeleteRegKey HKCU "Software\Classes\NetLoomHTML"
  DeleteRegKey HKCU "Software\Classes\NetLoomURL"
  !macro UnAssoc EXT
    DeleteRegValue HKCU "Software\Classes\${EXT}\OpenWithProgids" "NetLoomHTML"
  !macroend
  !insertmacro UnAssoc ".htm"
  !insertmacro UnAssoc ".html"
  !insertmacro UnAssoc ".shtml"
  !insertmacro UnAssoc ".xht"
  !insertmacro UnAssoc ".xhtml"
  !insertmacro UnAssoc ".svg"
  !insertmacro UnAssoc ".webp"
  !insertmacro UnAssoc ".avif"
  !insertmacro UnAssoc ".pdf"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\App Paths\${EXE}"
  DeleteRegKey HKCU "${UNINST}"
  DeleteRegKey HKCU "Software\NetLoom"

  ; закладки, пароли и настройки остаются в профиле (%APPDATA%\NetLoom) — их не трогаем
  RMDir /r "$INSTDIR"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
SectionEnd
