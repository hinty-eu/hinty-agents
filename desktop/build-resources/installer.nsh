; Hinty Agents: what the uninstaller does before the files go.
;  - update (a newer installer runs this uninstaller first): stop the background service, which runs on the bundled
;    node.exe that is about to be replaced; `--for-update` leaves it marked as running, so the new version starts it.
;  - real uninstall (Windows Settings, Apps): the same as "Remove everything" in the window with "also delete my data":
;    every agent's hooks and the Claude Code plugin removed, the service stopped, this computer unpaired, the program
;    copy and the data folder (only what hinty-agents created in it) deleted, and the sign-in start entry removed.
!macro customUnInstall
  ${if} ${FileExists} "$INSTDIR\resources\node\node.exe"
    ${if} ${isUpdated}
      nsExec::Exec '"$INSTDIR\resources\node\node.exe" "$INSTDIR\resources\bridge\bin\hinty-agents.js" stop --for-update'
      Pop $0
    ${else}
      nsExec::Exec '"$INSTDIR\resources\node\node.exe" "$INSTDIR\resources\bridge\bin\hinty-agents.js" uninstall --all --purge'
      Pop $0
      DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Hinty Agents"
    ${endif}
  ${endif}
!macroend
