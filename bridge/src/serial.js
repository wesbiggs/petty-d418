// Opens a serial device (a USB-serial adapter wired to the SwiftLink) as a
// stream, set to raw 8N1 at `baud` with no flow control. stty configures the
// open descriptor through its stdin, because macOS resets a port's settings
// when the last descriptor on it closes.

import fs from 'node:fs';
import tty from 'node:tty';
import { Duplex } from 'node:stream';
import { spawnSync } from 'node:child_process';

export function openSerial(path, baud) {
  const fd = fs.openSync(path, fs.constants.O_RDWR | fs.constants.O_NOCTTY | fs.constants.O_NONBLOCK);
  const stty = spawnSync('stty', ['raw', '-echo', 'clocal', '-crtscts', 'cs8', '-cstopb', '-parenb', String(baud)],
    { stdio: [fd, 'ignore', 'pipe'] });
  if (stty.status !== 0) {
    fs.closeSync(fd);
    throw new Error(`stty on ${path}: ${stty.stderr.toString().trim() || `exit ${stty.status}`}`);
  }
  return Duplex.from({ readable: new tty.ReadStream(fd), writable: new tty.WriteStream(fd) });
}
