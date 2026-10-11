import { defineConfig } from "vite";

export default defineConfig({
  resolve: { dedupe: ["three"] },
  optimizeDeps: {
    exclude: ["@urath/threejs"],
  },
  build: { rollupOptions: { output: { manualChunks: { three: ["three"] } } } },
});
