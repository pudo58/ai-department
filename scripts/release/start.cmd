@echo off
chcp 65001 >nul
rem Bản zip mang đi: dữ liệu nằm ngay trong thư mục này (.data), không ghi vào thư mục người dùng.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Chưa có Node.js. Cài Node.js 24 trở lên từ https://nodejs.org rồi chạy lại file này.
  pause
  exit /b 1
)
set "AIDEPT_HOME=%~dp0."
node app\cli.mjs %*
if errorlevel 1 pause
