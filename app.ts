import express, { type Express } from "express";
import http from "node:http";
import pinoHttp from "pino-http";
import { logger } from "./lib/logger";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(express.json());

app.use((req, res) => {
  const upstreamPort = Number(process.env["PYTHON_API_PORT"]);
  if (!Number.isFinite(upstreamPort) || upstreamPort <= 0) {
    res.status(503).json({ detail: "The API service is unavailable." });
    return;
  }

  const body =
    req.body === undefined
      ? undefined
      : Buffer.from(JSON.stringify(req.body), "utf8");
  const headers: http.OutgoingHttpHeaders = {
    "x-forwarded-proto": req.get("x-forwarded-proto") ?? "http",
  };
  const cookie = req.get("cookie");
  const contentType = req.get("content-type");
  const userAgent = req.get("user-agent");
  if (cookie) headers.cookie = cookie;
  if (contentType) headers["content-type"] = contentType;
  if (userAgent) headers["user-agent"] = userAgent;
  if (body) headers["content-length"] = body.length;

  const upstream = http.request(
    {
      hostname: "127.0.0.1",
      port: upstreamPort,
      path: req.originalUrl,
      method: req.method,
      headers,
    },
    (upstreamResponse) => {
      res.status(upstreamResponse.statusCode ?? 502);
      for (const name of ["content-type", "cache-control", "set-cookie"]) {
        const value = upstreamResponse.headers[name];
        if (value) res.setHeader(name, value);
      }
      upstreamResponse.pipe(res);
    },
  );

  upstream.setTimeout(180_000, () => {
    upstream.destroy(new Error("Upstream request timed out"));
  });
  upstream.on("error", (error: NodeJS.ErrnoException) => {
    logger.warn({ errorType: error.name }, "Python API upstream unavailable");
    if (!res.headersSent) {
      res.status(503).json({ detail: "The API service is temporarily unavailable." });
    } else {
      res.end();
    }
  });
  if (body) upstream.write(body);
  upstream.end();
});

export default app;
