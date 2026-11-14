# yt-score

유튜브 악보(TAB) 영상을 한 줄씩 잘라 PDF 로 저장함.

## 웹 버전 (설치 없음)

https://fre5h99.github.io/yt-score/ (Chrome·Edge 데스크톱)

1. "탭 공유 시작"으로 유튜브 탭을 공유함. 영상 화질 1080p, 극장 모드나 전체화면 권장
2. 파란 박스(자동 감지)의 위·아래 경계를 필요하면 조정함
3. "녹화 시작" 뒤 유튜브를 처음부터 재생하고, 끝나면 "정지"
4. 줄 목록에서 체크·편집(구간·분할·병합) 뒤 "PDF 저장"

로컬 mp4 는 "영상 파일 열기"로 같은 처리를 함. 영상과 이미지는 브라우저 밖으로 나가지 않음.
소스는 `docs/` (빌드 없음). 로컬 확인: `python3 -m http.server -d docs`

## 로컬 버전 (yt-dlp·ffmpeg 필요)

```
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/uvicorn app:app
# http://localhost:8000
```
