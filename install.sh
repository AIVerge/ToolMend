#!/usr/bin/env bash
# ToolMend one-click installer.
#
#   curl -fsSL https://raw.githubusercontent.com/AIVerge/ToolMend/main/install.sh | bash -s -- --upstream http://127.0.0.1:8080
#
# Installs ToolMend, registers it as a service (systemd on Linux, launchd on
# macOS), starts it, verifies health, and optionally repoints Claude Code at it.
# Safe to re-run: it upgrades in place and always backs up before editing.
set -euo pipefail

REPO_RAW="https://raw.githubusercontent.com/AIVerge/ToolMend/main"
UPSTREAM="${UPSTREAM:-}"
PORT="${PORT:-29090}"
HOST="${HOST:-127.0.0.1}"
WIRE_CLAUDE="ask"          # ask | yes | no
DO_UNINSTALL=0
CLAUDE_SETTINGS="${CLAUDE_SETTINGS:-$HOME/.claude/settings.json}"

c_red=$'\033[31m'; c_grn=$'\033[32m'; c_ylw=$'\033[33m'; c_dim=$'\033[2m'; c_off=$'\033[0m'
info() { printf '%s==>%s %s\n' "$c_grn" "$c_off" "$*"; }
warn() { printf '%s!! %s%s\n' "$c_ylw" "$*" "$c_off"; }
die()  { printf '%sxx %s%s\n' "$c_red" "$*" "$c_off" >&2; exit 1; }

usage() {
  cat <<EOF
ToolMend installer

Usage:
  install.sh --upstream URL [options]

Options:
  --upstream URL     Your LLM gateway / inference server (required)
                     e.g. http://127.0.0.1:8080
  --port N           Port ToolMend listens on          (default 29090)
  --host ADDR        Address ToolMend binds to         (default 127.0.0.1)
  --wire-claude      Repoint Claude Code at ToolMend without asking
  --no-wire-claude   Never touch Claude Code settings
  --uninstall        Stop, disable and remove ToolMend
  -h, --help         This message
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --upstream) UPSTREAM="${2:-}"; shift 2 ;;
    --port) PORT="${2:-}"; shift 2 ;;
    --host) HOST="${2:-}"; shift 2 ;;
    --wire-claude) WIRE_CLAUDE=yes; shift ;;
    --no-wire-claude) WIRE_CLAUDE=no; shift ;;
    --uninstall) DO_UNINSTALL=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1 (try --help)" ;;
  esac
done

OS="$(uname -s)"
if [ "$(id -u)" -eq 0 ]; then
  PREFIX=/opt/toolmend; SUDO=""
else
  PREFIX="$HOME/.local/share/toolmend"; SUDO="sudo"
fi
LOG_DIR="$([ "$(id -u)" -eq 0 ] && echo /var/log || echo "$PREFIX")"

# ---------------------------------------------------------------- uninstall --
if [ "$DO_UNINSTALL" -eq 1 ]; then
  info "Uninstalling ToolMend"
  case "$OS" in
    Linux)
      if command -v systemctl >/dev/null 2>&1; then
        $SUDO systemctl disable --now toolmend 2>/dev/null || true
        $SUDO rm -f /etc/systemd/system/toolmend.service
        $SUDO systemctl daemon-reload || true
      fi ;;
    Darwin)
      launchctl unload "$HOME/Library/LaunchAgents/com.aiverge.toolmend.plist" 2>/dev/null || true
      rm -f "$HOME/Library/LaunchAgents/com.aiverge.toolmend.plist" ;;
  esac
  rm -rf "$PREFIX"
  info "Removed. If you repointed Claude Code, restore ANTHROPIC_BASE_URL in $CLAUDE_SETTINGS"
  exit 0
fi

# ------------------------------------------------------------ preflight ------
[ -n "$UPSTREAM" ] || { usage; die "--upstream is required (where ToolMend should forward to)"; }
command -v node >/dev/null 2>&1 || die "Node.js not found. Install Node >= 18 first: https://nodejs.org"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || die "Node >= 18 required (found $(node -v))"
info "Node $(node -v) OK"

case "$UPSTREAM" in
  http://*|https://*) ;;
  *) die "--upstream must start with http:// or https:// (got: $UPSTREAM)" ;;
esac

if command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | grep -q ":$PORT "; then
  pgrep -f "toolmend" >/dev/null 2>&1 \
    && warn "port $PORT already used by an existing ToolMend — will upgrade it" \
    || die "port $PORT is already in use by something else; pick another with --port"
fi

# ------------------------------------------------------------- install -------
info "Installing to $PREFIX"
mkdir -p "$PREFIX/src" 2>/dev/null || $SUDO mkdir -p "$PREFIX/src"
WRITE() { if [ -w "$PREFIX" ]; then cat > "$1"; else $SUDO tee "$1" >/dev/null; fi; }

if [ -f "$(dirname "$0")/src/toolmend.js" ]; then
  info "Using local checkout"
  cat "$(dirname "$0")/src/toolmend.js" | WRITE "$PREFIX/src/toolmend.js"
else
  info "Downloading toolmend.js"
  curl -fsSL "$REPO_RAW/src/toolmend.js" | WRITE "$PREFIX/src/toolmend.js"
fi
[ -s "$PREFIX/src/toolmend.js" ] || die "download failed — $PREFIX/src/toolmend.js is empty"

info "Running self-test"
node "$PREFIX/src/toolmend.js" --selftest >/dev/null 2>&1 || die "self-test failed; refusing to install"
info "Self-test passed"

