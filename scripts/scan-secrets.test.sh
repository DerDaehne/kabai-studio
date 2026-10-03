#!/usr/bin/env bash
# Regression tests for scripts/scan-secrets.sh — one case per checked behaviour. Runs in a
# throwaway repository under mktemp and touches neither the real worktree nor .privacy-patterns.
# npm run test:scan-secrets, also a CI step of its own in .github/workflows/gitleaks.yml
# (gitleaks is installed there, so the gitleaks scenarios cover the real call instead of
# only the local fallback).
set -euo pipefail
repo_root="$(git rev-parse --show-toplevel)"
script="$repo_root/scripts/scan-secrets.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

work="$tmp/work"
bare="$tmp/origin.git"

git init -q --bare "$bare"
git init -q "$work"
mkdir -p "$work/scripts"
cp "$script" "$work/scripts/scan-secrets.sh"
chmod +x "$work/scripts/scan-secrets.sh"
echo placeholder >"$work/tracked.txt" # stays tracked, for the unstaged scenario below
git -C "$work" -c user.name=t -c user.email=t@example.invalid add scripts/scan-secrets.sh tracked.txt
git -C "$work" -c user.name=t -c user.email=t@example.invalid commit -q -m init
git -C "$work" remote add origin "$bare"
git -C "$work" push -q origin HEAD:main
git -C "$work" fetch -q origin

export SCAN_SECRETS_SKIP_GITLEAKS=1 # set to 0 per scenario where gitleaks itself is under test

pass=0
fail=0

reset_work() {
	# a throwaway repository under mktemp, unrelated to the real worktree — reset --hard is safe here
	git -C "$work" reset -q --hard origin/main
}

commit_as() {
	git -C "$work" -c user.name="$1" -c user.email="$2" commit -q -m "$3"
}

commit_as_author() {
	# commit_as_author <author name> <author mail> <committer name> <committer mail> <message>
	git -C "$work" -c user.name="$3" -c user.email="$4" commit -q -m "$5" --author="$1 <$2>"
}

check() {
	local name="$1" want="$2" grep_for="${3:-}" got=0
	(cd "$work" && bash scripts/scan-secrets.sh) >"$tmp/out.txt" 2>&1 || got=$?
	if [ "$got" -ne "$want" ]; then
		echo "FAIL: $name — exit $got, expected $want" >&2
		sed 's/^/    /' "$tmp/out.txt" >&2
		fail=$((fail + 1))
		return
	fi
	if [ -n "$grep_for" ] && ! grep -qF "$grep_for" "$tmp/out.txt"; then
		echo "FAIL: $name — output lacks: $grep_for" >&2
		sed 's/^/    /' "$tmp/out.txt" >&2
		fail=$((fail + 1))
		return
	fi
	echo "ok: $name"
	pass=$((pass + 1))
}

# --- scenarios ---

reset_work
printf 'ProbeSauber\n' >"$work/.privacy-patterns"
check "clean: no pattern matches" 0

reset_work
printf 'ProbeName\n' >"$work/.privacy-patterns"
echo "Kontakt: ProbeName wohnt hier" >"$work/note.txt"
git -C "$work" add note.txt
check "working tree: match in file content" 1 "note.txt:1"

reset_work
printf 'ProbeTrans\n' >"$work/.privacy-patterns"
echo "ProbeTrans drin" >"$work/trans.txt"
git -C "$work" add trans.txt
commit_as probe probe@example.invalid "add a file"
git -C "$work" rm -q trans.txt
commit_as probe probe@example.invalid "remove the file again"
check "intermediate commit: empty net diff, content still found" 1 "trans.txt:1"

reset_work
printf 'ProbeUmlaut\n' >"$work/.privacy-patterns"
echo "ProbeUmlaut drin" >"$work/Übersicht.md"
git -C "$work" add Übersicht.md
check "non-ASCII file name is not skipped" 1 "Übersicht.md:1"

reset_work
printf 'ProbeDateiname\n' >"$work/.privacy-patterns"
echo x >"$work/ProbeDateiname.txt"
git -C "$work" add ProbeDateiname.txt
check "pattern in the file name itself, not only in the content" 1 "file name ProbeDateiname.txt"

reset_work
printf 'ProbeRename\n' >"$work/.privacy-patterns"
echo x >"$work/ProbeRename.txt"
git -C "$work" add ProbeRename.txt
commit_as probe probe@example.invalid "add a file named after the probe"
git -C "$work" mv ProbeRename.txt safe.txt
commit_as probe probe@example.invalid "rename the file again"
check "file name only in an intermediate commit, renamed later" 1 "file name ProbeRename.txt (commit"

reset_work
printf 'ProbeCRLF\r\n' >"$work/.privacy-patterns"
echo "ProbeCRLF drin" >"$work/crlf.txt"
git -C "$work" add crlf.txt
check "pattern line with CRLF still works" 1 "crlf.txt:1"

