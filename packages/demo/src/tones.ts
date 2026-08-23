import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Writes short WAV files so the demo is audible on any machine with no assets,
 * no downloads and no dependencies. Not part of the library — just something
 * for the runtime to play.
 */
export async function writeTone(
  dir: string,
  name: string,
  frequency: number,
  seconds: number,
): Promise<string> {
  const sampleRate = 44_100;
  const total = Math.floor(sampleRate * seconds);
  const data = Buffer.alloc(total * 2);

  for (let i = 0; i < total; i++) {
    // Fade both ends, otherwise every track starts and stops with a click.
    const fade = Math.min(1, i / (sampleRate * 0.02), (total - i) / (sampleRate * 0.05));
    const sample = Math.sin((2 * Math.PI * frequency * i) / sampleRate) * 0.25 * fade;
    data.writeInt16LE(Math.round(sample * 0x7fff), i * 2);
  }

  const path = join(dir, `${name}.wav`);
  await writeFile(path, Buffer.concat([wavHeader(data.length, sampleRate), data]));
  return path;
}

function wavHeader(dataBytes: number, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // format: PCM
  header.writeUInt16LE(1, 22); // channels: mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(dataBytes, 40);
  return header;
}
