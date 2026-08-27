import http from "node:http";
import path from "node:path";
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const VERSION = "0.1.0";
const HOST = process.env.MCP_HOST || "127.0.0.1";
const PORT = parseInteger(process.env.MCP_PORT, 8765, 1, 65535, "MCP_PORT");
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || "";
const SHELL = process.env.MCP_SHELL || "/bin/bash";
const DEFAULT_TIMEOUT_MS = parseInteger(
  process.env.MCP_COMMAND_TIMEOUT_MS,
  120_000,
  1_000,
  900_000,
  "MCP_COMMAND_TIMEOUT_MS",
);
const MAX_TIMEOUT_MS = parseInteger(
  process.env.MCP_MAX_COMMAND_TIMEOUT_MS,
  900_000,
  DEFAULT_TIMEOUT_MS,
  3_600_000,
  "MCP_MAX_COMMAND_TIMEOUT_MS",
);
const MAX_OUTPUT_BYTES = parseInteger(
  process.env.MCP_MAX_OUTPUT_BYTES,
  1_000_000,
  16_384,
  10_000_000,
  "MCP_MAX_OUTPUT_BYTES",
);
const MAX_FILE_BYTES = parseInteger(
  process.env.MCP_MAX_FILE_BYTES,
  5_000_000,
  16_384,
  50_000_000,
  "MCP_MAX_FILE_BYTES",
);
const MAX_BACKGROUND_PROCESSES = 8;

if (AUTH_TOKEN.length < 32) {
  console.error("MCP_AUTH_TOKEN must contain at least 32 characters.");
  process.exit(1);
}

const workspaceRequested = path.resolve(
  process.env.MCP_WORKSPACE || process.cwd(),
);
const workspaceStat = await fs.stat(workspaceRequested).catch(() => null);
if (!workspaceStat?.isDirectory()) {
  console.error(`MCP_WORKSPACE is not a directory: ${workspaceRequested}`);
  process.exit(1);
}
const WORKSPACE = await fs.realpath(workspaceRequested);

const sessions = new Map();
const managedProcesses = new Map();
let shuttingDown = false;

