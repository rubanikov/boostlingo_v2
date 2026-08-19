import { describe, expect, it, vi } from 'vitest';
import type { AudioBufferSourceLike, AudioContextLike } from './gaplessPlayer';
import { createGaplessPlayer } from './gaplessPlayer';

function createFakeAudioContext(): AudioContextLike & { currentTime: number } {
  return {
    currentTime: 0,
    destination: {},
    createBuffer: vi.fn((_numberOfChannels: number, length: number, sampleRate: number) => {
      const channelData = new Float32Array(length);
      return {
        duration: length / sampleRate,
        getChannelData: () => channelData,
      };
    }),
    createBufferSource: vi.fn(
      (): AudioBufferSourceLike => ({
        buffer: null,
        connect: vi.fn(),
        start: vi.fn(),
      }),
    ),
  };
}

describe('createGaplessPlayer', () => {
  it('starts the first segment at the current audio time', () => {
    const context = createFakeAudioContext();
    const player = createGaplessPlayer(context);

    const source = player.schedule(new Float32Array(16000), 16000); // 1s @ 16kHz

    expect(source.start).toHaveBeenCalledWith(0);
  });

  it('schedules a second segment immediately after the first, with no gap or overlap', () => {
    const context = createFakeAudioContext();
    const player = createGaplessPlayer(context);

    player.schedule(new Float32Array(16000), 16000); // duration 1s, occupies [0, 1)
    const second = player.schedule(new Float32Array(8000), 16000); // duration 0.5s

    expect(second.start).toHaveBeenCalledWith(1);
  });

  it('chains a third segment after the second with no gap, even though currentTime has not advanced', () => {
    const context = createFakeAudioContext();
    const player = createGaplessPlayer(context);

    player.schedule(new Float32Array(16000), 16000); // ends at 1
    player.schedule(new Float32Array(8000), 16000); // ends at 1.5
    const third = player.schedule(new Float32Array(16000), 16000);

    expect(third.start).toHaveBeenCalledWith(1.5);
  });

  it('catches up to real time when playback has fallen behind the queue', () => {
    const context = createFakeAudioContext();
    const player = createGaplessPlayer(context);

    player.schedule(new Float32Array(16000), 16000); // queued end: 1
    context.currentTime = 5; // real playback has moved well past the queued end

    const source = player.schedule(new Float32Array(16000), 16000);

    expect(source.start).toHaveBeenCalledWith(5);
  });

  it('builds a mono buffer at the sample rate given for that segment', () => {
    const context = createFakeAudioContext();
    const player = createGaplessPlayer(context);

    player.schedule(new Float32Array(2205), 44100);

    expect(context.createBuffer).toHaveBeenCalledWith(1, 2205, 44100);
  });

  it('copies the decoded samples into the buffer channel data', () => {
    const context = createFakeAudioContext();
    const player = createGaplessPlayer(context);
    const samples = new Float32Array([0.1, -0.2, 0.3]);

    player.schedule(samples, 16000);

    const createdBuffer = (context.createBuffer as ReturnType<typeof vi.fn>).mock.results[0]
      .value as { getChannelData: (channel: number) => Float32Array };
    const copied = Array.from(createdBuffer.getChannelData(0));
    expect(copied).toHaveLength(3);
    copied.forEach((value, index) => expect(value).toBeCloseTo(samples[index], 5));
  });
});
