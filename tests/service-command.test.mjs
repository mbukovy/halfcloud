import assert from 'node:assert/strict';
import { PassThrough, Readable } from 'node:stream';
import test from 'node:test';
import Docker from 'dockerode';
import { DockerService } from '../dist/backend/docker.js';

function frame(type, text) {
  const body = Buffer.from(text);
  const header = Buffer.alloc(8);
  header[0] = type;
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}

function fixture({ frames = [], running = false, exitCode = 0, stream = Readable.from(frames) } = {}) {
  const service = Object.create(DockerService.prototype);
  const calls = [];
  const inspection = {
    Config: { User: '1000:1000', WorkingDir: '/app', Env: ['TOKEN=secret-value'] },
    State: { Running: true, Paused: false },
  };
  const candidate = { Id: 'container-id', Names: ['/web'], Labels: { 'halfcloud.managed': 'true', 'halfcloud.service.id': 'service_web' } };
  const container = {
    id: candidate.Id,
    inspect: async () => inspection,
    exec: async (options) => {
      calls.push(options);
      return {
        start: async (options) => { calls.push(options); return stream; },
        inspect: async () => ({ Running: running, ExitCode: exitCode }),
      };
    },
  };
  service.docker = {
    modem: new Docker().modem,
    listContainers: async () => [candidate],
    getContainer: () => container,
  };
  return { service, calls, inspection, candidate, stream, container };
}

test('executes directly as the configured user and demultiplexes stdout/stderr, redacting split secrets', async () => {
  const data = Buffer.concat([frame(1, 'hello secret-value\n'), frame(2, 'warning\n')]);
  const f = fixture({ frames: [data.subarray(0, 5), data.subarray(5, 18), data.subarray(18)] });
  const result = await f.service.runServiceCommand('service_web', ['node', '--version', '']);
  assert.deepEqual(f.calls, [
    { Cmd: ['node', '--version', ''], AttachStdout: true, AttachStderr: true, AttachStdin: false, Tty: false, Privileged: false, User: '1000:1000', WorkingDir: '/app' },
    { Detach: false, Tty: false },
  ]);
  assert.deepEqual(result, {
    containerId: 'container-id', output: 'hello [REDACTED]\nwarning\n', exitCode: 0,
    completed: true, running: false, truncated: false, timedOut: false, interrupted: false,
  });
  assert.equal(f.stream.destroyed, true);
});

test('returns failure output and the exit code without throwing away diagnostics', async () => {
  const f = fixture({ frames: [frame(2, 'command failed\n')], exitCode: 7 });
  const result = await f.service.runServiceCommand('web', ['false']);
  assert.equal(result.exitCode, 7);
  assert.equal(result.output, 'command failed\n');
  assert.equal(result.completed, true);
});

test('bounds output and redacts a secret prefix crossing the output limit', async () => {
  const f = fixture({ frames: [frame(1, `${'x'.repeat(32765)}secret-value`)] });
  const result = await f.service.runServiceCommand('web', ['report']);
  assert.equal(result.truncated, true);
  assert.equal(result.output, `${'x'.repeat(32765)}[REDACTED]`);
});

test('rejects unmanaged, stopped or paused containers and invalid arguments before execution', async () => {
  const f = fixture();
  for (const command of [[], [''], ['x\0y'], ['x'.repeat(4097)], Array(33).fill('x')]) {
    await assert.rejects(f.service.runServiceCommand('web', command), /arguments/);
  }
  for (const timeout of [0, 301, 1.5, NaN]) await assert.rejects(f.service.runServiceCommand('web', ['x'], timeout), /timeout/);
  f.inspection.State.Running = false;
  await assert.rejects(f.service.runServiceCommand('web', ['x']), /running/);
  f.inspection.State.Running = true;
  f.inspection.State.Paused = true;
  await assert.rejects(f.service.runServiceCommand('web', ['x']), /unpaused/);
  f.candidate.Labels['halfcloud.managed'] = 'false';
  await assert.rejects(f.service.runServiceCommand('web', ['x']), /not found/);
  assert.deepEqual(f.calls, []);
});

test('timeout disconnects and reports a still-running command with no exit code', async () => {
  const f = fixture({ stream: new PassThrough(), running: true, exitCode: 0 });
  const result = await f.service.runServiceCommand('web', ['long-task'], 1);
  assert.equal(result.timedOut, true);
  assert.equal(result.running, true);
  assert.equal(result.completed, false);
  assert.equal(result.exitCode, null);
  assert.equal(f.stream.destroyed, true);
});

test('chat cancellation disconnects while preserving captured output and execution state', async () => {
  const controller = new AbortController();
  const f = fixture({ stream: new PassThrough(), running: true });
  const pending = f.service.runServiceCommand('web', ['long-task'], 60, controller.signal);
  setImmediate(() => { f.stream.write(frame(1, 'partial output')); controller.abort(); });
  const result = await pending;
  assert.equal(result.output, 'partial output');
  assert.equal(result.interrupted, true);
  assert.equal(result.running, true);
  assert.equal(f.stream.destroyed, true);
  const aborted = fixture();
  await assert.rejects(aborted.service.runServiceCommand('web', ['x'], 60, controller.signal), { name: 'AbortError' });
  assert.deepEqual(aborted.calls, []);
});

test('stream errors disconnect and propagate instead of reporting success', async () => {
  const f = fixture({ stream: new PassThrough() });
  const pending = f.service.runServiceCommand('web', ['x']);
  setImmediate(() => f.stream.destroy(new Error('connection failed')));
  await assert.rejects(pending, /connection failed/);
  assert.equal(f.stream.destroyed, true);
});
