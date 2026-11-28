import errno
import os
import pty
import select
import signal
import sys
import time

pid, terminal = pty.fork()
if pid == 0:
    os.execv(sys.argv[1], sys.argv[1:])

output = bytearray()
sent = False
deadline = time.monotonic() + 20
try:
    while select.select([terminal], [], [], max(0, deadline - time.monotonic()))[0]:
        try:
            chunk = os.read(terminal, 4096)
        except OSError as error:
            if error.errno != errno.EIO:
                raise
            break  # Linux reports EIO when the slave closes.
        if not chunk:
            break
        output.extend(chunk)
        if not sent and b"Storage value: " in output:
            os.write(terminal, b"synthetic-terminal-secret\r")
            sent = True
    else:
        os.kill(pid, signal.SIGKILL)
finally:
    os.close(terminal)
    _, status = os.waitpid(pid, 0)

sys.stdout.buffer.write(output)
sys.exit(0 if os.WIFEXITED(status) and os.WEXITSTATUS(status) == 0 else 1)
