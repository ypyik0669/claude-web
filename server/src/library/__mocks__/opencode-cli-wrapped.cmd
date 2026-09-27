@echo off
rem not unwrappable by resolveSpawn: forces the cmd.exe -> node -> grandchild tree
set "ENTRY=%~dp0opencode-cli.mjs"
node "%ENTRY%" %*
