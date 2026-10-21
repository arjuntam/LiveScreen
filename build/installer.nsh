; Never classify every executable under $INSTDIR as the running application.
; The native plugin matches the executable name and works without PowerShell.
!include "LogicLib.nsh"

!macro customCheckAppRunning
  Push $R0
  nsProcess::_FindProcess /NOUNLOAD "${APP_EXECUTABLE_FILENAME}"
  Pop $R0
  ${If} $R0 == 0
    MessageBox MB_OKCANCEL|MB_ICONINFORMATION "LiveScreen 正在运行。继续将关闭软件和大屏播放，再进行安装或卸载。" /SD IDOK IDOK +3
    SetErrorLevel 2
    Quit
    nsProcess::_CloseProcess /NOUNLOAD "${APP_EXECUTABLE_FILENAME}"
    Pop $R0
    Sleep 300
    nsProcess::_FindProcess /NOUNLOAD "${APP_EXECUTABLE_FILENAME}"
    Pop $R0
  ${EndIf}
  ${If} $R0 != 603
    MessageBox MB_OK|MB_ICONSTOP "无法确认 LiveScreen 已退出（检测码 $R0）。请关闭软件；如提示权限不足，请使用相同 Windows 账户以管理员身份运行。项目与素材不会被删除。" /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}
  Pop $R0
  !ifndef BUILD_UNINSTALLER
    !insertmacro livescreenRepairLegacyUninstaller
  !endif
!macroend

; 0.1.0/0.2.0 shipped an invalid cross-built uninstaller. Repair ONLY our known
; versions before electron-builder invokes the registered old uninstaller.
; Keep the original outside $INSTDIR; never touch the user's content directory.
!macro livescreenRepairLegacyUninstaller
  Push $R0
  Push $R1
  Push $R2
  Push $R3
  StrCpy $R3 $OUTDIR
  ReadRegStr $R0 SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "DisplayVersion"
  ${If} $R0 == "0.1.0"
  ${OrIf} $R0 == "0.2.0"
    ReadRegStr $R1 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" "InstallLocation"
    ${If} $R1 != ""
    ${AndIf} ${FileExists} "$R1\${UNINSTALL_FILENAME}"
    ${AndIf} ${FileExists} "$R1\${APP_EXECUTABLE_FILENAME}"
      InitPluginsDir
      SetOutPath $PLUGINSDIR
      File /oname=livescreen-repaired-uninstaller.exe "${UNINSTALLER_OUT_FILE}"
      StrCpy $R2 "$LOCALAPPDATA\LiveScreen\installer-backups\$R0"
      CreateDirectory $R2
      ClearErrors
      ${IfNot} ${FileExists} "$R2\${UNINSTALL_FILENAME}"
        CopyFiles /SILENT "$R1\${UNINSTALL_FILENAME}" "$R2\${UNINSTALL_FILENAME}"
      ${EndIf}
      ${IfNot} ${Errors}
        CopyFiles /SILENT "$PLUGINSDIR\livescreen-repaired-uninstaller.exe" "$R1\${UNINSTALL_FILENAME}"
      ${EndIf}
      ${If} ${Errors}
        MessageBox MB_OK|MB_ICONSTOP "无法备份或修复旧卸载器。请关闭所有旧安装/卸载窗口后重试，必要时以管理员身份运行。项目与素材未删除。" /SD IDOK
        SetErrorLevel 2
        Quit
      ${EndIf}
    ${EndIf}
  ${EndIf}
  SetOutPath $R3
  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0
!macroend
