import { readFile } from 'node:fs/promises';
import { statfs } from 'node:fs/promises';

const hostRoot = process.env.HALFCLOUD_HOST_ROOT ?? '/host';
const procRoot = process.env.HALFCLOUD_HOST_PROC ?? '/host/proc';

async function readablePath(preferred: string, fallback: string) {
  try {
    await readFile(preferred);
    return preferred;
  } catch {
    return fallback;
  }
}

async function cpuSnapshot() {
  const file = await readablePath(`${procRoot}/stat`, '/proc/stat');
  const fields = (await readFile(file, 'utf8')).split('\n')[0]!.trim().split(/\s+/).slice(1).map(Number);
  const idle = (fields[3] ?? 0) + (fields[4] ?? 0);
  return { idle, total: fields.reduce((sum, value) => sum + value, 0) };
}

export async function getServerStats() {
  const first = await cpuSnapshot();
  await new Promise((resolve) => setTimeout(resolve, 120));
  const second = await cpuSnapshot();
  const totalDelta = second.total - first.total;
  const cpuPercent = totalDelta > 0 ? ((totalDelta - (second.idle - first.idle)) / totalDelta) * 100 : 0;

  const memoryFile = await readablePath(`${procRoot}/meminfo`, '/proc/meminfo');
  const memory = Object.fromEntries(
    (await readFile(memoryFile, 'utf8')).split('\n').filter(Boolean).map((line) => {
      const [key, value] = line.split(':');
      return [key, Number.parseInt(value ?? '0', 10) * 1024];
    }),
  );
  const memoryTotal = memory.MemTotal ?? 0;
  const memoryAvailable = memory.MemAvailable ?? memory.MemFree ?? 0;

  let disk;
  try {
    disk = await statfs(hostRoot, { bigint: true });
  } catch {
    disk = await statfs('/', { bigint: true });
  }
  const diskTotal = Number(disk.blocks * disk.bsize);
  const diskAvailable = Number(disk.bavail * disk.bsize);

  const uptimeFile = await readablePath(`${procRoot}/uptime`, '/proc/uptime');
  const uptimeSeconds = Number.parseFloat((await readFile(uptimeFile, 'utf8')).split(' ')[0] ?? '0');

  return {
    cpuPercent: Number(cpuPercent.toFixed(1)),
    memoryUsed: memoryTotal - memoryAvailable,
    memoryTotal,
    diskUsed: diskTotal - diskAvailable,
    diskTotal,
    uptimeSeconds: Math.floor(uptimeSeconds),
  };
}
