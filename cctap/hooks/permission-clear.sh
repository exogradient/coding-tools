#!/bin/bash
# cctap: clear permission gate file after tool execution completes
# stdin: JSON with session_id

GATE_DIR="$HOME/.cctap/gates"
[ -d "$GATE_DIR" ] || exit 0

SID=$(jq -r '.session_id // ""' 2>/dev/null) || exit 0
[ -n "$SID" ] && rm -f "$GATE_DIR/$SID.json"
