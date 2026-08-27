import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import net from "node:net";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const rootPath = fileURLToPath(root);
const dependenciesInstalled = existsSync(
  new URL("node_modules/@modelcontextprotocol/sdk", root),
);

async function freePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  server.close();
  await once(server, "close");
  return port;
}

async function waitForHealth(url, child) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error("Server exited before health check");
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) return;
    } catch {
      // Server has not started listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for server health");
}

async function mcpPost(url, token, body, sessionId) {
  return await fetch(`${url}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function readMcpResponse(response) {
  const text = await response.text();
  if (response.headers.get("content-type")?.includes("application/json")) {
    return JSON.parse(text);
  }
  const dataLine = text
    .split("\n")
    .find((line) => line.startsWith("data:"));
  if (!dataLine) throw new Error(`No MCP data event in response: ${text}`);
  return JSON.parse(dataLine.slice(5).trim());
}

test(
  "server authenticates and exposes MCP tools",
  { skip: dependenciesInstalled ? false : "npm dependencies are not installed" },
  async (t) => {
    const port = await freePort();
    const token = "a".repeat(64);
    const url = `http://127.0.0.1:${port}`;
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("src/server.js", root))],
      {
        cwd: rootPath,
        env: {
          ...process.env,
          MCP_PORT: String(port),
          MCP_WORKSPACE: rootPath,
          MCP_AUTH_TOKEN: token,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    t.after(async () => {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await once(child, "close").catch(() => {});
      }
    });

    await waitForHealth(url, child);

    const unauthorized = await fetch(`${url}/mcp`, { method: "POST" });
    assert.equal(unauthorized.status, 401);

    const initialize = await mcpPost(url, token, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "integration-test", version: "1.0.0" },
      },
    });
    assert.equal(initialize.status, 200, stderr);
    const sessionId = initialize.headers.get("mcp-session-id");
    assert.ok(sessionId);
    const initializeBody = await readMcpResponse(initialize);
    assert.equal(initializeBody.result.serverInfo.name, "notionai-terminal-connect");

    const initialized = await mcpPost(
      url,
      token,
      { jsonrpc: "2.0", method: "notifications/initialized" },
      sessionId,
    );
    assert.ok([200, 202, 204].includes(initialized.status), stderr);

    const toolsResponse = await mcpPost(
      url,
      token,
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      sessionId,
    );
    assert.equal(toolsResponse.status, 200, stderr);
    const toolsBody = await readMcpResponse(toolsResponse);
    const names = toolsBody.result.tools.map((tool) => tool.name);
    assert.ok(names.includes("terminal_execute"));
    assert.ok(names.includes("read_file"));
    assert.ok(names.includes("process_start"));
  },
);
