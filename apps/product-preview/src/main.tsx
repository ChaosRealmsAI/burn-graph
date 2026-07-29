import "@burn-graph/design-system/styles.css";
import React from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.tsx";
import "./preview.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root");

createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
