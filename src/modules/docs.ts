import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Router } from "express";
import { parse } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const specPath = join(here, "../../openapi.yaml");

const yamlText = readFileSync(specPath, "utf8");
const spec = parse(yamlText) as Record<string, unknown>;
const specJson = JSON.stringify(spec).replace(/</g, "\\u003c");

export const docsRouter = Router();

docsRouter.get("/openapi.json", (_req, res) => res.json(spec));

docsRouter.get("/openapi.yaml", (_req, res) => {
  res.type("text/yaml").send(yamlText);
});

/**
 * Self-hosted Redoc viewer. The spec is inlined into the page (no fetch), and the
 * Redoc bundle is pulled from a CDN — allowed via a route-scoped CSP override
 * (the rest of the API keeps helmet's locked-down default).
 */
docsRouter.get("/", (req, res) => {
  const base = req.baseUrl || "/api/v1/docs";
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.redoc.ly https://cdn.jsdelivr.net; " +
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
      "font-src https://fonts.gstatic.com data:; img-src 'self' data: https:; worker-src blob:; connect-src 'self'",
  );
  res.type("html").send(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Forma API</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>body { margin: 0; padding: 0; }</style>
  </head>
  <body>
    <div id="redoc"></div>
    <script src="https://cdn.redoc.ly/redoc/latest/bundles/redoc.standalone.js"></script>
    <script>
      var spec = ${specJson};
      function render() {
        if (window.Redoc && window.Redoc.init) {
          Redoc.init(spec, { hideDownloadButton: false, expandResponses: "200,201" }, document.getElementById("redoc"));
        } else {
          setTimeout(render, 50);
        }
      }
      render();
    </script>
    <noscript>Enable JavaScript, or fetch the raw spec at <a href="${base}/openapi.json">${base}/openapi.json</a></noscript>
  </body>
</html>`);
});
