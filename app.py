import json
import re
import subprocess
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, Response
from PIL import Image
from pydantic import BaseModel

import core

ROOT = Path(__file__).parent
DATA = ROOT / "data"
app = FastAPI()


class LoadReq(BaseModel):
    url: str


class ExtractReq(BaseModel):
    id: str
    top: int
    bottom: int


class Seg(BaseModel):
    start: float
    end: float


class PdfReq(ExtractReq):
    mask: bool
    lines: list[Seg]


def video_path(vid):
    if not re.fullmatch(r"[\w-]{11}", vid) or not (DATA / vid / "video.mp4").exists():
        raise HTTPException(404, "영상을 먼저 불러오세요")
    return str(DATA / vid / "video.mp4")


@app.get("/")
def index():
    return FileResponse(ROOT / "static" / "index.html")


@app.post("/api/load")
def load(req: LoadReq):
    m = re.search(r"(?:v=|youtu\.be/|shorts/|embed/)([\w-]{11})", req.url)
    if not m:
        raise HTTPException(400, "유튜브 URL 에서 영상 ID 를 찾지 못했습니다")
    vid = m.group(1)
    folder = DATA / vid
    meta = folder / "meta.json"
    if meta.exists():
        return json.loads(meta.read_text())

    folder.mkdir(parents=True, exist_ok=True)
    r = subprocess.run([
        "yt-dlp", "-f", "bv*[height<=1080][vcodec^=avc1]/bv*[height<=1080]/b[height<=1080]",
        "--remux-video", "mp4", "-o", str(folder / "video.%(ext)s"), "--no-playlist",
        f"https://www.youtube.com/watch?v={vid}"], capture_output=True, text=True)
    video = folder / "video.mp4"
    if r.returncode != 0 or not video.exists():
        raise HTTPException(500, "다운로드 실패 (yt-dlp -U 로 업데이트해 보세요)\n" + r.stderr[-1500:])

    duration, w, h = core.probe(str(video))
    info = {"id": vid, "duration": duration, "width": w, "height": h,
            "region": core.detect_region(str(video), duration, w, h)}
    meta.write_text(json.dumps(info))
    return info


@app.get("/api/frame/{vid}")
def frame(vid: str, t: float = 0):
    return Response(core.frame_jpeg(video_path(vid), t), media_type="image/jpeg")


@app.post("/api/extract")
def extract(req: ExtractReq):
    return core.extract(video_path(req.id), req.top, req.bottom)


def line_png(vid, start, end, top, bottom, mask):
    """줄 이미지 PNG 경로. 같은 조건은 캐시를 재사용한다."""
    video = video_path(vid)
    cache = DATA / vid / "cache" / f"{start:.2f}_{end:.2f}_{top}_{bottom}_{int(mask)}.png"
    if not cache.exists():
        cache.parent.mkdir(exist_ok=True)
        img = core.render_line(video, start, end, top, bottom, bool(mask))
        cache.write_bytes(core.png_bytes(img))
    return cache


@app.get("/api/line/{vid}")
def line(vid: str, start: float, end: float, top: int, bottom: int, mask: int = 1):
    return FileResponse(line_png(vid, start, end, top, bottom, mask), media_type="image/png")


@app.post("/api/pdf")
def pdf(req: PdfReq):
    video_path(req.id)
    w = json.loads((DATA / req.id / "meta.json").read_text())["width"]
    images = [Image.open(line_png(req.id, s.start, s.end, req.top, req.bottom, req.mask)) for s in req.lines]
    return Response(core.make_pdf(images, w), media_type="application/pdf",
                    headers={"Content-Disposition": f'attachment; filename="{req.id}.pdf"'})
