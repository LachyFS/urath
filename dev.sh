#!/usr/bin/env bash
set -e

cd "$(dirname "$0")"

# Kill any running vite dev server
lsof -ti :5173 2>/dev/null | xargs kill 2>/dev/null || true

echo "Building WASM..."
cd crates/urath-wasm
wasm-pack build --target web --out-dir ../../packages/urath/wasm
cd ../..

echo "Starting dev server..."
cd examples/demo
npm run dev
