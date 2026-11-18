"""Drive synthetic hidden input through a real terminal and report only the captured test output."""
import errno
import json
import os
import pty
import select
import subprocess
import sys
import termios
import time

node, project, profile_path, store_path, prompt_number = sys.argv[1:]
master, slave = pty.openpty()
original_flags = termios.tcgetattr(slave)[3]
process = subprocess.Popen(
    [node, "--import", "tsx", "src/index.ts", "auth", "import", "--profile", "owner", "--profiles", profile_path, "--credential-store", store_path],
    cwd=project, stdin=slave, stdout=slave, stderr=slave,
)
output = bytearray()
deadline = time.monotonic() + 10


def collect_until(label):
    while time.monotonic() < deadline:
        if label in output and not (termios.tcgetattr(slave)[3] & termios.ECHO):
            return
        readable, _, _ = select.select([master], [], [], 0.02)
        if readable:
            output.extend(os.read(master, 65536))
        if process.poll() is not None:
            raise RuntimeError("import exited before the requested prompt")
    raise RuntimeError("hidden prompt deadline exceeded")


try:
    collect_until(b"CloudKit API token:")
    if prompt_number == "2":
        os.write(master, b"synthetic-hidden-api-input\r")
        collect_until(b"CloudKit web authentication token:")
    os.write(master, b"\x03")
    process.wait(timeout=5)
    while select.select([master], [], [], 0.02)[0]:
        try:
            data = os.read(master, 65536)
            if not data:
                break
            output.extend(data)
        except OSError as error:
            if error.errno != errno.EIO:
                raise
            break
    restored_flags = termios.tcgetattr(slave)[3]
    print(json.dumps({"exitCode": process.returncode, "terminalRestored": (restored_flags & (termios.ECHO | termios.ICANON)) == (original_flags & (termios.ECHO | termios.ICANON)), "output": output.decode("utf-8")}))
finally:
    if process.poll() is None:
        process.kill()
        process.wait()
    os.close(master)
    os.close(slave)
