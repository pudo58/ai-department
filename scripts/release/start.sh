#!/bin/sh
# Portable copy: data stays in this folder (.data), not in the home folder.
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Chưa có Node.js. Cài Node.js 24 trở lên từ https://nodejs.org rồi chạy lại."
  exit 1
fi
AIDEPT_HOME="$(pwd)" exec node app/cli.mjs "$@"
