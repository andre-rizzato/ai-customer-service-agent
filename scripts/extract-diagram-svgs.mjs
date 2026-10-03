// One-off script: extracts the inline <svg> diagrams from the published
// HTML artifacts (docs/artifacts/*.html) into standalone .svg files, with
// every var(--token) resolved to its literal light-theme hex value - the
// artifacts' CSS custom properties only exist inside the full HTML page,
// and GitHub's image-embed pipeline strips <style>/CSS vars from SVGs
// served through its camo proxy, so a standalone file needs literal colors
// to render correctly everywhere (file view, README embeds, any viewer).
import { readFileSync, writeFileSync } from "node:fs";

const TOKENS = {
  "--bg": "#F3F6FA",
  "--surface": "#FFFFFF",
  "--surface-2": "#E7ECF3",
  "--ink": "#152138",
  "--ink-muted": "#58698A",
  "--accent": "#1C5FCC",
  "--accent-2": "#B5701E",
  "--good": "#2F8F62",
  "--warn": "#B4432E",
  "--border": "#C7D2E0",
  "--border-strong": "#9FB0C8",
};

function resolveVars(svg) {
  let out = svg;
  for (const [token, hex] of Object.entries(TOKENS)) {
    out = out.replaceAll(`var(${token})`, hex);
  }
  return out;
}

function extractSvgs(html) {
  const svgs = [];
  let idx = 0;
  while (true) {
    const start = html.indexOf("<svg", idx);
    if (start === -1) break;
    const end = html.indexOf("</svg>", start) + "</svg>".length;
    svgs.push(html.slice(start, end));
    idx = end;
  }
  return svgs;
}

function withWhiteBackground(svg) {
  // Inserts a background rect right after the opening <svg ...> tag,
  // sized from the viewBox, so the exported file never relies on the
  // viewer's own background (transparent SVG + dark GitHub theme would
  // make the dark-ink text unreadable).
  const viewBoxMatch = svg.match(/viewBox="0 0 (\d+) (\d+)"/);
  const [, w, h] = viewBoxMatch;
  const openTagEnd = svg.indexOf(">") + 1;
  const bgRect = `<rect x="0" y="0" width="${w}" height="${h}" fill="${TOKENS["--bg"]}" />`;
  return svg.slice(0, openTagEnd) + bgRect + svg.slice(openTagEnd);
}

function process(htmlPath, outPaths) {
  const html = readFileSync(htmlPath, "utf-8");
  const svgs = extractSvgs(html);
  if (svgs.length !== outPaths.length) {
    throw new Error(`${htmlPath}: expected ${outPaths.length} svg(s), found ${svgs.length}`);
  }
  svgs.forEach((svg, i) => {
    const resolved = withWhiteBackground(resolveVars(svg));
    writeFileSync(outPaths[i], resolved, "utf-8");
    console.log(`wrote ${outPaths[i]}`);
  });
}

process("docs/artifacts/blueprint-do-agente.html", ["docs/artifacts/images/blueprint-do-agente.svg"]);
process("docs/artifacts/mapa-capacidades.html", [
  "docs/artifacts/images/mapa-capacidades-camadas.svg",
  "docs/artifacts/images/mapa-capacidades-multi-tenant.svg",
]);
