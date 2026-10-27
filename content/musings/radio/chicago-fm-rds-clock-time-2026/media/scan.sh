#!/usr/bin/env bash
# FM RDS clock-time survey with one RTL-SDR and redsea.
#
# Pass 1 listens to every FM channel briefly to find the ones carrying RDS.
# Pass 2 dwells on each RDS channel long enough to cross two minute
# boundaries, since group 4A (clock time) is sent once a minute.
# Every decoded group is kept, timestamped by redsea at receive time.
#
# usage: scan.sh OUTDIR
# env:   REDSEA (path to redsea), DEVICE (rtl-sdr index or serial, default 0),
#        GAIN (dB), PASS1_S, PASS2_S, STOP_SERVICE
#        STOP_SERVICE lists services holding the dongle (e.g. "readsb"); they
#        are stopped for the survey and started again on any exit.
#        CHANNELS is a space-separated MHz list (default: every channel
#        87.9-107.9). SWEEP=0 skips the rtl_power level sweep.
set -euo pipefail

OUT=${1:?usage: scan.sh OUTDIR}
REDSEA=${REDSEA:-redsea}
DEVICE=${DEVICE:-0}
GAIN=${GAIN:-49.6}
PASS1_S=${PASS1_S:-12}
PASS2_S=${PASS2_S:-130}
STOP_SERVICE=${STOP_SERVICE:-}
CHANNELS=${CHANNELS:-}
SWEEP=${SWEEP:-1}
TS='%Y-%m-%dT%H:%M:%S.%f%z'

mkdir -p "$OUT/pass1" "$OUT/pass2"
log() { printf '%s %s\n' "$(date +%T)" "$*" | tee -a "$OUT/progress.log"; }

restore() {
  local s
  for s in $STOP_SERVICE; do
    sudo systemctl start "$s" && log "$s started again"
  done
  log "exit"
}
trap restore EXIT
trap 'exit 143' TERM INT HUP

# Prints the names of any STOP_SERVICE that is running.
holders() {
  local s
  for s in $STOP_SERVICE; do
    if systemctl is-active -q "$s"; then echo "$s"; fi
  done
}

free_dongle() {
  local s
  for s in $(holders); do
    sudo systemctl stop "$s"
    sleep 1
  done
}

# $1 MHz, $2 seconds, $3 output file. Retries once if the dongle was taken by a
# service or was still held by the previous rtl_fm (it can lag being killed).
capture() {
  local try err="$OUT/.rtl_fm.err"
  for try in 1 2; do
    free_dongle
    timeout "$2" rtl_fm -d "$DEVICE" -M fm -l 0 -A std -p 0 -s 171k -g "$GAIN" -F 9 -f "${1}M" 2>"$err" \
      | "$REDSEA" -r 171k -u -E -p -t "$TS" 2>/dev/null \
      | jq -c --argjson f "$1" --argjson g "$GAIN" '. + {freq_mhz: $f, gain_db: $g}' > "$3" || true
    [[ -s $3 ]] && return 0
    if grep -qiE 'failed to open|usb_claim_interface|no supported devices' "$err"; then
      log "dongle not ready on $1, retrying"
      sleep 3
      continue
    fi
    [[ -n $(holders) ]] || return 0
    log "$(holders | xargs) came back during $1, retrying"
  done
}

{
  echo "started: $(date -Is)"
  echo "redsea: $("$REDSEA" --version)"
  echo "device: $DEVICE  gain_db: $GAIN  pass1_s: $PASS1_S  pass2_s: $PASS2_S"
  echo "channels: ${CHANNELS:-all}"
  echo "dongle: $(lsusb | grep -iE 'rtl|2832|2838' || true)"
  echo "clock:"
  timedatectl show -p NTPSynchronized -p NTP -p Timezone 2>/dev/null || true
  chronyc tracking 2>/dev/null || true
} > "$OUT/scan-meta.txt"

if [[ $SWEEP == 1 ]]; then
  free_dongle
  log "level sweep 87.7-108.1 MHz"
  rtl_power -d "$DEVICE" -f 87.7M:108.1M:10k -g "$GAIN" -i 10 -e 30 "$OUT/levels.csv" 2>/dev/null || log "rtl_power failed"
fi

if [[ -n $CHANNELS ]]; then
  read -ra channels <<< "$CHANNELS"
else
  mapfile -t channels < <(seq -f '%.1f' 87.9 0.2 107.9)
fi
rds=()
i=0
for f in "${channels[@]}"; do
  i=$((i + 1))
  capture "$f" "$PASS1_S" "$OUT/pass1/$f.jsonl"
  pi=$(jq -r 'select(.pi) | .pi' "$OUT/pass1/$f.jsonl" | sort | uniq -c | sort -rn | awk 'NR==1 && $1>=3 {print $2}')
  if [[ -n $pi ]]; then
    rds+=("$f")
    log "pass1 $i/${#channels[@]} $f RDS $pi $(jq -r 'select(.callsign) | .callsign' "$OUT/pass1/$f.jsonl" | sort | uniq -c | sort -rn | awk 'NR==1 {print $2}')"
  else
    log "pass1 $i/${#channels[@]} $f -"
  fi
done
log "pass1 done: ${#rds[@]} channels with RDS"

i=0
for f in "${rds[@]}"; do
  i=$((i + 1))
  capture "$f" "$PASS2_S" "$OUT/pass2/$f.jsonl"
  # This channel had RDS a moment ago, so an empty capture is a receiver glitch.
  if [[ ! -s $OUT/pass2/$f.jsonl ]]; then
    log "pass2 $f captured nothing, retrying"
    sleep 3
    capture "$f" "$PASS2_S" "$OUT/pass2/$f.jsonl"
  fi
  ct=$(jq -r 'select(.clock_time) | .clock_time' "$OUT/pass2/$f.jsonl" | tail -1)
  log "pass2 $i/${#rds[@]} $f groups=$(wc -l < "$OUT/pass2/$f.jsonl") CT=${ct:-none}"
done

echo "finished: $(date -Is)" >> "$OUT/scan-meta.txt"
log "done"
