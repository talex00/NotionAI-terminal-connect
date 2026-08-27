#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
RUNTIME_DIR="$SCRIPT_DIR/.runtime"
BIN_DIR="$RUNTIME_DIR/bin"
WORKSPACE="${MCP_WORKSPACE:-$PWD}"
PORT="${MCP_PORT:-}"
CLOUDFLARED_BIN="${CLOUDFLARED_BIN:-}"
SERVER_PID=""
TUNNEL_PID=""
RUN_DIR=""

usage() {
  cat <<'EOF'
Usage: ./start.sh [options] [workspace]

Options:
  -w, --workspace DIR    Directory exposed to file tools (default: current directory)
  -p, --port PORT        Local port (default: choose a free port)
      --cloudflared FILE Use a specific cloudflared binary
  -h, --help             Show this help

Environment variables:
  MCP_WORKSPACE, MCP_PORT, MCP_SHELL, MCP_COMMAND_TIMEOUT_MS,
  MCP_MAX_COMMAND_TIMEOUT_MS, MCP_MAX_OUTPUT_BYTES, MCP_MAX_FILE_BYTES,
  CLOUDFLARED_BIN
EOF
}

while (($#)); do
  case "$1" in
    -w|--workspace)
      [[ $# -ge 2 ]] || { echo "Missing value for $1" >&2; exit 2; }
      WORKSPACE="$2"
      shift 2
      ;;
    -p|--port)
      [[ $# -ge 2 ]] || { echo "Missing value for $1" >&2; exit 2; }
      PORT="$2"
      shift 2
      ;;
    --cloudflared)
      [[ $# -ge 2 ]] || { echo "Missing value for $1" >&2; exit 2; }
      CLOUDFLARED_BIN="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift
      break
      ;;
    -*)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
    *)
      WORKSPACE="$1"
      shift
      [[ $# -eq 0 ]] || { echo "Only one workspace may be provided." >&2; exit 2; }
      ;;
  esac
done

command -v node >/dev/null 2>&1 || {
  echo "Node.js 20 or newer is required." >&2
  exit 1
}
command -v npm >/dev/null 2>&1 || {
  echo "npm is required." >&2
  exit 1
}

NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
if ((NODE_MAJOR < 20)); then
  echo "Node.js 20 or newer is required; found $(node --version)." >&2
  exit 1
fi

if [[ ! -d "$WORKSPACE" ]]; then
  echo "Workspace is not a directory: $WORKSPACE" >&2
  exit 1
fi
WORKSPACE="$(cd -- "$WORKSPACE" && pwd -P)"

if [[ ${EUID:-$(id -u)} -eq 0 && "${MCP_ALLOW_ROOT:-0}" != "1" ]]; then
  cat >&2 <<'EOF'
Refusing to expose a root shell. Run this script as an unprivileged user.
If you are intentionally inside an isolated container, set MCP_ALLOW_ROOT=1.
EOF
  exit 1
fi

mkdir -p "$BIN_DIR"

install_cloudflared() {
  local machine arch url temp
  machine="$(uname -m)"
  case "$machine" in
    x86_64|amd64) arch="amd64" ;;
    aarch64|arm64) arch="arm64" ;;
    armv7l|armv6l) arch="arm" ;;
    *)
      echo "Unsupported Linux architecture: $machine" >&2
      echo "Install cloudflared manually and set CLOUDFLARED_BIN." >&2
      return 1
      ;;
  esac

  url="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$arch"
  temp="$BIN_DIR/cloudflared.download"
  echo "Downloading cloudflared for $machine..."
  if command -v curl >/dev/null 2>&1; then
    curl --fail --location --retry 3 --output "$temp" "$url"
  elif command -v wget >/dev/null 2>&1; then
    wget --tries=3 --output-document="$temp" "$url"
  else
    echo "curl or wget is required to download cloudflared." >&2
    return 1
  fi
  chmod 0755 "$temp"
  mv -f "$temp" "$BIN_DIR/cloudflared"
}

if [[ -n "$CLOUDFLARED_BIN" ]]; then
  [[ -x "$CLOUDFLARED_BIN" ]] || {
    echo "cloudflared is not executable: $CLOUDFLARED_BIN" >&2
    exit 1
  }
elif command -v cloudflared >/dev/null 2>&1; then
  CLOUDFLARED_BIN="$(command -v cloudflared)"
else
  CLOUDFLARED_BIN="$BIN_DIR/cloudflared"
  [[ -x "$CLOUDFLARED_BIN" ]] || install_cloudflared
fi

if [[ ! -d "$SCRIPT_DIR/node_modules/@modelcontextprotocol/sdk" || ! -d "$SCRIPT_DIR/node_modules/zod" ]]; then
  echo "Installing Node.js dependencies..."
  (cd "$SCRIPT_DIR" && npm install --omit=dev --no-audit --no-fund)
fi

if [[ -z "$PORT" ]]; then
  PORT="$(node -e 'const n=require("node:net");const s=n.createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
fi
if [[ ! "$PORT" =~ ^[0-9]+$ ]] || ((PORT < 1 || PORT > 65535)); then
  echo "Invalid port: $PORT" >&2
  exit 2
fi

RUN_DIR="$(mktemp -d "$RUNTIME_DIR/run.XXXXXX")"
SERVER_LOG="$RUN_DIR/server.log"
TUNNEL_LOG="$RUN_DIR/tunnel.log"
TOKEN="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
LOCAL_URL="http://127.0.0.1:$PORT"

cleanup() {
  local pid
  trap - EXIT INT TERM HUP
  for pid in "$TUNNEL_PID" "$SERVER_PID"; do
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      kill -TERM "$pid" 2>/dev/null || true
    fi
  done
  sleep 0.3
  for pid in "$TUNNEL_PID" "$SERVER_PID"; do
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      kill -KILL "$pid" 2>/dev/null || true
    fi
    if [[ -n "$pid" ]]; then
      wait "$pid" 2>/dev/null || true
    fi
  done
  [[ -z "$RUN_DIR" ]] || rm -rf -- "$RUN_DIR"
  echo "Bridge stopped. The temporary URL and token are no longer usable."
}

on_signal() {
  exit 130
}

trap cleanup EXIT
trap on_signal INT TERM HUP

MCP_AUTH_TOKEN="$TOKEN" \
MCP_WORKSPACE="$WORKSPACE" \
MCP_PORT="$PORT" \
node "$SCRIPT_DIR/src/server.js" >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!

SERVER_READY=0
for _ in $(seq 1 100); do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "MCP server failed to start:" >&2
    cat "$SERVER_LOG" >&2
    exit 1
  fi
  if node -e 'fetch(process.argv[1]).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))' "$LOCAL_URL/health"; then
    SERVER_READY=1
    break
  fi
  sleep 0.1
done
if [[ "$SERVER_READY" != "1" ]]; then
  echo "Timed out waiting for the MCP server." >&2
  cat "$SERVER_LOG" >&2
  exit 1
fi

"$CLOUDFLARED_BIN" tunnel \
  --config /dev/null \
  --url "$LOCAL_URL" \
  --protocol http2 \
  --no-autoupdate >"$TUNNEL_LOG" 2>&1 &
TUNNEL_PID=$!

PUBLIC_URL=""
for _ in $(seq 1 300); do
  if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
    echo "cloudflared failed to start:" >&2
    cat "$TUNNEL_LOG" >&2
    exit 1
  fi
  PUBLIC_URL="$(grep -Eo 'https://[-a-zA-Z0-9]+\.trycloudflare\.com' "$TUNNEL_LOG" | head -n 1 || true)"
  [[ -z "$PUBLIC_URL" ]] || break
  sleep 0.1
done
if [[ -z "$PUBLIC_URL" ]]; then
  echo "Timed out waiting for the public tunnel URL." >&2
  cat "$TUNNEL_LOG" >&2
  exit 1
fi

cat <<EOF

============================================================
 Notion AI terminal bridge is ready
============================================================
 Workspace:      $WORKSPACE
 MCP Server URL: $PUBLIC_URL/mcp
 Authentication: Bearer token
 Token:          $TOKEN
============================================================

Keep this terminal open. Press Ctrl+C to stop the server,
terminate managed processes, and invalidate this connection.

WARNING: terminal commands run with your local user permissions.
EOF

while true; do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "MCP server stopped unexpectedly:" >&2
    cat "$SERVER_LOG" >&2
    exit 1
  fi
  if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
    echo "Public tunnel stopped unexpectedly:" >&2
    cat "$TUNNEL_LOG" >&2
    exit 1
  fi
  sleep 1
done
