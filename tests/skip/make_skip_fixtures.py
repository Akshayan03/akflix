#!/usr/bin/env python3
"""Generated test seasons for skip-intro detection. No downloads, no copyrighted media: every sound is synthesized by
ffmpeg's lavfi sources (a melody for each season's intro and credits theme, seeded pink-noise "dialogue" and a seeded
score for each episode's own content).

    python3 make_skip_fixtures.py <out dir>

writes <out dir>/<season>/e<N>.<mp4|mkv> and <out dir>/truth.json:
  A  five episodes, the same 52 s intro after cold opens of 0 to 129 s, the same 46 s credits theme; every episode
     encoded differently (AAC 64-192 kb/s, 44.1 or 48 kHz, +-3 dB, MP4 or MKV).
  N  four episodes that must get NO intro: each has its own theme, and they share only things that are not an intro
     (a 4 s sting, 30 s of silence, a 25 s steady tone).
  B  three harder episodes of one theme: clean; dialogue over its first 8 s and its last 3 s cut; only its first 30 s.
  C  two episodes whose MKV chapters name the recap, the intro and the end credits.
Same arguments, same files (ffmpeg's generators are deterministic). `make_skip_fixtures.py <out> B` makes season B only
(and keeps the other seasons' entries in truth.json)."""

import json
import os
import subprocess
import sys

RATE = 44100


def run(args):
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *args], check=True)


def theme(seconds, base, step, rate_per_s, shift):
    """A melody: rate_per_s notes a second walking a scale by `step`, with harmonics, a bass line and a plucked
    envelope, as an aevalsrc expression."""
    n = f"floor(t*{rate_per_s})"
    semitone = f"(mod({n}*{step}+{shift}*floor({n}/8),12)+12*mod(floor({n}/4),2))"
    freq = f"({base}*pow(2,{semitone}/12))"
    env = f"exp(-5*mod(t,{1 / rate_per_s:.6f}))"
    voice = f"{env}*(sin(2*PI*{freq}*t)+0.45*sin(4*PI*{freq}*t)+0.2*sin(6*PI*{freq}*t))"
    bass = f"0.6*sin(2*PI*{base / 4}*pow(2,mod(floor(t/2)*{step + 2},12)/12)*t)"
    return f"aevalsrc=exprs='0.22*({voice})+0.12*({bass})':s={RATE}:d={seconds}"


def content(path, seconds, seed):
    """An episode's own audio: syllable-like bursts of band-limited pink noise over a quiet seeded score."""
    s = seed
    score = theme(seconds, 150 + (s * 37) % 140, 2 + s % 9, 1.5 + (s % 4) * 0.5, s % 7)
    graph = (
        f"anoisesrc=color=pink:seed={1000 + s}:amplitude=0.5:r={RATE}:d={seconds},highpass=f=280,lowpass=f=3200,"
        f"volume=eval=frame:volume='0.05+0.95*pow(abs(sin(t*PI*{2.1 + (s % 5) * 0.37:.3f}+{s})),3)"
        f"*gt(sin(t*{0.6 + (s % 3) * 0.21:.3f}+{s * 1.3:.3f}),-0.35)'[talk];"
        f"{score},volume=0.35[score];[talk][score]amix=inputs=2:normalize=0"
    )
    run(["-filter_complex", graph, "-ac", "1", "-ar", str(RATE), path])


def tone(path, seconds, freq):
    run(["-f", "lavfi", "-i", f"sine=frequency={freq}:sample_rate={RATE}:duration={seconds}", "-af", "volume=0.3", path])


def silence(path, seconds):
    run(["-f", "lavfi", "-i", f"anullsrc=r={RATE}:cl=mono", "-t", str(seconds), path])


def render(path, expression, seconds=None):
    run(["-f", "lavfi", "-i", expression, "-ac", "1", "-ar", str(RATE), *(["-t", str(seconds)] if seconds else []), path])


def concat(parts, path):
    inputs = []
    for part in parts:
        inputs += ["-i", part]
    graph = "".join(f"[{i}:a]" for i in range(len(parts))) + f"concat=n={len(parts)}:v=0:a=1"
    run([*inputs, "-filter_complex", graph, "-ac", "1", "-ar", str(RATE), path])


