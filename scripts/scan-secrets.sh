#!/usr/bin/env bash
# npm run scan:secrets — vor jedem Commit ausführen (Hinweis dazu in CLAUDE.md).
# 1) gitleaks über die volle History (wie der CI-Job .github/workflows/gitleaks.yml), über
#    Gestagtes UND über unstaged Änderungen an getrackten Dateien — ein Secret fliegt so in
#    jedem Stadium vor dem Commit auf. SCAN_SECRETS_SKIP_GITLEAKS=1 überspringt diesen Teil
#    (nur für scripts/scan-secrets.test.sh, das gitleaks separat und gezielt prüft).
# 2) Privatsphären-Scan: Muster aus der gitignorten .privacy-patterns (case-insensitiv) gegen
#    - Dateinamen UND Dateiinhalt des Arbeitsstands (inkl. Index),
#    - Dateinamen UND Dateiinhalt JEDES einzelnen noch nicht gepushten Commits für sich (nicht
#      nur den Netto-Diff — sonst übersteht ein Name, der in Commit A dazukommt und in Commit B
#      wieder verschwindet, den Scan unentdeckt, landet aber beim Push trotzdem in der History),
#    - Commit-Nachricht, Autor und Committer dieser Commits.
#    Ohne die Datei läuft der Teil mit einem Hinweis durch (siehe .privacy-patterns.example).
#    Bekannte Grenze: Merge-Commits prüft der Scan nicht (diff-tree liefert dafür ohne -m/--cc
#    nichts) — tolerierbar, weil das Ruleset auf main lineare History erzwingt, Merges also nie
#    dort landen.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

GITLEAKS_HINT="Secret sofort rotieren, History vor dem Push bereinigen; Fehlalarm → Fingerprint in .gitleaksignore ergänzen."
CONTENT_HINT="Stelle entfernen; schon committet → git commit --amend bzw. git rebase -i origin/main, vor dem Push."
PATH_HINT="Datei umbenennen (git mv); schon committet → git rebase -i origin/main, vor dem Push."

status=0

run_gitleaks() {
	if command -v gitleaks >/dev/null 2>&1; then
		gitleaks "$@"
	elif command -v nix >/dev/null 2>&1; then
		nix shell nixpkgs#gitleaks --command gitleaks "$@"
	else
		echo "gitleaks fehlt. Installieren mit 'nix shell nixpkgs#gitleaks' oder von https://github.com/gitleaks/gitleaks/releases (PATH)." >&2
		exit 1
	fi
}

if [ "${SCAN_SECRETS_SKIP_GITLEAKS:-}" = "1" ]; then
	echo "== gitleaks: übersprungen (SCAN_SECRETS_SKIP_GITLEAKS=1) =="
else
	echo "== gitleaks: History =="
	if ! run_gitleaks git --redact -v --no-banner .; then
		echo "$GITLEAKS_HINT" >&2
		status=1
	fi

	echo
	echo "== gitleaks: Gestagtes (vor dem Commit) =="
	if ! run_gitleaks git --staged --redact -v --no-banner .; then
		echo "$GITLEAKS_HINT" >&2
		status=1
	fi

	echo
	echo "== gitleaks: Unstaged, getrackte Änderungen (vor dem Commit) =="
	if ! run_gitleaks git --pre-commit --redact -v --no-banner .; then
		echo "$GITLEAKS_HINT" >&2
		status=1
	fi
fi

echo
echo "== Privatsphären-Scan (Arbeitsstand + jeder ungepushte Commit einzeln gegen origin/main) =="
patterns_file=".privacy-patterns"
if [ ! -f "$patterns_file" ]; then
	echo "Kein $patterns_file gefunden — Privatsphären-Scan übersprungen (gitignored, siehe .privacy-patterns.example fürs Format)."
elif ! git rev-parse --verify origin/main >/dev/null 2>&1; then
	echo "origin/main unbekannt (git fetch nötig) — Privatsphären-Scan übersprungen."
