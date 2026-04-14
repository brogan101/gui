@echo off
title Sovereign GUI Uploader
echo ======================================================
echo    Sovereign GUI - GitHub Upload Tool
echo ======================================================
echo.

:: Change directory to the folder where the bat file is located
cd /d %~dp0

echo [1/5] Initializing local Git repository...
git init

echo [2/5] Adding all GUI files...
git add .

echo [3/5] Creating initial commit...
git commit -m "Initial upload of Sovereign GUI assets"

echo [4/5] Linking to GitHub repository...
:: If a remote already exists, remove it first to avoid errors
git remote remove origin 2>nul
git remote add origin https://github.com/brogan101/gui.git

echo [5/5] Pushing files to GitHub...
git branch -M main
git push -u origin main

echo.
echo ======================================================
echo ✅ UPLOAD COMPLETE! 
echo Your GUI is now live at: https://github.com/brogan101/gui
echo =======================================================================================
pause
