Unicode true
RequestExecutionLevel user
Name "Outpost"
Icon "${ICON}"
OutFile "${OUT}"
InstallDir "$LOCALAPPDATA\Programs\Outpost"
Page directory
Page instfiles
UninstPage uninstConfirm
UninstPage instfiles
Section
  SetOutPath "$INSTDIR"
  File /r "${APP}\*"
  WriteRegStr HKCU "Software\Classes\outpost" "" "URL:Outpost session"
  WriteRegStr HKCU "Software\Classes\outpost" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\outpost\shell\open\command" "" '"$INSTDIR\Outpost.exe" "%1"'
  CreateShortCut "$SMPROGRAMS\Outpost.lnk" "$INSTDIR\Outpost.exe"
  CreateShortCut "$DESKTOP\Outpost.lnk" "$INSTDIR\Outpost.exe"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Outpost" "DisplayName" "Outpost"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Outpost" "UninstallString" '"$INSTDIR\Uninstall.exe"'
SectionEnd
Section "Uninstall"
  DeleteRegKey HKCU "Software\Classes\outpost"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Outpost"
  Delete "$SMPROGRAMS\Outpost.lnk"
  Delete "$DESKTOP\Outpost.lnk"
  Delete "$INSTDIR\Outpost.exe"
  RMDir /r "$INSTDIR\resources"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
SectionEnd
