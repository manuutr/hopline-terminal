"""A fake serial console device on a PTY pair, for e2e tests (no socat needed).

Prints the slave path (what the app opens as its serial port) on the first line of stdout, then
behaves like an IOS console: echo, a "Router>" prompt, `show version`, and reports BREAK if the
line discipline delivers one (pty BREAK shows up as a NUL with PARMRK off; we accept either).
"""
import os, pty, sys, termios, tty, select

master, slave = pty.openpty()
tty.setraw(slave)
print(os.ttyname(slave), flush=True)

def out(s):
    os.write(master, s.encode())

line = ''
out('\r\n\r\nPress RETURN to get started.\r\n')
while True:
    r, _, _ = select.select([master, sys.stdin], [], [], 30)
    if sys.stdin in r:
        if not sys.stdin.readline():
            break
    if master not in r:
        continue
    try:
        data = os.read(master, 1024).decode(errors='replace')
    except OSError:
        continue
    for ch in data:
        if ch in '\r\n':
            cmd = line.strip()
            line = ''
            out('\r\n')
            if cmd in ('show version', 'sh ver'):
                out('Cisco IOS Software, C2960X Software, Version 15.2(7)E8 (serial console)\r\n')
            elif cmd:
                out("% Invalid input detected at '^' marker.\r\n")
            out('Router>')
        elif ch == '\x7f':
            if line:
                line = line[:-1]
                out('\b \b')
        elif ch >= ' ':
            line += ch
            out(ch)