# ------------------------------------------------------------- service -------
NODE_BIN="$(command -v node)"
case "$OS" in
  Linux)
    command -v systemctl >/dev/null 2>&1 || die "systemd not found; run manually: node $PREFIX/src/toolmend.js"
    info "Registering systemd service"
    $SUDO tee /etc/systemd/system/toolmend.service >/dev/null <<EOF
[Unit]
Description=ToolMend - repair broken LLM tool calls
After=network.target

[Service]
Type=simple
ExecStart=$NODE_BIN $PREFIX/src/toolmend.js
Environment=LISTEN_HOST=$HOST
Environment=LISTEN_PORT=$PORT
Environment=UPSTREAM=$UPSTREAM
Environment=TOOLMEND_LOG=$LOG_DIR/toolmend.log
KillSignal=SIGTERM
TimeoutStopSec=310
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF
    $SUDO systemctl daemon-reload
    $SUDO systemctl enable toolmend >/dev/null 2>&1 || true
    $SUDO systemctl restart toolmend
    ;;
  Darwin)
    info "Registering launchd agent"
    PLIST="$HOME/Library/LaunchAgents/com.aiverge.toolmend.plist"
    mkdir -p "$(dirname "$PLIST")"
    cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.aiverge.toolmend</string>
  <key>ProgramArguments</key>
  <array><string>$NODE_BIN</string><string>$PREFIX/src/toolmend.js</string></array>
  <key>EnvironmentVariables</key><dict>
    <key>LISTEN_HOST</key><string>$HOST</string>
    <key>LISTEN_PORT</key><string>$PORT</string>
    <key>UPSTREAM</key><string>$UPSTREAM</string>
    <key>TOOLMEND_LOG</key><string>$PREFIX/toolmend.log</string>
  </dict>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
</dict></plist>
EOF
    launchctl unload "$PLIST" 2>/dev/null || true
    launchctl load "$PLIST"
    ;;
  *) die "unsupported OS: $OS — run manually: node $PREFIX/src/toolmend.js" ;;
esac

# -------------------------------------------------------------- verify -------
info "Waiting for ToolMend to come up"
HEALTH=""
for _ in 1 2 3 4 5 6 7 8 9 10; do
  HEALTH="$(curl -fsS --max-time 2 "http://$HOST:$PORT/healthz" 2>/dev/null || true)"
  [ -n "$HEALTH" ] && break
  sleep 0.5
done
[ -n "$HEALTH" ] || die "ToolMend did not become healthy. Check: journalctl -u toolmend -n 50"
info "Healthy: $HEALTH"

info "Checking upstream reachability"
if curl -fsS --max-time 5 -o /dev/null "$UPSTREAM" 2>/dev/null; then
  info "Upstream $UPSTREAM reachable"
else
  warn "Could not reach $UPSTREAM directly (may be normal if it requires auth or a specific path)"
fi

# --------------------------------------------------------- wire the client ---
BASE_URL="http://$HOST:$PORT"
if [ "$WIRE_CLAUDE" = "ask" ] && [ -t 0 ] && [ -f "$CLAUDE_SETTINGS" ]; then
  printf 'Point Claude Code at ToolMend (updates ANTHROPIC_BASE_URL in %s)? [y/N] ' "$CLAUDE_SETTINGS"
  read -r reply </dev/tty || reply=n
  case "$reply" in y|Y|yes) WIRE_CLAUDE=yes ;; *) WIRE_CLAUDE=no ;; esac
fi

if [ "$WIRE_CLAUDE" = "yes" ] && [ -f "$CLAUDE_SETTINGS" ]; then
  BACKUP="$CLAUDE_SETTINGS.bak.$(date +%s)"
  cp "$CLAUDE_SETTINGS" "$BACKUP"
  node -e '
    const fs=require("fs"), p=process.argv[1], url=process.argv[2];
    const d=JSON.parse(fs.readFileSync(p,"utf8"));
    d.env=d.env||{};
    const old=d.env.ANTHROPIC_BASE_URL||"(unset)";
    d.env.ANTHROPIC_BASE_URL=url;
    fs.writeFileSync(p, JSON.stringify(d,null,2)+"\n");
    console.log("   ANTHROPIC_BASE_URL: "+old+"  ->  "+url);
  ' "$CLAUDE_SETTINGS" "$BASE_URL"
  info "Updated $CLAUDE_SETTINGS (backup: $BACKUP)"
  warn "Restart Claude Code for it to take effect"
fi

# ---------------------------------------------------------------- summary ----
cat <<EOF

${c_grn}ToolMend is running.${c_off}

  Listening   ${BASE_URL}
  Upstream    ${UPSTREAM}
  Logs        ${LOG_DIR}/toolmend.log
  Health      curl ${BASE_URL}/healthz

${c_dim}If you did not let the installer wire it up, point your client at ToolMend:${c_off}
  export ANTHROPIC_BASE_URL=${BASE_URL}

${c_dim}Manage:${c_off}
EOF
if [ "$OS" = "Linux" ]; then
  cat <<EOF
  systemctl status toolmend
  journalctl -u toolmend -f
  systemctl restart toolmend        ${c_dim}# drains in-flight streams first${c_off}
EOF
else
  cat <<EOF
  launchctl list | grep toolmend
  tail -f $PREFIX/toolmend.log
EOF
fi
echo "  bash install.sh --uninstall"
echo
