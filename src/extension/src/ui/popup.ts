import { mountPopup } from "./popup-view";
const root = document.querySelector<HTMLElement>("#popup-app");
if (root) {
  const view = mountPopup(root);
  window.addEventListener("pagehide", () => view.dispose(), { once: true });
}
