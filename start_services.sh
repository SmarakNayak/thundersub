#!/usr/bin/env bash
# start-fcc.sh: start fcc-server and fcc-claude, each in its own terminal window.
# When fcc-claude ends (you quit it, or close its window), fcc-server is stopped too.
# Errors are written to ~/start-fcc.log.

WORKDIR="/home/squidly/thundersub-main"   # folder both commands start in
DELAY=2                                    # seconds to wait for the server before starting the client
LOG="$HOME/start-fcc.log"
SERVERPAT='^(([^ ]*/)?(python[0-9.]*|node|bash|sh) +)?([^ ]*/)?fcc-server( |$)'   # matches the server process by command line
PIDFILE="/tmp/fcc-server.pid"              # where the server window records its shell PID

echo "=== $(date) ===" >> "$LOG"

# Commands run inside each window (bash -ic, so your .bashrc, aliases and PATH apply).
# __WORKDIR__ and __PIDFILE__ are filled in below.

SERVER_TPL='cd "__WORKDIR__" || { echo "Cannot cd to __WORKDIR__"; read -rp "Press Enter to close"; exit 1; }
echo "Working in: $PWD"
echo $$ > "__PIDFILE__"
fcc-server
rc=$?
rm -f "__PIDFILE__"
# 143/129/130 mean it was stopped on purpose, so close quietly
if [ $rc -ne 0 ] && [ $rc -ne 143 ] && [ $rc -ne 129 ] && [ $rc -ne 130 ]; then
    echo "fcc-server exited with code $rc"; read -rp "Press Enter to close"
fi'

CLIENT_TPL='cd "__WORKDIR__" || { echo "Cannot cd to __WORKDIR__"; read -rp "Press Enter to close"; exit 1; }
echo "Working in: $PWD"
kill_tree() { local c; for c in $(pgrep -P "$1"); do kill_tree "$c"; done; kill "$1" 2>/dev/null; }
stop_server() {
    local p c
    if [ -f "__PIDFILE__" ]; then
        p=$(cat "__PIDFILE__")
        for c in $(pgrep -P "$p"); do kill_tree "$c"; done
        kill -HUP "$p" 2>/dev/null
        rm -f "__PIDFILE__"
    fi
    # fallback: stop any fcc-server that escaped the window (detached/daemonized)
    pkill -f "__SERVERPAT__" 2>/dev/null
    return 0
}
trap stop_server EXIT
trap "exit 143" HUP TERM
fcc-claude
rc=$?
stop_server
if [ $rc -ne 0 ]; then
    echo "fcc-claude exited with code $rc"; read -rp "Press Enter to close"
fi'

fill() { local s="${1//__WORKDIR__/$WORKDIR}"; s="${s//__PIDFILE__/$PIDFILE}"; echo "${s//__SERVERPAT__/$SERVERPAT}"; }

# open_term "window title" "commands"
# Each window is launched detached (setsid + &) so this script never waits on it.
open_term() {
    local title="$1" cmd="$2"
    if command -v ptyxis >/dev/null; then
        setsid ptyxis --new-window --title "$title" --working-directory "$WORKDIR" -- bash -ic "$cmd" >>"$LOG" 2>&1 &
    elif command -v gnome-terminal >/dev/null; then
        setsid gnome-terminal --title="$title" --working-directory="$WORKDIR" -- bash -ic "$cmd" >>"$LOG" 2>&1 &
    elif command -v x-terminal-emulator >/dev/null; then
        setsid x-terminal-emulator -T "$title" -e bash -ic "$cmd" >>"$LOG" 2>&1 &
    else
        echo "No supported terminal found" >> "$LOG"
        return 1
    fi
}

# Clean up any fcc-server left over from an earlier run before starting a fresh one
pkill -f "$SERVERPAT" 2>/dev/null
rm -f "$PIDFILE"
sleep 1

open_term "fcc-server" "$(fill "$SERVER_TPL")" || exit 1
sleep "$DELAY"
open_term "fcc-claude" "$(fill "$CLIENT_TPL")" || exit 1

