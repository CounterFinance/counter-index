# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  OpKit — justfile                                                            ║
# ║  Indexer framework for OPNET                                                 ║
# ╚══════════════════════════════════════════════════════════════════════════════╝

# ── Colours ───────────────────────────────────────────────────────────────────
export RED    := '\033[0;31m'
export GREEN  := '\033[0;32m'
export YELLOW := '\033[0;33m'
export BLUE   := '\033[0;34m'
export CYAN   := '\033[0;36m'
export BOLD   := '\033[1m'
export RESET  := '\033[0m'

# ── Default ───────────────────────────────────────────────────────────────────
default:
    @just --list

# ══════════════════════════════════════════════════════════════════════════════
# §1  Setup
# ══════════════════════════════════════════════════════════════════════════════

# Install dependencies
install:
    @echo "${BLUE}▶ Installing dependencies...${RESET}"
    npm install
    @echo "${GREEN}✔ Done${RESET}"

# ══════════════════════════════════════════════════════════════════════════════
# §2  Develop / Validate
# ══════════════════════════════════════════════════════════════════════════════

# Run all tests
test:
    @echo "${BLUE}▶ Running tests...${RESET}"
    npx vitest run
    @echo "${GREEN}✔ All tests passed${RESET}"

# Watch mode tests
test-watch:
    npx vitest

# TypeScript type check (no emit)
typecheck:
    @echo "${BLUE}▶ Type checking...${RESET}"
    npx tsc --noEmit
    @echo "${GREEN}✔ No type errors${RESET}"

# Run tests + typecheck
check: test typecheck

# ══════════════════════════════════════════════════════════════════════════════
# §3  Docker (full-stack — OpStream + OpKit-based indexer)
# ══════════════════════════════════════════════════════════════════════════════
#
# Run these from the Opnet-devs/ PARENT directory:
#   cd .. && just -f OpKit/justfile docker-up
#
# Or from OpKit/ using absolute context:
#   just docker-up

# Build the Docker images (context: Opnet-devs/ parent for local OpKit dep)
docker-build:
    @echo "${BLUE}▶ Building Docker images...${RESET}"
    docker compose build
    @echo "${GREEN}✔ Images built${RESET}"

# Start the full stack in background (OpStream + opkit-indexer)
docker-up:
    @echo "${BLUE}▶ Starting full stack (OpStream + opkit-indexer)...${RESET}"
    docker compose up -d
    @echo "${GREEN}✔ Running — 'just docker-logs' to follow output${RESET}"

# Start in foreground (logs visible, Ctrl+C to stop)
docker-fg:
    docker compose up

# Stop all containers (data preserved)
docker-down:
    @echo "${YELLOW}▶ Stopping containers...${RESET}"
    docker compose down

# Rebuild and redeploy after code changes
docker-redeploy: docker-build
    @echo "${YELLOW}▶ Redeploying...${RESET}"
    docker compose down
    docker compose up -d
    @echo "${GREEN}✔ Redeployed${RESET}"

# Stream logs from both services
docker-logs:
    docker compose logs -f

# Stream opstream logs only
docker-logs-stream:
    docker compose logs -f opstream

# Stream opkit-indexer logs only
docker-logs-indexer:
    docker compose logs -f opkit-indexer

# Show container status
docker-status:
    docker compose ps

# Open a shell inside the opkit-indexer container
docker-shell:
    docker compose exec opkit-indexer sh

# Remove images + volumes (does NOT delete host ./data)
docker-clean:
    #!/usr/bin/env bash
    echo "${RED}${BOLD}⚠  This removes Docker images and named volumes.${RESET}"
    read -r -p "Type 'yes' to confirm: " CONFIRM
    if [ "$CONFIRM" = "yes" ]; then
        docker compose down --rmi local --volumes
        echo "${GREEN}✔ Cleaned${RESET}"
    else
        echo "${YELLOW}Aborted${RESET}"
    fi

# ══════════════════════════════════════════════════════════════════════════════
# §4  Utilities
# ══════════════════════════════════════════════════════════════════════════════

# Check all prerequisites (node version, tsx, docker)
doctor:
    #!/usr/bin/env bash
    echo "${CYAN}${BOLD}OpKit Doctor${RESET}"
    echo ""

    # Node.js
    if command -v node >/dev/null 2>&1; then
        NODE_VER=$(node --version)
        MAJOR=$(echo "$NODE_VER" | cut -d. -f1 | tr -d 'v')
        if [ "$MAJOR" -ge 22 ]; then
            echo "  ${GREEN}✔${RESET}  node $NODE_VER"
        else
            echo "  ${RED}✘${RESET}  node $NODE_VER — need v22+ (node:sqlite built-in)"
        fi
    else
        echo "  ${RED}✘${RESET}  node — not found"
    fi

    # tsx
    if npx tsx --version >/dev/null 2>&1; then
        TSX_VER=$(npx tsx --version 2>/dev/null | head -1)
        echo "  ${GREEN}✔${RESET}  tsx $TSX_VER"
    else
        echo "  ${YELLOW}⚠${RESET}  tsx — run 'just install'"
    fi

    # vitest
    if npx vitest --version >/dev/null 2>&1; then
        echo "  ${GREEN}✔${RESET}  vitest $(npx vitest --version 2>/dev/null)"
    else
        echo "  ${YELLOW}⚠${RESET}  vitest — run 'just install'"
    fi

    # Docker
    if command -v docker >/dev/null 2>&1; then
        echo "  ${GREEN}✔${RESET}  docker $(docker --version | cut -d' ' -f3 | tr -d ',')"
    else
        echo "  ${YELLOW}⚠${RESET}  docker — not found (optional, for containerised deployment)"
    fi

    # node_modules
    if [ -d node_modules ]; then
        echo "  ${GREEN}✔${RESET}  node_modules present"
    else
        echo "  ${YELLOW}⚠${RESET}  node_modules missing — run 'just install'"
    fi

    echo ""
