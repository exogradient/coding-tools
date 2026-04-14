#!/bin/bash
# cctap: write permission gate file on permission_prompt notification
# stdin: JSON with session_id, cwd, message, notification_type

set -euo pipefail

GATE_DIR="$HOME/.cctap/gates"
mkdir -p "$GATE_DIR"

INPUT=$(cat)

# Only process permission_prompt; extract session_id in one pass
SID=$(echo "$INPUT" | jq -r '
  if .notification_type == "permission_prompt" and (.session_id // "") != ""
  then .session_id else empty end
' 2>/dev/null) || exit 0

[[ -z "${SID:-}" ]] && exit 0

echo "$INPUT" | jq '{
  session_id: .session_id,
  cwd:        .cwd,
  message:    .message,
  title:      .title,
  timestamp:  (now * 1000 | floor)
}' > "$GATE_DIR/$SID.json"
