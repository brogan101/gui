# Sovereign AI OS - Master Launcher
Write-Host "Starting Sovereign AI OS Backend..." -ForegroundColor Cyan
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd 'C:\Users\broga\Desktop\LOCAL AI\artifacts\api-server'; pnpm run dev"

Start-Sleep -Seconds 5

Write-Host "Starting Sovereign AI OS Frontend..." -ForegroundColor Green
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd 'C:\Users\broga\Desktop\LOCAL AI\artifacts\localai-control-center'; pnpm run dev"

Write-Host "System Launching... Open your browser to http://localhost:5173" -ForegroundColor Yellow
