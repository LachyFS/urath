#!/usr/bin/env bash
set -e

cd "$(dirname "$0")"

npm run build
exec npm run dev
