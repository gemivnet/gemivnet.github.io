#!/usr/bin/env bash
# One survey run: scan.sh over every channel, then a longer second look at each
# listed station that showed no RDS in its 12 s pass-1 window, merged into the
# same run directory. Resumable: a finished main scan is not repeated.
#
# usage: survey.sh RUNDIR      (same env as scan.sh; RECHECK_S defaults to 40)
set -euo pipefail

RUN=${1:?usage: survey.sh RUNDIR}
HERE=$(cd "$(dirname "$0")" && pwd)
RECHECK_S=${RECHECK_S:-40}

if grep -q ' done$' "$RUN/progress.log" 2>/dev/null; then
  echo "main scan already finished in $RUN, skipping to recheck"
else
  "$HERE/scan.sh" "$RUN"
fi

# Listed channels whose pass-1 capture had no PI code at least 3 times.
recheck=()
for f in $(jq -r 'keys[] | select(test("^[0-9]"))' "$HERE/stations.json"); do
  n=$(jq -r 'select(.pi) | .pi' "$RUN/pass1/$f.jsonl" 2>/dev/null | sort | uniq -c | sort -rn | awk 'NR==1 {print $1}')
  if [[ ${n:-0} -lt 3 ]]; then recheck+=("$f"); fi
done
echo "rechecking ${#recheck[@]} channels for ${RECHECK_S} s: ${recheck[*]}"

if [[ ${#recheck[@]} -gt 0 ]]; then
  CHANNELS="${recheck[*]}" PASS1_S="$RECHECK_S" SWEEP=0 "$HERE/scan.sh" "$RUN/recheck"
  mkdir -p "$RUN/pass3"
  cp "$RUN/recheck/pass1/"*.jsonl "$RUN/pass3/"
  for f in "$RUN/recheck/pass2/"*.jsonl; do
    [[ -e $f ]] && cp "$f" "$RUN/pass2/"
  done
fi
echo "survey complete: $RUN"
