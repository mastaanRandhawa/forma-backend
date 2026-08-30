import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Router } from "express";
import { parse } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const specPath = join(here, "../../openapi.yaml");

const yamlText = readFileSync(specPath, "utf8");
const spec = parse(yamlText) as Record<string, unknown>;

export const docsRouter = Router();

docsRouter.get("/openapi.json", (_req, res) => res.json(spec));

docsRouter.get("/openapi.yaml", (_req, res) => {
  res.type("text/yaml").send(yamlText);
});

/** Self-hosted Redoc viewer. Redoc bundle is pulled from a CDN — allowed here
 *  via a route-scoped CSP override (the rest of the API stays locked down). */
docsRouter.get("/", (_req, res) => {
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.redoc.ly; " +
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
      "font-src https://fonts.gstatic.com; img-src 'self' data:; worker-src blob:; connect-src 'self'",
  );
  res.type("html").send(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Forma API</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
  </head>
  <body>
    <redoc spec-url="openapi.json"></redoc>
    <script src="https://cdn.redoc.ly/redoc/latest/bundles/redoc.standalone.js"></script>
  </body>
</html>`);
});
