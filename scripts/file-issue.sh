#!/usr/bin/env bash
# Creates a fully-conformant GitHub issue: type-labeled, on the project board, linked to a parent.
#
# Usage:
#   ./scripts/file-issue.sh --title TITLE --body BODY --label TYPE --parent N \
#     [--extra-label LABEL]... [--dry-run]
#
# TYPE must be one of: epic  feature  user-story  task
# PARENT is the parent issue number (required — no orphan issues).
# --dry-run validates inputs and prints what would happen without making any API calls.

set -euo pipefail

REPO="Nossimonov/Mjolnirsoft"
PROJECT_ID="PVT_kwHOEIjUTs4BVVi-"
VALID_TYPES=(epic feature user-story task)

title=""
body=""
label=""
parent=""
extra_labels=()
dry_run=false

usage() {
  cat >&2 <<'EOF'
Usage: file-issue.sh --title TITLE --body BODY --label TYPE --parent N [options]

Required:
  --title TITLE          Issue title
  --body BODY            Issue body text
  --label TYPE           Type label: epic | feature | user-story | task
  --parent N             Parent issue number (no orphan issues allowed)

Optional:
  --extra-label LABEL    Additional label (e.g. in-flight-bug, blocked); repeatable
  --dry-run              Print what would happen without creating anything
  -h, --help             Show this help
EOF
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --title)        title="$2";           shift 2 ;;
    --body)         body="$2";            shift 2 ;;
    --label)        label="$2";           shift 2 ;;
    --parent)       parent="$2";          shift 2 ;;
    --extra-label)  extra_labels+=("$2"); shift 2 ;;
    --dry-run)      dry_run=true;         shift   ;;
    -h|--help)      usage ;;
    *)              echo "ERROR: Unknown argument: $1" >&2; usage ;;
  esac
done

# --- Guardrails (all checked before any API call) ---
errors=0

if [[ -z "$title" ]]; then
  echo "ERROR: --title is required." >&2
  errors=$((errors + 1))
fi

if [[ -z "$body" ]]; then
  echo "ERROR: --body is required." >&2
  errors=$((errors + 1))
fi

if [[ -z "$label" ]]; then
  echo "ERROR: --label is required. Must be one of: ${VALID_TYPES[*]}" >&2
  errors=$((errors + 1))
else
  valid=0
  for t in "${VALID_TYPES[@]}"; do
    [[ "$label" == "$t" ]] && valid=1 && break
  done
  if [[ $valid -eq 0 ]]; then
    echo "ERROR: '$label' is not a valid type label. Must be one of: ${VALID_TYPES[*]}" >&2
    errors=$((errors + 1))
  fi
fi

if [[ -z "$parent" ]]; then
  echo "ERROR: --parent is required (parent issue number). No orphan issues." >&2
  errors=$((errors + 1))
elif ! [[ "$parent" =~ ^[0-9]+$ ]]; then
  echo "ERROR: --parent must be a positive integer (issue number), got: '$parent'" >&2
  errors=$((errors + 1))
fi

if [[ $errors -gt 0 ]]; then
  exit 1
fi

# --- Dry-run: print intent and exit ---
if $dry_run; then
  echo "[dry-run] Would create issue on $REPO:"
  echo "  title:        $title"
  echo "  label:        $label"
  echo "  parent:       #$parent"
  if [[ ${#extra_labels[@]} -gt 0 ]]; then
    echo "  extra labels: ${extra_labels[*]}"
  fi
  echo "  body (first line): $(echo "$body" | head -1)"
  echo "[dry-run] Would add to project board: $PROJECT_ID"
  echo "[dry-run] Would link as sub-issue of #$parent"
  exit 0
fi

# --- Step 1: Create the issue ---
echo "Creating issue..."

label_args=(--label "$label")
for el in "${extra_labels[@]}"; do
  label_args+=(--label "$el")
done

issue_url=$(gh issue create --repo "$REPO" \
  --title "$title" --body "$body" "${label_args[@]}")

NUMBER=$(echo "$issue_url" | grep -oE '[0-9]+$')
if [[ -z "$NUMBER" ]]; then
  echo "ERROR: Could not extract issue number from URL: $issue_url" >&2
  exit 1
fi
echo "Created issue #$NUMBER ($issue_url)"

# --- Step 2: Add to project board ---
echo "Adding #$NUMBER to project board..."

NODE_ID=$(gh api graphql \
  -f query="{ repository(owner:\"Nossimonov\",name:\"Mjolnirsoft\"){ issue(number:$NUMBER){ id } } }" \
  --jq '.data.repository.issue.id')

gh api graphql \
  -f query="mutation { addProjectV2ItemById(input:{projectId:\"$PROJECT_ID\" contentId:\"$NODE_ID\"}) { item { id } } }" \
  --jq '.data.addProjectV2ItemById.item.id' > /dev/null

echo "Added to project board."

# --- Step 3: Link to parent as sub-issue ---
echo "Linking #$NUMBER under parent #$parent..."

PARENT_NODE=$(gh api graphql \
  -f query="{ repository(owner:\"Nossimonov\",name:\"Mjolnirsoft\"){ issue(number:$parent){ id } } }" \
  --jq '.data.repository.issue.id')

gh api graphql \
  -f query="mutation { addSubIssue(input:{issueId:\"$PARENT_NODE\" subIssueId:\"$NODE_ID\"}) { issue { number } } }" \
  --jq '.data.addSubIssue.issue.number' > /dev/null

echo "Linked as sub-issue of #$parent."

echo ""
echo "Issue #$NUMBER: labeled '$label', on the project board, parented under #$parent."