def duration_of(path):
    out = subprocess.run(["ffmpeg", "-hide_banner", "-i", path], capture_output=True, text=True).stderr
    for line in out.splitlines():
        if "Duration:" in line:
            h, m, s = line.split("Duration:")[1].split(",")[0].strip().split(":")
            return int(h) * 3600 + int(m) * 60 + float(s)
    raise RuntimeError(f"no duration for {path}")


def encode(audio, path, bitrate, rate, gain_db, chapters=None):
    seconds = duration_of(audio)
    args = ["-f", "lavfi", "-i", f"color=c=0x202020:s=128x72:r=5:d={seconds:.3f}", "-i", audio]
    if chapters:
        meta = path + ".ffmeta"
        with open(meta, "w") as f:
            f.write(";FFMETADATA1\n")
            for title, start, end in chapters:
                f.write(f"[CHAPTER]\nTIMEBASE=1/1000\nSTART={int(start * 1000)}\nEND={int(end * 1000)}\ntitle={title}\n")
        args += ["-i", meta, "-map_metadata", "2", "-map_chapters", "2"]
    args += ["-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-preset", "ultrafast", "-tune", "stillimage",
             "-af", f"volume={gain_db}dB", "-c:a", "aac", "-b:a", bitrate, "-ar", str(rate), "-shortest", path]
    run(args)
    if chapters:
        os.remove(path + ".ffmeta")
    return seconds


def trim(source, path, start, seconds):
    run(["-i", source, "-ss", str(start), "-t", str(seconds), "-ac", "1", "-ar", str(RATE), path])


def overlay(source, talk, path):
    run(["-i", source, "-i", talk, "-filter_complex", "[0:a][1:a]amix=inputs=2:duration=first:normalize=0",
         "-ac", "1", "-ar", str(RATE), path])


def main():
    out = os.path.abspath(sys.argv[1])
    only = set(sys.argv[2]) if len(sys.argv) > 2 else set("ANBC")
    work = os.path.join(out, "work")
    os.makedirs(work, exist_ok=True)
    truth = {}
    try:
        with open(os.path.join(out, "truth.json")) as f:
            truth = {k: v for k, v in json.load(f).items() if v["season"] not in only}
    except (OSError, ValueError):
        pass
    if "A" in only:
        season_a(out, work, truth)
    if "N" in only:
        season_n(out, work, truth)
    if "B" in only:
        season_b(out, work, truth)
    if "C" in only:
        season_c(out, work, truth)
    with open(os.path.join(out, "truth.json"), "w") as f:
        json.dump(truth, f, indent=2, sort_keys=True)
    for name in os.listdir(work):
        os.remove(os.path.join(work, name))
    os.rmdir(work)
    print(f"{len(truth)} episodes in {out}")


def season_b(out, work, truth):
    """One 45 s theme, three ways: whole; under 8 s of dialogue with its last 3 s cut; its first 30 s only."""
    theme_b = os.path.join(work, "b-theme.wav")
    render(theme_b, theme(45, 247, 5, 4, 5))
    credits_b = os.path.join(work, "b-credits.wav")
    render(credits_b, theme(40, 196, 4, 3, 2))
    talk = os.path.join(work, "b-talk.wav")
    content(talk, 8, 700)
    os.makedirs(os.path.join(out, "B"), exist_ok=True)
    versions = []
    whole = theme_b
    versions.append((whole, 45, 0))
    head = os.path.join(work, "b-head.wav")
    overlay(theme_b, talk, head)  # dialogue mixed over the first 8 s
    cut = os.path.join(work, "b-cut.wav")
    trim(head, cut, 0, 42)
    versions.append((cut, 42, 8))
    short = os.path.join(work, "b-short.wav")
    trim(theme_b, short, 0, 30)
    versions.append((short, 30, 0))
    colds = [64.21, 23.9, 147.6]
    for index, ((intro, length, talked), cold) in enumerate(zip(versions, colds), start=1):
        cold_part = os.path.join(work, f"b{index}-cold.wav")
        content(cold_part, cold, 800 + index)
        body = os.path.join(work, f"b{index}-body.wav")
        content(body, 350 + index * 17, 900 + index)
        audio = os.path.join(work, f"b{index}.wav")
        concat([cold_part, intro, body, credits_b], audio)
        name = f"B/e{index}.mp4"
        seconds = encode(audio, os.path.join(out, name), ["128k", "64k", "96k"][index - 1], [48000, 44100, 48000][index - 1], 0)
        truth[name] = {"season": "B", "episode": index, "duration": round(seconds, 3),
                       "intro": [cold, cold + length], "intro_clean_from": cold + talked,
                       "credits": [cold + length + 350 + index * 17, seconds]}


