/**
 * Entry point — the only job of this file is to start the server.
 * All behavior lives in app.ts; all config in config/env.ts.
 */
import { env } from "./config/env.js";
import { app } from "./app.js";

app.listen(env.PORT, () => {
  console.log(`✅ Inventory API running at http://localhost:${env.PORT}`);
  console.log(`   Health check: http://localhost:${env.PORT}/api/health`);
});
