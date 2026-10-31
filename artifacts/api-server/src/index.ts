import app from "./app";
import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "./lib/logger";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const artifactDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const pythonDir = path.join(artifactDir, "python");
const workspaceDir = path.resolve(artifactDir, "../..");
let pythonProcess: ChildProcess | null = null;

function allocateInternalPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") {
        probe.close();
        reject(new Error("Unable to allocate an internal API port"));
        return;
      }
      probe.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

function waitForPythonApi(apiPort: number, attempt = 0): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const retryOrReject = () => {
      if (settled) return;
      settled = true;
      if (attempt >= 59 || pythonProcess?.exitCode !== null) {
        reject(new Error("Python API did not become ready"));
        return;
      }
      setTimeout(() => {
        void waitForPythonApi(apiPort, attempt + 1).then(resolve, reject);
      }, 500);
    };
    const request = http.get(
      `http://127.0.0.1:${apiPort}/api/healthz`,
      (response) => {
        response.resume();
        if (response.statusCode === 200) {
          if (!settled) {
            settled = true;
            resolve();
          }
        } else {
          retryOrReject();
        }
      },
    );
    request.setTimeout(500);
    request.on("error", retryOrReject);
    request.on("timeout", () => {
      request.destroy();
      retryOrReject();
    });
  });
}

async function start() {
  const apiPort = await allocateInternalPort();
  process.env["PYTHON_API_PORT"] = String(apiPort);
  pythonProcess = spawn(
    "uv",
    [
      "run",
      "--project",
      workspaceDir,
      "python",
      "-m",
      "uvicorn",
      "main:app",
      "--host",
      "127.0.0.1",
      "--port",
      String(apiPort),
    ],
    {
      cwd: pythonDir,
      env: {
        ...process.env,
        UV_PROJECT_ENVIRONMENT: path.join(workspaceDir, ".pythonlibs"),
        PYTHONPATH: pythonDir,
        PYTHONUNBUFFERED: "1",
      },
      stdio: ["ignore", "inherit", "inherit"],
    },
  );

  pythonProcess.on("error", (error) => {
    logger.error({ errorType: error.name }, "Unable to start Python API");
  });
  await waitForPythonApi(apiPort);
  await new Promise<void>((resolve, reject) => {
    const server = app.listen(port, () => {
      logger.info({ port }, "API gateway listening");
      resolve();
    });
    server.on("error", reject);
  });
}

void start()
  .catch((error: Error) => {
    logger.error({ errorType: error.name }, "API service startup failed");
    pythonProcess?.kill("SIGTERM");
    process.exit(1);
  });

function stopPython() {
  if (pythonProcess && pythonProcess.exitCode === null) {
    pythonProcess.kill("SIGTERM");
  }
}

process.on("SIGTERM", stopPython);
process.on("SIGINT", stopPython);