function parseInteger(raw, fallback, minimum, maximum, name) {
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function isWithinWorkspace(candidate) {
  const relative = path.relative(WORKSPACE, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

async function resolveWorkspacePath(
  requestedPath = ".",
  { mustExist = true, directory = false, writableTarget = false } = {},
) {
  if (typeof requestedPath !== "string" || requestedPath.includes("\0")) {
    throw new Error("Path must be a string without NUL bytes.");
  }

  const absolute = path.resolve(WORKSPACE, requestedPath);
  if (!isWithinWorkspace(absolute)) {
    throw new Error(`Path escapes the workspace: ${requestedPath}`);
  }

  let existing = absolute;
  while (true) {
    try {
      await fs.lstat(existing);
      break;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw error;
      existing = parent;
    }
  }

  const existingReal = await fs.realpath(existing);
  if (!isWithinWorkspace(existingReal)) {
    throw new Error(`Path resolves outside the workspace: ${requestedPath}`);
  }

  let resolved = absolute;
  if (mustExist) {
    resolved = await fs.realpath(absolute);
    if (!isWithinWorkspace(resolved)) {
      throw new Error(`Path resolves outside the workspace: ${requestedPath}`);
    }
  }

  const stat = await fs.stat(resolved).catch((error) => {
    if (!mustExist && error?.code === "ENOENT") return null;
    throw error;
  });
  if (mustExist && !stat) throw new Error(`Path does not exist: ${requestedPath}`);
  if (directory && stat && !stat.isDirectory()) {
    throw new Error(`Path is not a directory: ${requestedPath}`);
  }

  if (writableTarget) {
    const linkStat = await fs.lstat(absolute).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (linkStat?.isSymbolicLink()) {
      throw new Error("Writing through a symbolic link is not allowed.");
    }
  }

  return resolved;
}

function relativePath(absolute) {
  return path.relative(WORKSPACE, absolute) || ".";
}

function toolResult(value, isError = false) {
  return {
    content: [
      {
        type: "text",
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
    ...(isError ? { isError: true } : {}),
  };
}

function registerTool(server, name, config, handler) {
  server.registerTool(name, config, async (args) => {
    try {
      return toolResult(await handler(args));
    } catch (error) {
      return toolResult(
        {
          error: error instanceof Error ? error.message : String(error),
          tool: name,
        },
        true,
      );
    }
  });
}

class CappedOutput {
  constructor(limit = MAX_OUTPUT_BYTES) {
    this.limit = limit;
    this.chunks = [];
    this.bytes = 0;
    this.truncated = false;
  }

  append(chunk) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const remaining = this.limit - this.bytes;
    if (remaining <= 0) {
      this.truncated = true;
      return;
    }
    const accepted = buffer.subarray(0, remaining);
    this.chunks.push(accepted);
    this.bytes += accepted.length;
    if (accepted.length < buffer.length) this.truncated = true;
  }

  text() {
    return Buffer.concat(this.chunks, this.bytes).toString("utf8");
  }
}

function spawnShell(command, cwd) {
  return spawn(SHELL, ["-lc", command], {
    cwd,
    env: {
      ...process.env,
      PWD: cwd,
      NOTION_MCP_WORKSPACE: WORKSPACE,
    },
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function signalProcessGroup(child, signal) {
  if (!child?.pid) return;
  try {
    if (process.platform !== "win32") process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if (error?.code !== "ESRCH") {
      try {
        child.kill(signal);
      } catch {
        // The process already exited.
      }
    }
  }
}

async function executeCommand(command, cwd, timeoutMs) {
  return await new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const stdout = new CappedOutput();
    const stderr = new CappedOutput();
    let timedOut = false;
    let settled = false;
    let forceTimer;

    const child = spawnShell(command, cwd);
    child.stdout.on("data", (chunk) => stdout.append(chunk));
    child.stderr.on("data", (chunk) => stderr.append(chunk));
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(forceTimer);
      reject(error);
    });
    child.once("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(forceTimer);
      resolve({
        command,
        cwd: relativePath(cwd),
        exitCode,
        signal,
        timedOut,
        durationMs: Date.now() - startedAt,
        stdout: stdout.text(),
        stderr: stderr.text(),
        outputTruncated: stdout.truncated || stderr.truncated,
      });
    });

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      signalProcessGroup(child, "SIGTERM");
      forceTimer = setTimeout(() => signalProcessGroup(child, "SIGKILL"), 2_000);
      forceTimer.unref();
    }, timeoutMs);
    timeoutTimer.unref();
  });
}

function removeOldProcessRecords() {
  if (managedProcesses.size <= 20) return;
  const finished = [...managedProcesses.values()]
    .filter((entry) => !entry.running)
    .sort((a, b) => a.startedAt - b.startedAt);
  for (const entry of finished.slice(0, managedProcesses.size - 20)) {
    managedProcesses.delete(entry.id);
  }
}

function processSnapshot(entry) {
  return {
    processId: entry.id,
    command: entry.command,
    cwd: relativePath(entry.cwd),
    running: entry.running,
    pid: entry.child.pid,
    exitCode: entry.exitCode,
    signal: entry.signal,
    startedAt: new Date(entry.startedAt).toISOString(),
    durationMs: Date.now() - entry.startedAt,
    stdout: entry.stdout.text(),
    stderr: entry.stderr.text(),
    outputTruncated: entry.stdout.truncated || entry.stderr.truncated,
  };
}

