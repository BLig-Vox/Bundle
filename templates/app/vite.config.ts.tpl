import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: { host: "127.0.0.1", port: Number(process.env.VITE_PORT ?? "5173"), strictPort: true,
    proxy: { "/api": { target: `http://127.0.0.1:${process.env.BUNDLE_PORT ?? "3000"}` } } },
  preview: { host: "127.0.0.1", port: 4173, strictPort: true },
});
