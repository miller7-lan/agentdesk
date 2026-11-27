#!/usr/bin/python3 -I
# Runs one program in a fresh pseudo-terminal on VPS2 (native CLI single chats, native-tui-host.js).
#
#   pty-run.py <cols> <rows> -- <program> [args...]
#
# fd 0: keystrokes for the terminal, written to it unchanged (Ctrl+C is the byte 0x03; the terminal turns it
#       into SIGINT for the program, exactly as in a real terminal).
# fd 1: everything the program draws, unchanged.
# fd 3: control lines "<cols> <rows>\n": resize the terminal (the program gets SIGWINCH from the kernel).
# Exits with the program's exit code (128 + signal when it was killed).
import errno
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios


def set_size(fd, cols, rows):
    cols = max(10, min(int(cols), 1000))
    rows = max(4, min(int(rows), 500))
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))


def main():
    args = sys.argv[1:]
    if len(args) < 4 or args[2] != '--':
        sys.stderr.write('pty-run: usage: pty-run.py <cols> <rows> -- <program> [args...]\n')
        return 2
    cols, rows, program = args[0], args[1], args[3:]
    pid, master = pty.fork()
    if pid == 0:
        try:
            os.execv(program[0], program)
        except OSError as error:
            sys.stderr.write('pty-run: %s\n' % error)
        os._exit(127)
    set_size(master, cols, rows)
    control = 3
    try:
        os.fstat(control)
    except OSError:
        control = None
    readers = [0, master] + ([control] if control is not None else [])
    pending = b''
    control_buffer = b''
    status = None

    def write_all(fd, data):
        while data:
            try:
                written = os.write(fd, data)
            except OSError as error:
                if error.errno == errno.EAGAIN:
                    select.select([], [fd], [], 1)
                    continue
                raise
            data = data[written:]

    while True:
        try:
            ready, _, _ = select.select(readers, [], [], 0.5)
        except InterruptedError:
            continue
        if master in ready:
            try:
                data = os.read(master, 65536)
            except OSError as error:
                data = b'' if error.errno == errno.EIO else None
                if data is None:
                    raise
            if not data:
                break
            write_all(1, data)
        if 0 in ready:
            try:
                data = os.read(0, 65536)
            except OSError:
                data = b''
            if not data:
                # The other side is gone: end the program as a closed terminal would.
                readers.remove(0)
                try:
                    os.kill(pid, signal.SIGHUP)
                except ProcessLookupError:
                    pass
            else:
                write_all(master, data)
        if control is not None and control in ready:
            try:
                data = os.read(control, 4096)
            except OSError:
                data = b''
            if not data:
                readers.remove(control)
                control = None
            else:
                control_buffer += data
                while b'\n' in control_buffer:
                    line, control_buffer = control_buffer.split(b'\n', 1)
                    parts = line.split()
                    if len(parts) == 2 and all(part.isdigit() for part in parts):
                        set_size(master, parts[0], parts[1])
        if status is None:
            done, value = os.waitpid(pid, os.WNOHANG)
            if done:
                status = value
    if status is None:
        _, status = os.waitpid(pid, 0)
    if os.WIFSIGNALED(status):
        return 128 + os.WTERMSIG(status)
    return os.WEXITSTATUS(status)


if __name__ == '__main__':
    sys.exit(main())
