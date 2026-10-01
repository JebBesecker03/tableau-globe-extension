@echo off
rem Rebuilds the experimental globe, copies both builds into docs\ (served by GitHub Pages)
rem and pushes. The stable build is copied as-is from globe-viz\dist; it is never rebuilt.
setlocal
cd /d "%~dp0"
set "PATH=C:\Program Files\Git\cmd;%PATH%"

echo Building experimental globe...
pushd globe-viz-experimental
call npm run build || (popd & echo Build failed. & pause & exit /b 1)
popd

robocopy globe-viz\dist docs\stable /MIR /NFL /NDL /NJH /NJS >nul
robocopy globe-viz-experimental\dist docs\experimental /MIR /NFL /NDL /NJH /NJS >nul

git add -A
git commit -m "Update hosted globe builds" || echo Nothing new to commit.
git push
echo.
echo Done. GitHub Pages updates about a minute after the push.
pause
