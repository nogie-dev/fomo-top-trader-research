import { cp, mkdir, rm } from "node:fs/promises";
import { build } from "esbuild";

await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });
await cp("public", "dist", { recursive: true });

await build({
  entryPoints: {
    background: "src/background/main.ts",
    content: "src/content/main.ts",
    popup: "src/ui/popup.ts",
    results: "src/ui/results.ts",
  },
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "chrome120",
  outdir: "dist",
});
