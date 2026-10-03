#!/usr/bin/env bash
# npm run scan:secrets — run before every commit (see CLAUDE.md).
# 1) gitleaks over the full history (like the CI job .github/workflows/gitleaks.yml), over
#    staged AND unstaged changes to tracked files, so a secret is caught at every stage
#    before the commit. SCAN_SECRETS_SKIP_GITLEAKS=1 skips this part
#    (for scripts/scan-secrets.test.sh, which exercises gitleaks separately).
# 2) Privacy scan: patterns from the gitignored .privacy-patterns (case-insensitive) against
#    - file names AND contents of the working tree (including the index),
#    - file names AND contents of EVERY unpushed commit on its own (not just the net diff,
#      otherwise a name added in commit A and removed in commit B would pass the scan
#      unnoticed while still reaching the history on push),
#    - commit message, author and committer of these commits.
#    Without the file this part passes with a notice (see .privacy-patterns.example).
#    Known limit: merge commits are not checked (diff-tree returns nothing for them without
#    -m/--cc) — acceptable because the ruleset on main enforces a linear history, so merges
#    never land there.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

GITLEAKS_HINT="Rotate the secret now and clean the history before pushing; false positive → add its fingerprint to .gitleaksignore."
CONTENT_HINT="Remove it; if already committed → git commit --amend or git rebase -i origin/main, before pushing."
PATH_HINT="Rename the file (git mv); if already committed → git rebase -i origin/main, before pushing."

status=0

run_gitleaks() {
	if command -v gitleaks >/dev/null 2>&1; then
		gitleaks "$@"
	elif command -v nix >/dev/null 2>&1; then
		nix shell nixpkgs#gitleaks --command gitleaks "$@"
	else
		echo "gitleaks is missing. Install it with 'nix shell nixpkgs#gitleaks' or from https://github.com/gitleaks/gitleaks/releases (PATH)." >&2
		exit 1
	fi
}

if [ "${SCAN_SECRETS_SKIP_GITLEAKS:-}" = "1" ]; then
	echo "== gitleaks: skipped (SCAN_SECRETS_SKIP_GITLEAKS=1) =="
else
	echo "== gitleaks: History =="
	if ! run_gitleaks git --redact -v --no-banner .; then
		echo "$GITLEAKS_HINT" >&2
		status=1
	fi

	echo
	echo "== gitleaks: staged (before the commit) =="
	if ! run_gitleaks git --staged --redact -v --no-banner .; then
		echo "$GITLEAKS_HINT" >&2
		status=1
	fi

	echo
	echo "== gitleaks: unstaged changes to tracked files (before the commit) =="
	if ! run_gitleaks git --pre-commit --redact -v --no-banner .; then
		echo "$GITLEAKS_HINT" >&2
		status=1
	fi
fi

echo
echo "== Privacy scan (working tree + every unpushed commit on its own, against origin/main) =="
patterns_file=".privacy-patterns"
if [ ! -f "$patterns_file" ]; then
	echo "No $patterns_file found — privacy scan skipped (gitignored, see .privacy-patterns.example for the format)."
elif ! git rev-parse --verify origin/main >/dev/null 2>&1; then
	echo "origin/main unknown (git fetch needed) — privacy scan skipped."
else
	# core.quotePath=false + -z: otherwise file names with non-ASCII characters come back
	# quoted ("...") and [ -f "$file" ] or git grep miss them.
	# git diff origin/main (without ..HEAD) compares against the working tree including the
	# index, which covers staged and unstaged changes.
	mapfile -d '' -t changed_files < <(git -c core.quotePath=false diff --name-only -z origin/main -- . 2>/dev/null)
	mapfile -t unpushed_shas < <(git rev-list origin/main..HEAD 2>/dev/null)
	hit=0
	while IFS= read -r pattern || [ -n "$pattern" ]; do
		pattern=${pattern%$'\r'} # a CRLF in .privacy-patterns would otherwise keep the pattern from ever matching
		case "$pattern" in "" | "#"*) continue ;; esac

		if : | grep -iE -- "$pattern" >/dev/null 2>&1; then
			: # a valid regex, which as expected does not match empty input
		else
			rc=$?
			if [ "$rc" -eq 2 ]; then
				echo "Invalid regex in $patterns_file skipped: $pattern — fix it in .privacy-patterns (grep -E syntax)." >&2
				hit=1
				continue
			fi
		fi

		# Working tree: file name AND content of the files changed against origin/main.
		# -a: matches in binary files still get a line number instead of just "matches".
		# -i: patterns match case-insensitively.
		# tr -d '\0': avoids bash's "ignored null byte" warning for binary files.
		for file in "${changed_files[@]}"; do
			if printf '%s' "$file" | grep -qiE -- "$pattern"; then
				echo "Match for pattern »$pattern« in file name $file (working tree) — $PATH_HINT" >&2
				hit=1
			fi
			[ -f "$file" ] || continue
			if grep_out=$(grep -nEai -- "$pattern" "$file" 2>/dev/null | tr -d '\0'); then
				while IFS= read -r hitline; do
					echo "Match for pattern »$pattern« in $file:${hitline%%:*} — $CONTENT_HINT" >&2
					hit=1
				done <<<"$grep_out"
			fi
		done

		# Every unpushed commit on its own: file name AND content of the files changed IN THIS
		# commit (not only the net diff over all commits), plus message, author and committer.
		# -h and one call per file: git grep would otherwise print "<sha>:<file>:<line>:<content>",
		# which is ambiguous for file names containing ":" and repeats long lines; this way only
		# "<line>" is left, and file and commit are known from the loop.
		for sha in "${unpushed_shas[@]}"; do
			mapfile -d '' -t commit_files < <(git -c core.quotePath=false diff-tree --no-commit-id --name-only -r -z --diff-filter=d "$sha")
			for file in "${commit_files[@]}"; do
				if printf '%s' "$file" | grep -qiE -- "$pattern"; then
					echo "Match for pattern »$pattern« in file name $file (commit ${sha:0:7}) — $PATH_HINT" >&2
					hit=1
				fi
				if grep_out=$(git -c core.quotePath=false grep -n -a -i -h -E -e "$pattern" "$sha" -- "$file" 2>/dev/null | tr -d '\0'); then
					while IFS= read -r hitline; do
						echo "Match for pattern »$pattern« in commit ${sha:0:7}, $file:${hitline%%:*} — $CONTENT_HINT" >&2
						hit=1
					done <<<"$grep_out"
				fi
			done

			meta="$(git log -1 --format='%an <%ae>%n%cn <%ce>%n%B' "$sha")"
			if printf '%s\n' "$meta" | grep -qiE -- "$pattern"; then
				echo "Match for pattern »$pattern« in commit message/author/committer of ${sha:0:7} — $CONTENT_HINT" >&2
				hit=1
			fi
		done
	done <"$patterns_file"

	if [ "$hit" -eq 1 ]; then
		status=1
	else
		echo "Privacy scan: no matches."
	fi
fi

exit $status
