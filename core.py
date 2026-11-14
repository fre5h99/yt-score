"""영상 처리 로직. 웹과 무관한 순수 함수만 둔다."""
import io
import json
import subprocess

import numpy as np
from PIL import Image


def probe(video):
    """(duration, width, height)"""
    info = json.loads(subprocess.check_output([
        "ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=width,height:format=duration", "-of", "json", video]))
    s = info["streams"][0]
    return float(info["format"]["duration"]), s["width"], s["height"]


def frame_jpeg(video, t):
    return subprocess.check_output([
        "ffmpeg", "-loglevel", "error", "-ss", str(t), "-i", video,
        "-frames:v", "1", "-q:v", "3", "-f", "image2pipe", "-vcodec", "mjpeg", "-"])


def grab(video, top, bottom, fps, start=None, end=None, width=None):
    """[top, bottom) 영역을 잘라 RGB 프레임 배열 (N, h, w, 3) 로 반환. width 를 주면 축소."""
    _, W, _ = probe(video)
    top, bottom = top // 2 * 2, bottom // 2 * 2
    vf = f"fps={fps},crop={W}:{bottom - top}:0:{top}"
    w, h = W, bottom - top
    if width:
        h = round(h * width / W / 2) * 2
        w = width
        vf += f",scale={w}:{h}"
    cmd = ["ffmpeg", "-loglevel", "error"]
    if start is not None:
        cmd += ["-ss", str(start), "-to", str(end)]
    cmd += ["-i", video, "-vf", vf, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]
    raw = subprocess.check_output(cmd)
    return np.frombuffer(raw, np.uint8).reshape(-1, h, w, 3)


def detect_region(video, duration, W, H, n=20, contrast=30):
    """가로 직선(오선) 행이 몰린 가장 큰 덩어리를 찾아 위아래 여백을 붙인다."""
    gs = []
    for k in range(n):
        raw = subprocess.check_output([
            "ffmpeg", "-loglevel", "error", "-ss", str(duration * (k + 0.5) / n), "-i", video,
            "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "-"])
        if len(raw) == W * H:
            gs.append(np.frombuffer(raw, np.uint8).reshape(H, W).astype(np.int16))
    default = {"top": int(H * 0.7), "bottom": H}
    if not gs:
        return default
    g = np.stack(gs)
    c, up, dn = g[:, 2:-2], g[:, :-4], g[:, 4:]
    # 얇은 선: 위아래 양쪽보다 같은 방향으로 크게 다름. 한쪽만 다르면 경계(edge)
    thin = (np.minimum(up - c, dn - c) > contrast) | (np.minimum(c - up, c - dn) > contrast)
    line_score = (thin.mean(axis=2) >= 0.5).mean(axis=0)
    edge_score = ((np.abs(up - dn) > contrast).mean(axis=2) >= 0.5).mean(axis=0)
    rows = np.nonzero(line_score >= 0.1)[0] + 2
    if len(rows) == 0:
        return default

    # 간격 0.05H 이하로 이어진 행 묶음 중 점수 합이 가장 큰 것
    gap = H * 0.05
    groups, cur = [], [rows[0]]
    for y in rows[1:]:
        if y - cur[-1] > gap:
            groups.append(cur)
            cur = []
        cur.append(y)
    groups.append(cur)
    best = max(groups, key=lambda grp: line_score[np.array(grp) - 2].sum())
    y0, y1 = best[0], best[-1]

    # 위는 코드명이 들어가도록 넉넉히. 단 패널 경계 같은 edge 행은 넘지 않음
    top, bottom = max(0, int(y0 - H * 0.08)), min(H, int(y1 + H * 0.07))
    edges = np.nonzero(edge_score >= 0.5)[0] + 2
    above = edges[(edges > top) & (edges < y0 - 4)]
    below = edges[(edges < bottom) & (edges > y1 + 4)]
    if len(above):
        top = int(above.max()) + 3
    if len(below):
        bottom = int(below.min()) - 2
    return {"top": top // 2 * 2, "bottom": bottom // 2 * 2}


def segment(frames, fps, diff=40, ratio=0.04):
    """프레임 변화율이 ratio 를 넘으면 새 줄. [(start_sec, end_sec)]"""
    small = frames[:, ::2, ::2].mean(axis=3)
    segs, s = [], 0
    for i in range(1, len(frames)):
        if (np.abs(small[i] - small[s]) > diff).mean() > ratio:
            segs.append((s, i))
            s = i
    segs.append((s, len(frames)))
    return [(a / fps, b / fps) for a, b in segs]


def ink_mask(frames):
    """배경 제거: 잉크 픽셀 True. 여러 프레임에서 유지되는 무채색 글자/선만 남긴다."""
    f = frames.astype(np.int16)
    gray = f.mean(axis=3)
    sat = f.max(axis=3) - f.min(axis=3)
    if gray.mean() < 128:  # 어두운 배경 + 밝은 잉크
        return np.percentile(np.where(sat < 60, gray, 0), 20, axis=0) > 150
    return np.percentile(np.where(sat < 60, gray, 255), 50, axis=0) < 170


def extract(video, top, bottom, fps=2, width=640, min_len=1.0, min_ink=0.005, max_ink=0.1, dup=0.02):
    """줄 구간 목록 [{start, end, include, reason}]"""
    frames = grab(video, top, bottom, fps, width=width)
    lines, prev, prev_mask = [], None, None
    for start, end in segment(frames, fps):
        line = {"start": start, "end": end, "include": False, "reason": None}
        a, b = int(start * fps), int(end * fps)
        mask = ink_mask(frames[a:b])
        if end - start < min_len:
            line["reason"] = "transition"
        elif not min_ink <= mask.mean() <= max_ink:
            # 잉크가 거의 없거나(검은/빈 화면) 너무 많으면(로고·실사 화면) 악보가 아님
            line["reason"] = "empty"
        elif prev is not None and (mask != prev_mask).mean() < dup:
            # 같은 줄이면 더 긴 구간(페이드가 아닌 쪽)을 남긴다
            if end - start <= prev["end"] - prev["start"]:
                line["reason"] = "duplicate"
            else:
                prev.update(include=False, reason="duplicate")
        if line["reason"] is None:
            line["include"] = True
            prev, prev_mask = line, mask
        lines.append(line)
    return lines


def render_line(video, start, end, top, bottom, mask):
    """구간의 픽셀별 중앙값 이미지. mask=True 면 흑백 잉크만."""
    frames = grab(video, top, bottom, 4, start, end)
    if len(frames) == 0:
        frames = grab(video, top, bottom, 1, start, start + 0.5)
    if mask:
        return Image.fromarray(np.where(ink_mask(frames), 0, 255).astype(np.uint8))
    return Image.fromarray(np.median(frames, axis=0).astype(np.uint8))


def png_bytes(img):
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


def make_pdf(images, W, margin=40, gap=20):
    """폭 W, 높이 1.414W 페이지에 줄 이미지를 위에서부터 쌓는다."""
    PH, inner = int(W * 1.414), W - 2 * margin
    pages, page, y = [], None, margin
    for im in images:
        im = im.convert("RGB")
        im = im.resize((inner, round(im.height * inner / im.width)))
        if page is None or y + im.height > PH - margin:
            page, y = Image.new("RGB", (W, PH), "white"), margin
            pages.append(page)
        page.paste(im, (margin, y))
        y += im.height + gap
    if not pages:
        pages = [Image.new("RGB", (W, PH), "white")]
    buf = io.BytesIO()
    pages[0].save(buf, "PDF", save_all=True, append_images=pages[1:], resolution=150)
    return buf.getvalue()
