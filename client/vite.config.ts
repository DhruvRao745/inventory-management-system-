import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // Bind to all interfaces so a phone (or an ngrok tunnel) can reach the
    // dev server, not just localhost.
    host: true,
    // Vite 6 rejects requests from unknown hostnames; allow tunnel domains
    // (ngrok/localtunnel) so phone-over-HTTPS works in dev.
    allowedHosts: true,
    // Proxy: when the React app calls fetch("/api/..."), Vite forwards it
    // to the Express server on :5000. This avoids CORS pain in development
    // and means the frontend never hard-codes the API's address. Because
    // the tunnel points at Vite, /api is proxied to :5000 on THIS machine.
    proxy: {
      "/api": {
        target: "http://localhost:5000",
        changeOrigin: true,
      },
    },
  },
});
