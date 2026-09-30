#!/usr/bin/env bash
# Regressionstests für scripts/scan-secrets.sh — ein Fall pro geprüftem Verhalten. Läuft in
# einem Wegwerf-Repo unter mktemp, rührt weder den echten Worktree noch .privacy-patterns an.
# npm run test:scan-secrets, außerdem eigener CI-Schritt in .github/workflows/gitleaks.yml
# (dort ist gitleaks schon installiert, die gitleaks-Szenarien decken dann den echten Aufruf ab
# statt nur den lokalen Fallback).
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
echo placeholder >"$work/tracked.txt" # bleibt getrackt, für das Unstaged-Szenario unten
git -C "$work" -c user.name=t -c user.email=t@example.invalid add scripts/scan-secrets.sh tracked.txt
git -C "$work" -c user.name=t -c user.email=t@example.invalid commit -q -m init
git -C "$work" remote add origin "$bare"
git -C "$work" push -q origin HEAD:main
git -C "$work" fetch -q origin

export SCAN_SECRETS_SKIP_GITLEAKS=1 # per Szenario einzeln auf 0 setzen, wo gitleaks selbst geprüft wird

pass=0
fail=0

reset_work() {
	# Wegwerf-Repo unter mktemp, kein Bezug zum echten Worktree — reset --hard ist hier sicher.
	git -C "$work" reset -q --hard origin/main
}

commit_as() {
	git -C "$work" -c user.name="$1" -c user.email="$2" commit -q -m "$3"
}

commit_as_author() {
	# commit_as_author <Autor-Name> <Autor-Mail> <Committer-Name> <Committer-Mail> <Nachricht>
	git -C "$work" -c user.name="$3" -c user.email="$4" commit -q -m "$5" --author="$1 <$2>"
}

check() {
	local name="$1" want="$2" grep_for="${3:-}" got=0
	(cd "$work" && bash scripts/scan-secrets.sh) >"$tmp/out.txt" 2>&1 || got=$?
	if [ "$got" -ne "$want" ]; then
		echo "FAIL: $name — Exit $got, erwartet $want" >&2
		sed 's/^/    /' "$tmp/out.txt" >&2
		fail=$((fail + 1))
		return
	fi
	if [ -n "$grep_for" ] && ! grep -qF "$grep_for" "$tmp/out.txt"; then
		echo "FAIL: $name — Ausgabe enthält nicht: $grep_for" >&2
		sed 's/^/    /' "$tmp/out.txt" >&2
		fail=$((fail + 1))
		return
	fi
	echo "ok: $name"
	pass=$((pass + 1))
}

# --- Szenarien ---

reset_work
printf 'ProbeSauber\n' >"$work/.privacy-patterns"
check "sauber: kein Muster-Treffer" 0

reset_work
printf 'ProbeName\n' >"$work/.privacy-patterns"
echo "Kontakt: ProbeName wohnt hier" >"$work/note.txt"
git -C "$work" add note.txt
check "Arbeitsstand: Treffer im Dateiinhalt" 1 "note.txt:1"

reset_work
printf 'ProbeTrans\n' >"$work/.privacy-patterns"
echo "ProbeTrans drin" >"$work/trans.txt"
git -C "$work" add trans.txt
commit_as probe probe@example.invalid "fuegt Datei hinzu"
git -C "$work" rm -q trans.txt
commit_as probe probe@example.invalid "entfernt Datei wieder"
check "Zwischen-Commit: Netto-Diff leer, Inhalt trotzdem gefunden" 1 "trans.txt:1"

reset_work
printf 'ProbeUmlaut\n' >"$work/.privacy-patterns"
echo "ProbeUmlaut drin" >"$work/Übersicht.md"
git -C "$work" add Übersicht.md
check "Umlaut im Dateinamen wird nicht übersprungen" 1 "Übersicht.md:1"

reset_work
printf 'ProbeDateiname\n' >"$work/.privacy-patterns"
echo x >"$work/ProbeDateiname.txt"
git -C "$work" add ProbeDateiname.txt
check "Muster im Dateinamen selbst, nicht nur im Inhalt" 1 "Dateinamen ProbeDateiname.txt"

