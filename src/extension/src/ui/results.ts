import { mountResults } from "./results-view";
const root = document.querySelector<HTMLElement>("#results-app");
if (root) {
  const view = mountResults(root);
  window.addEventListener("pagehide", () => view.dispose(), { once: true });
}
