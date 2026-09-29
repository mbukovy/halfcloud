import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Capture the browser's actual composited pixels, never serialized DOM or foreignObject SVG.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output = resolve(process.argv[2] || fileURLToPath(new URL('halfcloud-product-video.mp4', import.meta.url)));
const scratch = await mkdtemp(join(process.env.RENDER_TMP || tmpdir(), 'halfcloud-frames-'));
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
});
let encoder;

try {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const original = OfflineAudioContext.prototype.startRendering;
    OfflineAudioContext.prototype.startRendering = async function (...args) {
      const buffer = await original.apply(this, args);
      window.renderedAudio = buffer;
      return buffer;
    };
  });
  const url = new URL('index.html', import.meta.url);
  url.search = '?clean&paused&t=0';
  await page.goto(url.href);
  await page.evaluate(async () => {
    await document.fonts.ready;
    const faces = await Promise.all([
      ...[400, 500, 600, 700, 800].map((weight) => document.fonts.load(`${weight} 24px Manrope`)),
      ...[400, 500].map((weight) => document.fonts.load(`${weight} 14px "DM Mono"`)),
    ]);
    if (faces.some((face) => !face.length)) throw new Error('Required fonts did not load. Refusing to render fallback typography.');
    document.querySelector('#sound').click();
  });
  await page.waitForFunction(() => window.renderedAudio, null, { timeout: 30000 });
  const wav = await page.evaluate(() => {
    const audio = window.renderedAudio;
    const channels = audio.numberOfChannels;
    const bytes = new Uint8Array(44 + audio.length * channels * 2);
    const header = new DataView(bytes.buffer);
    const text = (offset, value) => [...value].forEach((char, i) => bytes[offset + i] = char.charCodeAt(0));
    text(0, 'RIFF'); header.setUint32(4, bytes.length - 8, true);
    text(8, 'WAVE'); text(12, 'fmt '); header.setUint32(16, 16, true);
    header.setUint16(20, 1, true); header.setUint16(22, channels, true);
    header.setUint32(24, audio.sampleRate, true); header.setUint32(28, audio.sampleRate * channels * 2, true);
    header.setUint16(32, channels * 2, true); header.setUint16(34, 16, true);
    text(36, 'data'); header.setUint32(40, bytes.length - 44, true);
    const samples = Array.from({ length: channels }, (_, channel) => audio.getChannelData(channel));
    for (let i = 0; i < audio.length; i++) {
      for (let channel = 0; channel < channels; channel++) {
        const sample = Math.max(-1, Math.min(1, samples[channel][i]));
        header.setInt16(44 + (i * channels + channel) * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
      }
    }
    let binary = '';
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return btoa(binary);
  });
  const audioPath = join(scratch, 'soundtrack.wav');
  await writeFile(audioPath, Buffer.from(wav, 'base64'));
  encoder = spawn(process.env.FFMPEG_PATH || 'ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'image2pipe', '-framerate', '30', '-c:v', 'png', '-i', 'pipe:0',
    '-i', audioPath, '-map', '0:v:0', '-map', '1:a:0',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-threads', '4',
    '-pix_fmt', 'yuv420p', '-r', '30', '-frames:v', '900', '-t', '30',
    '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', output,
  ], { stdio: ['pipe', 'ignore', 'pipe'] });
  let encoderError = '';
  encoder.stderr.on('data', (chunk) => encoderError += chunk);
  const finished = new Promise((resolve, reject) => {
    encoder.on('error', reject);
    encoder.on('close', (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${encoderError}`)));
  });
  // Observe early process failures while capturing, without unhandled rejections.
  finished.catch(() => {});
  const referenceFrames = new Set([90, 204, 342, 444, 516, 654, 855]);
  for (let frame = 0; frame < 900; frame++) {
    await page.locator('#seek').evaluate((slider, time) => {
      slider.value = String(time);
      slider.dispatchEvent(new Event('input', { bubbles: true }));
    }, frame / 30);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const pixels = await page.screenshot({ type: 'png' });
    if (referenceFrames.has(frame)) await writeFile(join(scratch, `reference-${frame}.png`), pixels);
    await new Promise((resolve, reject) => encoder.stdin.write(pixels, (error) => error ? reject(error) : resolve()));
    if (frame % 90 === 0) console.log(`Captured ${frame}/900 frames`);
  }
  encoder.stdin.end();
  await finished;
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(JSON.stringify({ output, scratch, resolution: '1920x1080', fps: 30, frames: 900, duration: 30, browserErrors: errors }));
} finally {
  if (encoder && encoder.exitCode === null) encoder.kill();
  await browser.close();
}