reset_work
printf 'ProbeLastLine' >"$work/.privacy-patterns" # deliberately without a trailing newline
echo "ProbeLastLine drin" >"$work/lastline.txt"
git -C "$work" add lastline.txt
check "last pattern line without newline works" 1 "lastline.txt:1"

reset_work
printf 'ProbeBin\n' >"$work/.privacy-patterns"
printf 'x ProbeBin \000\001binary' >"$work/probe.bin"
git -C "$work" add probe.bin
check "match in a binary file with line number" 1 "probe.bin:1"

reset_work
printf 'ProbeCommitter\n' >"$work/.privacy-patterns"
echo x >"$work/c.txt"
git -C "$work" add c.txt
commit_as Neutral neutral@example.invalid neutral
git -C "$work" -c user.name=ProbeCommitter -c user.email=probecommitter@example.invalid commit -q --amend --no-edit
check "pattern only in the committer, not the author" 1 "commit message/author/committer"

reset_work
printf 'ProbeAuthor\n' >"$work/.privacy-patterns"
echo x >"$work/a.txt"
git -C "$work" add a.txt
commit_as_author ProbeAuthor probeauthor@example.invalid Neutral neutral@example.invalid neutral
check "pattern only in the author, not the committer" 1 "commit message/author/committer"

reset_work
printf 'ProbeMsg\n' >"$work/.privacy-patterns"
echo x >"$work/m.txt"
git -C "$work" add m.txt
commit_as Neutral neutral@example.invalid "neutral, ProbeMsg in the text"
check "pattern only in the commit message" 1 "commit message/author/committer"

reset_work
printf 'ProbeCase\n' >"$work/.privacy-patterns"
echo "probecase in lower case" >"$work/case.txt"
git -C "$work" add case.txt
check "pattern is case-insensitive" 1 "case.txt:1"

reset_work
printf 'foo(\n' >"$work/.privacy-patterns"
echo x >"$work/ok.txt"
git -C "$work" add ok.txt
check "invalid regex is reported, not silently skipped" 1 "Invalid regex"

if command -v gitleaks >/dev/null 2>&1 || command -v nix >/dev/null 2>&1; then
	reset_work
	printf 'ProbeNoop\n' >"$work/.privacy-patterns"
	# "PRIVATE"+" "+"KEY" is assembled through a variable on purpose: a contiguous
	# "-----BEGIN...PRIVATE KEY-----" in THIS source file would trigger gitleaks' own
	# private-key rule on scan-secrets.test.sh itself. Only the fixture file
	# (written below at runtime in the throwaway repository) holds the full string
	# that gitleaks is meant to find there.
	sp=' '
	cat >"$work/secret.pem" <<PEM
-----BEGIN RSA PRIVATE${sp}KEY-----
MIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu
KUpRKfFLfRYC9AIKjbJTWit+CqvjWYzvQwECAwEAAQJAIJLixBy2qpFoS4DSmoEm
o3qGy0t6z09AIJtH5OeRV1be5N4cDYJKffGzMDBLNhQ2sdEbsxJv0KRINqTS9mQ
IhAKMSvzIBnni7ot5OSie2TmJLY4SwTQAevXysE2RbFDYdAiEBjLTZQO4d1AAA=
-----END RSA PRIVATE${sp}KEY-----
PEM
	git -C "$work" add secret.pem
	SCAN_SECRETS_SKIP_GITLEAKS=0 check "gitleaks finds a staged secret" 1 "private-key"

	reset_work
	printf 'ProbeNoop\n' >"$work/.privacy-patterns"
	sp=' '
	cat >"$work/tracked.txt" <<PEM
-----BEGIN RSA PRIVATE${sp}KEY-----
MIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu
KUpRKfFLfRYC9AIKjbJTWit+CqvjWYzvQwECAwEAAQJAIJLixBy2qpFoS4DSmoEm
o3qGy0t6z09AIJtH5OeRV1be5N4cDYJKffGzMDBLNhQ2sdEbsxJv0KRINqTS9mQ
IhAKMSvzIBnni7ot5OSie2TmJLY4SwTQAevXysE2RbFDYdAiEBjLTZQO4d1AAA=
-----END RSA PRIVATE${sp}KEY-----
PEM
	# deliberately NOT staged: tracked.txt is already tracked (init commit), so this change
	# stays unstaged — only `gitleaks git --pre-commit` (without --staged) sees it.
	SCAN_SECRETS_SKIP_GITLEAKS=0 check "gitleaks finds an unstaged change to a tracked file" 1 "private-key"
else
	echo "skipped: gitleaks scenarios (neither gitleaks nor nix available)"
fi

echo
echo "$pass passed, $fail failed."
[ "$fail" -eq 0 ]
