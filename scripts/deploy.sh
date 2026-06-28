#!/usr/bin/env bash
# Deploy Soroban Identity contracts to Stellar network
set -euo pipefail

# Configuration
STELLAR_NETWORK="${STELLAR_NETWORK:-testnet}"
STELLAR_RPC_URL="${STELLAR_RPC_URL:-https://soroban-testnet.stellar.org}"
SOURCE_ACCOUNT="${STELLAR_SECRET_KEY:?Set STELLAR_SECRET_KEY}"

# Retry configuration with exponential backoff
MAX_RETRIES="${MAX_RETRIES:-3}"
RETRY_DELAY="${RETRY_DELAY:-2}"

# Retry function with exponential backoff
retry_command() {
  local max_attempts="$MAX_RETRIES"
  local delay="$RETRY_DELAY"
  local attempt=1

  while [ "$attempt" -le "$max_attempts" ]; do
    echo "Attempt $attempt/$max_attempts..."
    if "$@"; then
      return 0
    fi
    echo "Failed. Retrying in ${delay}s..."
    sleep "$delay"
    delay=$((delay * 2))
    attempt=$((attempt + 1))
  done

  echo "All attempts failed."
  return 1
}

# Print active network
echo "========================================"
echo "  Deployment Configuration"
echo "========================================"
echo "  Network:  $STELLAR_NETWORK"
echo "  RPC URL:  $STELLAR_RPC_URL"
echo "  Max Retries:  $MAX_RETRIES"
echo "  Initial Retry Delay:  ${RETRY_DELAY}s"
echo "========================================"
echo ""

echo "==> Building contracts..."
(cd contracts && cargo build --target wasm32-unknown-unknown --release)

REGISTRY_WASM="contracts/target/wasm32-unknown-unknown/release/identity_registry.wasm"
CREDENTIAL_WASM="contracts/target/wasm32-unknown-unknown/release/credential_manager.wasm"
REPUTATION_WASM="contracts/target/wasm32-unknown-unknown/release/reputation.wasm"

assert_contract_id() {
  local name="$1"
  local id="$2"
  local raw_output="$3"
  if ! echo "$id" | grep -qE '^[A-Z0-9]{56}$'; then
    echo "ERROR: $name deployment returned an invalid contract ID: '$id'"
    echo "Raw RPC output:"
    echo "$raw_output"
    exit 1
  fi
}

echo "==> Deploying identity-registry..."
REGISTRY_RAW=$(retry_command stellar contract deploy \
  --wasm "$REGISTRY_WASM" \
  --source "$SOURCE_ACCOUNT" \
  --network "$STELLAR_NETWORK" \
  --rpc-url "$STELLAR_RPC_URL" 2>&1)
REGISTRY_ID=$(echo "$REGISTRY_RAW" | tail -n1)
assert_contract_id "identity-registry" "$REGISTRY_ID" "$REGISTRY_RAW"
echo "identity-registry: $REGISTRY_ID"

echo "==> Deploying credential-manager..."
CREDENTIAL_RAW=$(retry_command stellar contract deploy \
  --wasm "$CREDENTIAL_WASM" \
  --source "$SOURCE_ACCOUNT" \
  --network "$STELLAR_NETWORK" \
  --rpc-url "$STELLAR_RPC_URL" 2>&1)
CREDENTIAL_ID=$(echo "$CREDENTIAL_RAW" | tail -n1)
assert_contract_id "credential-manager" "$CREDENTIAL_ID" "$CREDENTIAL_RAW"
echo "credential-manager: $CREDENTIAL_ID"

echo "==> Deploying reputation..."
REPUTATION_RAW=$(retry_command stellar contract deploy \
  --wasm "$REPUTATION_WASM" \
  --source "$SOURCE_ACCOUNT" \
  --network "$STELLAR_NETWORK" \
  --rpc-url "$STELLAR_RPC_URL" 2>&1)
REPUTATION_ID=$(echo "$REPUTATION_RAW" | tail -n1)
assert_contract_id "reputation" "$REPUTATION_ID" "$REPUTATION_RAW"
echo "reputation: $REPUTATION_ID"

echo "==> Initializing contracts..."
ADMIN_ADDRESS=$(stellar keys address "$SOURCE_ACCOUNT" --network "$STELLAR_NETWORK")

retry_command stellar contract invoke \
  --id "$REGISTRY_ID" \
  --source "$SOURCE_ACCOUNT" \
  --network "$STELLAR_NETWORK" \
  --rpc-url "$STELLAR_RPC_URL" \
  -- initialize --admin "$ADMIN_ADDRESS"

retry_command stellar contract invoke \
  --id "$CREDENTIAL_ID" \
  --source "$SOURCE_ACCOUNT" \
  --network "$STELLAR_NETWORK" \
  --rpc-url "$STELLAR_RPC_URL" \
  -- initialize --admin "$ADMIN_ADDRESS"

retry_command stellar contract invoke \
  --id "$REPUTATION_ID" \
  --source "$SOURCE_ACCOUNT" \
  --network "$STELLAR_NETWORK" \
  --rpc-url "$STELLAR_RPC_URL" \
  -- initialize --admin "$ADMIN_ADDRESS"

DEPLOYED_ENV="$(dirname "$0")/../deployed.env"
cat > "$DEPLOYED_ENV" <<EOF
IDENTITY_REGISTRY_ID=$REGISTRY_ID
CREDENTIAL_MANAGER_ID=$CREDENTIAL_ID
REPUTATION_ID=$REPUTATION_ID
EOF

echo ""
echo "========================================"
echo "  Deployment Summary"
echo "========================================"
echo "  Network:            $STELLAR_NETWORK"
echo "  RPC URL:            $STELLAR_RPC_URL"
echo "  identity-registry:  $REGISTRY_ID"
echo "  credential-manager: $CREDENTIAL_ID"
echo "  reputation:         $REPUTATION_ID"
echo "========================================"
echo ""
echo "Contract IDs written to deployed.env"
echo "Update sdk/src/index.ts with the IDs above."

POST_DEPLOY_HEALTH_CHECK="$(dirname "$0")/post_deploy_health_check.sh"
if [ -f "$POST_DEPLOY_HEALTH_CHECK" ]; then
  echo "==> Running post-deploy health check..."
  bash "$POST_DEPLOY_HEALTH_CHECK"
fi
