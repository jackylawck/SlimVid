import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveAacAudioConfig,
  buildAacLcAudioSpecificConfig,
} from '../src/engines/mp4-scanner.js';

test('buildAacLcAudioSpecificConfig 正確編碼 48kHz 雙聲道與 44.1kHz 單聲道 AAC-LC', () => {
  assert.deepEqual(
    Array.from(buildAacLcAudioSpecificConfig(48000, 2)),
    [0x11, 0x90]
  );
  assert.deepEqual(
    Array.from(buildAacLcAudioSpecificConfig(44100, 1)),
    [0x12, 0x08]
  );
});

test('resolveAacAudioConfig 支援 Apple QuickTime .MOV 的 mp4a 音軌與 wave->esds', () => {
  // 模擬 QuickTime wave 原子內含 esds (oti=0x40, ASC=[0x11, 0x90])
  const waveData = new Uint8Array([
    0x00, 0x00, 0x00, 0x27, 0x65, 0x73, 0x64, 0x73, // size=39, 'esds'
    0x00, 0x00, 0x00, 0x00,                         // version + flags
    0x03, 0x19, 0x00, 0x00, 0x00,                   // ES_Descriptor
    0x04, 0x11, 0x40,                               // DecoderConfigDescriptor (oti=0x40)
    0x15, 0x00, 0x00, 0x00, 0x00, 0x01, 0xf4, 0x00, 0x00, 0x01, 0xf4, 0x00,
    0x05, 0x02, 0x11, 0x90,                         // DecoderSpecificInfo (48kHz stereo)
  ]);

  const movTrak = {
    mdia: {
      minf: {
        stbl: {
          stsd: {
            entries: [{ wave: { data: waveData } }],
          },
        },
      },
    },
  };

  const resolved = resolveAacAudioConfig(movTrak, {
    codec: 'mp4a',
    sampleRate: 48000,
    channelCount: 2,
  });

  assert.equal(resolved.isAac, true);
  assert.equal(resolved.codec, 'mp4a.40.2');
  assert.deepEqual(Array.from(resolved.description), [0x11, 0x90]);
});
