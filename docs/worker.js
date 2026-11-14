// 탭 캡처 프레임을 초당 4장으로 솎아 메인 스레드로 보낸다.
// Worker 는 페이지가 백그라운드 탭이어도 타이머 스로틀링을 받지 않는다.
onmessage = async ({ data: { readable, fps } }) => {
  const reader = readable.getReader();
  let next = 0;
  for (;;) {
    const { value: frame, done } = await reader.read();
    if (done) break;
    const t = frame.timestamp / 1e6;
    if (t >= next) {
      next += 1 / fps;
      if (next <= t) next = t + 1 / fps; // 첫 프레임이거나 프레임이 끊긴 뒤
      const bitmap = await createImageBitmap(frame);
      postMessage({ bitmap, t }, [bitmap]);
    }
    frame.close();
  }
  postMessage({ done: true });
};
