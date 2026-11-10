#!/usr/bin/env python3
"""One-shot, user-requested Herdr resume timer. No model/API calls until due."""
import datetime as dt
import fcntl
import json
from pathlib import Path
import shutil
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parent
DUE = dt.datetime.fromisoformat("2026-11-11T02:05:00+09:00")
STATUS = ROOT / "RESUME_STATUS.json"
HERDR = shutil.which("herdr")
PROMPT = (
    "사용자가 예약한 재개 시각(2026-11-11 02:05 Asia/Seoul)이 되었습니다. "
    "Duet UX 점검·수정 작업을 체크포인트에서 재개하세요. "
    "먼저 docs/reviews/2026-11-10-ux-smoke/{PAUSED.md,INTEGRATION.json,state.json,PROTOCOL.md}와 "
    "research/{REGISTRY,STATUS,CARGO_QUEUE}.md 및 각 팀 체크포인트를 읽으세요. "
    "Herdr --session duet를 사용하고, 실제 agent list를 확인하여 기존 Opus5.5 총괄과 구현 워커, "
    "Sol6.1 리뷰 워커를 깨우세요. 사용자는 Sol 구현 전환 대신 초기화 후 원래 모델 구성 유지를 선택했습니다. "
    "원래 과제는 여러 압축 파일의 현재 폴더 해제 및 Windows 다중선택 더보기 등 전체 모듈 UX 스모크 점검입니다. "
    "이미 main에 통합한 커밋을 중복 cherry-pick하지 말고 INTEGRATION.json과 git log를 대조하세요. "
    "최대3회 독립 리뷰 후 실제 검증된 변경만 통합하고 나머지는 중복 제거 대장에 남기세요. "
    "사용자 미커밋 src-tauri/src/fs/local.rs를 보존하세요. 빌드 자원은 최대2팀, 팀당 Cargo1개, "
    "Vitest worker1개로 제한하고 /tmp/duet-ux-target-ready의 별도 APFS 복제 캐시를 사용하세요. "
    "예약 타이머는 이미 이 메시지를 보낸 뒤 종료합니다. 재예약하지 말고 작업을 완료하세요."
)

def record(state, **extra):
    value = {"state": state, "due": DUE.isoformat(),
             "updated_at": dt.datetime.now(dt.timezone.utc).isoformat(), **extra}
    STATUS.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(value, ensure_ascii=False), flush=True)

if "--check" in sys.argv:
    assert HERDR, "herdr binary not found"
    assert DUE > dt.datetime.now(dt.timezone.utc), "resume time already passed"
    print("Timer configuration valid:", DUE.isoformat(), HERDR)
    raise SystemExit(0)

lock = (ROOT / "resume-timer.lock").open("a")
try:
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    raise SystemExit("Another resume timer is already running")
if STATUS.exists() and json.loads(STATUS.read_text()).get("state") == "sent":
    raise SystemExit("Resume already sent")
record("scheduled", pane="w2:p4", target="w1:p1")
while True:
    remaining = (DUE - dt.datetime.now(dt.timezone.utc)).total_seconds()
    if remaining <= 0:
        break
    time.sleep(min(30, remaining))

# Preserve existing approval dialogs: retry without sending keys or authorizing them.
for attempt in range(1, 121):
    try:
        result = subprocess.run(
            [HERDR, "--session", "duet", "agent", "prompt", "w1:p1", PROMPT],
            capture_output=True, text=True, timeout=20,
        )
        if result.returncode == 0:
            payload = json.loads(result.stdout)
            if "error" not in payload:
                record("sent", attempt=attempt, response=payload)
                raise SystemExit(0)
        record("retrying", attempt=attempt, error=(result.stderr or result.stdout)[-2000:])
    except (subprocess.TimeoutExpired, OSError, json.JSONDecodeError) as exc:
        record("retrying", attempt=attempt, error=str(exc))
    time.sleep(30)
record("failed", reason="Herdr main session unavailable after retries; manual resume needed")
raise SystemExit(1)
