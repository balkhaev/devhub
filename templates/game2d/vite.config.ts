import { defineConfig } from "vite";

export default defineConfig({
  build: {
    target: "es2022",
    rollupOptions: {
      output: {
        manualChunks: (id) => id.includes("node_modules/phaser") ? "phaser" : undefined,
      },
    },
  },
});
