import math
import struct
import wave

SAMPLE_RATE = 48000
DURATION = 10.0
CHANNELS = 2
FRAMES = int(SAMPLE_RATE * DURATION)

# A small original synth bed: restrained, dark, and rhythmic enough to support
# the UI without competing with the narration.
roots = [110.00, 146.83, 130.81, 98.00]
motif = [440.00, 523.25, 659.25, 587.33]


def tone(freq, t, amp, decay=1.0):
    return amp * math.sin(2.0 * math.pi * freq * t) * decay


def frame(t):
    section = min(int(t / 2.5), len(roots) - 1)
    root = roots[section]
    beat_pos = (t * 2.0) % 1.0  # 120 BPM
    pulse = math.exp(-beat_pos * 18.0)
    eighth = (t * 4.0) % 1.0
    click = math.exp(-eighth * 34.0)

    pad = (
        tone(root, t, 0.030, 0.72)
        + tone(root * 1.25, t, 0.019, 0.70)
        + tone(root * 1.50, t, 0.015, 0.68)
    )
    bass = tone(root / 2.0, t, 0.032, 0.55) * (0.45 + 0.55 * pulse)
    note = motif[int(t * 2.0) % len(motif)]
    lead = tone(note, t, 0.009, math.exp(-((t * 2.0) % 1.0) * 4.5))
    tick = tone(1760.0, t, 0.006, click)
    value = (pad + bass + lead + tick) * min(1.0, t / 0.35) * min(1.0, (DURATION - t) / 0.55)
    return max(-0.18, min(0.18, value))


with wave.open(r"C:\Users\USUARIO\Documents\github\fleetdeck-landing\video-poc\music-bed.wav", "wb") as out:
    out.setnchannels(CHANNELS)
    out.setsampwidth(2)
    out.setframerate(SAMPLE_RATE)
    for i in range(FRAMES):
        t = i / SAMPLE_RATE
        left = frame(t)
        right = frame(t + 0.0007) * 0.96
        out.writeframes(struct.pack('<hh', int(left * 32767), int(right * 32767)))

print('wrote music-bed.wav', FRAMES, 'frames')
