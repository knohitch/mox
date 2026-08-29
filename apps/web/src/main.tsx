import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./styles.css";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root missing");
createRoot(rootEl).render(<App />);

if (import.meta.env.DEV) {
  window.setTimeout(() => {
    const hasContent = rootEl.textContent?.trim() || rootEl.querySelector("[role='status'], [role='alert'], h1, main");
    if (hasContent) return;
    rootEl.innerHTML = [
      "<main class=\"main\">",
      "<div class=\"backend-error\" role=\"alert\" data-empty-root-diagnostic>",
      "<h1>Application root is empty</h1>",
      "<p>The route resolved, but no page landmark or state content rendered.</p>",
      "</div>",
      "</main>",
    ].join("");
  }, 1000);
}