else
	# core.quotePath=false + -z: Dateinamen mit Nicht-ASCII (Umlaute etc.) kommen sonst
	# quotiert zurück ("...") und [ -f "$file" ] bzw. git grep laufen an ihnen vorbei.
	# git diff origin/main (ohne ..HEAD) vergleicht gegen den Arbeitsstand inkl. Index —
	# das deckt Gestagtes und Unstaged ab.
	mapfile -d '' -t changed_files < <(git -c core.quotePath=false diff --name-only -z origin/main -- . 2>/dev/null)
	mapfile -t unpushed_shas < <(git rev-list origin/main..HEAD 2>/dev/null)
	hit=0
	while IFS= read -r pattern || [ -n "$pattern" ]; do
		pattern=${pattern%$'\r'} # CRLF in .privacy-patterns lässt das Muster sonst nie treffen
		case "$pattern" in "" | "#"*) continue ;; esac

		if : | grep -iE -- "$pattern" >/dev/null 2>&1; then
			: # gültige Regex, erwartungsgemäß kein Treffer auf leerem Input
		else
			rc=$?
			if [ "$rc" -eq 2 ]; then
				echo "Ungültige Regex in $patterns_file übersprungen: $pattern — in .privacy-patterns korrigieren (grep -E-Syntax)." >&2
				hit=1
				continue
			fi
		fi

		# Arbeitsstand: Dateiname UND Inhalt der gegenüber origin/main geänderten Dateien.
		# -a: Treffer in Binärdateien bekommen trotzdem eine Zeilennummer statt nur "matches".
		# -i: patterns match case-insensitively.
		# tr -d '\0': erspart bashs "NULL-Byte ignoriert"-Warnung bei Binärdateien.
		for file in "${changed_files[@]}"; do
			if printf '%s' "$file" | grep -qiE -- "$pattern"; then
				echo "Treffer für Muster »$pattern« im Dateinamen $file (Arbeitsstand) — $PATH_HINT" >&2
				hit=1
			fi
			[ -f "$file" ] || continue
			if grep_out=$(grep -nEai -- "$pattern" "$file" 2>/dev/null | tr -d '\0'); then
				while IFS= read -r hitline; do
					echo "Treffer für Muster »$pattern« in $file:${hitline%%:*} — $CONTENT_HINT" >&2
					hit=1
				done <<<"$grep_out"
			fi
		done

		# Jeder ungepushte Commit einzeln: Dateiname UND Inhalt der darin geänderten Dateien IN
		# DIESEM Commit (nicht nur der Netto-Diff über alle Commits), plus
		# Nachricht/Autor/Committer. --no-filename + Schleife pro Datei: git grep würde sonst
		# "<sha>:<Datei>:<Zeile>:<Inhalt>" liefern — bei Dateinamen mit ":" nicht eindeutig
		# trennbar, und der Inhalt würde mit ausgegeben (Nit: lange/minifizierte/Binär-Zeilen
		# kosten unnötig Tokens). So bleibt nur "<Zeile>" übrig, Datei und Commit kennen wir
		# schon aus der Schleife.
		for sha in "${unpushed_shas[@]}"; do
			mapfile -d '' -t commit_files < <(git -c core.quotePath=false diff-tree --no-commit-id --name-only -r -z --diff-filter=d "$sha")
			for file in "${commit_files[@]}"; do
				if printf '%s' "$file" | grep -qiE -- "$pattern"; then
					echo "Treffer für Muster »$pattern« im Dateinamen $file (Commit ${sha:0:7}) — $PATH_HINT" >&2
					hit=1
				fi
				if grep_out=$(git -c core.quotePath=false grep -n -a -i -h -E -e "$pattern" "$sha" -- "$file" 2>/dev/null | tr -d '\0'); then
					while IFS= read -r hitline; do
						echo "Treffer für Muster »$pattern« in Commit ${sha:0:7}, $file:${hitline%%:*} — $CONTENT_HINT" >&2
						hit=1
					done <<<"$grep_out"
				fi
			done

			meta="$(git log -1 --format='%an <%ae>%n%cn <%ce>%n%B' "$sha")"
			if printf '%s\n' "$meta" | grep -qiE -- "$pattern"; then
				echo "Treffer für Muster »$pattern« in Commit-Nachricht/Autor/Committer von ${sha:0:7} — $CONTENT_HINT" >&2
				hit=1
			fi
		done
	done <"$patterns_file"

	if [ "$hit" -eq 1 ]; then
		status=1
	else
		echo "Privatsphären-Scan: keine Treffer."
	fi
fi

exit $status
