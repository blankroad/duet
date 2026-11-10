# 원격 모듈 최종 결과

Opus 5.5 구현·Sol 6.1 리뷰, Herdr w7. **FE 승인 묶음만 main에 통합했다.** BE 작업은 원본 브랜치에 보존했다.

## 통합

FE1(R1): 사용자 이름의 @를 포함한 endpoint 파싱과 자동 재연결 뒤 활성 패널 갱신. FE2(R3): 호스트/암호 저장 실패 안내, 정확한 endpoint 세션의 연결 끊기, prototype 이름 별칭의 상태/닉네임 처리. 다른 이름만 같은 세션을 끊지 않도록 독립 테스트를 보강했다.

메인 FE1 22개, FE2 14파일75개 테스트 통과. 모두 IPC 모킹이며 실제 SSH 동작을 이 수치로 주장하지 않는다. sol-review-r1-fe.md → sol-review-r2-fe.md → sol-review-r3-fe.md 및 ../INTEGRATION.json이 근거다.

## 미통합 BE

G-10 세션 잠금/시간 제한, remote-03 링크 분류/순회, remote-11/25 검색, remote-12 sudo staging 수정은 전체 R2 CHANGES가 남아 있다. 특히 취소를 예정한 시간과 실제 취소 순서를 혼동한 테스트 허용 범위 및 최종 재실행 근거가 해결되지 않았다. 일부 Docker/단위 테스트 성공은 전체 승인을 대신하지 않는다. sol-review-be-r2.md와 STATUS.md, remote-opus/_report/opus.md에 결과·후속을 보존했다.

사용 한도 이후 새 구현 모델로 전환하지 않았고 미승인 BE를 main에 넣지 않았다. 기존 endpoint/vault/ProxyJump 정체성, 끊긴 탭의 작업, 원격 편집 충돌 등은 ../research/BACKLOG.md에 남아 있다.