function createMcpServer() {
  const server = new McpServer({
    name: "notionai-terminal-connect",
    version: VERSION,
  });

  registerTool(
    server,
    "workspace_info",
    {
      title: "Workspace information",
      description:
        "Show the selected workspace and command-execution security boundary.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => ({
      workspace: WORKSPACE,
      shell: SHELL,
      fileToolsConfinedToWorkspace: true,
      terminalCommandsSandboxed: false,
      warning:
        "Terminal commands run as the bridge user and can access anything that user can access.",
    }),
  );

  registerTool(
    server,
    "list_directory",
    {
      title: "List directory",
      description:
        "List files under a workspace directory. Symbolic links are reported but not followed.",
      inputSchema: {
        path: z.string().default("."),
        depth: z.number().int().min(1).max(5).default(2),
        maxEntries: z.number().int().min(1).max(2_000).default(500),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ path: requestedPath, depth, maxEntries }) => {
      const root = await resolveWorkspacePath(requestedPath, { directory: true });
      const entries = [];
      let truncated = false;

      async function walk(directoryPath, remainingDepth) {
        const children = await fs.readdir(directoryPath, { withFileTypes: true });
        children.sort((a, b) => a.name.localeCompare(b.name));

        for (const child of children) {
          if (entries.length >= maxEntries) {
            truncated = true;
            return;
          }
          const absolute = path.join(directoryPath, child.name);
          const item = {
            path: relativePath(absolute),
            type: child.isSymbolicLink()
              ? "symlink"
              : child.isDirectory()
                ? "directory"
                : child.isFile()
                  ? "file"
                  : "other",
          };
          if (child.isFile()) {
            const stat = await fs.stat(absolute);
            item.size = stat.size;
          }
          entries.push(item);

          if (child.isDirectory() && remainingDepth > 1) {
            await walk(absolute, remainingDepth - 1);
            if (truncated) return;
          }
        }
      }

      await walk(root, depth);
      return { directory: relativePath(root), entries, truncated };
    },
  );

  registerTool(
    server,
    "read_file",
    {
      title: "Read file",
      description: "Read a UTF-8 or base64 file chunk inside the workspace.",
      inputSchema: {
        path: z.string().min(1),
        offset: z.number().int().min(0).default(0),
        maxBytes: z
          .number()
          .int()
          .min(1)
          .max(MAX_FILE_BYTES)
          .default(Math.min(MAX_FILE_BYTES, 1_000_000)),
        encoding: z.enum(["utf8", "base64"]).default("utf8"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ path: requestedPath, offset, maxBytes, encoding }) => {
      const filePath = await resolveWorkspacePath(requestedPath);
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) throw new Error(`Not a regular file: ${requestedPath}`);

      const handle = await fs.open(filePath, "r");
      try {
        const length = Math.min(maxBytes, Math.max(0, stat.size - offset));
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, offset);
        return {
          path: relativePath(filePath),
          size: stat.size,
          offset,
          bytesRead,
          truncated: offset + bytesRead < stat.size,
          encoding,
          content: buffer.subarray(0, bytesRead).toString(encoding),
        };
      } finally {
        await handle.close();
      }
    },
  );

  registerTool(
    server,
    "write_file",
    {
      title: "Write file",
      description:
        "Create, overwrite, or append to a file inside the workspace. Writing through symlinks is rejected.",
      inputSchema: {
        path: z.string().min(1),
        content: z.string(),
        encoding: z.enum(["utf8", "base64"]).default("utf8"),
        mode: z.enum(["overwrite", "append", "create_new"]).default("overwrite"),
        createParents: z.boolean().default(true),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    async ({ path: requestedPath, content, encoding, mode, createParents }) => {
      const buffer = Buffer.from(content, encoding);
      if (buffer.length > MAX_FILE_BYTES) {
        throw new Error(`Content exceeds ${MAX_FILE_BYTES} bytes.`);
      }

      const filePath = await resolveWorkspacePath(requestedPath, {
        mustExist: false,
        writableTarget: true,
      });
      const parent = path.dirname(filePath);
      await resolveWorkspacePath(relativePath(parent), { mustExist: false });
      if (createParents) await fs.mkdir(parent, { recursive: true });
      await resolveWorkspacePath(relativePath(parent), { directory: true });

      const flag = mode === "append" ? "a" : mode === "create_new" ? "wx" : "w";
      await fs.writeFile(filePath, buffer, { flag });
      return {
        path: relativePath(filePath),
        bytesWritten: buffer.length,
        mode,
      };
    },
  );

  registerTool(
    server,
    "replace_in_file",
    {
      title: "Replace in file",
      description:
        "Replace exact text in a UTF-8 file, with an expected-match guard to avoid accidental edits.",
      inputSchema: {
        path: z.string().min(1),
        oldText: z.string().min(1),
        newText: z.string(),
        expectedMatches: z.number().int().min(1).default(1),
        replaceAll: z.boolean().default(false),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    async ({ path: requestedPath, oldText, newText, expectedMatches, replaceAll }) => {
      const filePath = await resolveWorkspacePath(requestedPath, {
        writableTarget: true,
      });
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) throw new Error(`Not a regular file: ${requestedPath}`);
      if (stat.size > MAX_FILE_BYTES) {
        throw new Error(`File exceeds ${MAX_FILE_BYTES} bytes.`);
      }

      const original = await fs.readFile(filePath, "utf8");
      const matches = original.split(oldText).length - 1;
      if (matches !== expectedMatches) {
        throw new Error(
          `Expected ${expectedMatches} match(es), but found ${matches}. File was not changed.`,
        );
      }
      const updated = replaceAll
        ? original.split(oldText).join(newText)
        : original.replace(oldText, newText);
      if (Buffer.byteLength(updated) > MAX_FILE_BYTES) {
        throw new Error(`Updated file exceeds ${MAX_FILE_BYTES} bytes.`);
      }
      await fs.writeFile(filePath, updated, "utf8");
      return {
        path: relativePath(filePath),
        replacements: replaceAll ? matches : 1,
        bytesWritten: Buffer.byteLength(updated),
      };
    },
  );

  registerTool(
    server,
    "make_directory",
    {
      title: "Make directory",
      description: "Create a directory and missing parents inside the workspace.",
      inputSchema: { path: z.string().min(1) },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async ({ path: requestedPath }) => {
      const directoryPath = await resolveWorkspacePath(requestedPath, {
        mustExist: false,
        writableTarget: true,
      });
      await fs.mkdir(directoryPath, { recursive: true });
      const verified = await resolveWorkspacePath(requestedPath, { directory: true });
      return { path: relativePath(verified), created: true };
    },
  );

  registerTool(
    server,
    "terminal_execute",
    {
      title: "Execute terminal command",
      description:
        "Run a shell command and wait for stdout, stderr, and the exit code. Commands run as the bridge user and are not sandboxed.",
      inputSchema: {
        command: z.string().min(1).max(20_000),
        cwd: z.string().default("."),
        timeoutMs: z
          .number()
          .int()
          .min(1_000)
          .max(MAX_TIMEOUT_MS)
          .default(DEFAULT_TIMEOUT_MS),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    async ({ command, cwd: requestedCwd, timeoutMs }) => {
      const cwd = await resolveWorkspacePath(requestedCwd, { directory: true });
      return await executeCommand(command, cwd, timeoutMs);
    },
  );

  registerTool(
    server,
    "process_start",
    {
      title: "Start background process",
      description:
        "Start a managed background shell command. Use process_status to read output and process_stop to terminate it.",
      inputSchema: {
        command: z.string().min(1).max(20_000),
        cwd: z.string().default("."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    async ({ command, cwd: requestedCwd }) => {
      const activeCount = [...managedProcesses.values()].filter(
        (entry) => entry.running,
      ).length;
      if (activeCount >= MAX_BACKGROUND_PROCESSES) {
        throw new Error(
          `At most ${MAX_BACKGROUND_PROCESSES} background processes may run at once.`,
        );
      }

      const cwd = await resolveWorkspacePath(requestedCwd, { directory: true });
      const child = spawnShell(command, cwd);
      const entry = {
        id: randomUUID(),
        command,
        cwd,
        child,
        startedAt: Date.now(),
        running: true,
        exitCode: null,
        signal: null,
        stdout: new CappedOutput(),
        stderr: new CappedOutput(),
      };
      managedProcesses.set(entry.id, entry);
      child.stdout.on("data", (chunk) => entry.stdout.append(chunk));
      child.stderr.on("data", (chunk) => entry.stderr.append(chunk));
      child.once("error", (error) => {
        entry.stderr.append(`\nFailed to start process: ${error.message}\n`);
        entry.running = false;
      });
      child.once("close", (exitCode, signal) => {
        entry.running = false;
        entry.exitCode = exitCode;
        entry.signal = signal;
        removeOldProcessRecords();
      });
      return processSnapshot(entry);
    },
  );

  registerTool(
    server,
    "process_status",
    {
      title: "Read background process",
      description: "Return current output and status for a managed process.",
      inputSchema: { processId: z.string().uuid() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ processId }) => {
      const entry = managedProcesses.get(processId);
      if (!entry) throw new Error(`Unknown process: ${processId}`);
      return processSnapshot(entry);
    },
  );

  registerTool(
    server,
    "process_list",
    {
      title: "List background processes",
      description: "List managed background process states without their output.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => ({
      processes: [...managedProcesses.values()].map((entry) => ({
        processId: entry.id,
        command: entry.command,
        cwd: relativePath(entry.cwd),
        running: entry.running,
        exitCode: entry.exitCode,
        signal: entry.signal,
        startedAt: new Date(entry.startedAt).toISOString(),
      })),
    }),
  );

  registerTool(
    server,
    "process_stop",
    {
      title: "Stop background process",
      description: "Terminate a managed process group.",
      inputSchema: { processId: z.string().uuid() },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    async ({ processId }) => {
      const entry = managedProcesses.get(processId);
      if (!entry) throw new Error(`Unknown process: ${processId}`);
      if (entry.running) {
        signalProcessGroup(entry.child, "SIGTERM");
        const forceTimer = setTimeout(() => {
          if (entry.running) signalProcessGroup(entry.child, "SIGKILL");
        }, 2_000);
        forceTimer.unref();
      }
      return { processId, stopRequested: entry.running };
    },
  );

  return server;
}

function isAuthorized(request) {
  const supplied = request.headers.authorization || "";
  const expected = `Bearer ${AUTH_TOKEN}`;
  const suppliedBuffer = Buffer.from(supplied);
  const expectedBuffer = Buffer.from(expected);
  return (
    suppliedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(suppliedBuffer, expectedBuffer)
  );
}

function applyCors(response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader(
    "Access-Control-Allow-Headers",
    "authorization, content-type, mcp-session-id, last-event-id",
  );
  response.setHeader(
    "Access-Control-Expose-Headers",
    "mcp-session-id, www-authenticate",
  );
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
}

function sendJson(response, statusCode, value) {
  if (response.headersSent) return;
  response.writeHead(statusCode, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
}

async function readJsonBody(request, limit = 2_000_000) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > limit) throw new Error("Request body is too large.");
    chunks.push(chunk);
  }
  if (bytes === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const httpServer = http.createServer(async (request, response) => {
  applyCors(response);

  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  const requestUrl = new URL(request.url || "/", "http:" + "//" + HOST + ":" + PORT);
  if (requestUrl.pathname === "/health") {
    sendJson(response, 200, { ok: true, version: VERSION });
    return;
  }
  if (requestUrl.pathname !== "/mcp") {
    sendJson(response, 404, { error: "Not found" });
    return;
  }
  if (!isAuthorized(request)) {
    response.setHeader("WWW-Authenticate", 'Bearer realm="notion-terminal-mcp"');
    sendJson(response, 401, { error: "Unauthorized" });
    return;
  }
  if (!["GET", "POST", "DELETE"].includes(request.method || "")) {
    sendJson(response, 405, { error: "Method not allowed" });
    return;
  }

  try {
    const sessionIdHeader = request.headers["mcp-session-id"];
    const sessionId = Array.isArray(sessionIdHeader)
      ? sessionIdHeader[0]
      : sessionIdHeader;
    let entry = sessionId ? sessions.get(sessionId) : undefined;
    let body;

    if (request.method === "POST") body = await readJsonBody(request);

    if (!entry && request.method === "POST" && isInitializeRequest(body)) {
      const mcpServer = createMcpServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newSessionId) => {
          sessions.set(newSessionId, { mcpServer, transport });
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };
      await mcpServer.connect(transport);
      entry = { mcpServer, transport };
    }

    if (!entry) {
      sendJson(response, 400, {
        error: "Missing or invalid MCP session. Send an initialize request first.",
      });
      return;
    }

    await entry.transport.handleRequest(request, response, body);
  } catch (error) {
    console.error("MCP request failed:", error);
    sendJson(response, 500, {
      error: error instanceof Error ? error.message : "Internal server error",
    });
  }
});

httpServer.on("clientError", (error, socket) => {
  console.error("HTTP client error:", error.message);
  socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
});

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\nStopping after ${signal}...`);

  for (const entry of managedProcesses.values()) {
    if (entry.running) signalProcessGroup(entry.child, "SIGTERM");
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
  for (const entry of managedProcesses.values()) {
    if (entry.running) signalProcessGroup(entry.child, "SIGKILL");
  }

  await Promise.allSettled(
    [...sessions.values()].map(async ({ mcpServer }) => {
      await mcpServer.close();
    }),
  );

  await new Promise((resolve) => httpServer.close(resolve));
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

httpServer.listen(PORT, HOST, () => {
  console.log(`Notion terminal MCP ${VERSION}`);
  console.log(`Workspace: ${WORKSPACE}`);
  console.log("Listening: " + "http:" + "//" + HOST + ":" + PORT + "/mcp");
});
