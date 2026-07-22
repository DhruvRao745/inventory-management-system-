/**
 * Frontend entry point — finds the #root div in index.html
 * and renders our React app into it.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { initTheme } from "./lib/theme";

initTheme(); // apply saved theme before anything renders — no flash

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