reset_work
printf 'ProbeRename\n' >"$work/.privacy-patterns"
echo x >"$work/ProbeRename.txt"
git -C "$work" add ProbeRename.txt
commit_as probe probe@example.invalid "legt Datei mit Testname im Namen an"
git -C "$work" mv ProbeRename.txt safe.txt
commit_as probe probe@example.invalid "benennt Datei wieder um"
check "Dateiname nur in einem Zwischen-Commit, später umbenannt" 1 "Dateinamen ProbeRename.txt (Commit"

reset_work
printf 'ProbeCRLF\r\n' >"$work/.privacy-patterns"
echo "ProbeCRLF drin" >"$work/crlf.txt"
git -C "$work" add crlf.txt
check "Musterzeile mit CRLF wirkt trotzdem" 1 "crlf.txt:1"

reset_work
printf 'ProbeLastLine' >"$work/.privacy-patterns" # bewusst ohne abschließenden Newline
echo "ProbeLastLine drin" >"$work/lastline.txt"
git -C "$work" add lastline.txt
check "letzte Musterzeile ohne Newline wirkt" 1 "lastline.txt:1"

reset_work
printf 'ProbeBin\n' >"$work/.privacy-patterns"
printf 'x ProbeBin \000\001binary' >"$work/probe.bin"
git -C "$work" add probe.bin
check "Treffer in Binärdatei mit Zeilennummer" 1 "probe.bin:1"

reset_work
printf 'ProbeCommitter\n' >"$work/.privacy-patterns"
echo x >"$work/c.txt"
git -C "$work" add c.txt
commit_as Neutral neutral@example.invalid neutral
git -C "$work" -c user.name=ProbeCommitter -c user.email=probecommitter@example.invalid commit -q --amend --no-edit
check "Muster nur im Committer, nicht im Autor" 1 "Commit-Nachricht/Autor/Committer"

reset_work
printf 'ProbeAuthor\n' >"$work/.privacy-patterns"
echo x >"$work/a.txt"
git -C "$work" add a.txt
commit_as_author ProbeAuthor probeauthor@example.invalid Neutral neutral@example.invalid neutral
check "Muster nur im Autor, nicht im Committer" 1 "Commit-Nachricht/Autor/Committer"

reset_work
printf 'ProbeMsg\n' >"$work/.privacy-patterns"
echo x >"$work/m.txt"
git -C "$work" add m.txt
commit_as Neutral neutral@example.invalid "neutral, ProbeMsg im Text"
check "Muster nur in der Commit-Nachricht" 1 "Commit-Nachricht/Autor/Committer"

reset_work
printf 'ProbeCase\n' >"$work/.privacy-patterns"
echo "probecase klein geschrieben" >"$work/case.txt"
git -C "$work" add case.txt
check "Muster ist case-insensitiv" 1 "case.txt:1"

reset_work
printf 'foo(\n' >"$work/.privacy-patterns"
echo x >"$work/ok.txt"
git -C "$work" add ok.txt
check "ungültige Regex wird erkannt, nicht stillschweigend übersprungen" 1 "Ungültige Regex"

if command -v gitleaks >/dev/null 2>&1 || command -v nix >/dev/null 2>&1; then
	reset_work
	printf 'ProbeNoop\n' >"$work/.privacy-patterns"
	# "PRIVATE"+" "+"KEY" bewusst per Variable zusammengesetzt: ein zusammenhängendes
	# "-----BEGIN...PRIVATE KEY-----" in DIESER Quelldatei würde gitleaks' eigene
	# private-key-Regel auf scan-secrets.test.sh selbst auslösen. Erst in der
	# Fixture-Datei (unten, zur Laufzeit im Wegwerf-Repo geschrieben) steht der
	# vollständige String, den gitleaks dort auch tatsächlich finden soll.
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
	SCAN_SECRETS_SKIP_GITLEAKS=0 check "gestagtes Secret wird von gitleaks gefunden" 1 "private-key"

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
	# bewusst NICHT gestagt: tracked.txt ist schon getrackt (init-Commit), diese Änderung
	# bleibt unstaged — nur `gitleaks git --pre-commit` (ohne --staged) sieht sie.
	SCAN_SECRETS_SKIP_GITLEAKS=0 check "unstaged Änderung an getrackter Datei wird von gitleaks gefunden" 1 "private-key"
else
	echo "übersprungen: gitleaks-Szenarien (weder gitleaks noch nix verfügbar)"
fi

echo
echo "$pass bestanden, $fail fehlgeschlagen."
[ "$fail" -eq 0 ]