def season_a(out, work, truth):
    # Season A: shared intro and credits themes.
    intro_a, credits_a = os.path.join(work, "a-intro.wav"), os.path.join(work, "a-credits.wav")
    render(intro_a, theme(52, 220, 7, 4, 3))
    render(credits_a, theme(46, 330, 5, 3, 1))
    plan = [  # cold open, content, bitrate, sample rate, gain, container
        (0.0, 380, "128k", 48000, 0, "mp4"),
        (37.37, 420, "96k", 44100, -3, "mkv"),
        (91.13, 360, "192k", 48000, 2, "mp4"),
        (12.5, 400, "64k", 44100, 3, "mp4"),
        (128.9, 395, "160k", 48000, -2, "mkv"),
    ]
    os.makedirs(os.path.join(out, "A"), exist_ok=True)
    for index, (cold, body, bitrate, rate, gain, container) in enumerate(plan, start=1):
        parts = []
        if cold > 0:
            parts.append(os.path.join(work, f"a{index}-cold.wav"))
            content(parts[-1], cold, index)
        parts.append(intro_a)
        parts.append(os.path.join(work, f"a{index}-body.wav"))
        content(parts[-1], body, 50 + index)
        parts.append(credits_a)
        audio = os.path.join(work, f"a{index}.wav")
        concat(parts, audio)
        name = f"A/e{index}.{container}"
        seconds = encode(audio, os.path.join(out, name), bitrate, rate, gain)
        truth[name] = {"season": "A", "episode": index, "duration": round(seconds, 3),
                       "intro": [cold, cold + 52], "credits": [cold + 52 + body, seconds]}



def season_n(out, work, truth):
    # Season N: nothing that may be offered as an intro.
    sting = os.path.join(work, "n-sting.wav")
    render(sting, theme(4, 260, 3, 4, 2))
    hush = os.path.join(work, "n-silence.wav")
    silence(hush, 30)
    hum = os.path.join(work, "n-tone.wav")
    tone(hum, 25, 1000)
    os.makedirs(os.path.join(out, "N"), exist_ok=True)
    for index in range(1, 5):
        own = os.path.join(work, f"n{index}-theme.wav")
        render(own, theme(50, 180 + index * 23, 1 + index * 2, 3 + index % 2, index))
        cold = os.path.join(work, f"n{index}-cold.wav")
        content(cold, 20 + index * 11, 200 + index)
        body = os.path.join(work, f"n{index}-body.wav")
        content(body, 300, 300 + index)
        audio = os.path.join(work, f"n{index}.wav")
        concat([cold, sting, own, hush, hum, body], audio)
        name = f"N/e{index}.mp4"
        seconds = encode(audio, os.path.join(out, name), ["96k", "128k", "64k", "160k"][index - 1], 44100, 0)
        truth[name] = {"season": "N", "episode": index, "duration": round(seconds, 3), "intro": None, "credits": None}



def season_c(out, work, truth):
    # Season C: chapters name everything.
    os.makedirs(os.path.join(out, "C"), exist_ok=True)
    for index in range(1, 3):
        recap = os.path.join(work, f"c{index}-recap.wav")
        content(recap, 40, 400 + index)
        intro = os.path.join(work, f"c{index}-intro.wav")
        render(intro, theme(30, 200 + index * 40, 3 + index, 4, index))
        body = os.path.join(work, f"c{index}-body.wav")
        content(body, 330, 500 + index)
        credits = os.path.join(work, f"c{index}-credits.wav")
        content(credits, 40, 600 + index)
        audio = os.path.join(work, f"c{index}.wav")
        concat([recap, intro, body, credits], audio)
        total = 40 + 30 + 330 + 40
        chapters = [("Previously On", 0, 40), ("Opening", 40, 70), ("Episode", 70, 400), ("End Credits", 400, total)]
        name = f"C/e{index}.mkv"
        seconds = encode(audio, os.path.join(out, name), "128k", 48000, 0, chapters)
        truth[name] = {"season": "C", "episode": index, "duration": round(seconds, 3), "recap": [0, 40],
                       "intro": [40, 70], "credits": [400, seconds], "chapters": True}


if __name__ == "__main__":
    main()
