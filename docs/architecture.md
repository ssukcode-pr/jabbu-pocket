# jabbu-pocket 설계 코어

[← README](../README.md) · [사용 설명서](guide.md) · [기여 안내](../CONTRIBUTING.md)

이 문서는 코드를 고치는 사람(사람·에이전트)이 PR을 보내기 전에 읽는 설계 기준이다. 동작 설명은 [사용 설명서](guide.md)에, 메일박스 경합 규칙의 형식 모델은 [spec/tla/mailbox](../spec/tla/mailbox/README.md)에 있다. 이 문서와 코드가 어긋나면 코드와 그 게이트(테스트·`bun run check`·TLA+)가 기준이고, 이 문서를 같은 PR에서 고친다.

## 1. 한 줄 요약

오너 한 명의 채팅 메시지를 **장부(SQLite)에 먼저 적고**, 대화(origin)마다 하나뿐인 **직렬 액터(Mailbox)** 가 그 행을 omp 자식 프로세스의 턴으로 넘기고, 답을 다시 **전달 장부(deliveries)** 에 적은 뒤 채널 어댑터의 **펌프**가 플랫폼에 보낸다. 모든 상태 변화는 장부 전이로 남으므로 재시작·충돌 뒤에도 같은 장부에서 이어 간다.

```
Discord ──▶ channel adapter ──▶ CoreSink(daemon-sink) ──▶ store: inbound(pending)
                                                            │
                                     OriginRouter ──▶ Mailbox(origin 하나에 하나, 직렬)
                                                            │ sending(write-ahead) → prompt/steer
                                                            ▼
                                                    OmpSessionDriver ──▶ omp --mode rpc (stdio)
                                                            │ final
                                                            ▼
                     store: deliveries(pending) ◀── answered
                            │
                            ▼
                channel pump(claim → send → confirm/fail/defer) ──▶ Discord
```

## 2. 모듈 지도

| 디렉터리 | 맡는 일 | 들어가는 곳 |
| --- | --- | --- |
| `src/main.ts`, `src/cli/` | 명령줄 진입점(`daemon`·`apply`·`tasks`·`lanes`·`doctor` 등) | `src/cli/index.ts` |
| `src/daemon/` | 배선: store·라우터·어댑터·유닉스 소켓·타이머를 묶고, 시작 시 복구·종료 시 drain | `daemon.ts`, `recovery.ts`, `daemon-sink.ts` |
| `src/core/` | 대화 하나의 직렬 액터(`Mailbox`)와 origin 라우팅, 채팅 명령, 세션 epoch | `mailbox.ts`, `origin.ts`, `mailbox-sending.ts` |
| `src/omp/` | omp·agy 자식과의 경계. omp 패키지를 import하지 않고 공개 stdio RPC만 말한다 | `driver.ts`(`OmpSessionDriver`), `rpc-client.ts`, `agy-driver.ts` |
| `src/channel/` | 플랫폼과 무관한 어댑터 계약과 공용 전달 펌프 | `adapter.ts`(`ChannelAdapter`), `port.ts`(`ChannelPort`), `types.ts`(`CoreSink`), `pump.ts` |
| `src/discord/` | Discord 어댑터(게이트웨이·REST·카드·백필) | `adapter.ts` |
| `src/store/` | 장부: 스키마, 상태 전이, 행 읽기·쓰기 | `db.ts`, `transitions.ts`, `schema-version.ts` |
| `src/safety/` | 승인·질문 카드, 호스트 도구, 비밀 색인, 인젝션 경고, 안전 바닥글 | `approval.ts`, `host-tools.ts`, `prompt.ts` |
| `src/redact.ts` | 비밀 마스킹(로그·DB·전송 전부) | — |
| `src/tasks/`, `src/lanes/`, `src/dispatch/`, `src/flow/` | 작업 위임: `[TASK]` 상태 문서·스윕·착지, 작업 레인(worktree·PR 착지), `jabbu_dispatch` | `tasks/sweeper.ts`, `lanes/manager.ts`, `dispatch/tool.ts` |
| `src/monitors/` | cron·at·script·watcher·webhook 트리거 모니터 | `scheduler.ts`, `spec.ts` |
| `src/ops/` | apply·백업·복구·gc·건강 게이트·동결·비용 상한 | `apply.ts`, `gates.ts`, `freeze.ts` |
| `src/dashboard/` | 루프백 전용 **읽기 전용** 현황판 | `server.ts`, `snapshot.ts` |
| `src/review/`, `src/wiki/` | 스킬 리뷰·개선 후보, 위키 노트 outbox | — |
| `src/release/` | 공개로 나가는 변경의 누출 검사(denylist·gitleaks·죽은 링크·외부 코드 표지) | `leak-check.ts` |
| `src/config*.ts` | 설정 읽기·검증·옛 키 거부 | `config.ts`, `config-validate.ts` |
| `src/dev/`, `scripts/` | 저장소 게이트(LOC 래칫·시험 sleep·TLA+ 덮인 파일) | `check-loc.ts`, `test-sleeps.ts`, `scripts/tla-covered.ts` |

## 3. 코어 불변식

PR이 아래 중 하나를 깨면 기능이 맞아 보여도 받지 않는다. "게이트" 칸은 깨질 때 실패하는 검사다. 게이트가 "리뷰"뿐인 항목은 리뷰어가 직접 본다.

| # | 불변식 | 지키는 곳 | 게이트 |
| --- | --- | --- | --- |
| I1 | inbound 행 하나는 omp 턴에 많아야 한 번 들어간다. 닿았을 수 있는 행은 `uncertain`으로 남고 자동으로 다시 보내지 않는다(오너의 `/queue retry`만) | `core/mailbox-sending.ts`(write-ahead `sending`), `daemon/recovery.ts` | TLA+ `DispatchAtMostOnce`, 테스트 |
| I2 | pending 행은 결국 pending을 벗어난다(재시작 drain 중에 들어온 행 포함) | `core/mailbox.ts` `#drain`·`resumePending` | TLA+ `NoLostRow` |
| I3 | 한 origin의 새 턴은 받은 순서대로 시작하고, 한 origin에는 동시에 턴이 하나뿐이다 | `Mailbox`의 단일 promise 체인 | TLA+ `OriginFifo`, `SingleTurnPerOrigin` |
| I4 | 전달 하나는 많아야 한 번 `confirmed`. `failed_ambiguous`는 자동 사건으로 움직이지 않고 오너(`ack`·`resend`)만 옮긴다. 429는 시도 횟수를 올리지 않는다 | `store/transitions.ts` `transitionDelivery`, `channel/pump.ts` | TLA+ `DeliveryAtMostOnce`, 테스트 |
| I5 | 장부 상태는 정해진 전이표로만 바뀐다(`INBOUND_TRANSITIONS`, `transitionDelivery`). 새 상태·전이는 표와 TLA+ 모델을 같이 고친다 | `store/transitions.ts` | `assertInboundTransition`, 테스트, `tla-covered` |
| I6 | 스키마(표·컬럼·인덱스)를 바꾸면 `SCHEMA_VERSION`을 1 올리고, 더 새 스키마 DB는 쓰기 열기에서 `newer_schema`로 거부한다 | `store/schema-version.ts`, `store/db-schema.ts` | `test/schema-version.test.ts` |
| I7 | omp를 포크·패치·import하지 않는다. 공개 stdio RPC로만 말한다 | `omp/rpc-client.ts` | CI `e2e-omp-mock`(`test/omp-mock.e2e.test.ts`, 진짜 omp + 가짜 모델). `test/omp-rpc.contract.test.ts`는 `JABBU_E2E_OMP=1`(`bun run smoke-omp`, 모델 비용)일 때만 돌고 CI에서는 skip |
| I8 | 사람은 오너 한 명만 받는다. 오너가 아닌 사용자의 메시지·버튼·파일은 무시하거나 거절한다. 예외는 설정한 피어 봇(`channels.discord.peerBots`)의 서버 채널 멘션뿐이고, 피어 봇이 쓴 대화의 자식은 줄어든 호스트 도구만 받는다 | `discord/adapter.ts`(오너·`peerBots` 판정), `daemon/daemon-host-tools.ts` `peerTouched`·`hostToolsFor` | 테스트 |
| I9 | 비밀값은 로그·DB·채팅 전송 어디에도 원문으로 나가지 않는다. 마스킹은 끄는 스위치가 없다. 공개로 나가는 diff는 누출 검사(denylist·gitleaks·죽은 링크)를 거친다 | `redact.ts`, `safety/secret-index.ts`, `safety/host-tools.ts` `checkUploadable`, `release/leak-check.ts`(PR 착지의 머지 직전 검사) | 테스트(CI는 gitleaks를 누출 검사기 *시험용*으로만 설치하고 PR diff 자체를 gitleaks로 훑지는 않는다) |
| I10 | 루프백 밖으로 여는 HTTP는 없다. 현황판(읽기 전용)과 webhook 모니터 리스너 둘뿐이고 `bind`는 `127.0.0.1`·`::1`만 허용한다. 데몬 IPC는 `0600` 유닉스 소켓, 데몬은 홈마다 하나(잠금) | `dashboard/server.ts`·`host-guard.ts`, `monitors/webhook.ts`, `config.ts`(`bind` 검증), `daemon/ipc.ts`, `daemon/lock.ts` | 테스트 |
| I11 | 되돌릴 수 없거나 밖으로 나가는 일은 승인 카드를 거친다. 승인 장부는 영속이다 | `safety/approval.ts`, `safety/answer-ledger.ts` | 테스트 |
| I12 | 새 설정 키는 `LIVE_FIELDS`·`RESTART_FIELDS`·`CLI_FIELDS` 중 하나에 넣는다. 지운 키는 조용히 무시하지 않고 거부한다 | `daemon/reload-fields.ts`, `config-removed-keys.ts` | 컴파일 타임 가드(`daemon/reload.ts` `UnclassifiedField`) |
| I13 | 모듈 사이 import 순환 0건, `src` 파일 줄 수는 기준선 이하(새 파일 400줄), 쓰이지 않는 export 없음(`@public` 제외) | `biome.json`, `src/dev/check-loc.ts`, `knip.json` | `bun run check`, `bun run knip` |
| I14 | 시험은 시간 운에 기대지 않는다(고정 sleep 금지) | `src/dev/test-sleeps.ts` | `bun run check` |

## 4. 보호 구역

아래 파일은 위 불변식을 직접 들고 있다. 고치는 PR은 일반 변경보다 한 단계 더 한다.

| 파일 | 함께 할 일 |
| --- | --- |
| `scripts/tla-covered.ts`의 `COVERED` 목록(`core/mailbox.ts`·`mailbox-active-turn.ts`·`mailbox-types.ts`·`mailbox-commands.ts`·`mailbox-sending.ts`, `store/transitions.ts`·`db.ts`, `daemon/recovery.ts`, `channel/pump.ts`) | `Mailbox.tla`가 바뀐 동작을 여전히 모델링하는지 보고, `bun scripts/tla-check.ts --strict`가 통과한 뒤에만 `bun scripts/tla-covered.ts --record`. 모델이 실패하면 기록하지 않는다. 모델이 다루는 소스 파일을 새로 만들거나 쪼개면 `COVERED`에도 넣는다 |
| 스키마를 정의하는 파일(`CREATE TABLE`이 있는 곳): `store/db-schema.ts`·`legacy-ddl.ts`·`card-answers.ts`, `tasks/ledger-schema.ts`, `monitors/ledger.ts`, 그리고 `store/db-sending.ts`·`rename-migration.ts` | I6의 버전 올림과 이전 시험 |
| `release/leak-check.ts` | 누출 검사를 느슨하게 하는 변경(패턴 삭제·건너뛰기 조건 추가)은 그 이유와 대체 검사를 PR 본문에 적는다 |
| `dashboard/server.ts`·`host-guard.ts`, `monitors/webhook.ts`, `daemon/ipc.ts`, `daemon/lock.ts` | I10. 바인드 주소·권한·Host 검사·잠금을 느슨하게 하지 않는다. 바꾸면 거부되는 경우의 시험을 같이 넣는다 |
| `omp/rpc-client.ts`, `omp/rpc-driver.ts`, `omp/driver.ts` | `bun run test:omp-mock`(토큰 비용 없음)으로 실제 omp RPC 계약 확인 |
| `redact.ts`, `safety/*` | 비밀이 새는 경로·승인을 우회하는 경로가 생기지 않는지 적대 시험 추가 |
| `channel/adapter.ts`, `channel/port.ts`, `channel/types.ts` | 어댑터 계약이므로 Discord 어댑터와 테스트 전송(`discord/test-transport.ts`)을 같은 PR에서 맞춘다 |

## 5. 확장점

새 기능은 되도록 아래 자리에 붙인다. 코어(메일박스·장부 전이)를 고치지 않고 붙일 수 있으면 그 길을 고른다.

- **채널 어댑터:** `ChannelAdapter`(`channel/adapter.ts`)와 `ChannelPort`(`channel/port.ts`)를 구현하고, 전달은 공용 펌프(`channel/pump.ts`)에 플랫폼별 `DeliverySender`만 넘긴다. 범위 밖 어댑터(Telegram 등)는 [AGENTS.md](../AGENTS.md)를 따른다.
- **호스트 도구(omp가 부르는 jabbu 도구):** `safety/host-tools.ts`의 `HostToolDef`로 정의하고 `daemon/daemon-host-tools.ts`에서 대화별로 고른다.
- **모니터 트리거:** `monitors/spec.ts`의 트리거 합집합(`cron`·`at`·`script`·`watcher`·`webhook`)에 추가하고 `monitors/scheduler.ts`에서 돈다.
- **채팅 명령:** `core/types.ts` `parseCommand`와 `core/mailbox-commands.ts`.
- **설정 키:** `config.ts` 타입 → `config-validate.ts` 검증 → `daemon/reload-fields.ts` 분류(I12) → [사용 설명서](guide.md) 설정 표.
- **건강 게이트:** `ops/gates.ts`, 문턱은 `ops/gate-thresholds.ts`.

## 6. 여러 PR이 동시에 들어올 때

`main`은 PR 필수·선형 이력(squash)이다. 필수 체크(`test`, `e2e-omp-mock`)는 PR 브랜치 기준으로 돌므로, 서로 모르는 두 PR이 각각 초록이어도 합친 결과는 검사되지 않았을 수 있다. 그래서:

1. **머지 직전에 최신 `main`을 브랜치에 합치고(merge, rebase·force push 아님) CI가 다시 초록일 때 머지한다.** 오래된 기준의 초록은 증거가 아니다.
2. **한 PR은 한 가지 일만 한다.** 리팩터와 동작 변경, 서로 다른 결함 수정을 섞지 않는다. 겹치는 파일이 줄어 충돌과 리뷰 비용이 같이 준다.
3. **자주 겹치는 자리는 아래처럼 푼다.**

| 자리 | 충돌 때 할 일 |
| --- | --- |
| `SCHEMA_VERSION`(`store/schema-version.ts`) | 스키마 PR은 한 번에 하나만 연다. 먼저 머지된 PR이 번호를 가지고, 뒤 PR은 최신 `main` 위에서 다시 1 올리고 주석의 버전 목록도 이어 쓴다. 두 PR이 같은 번호를 쓰면 안 된다 |
| `src/dev/loc-baseline.json` | 손으로 합치지 않는다(충돌 표지가 남으면 `check-loc`이 JSON을 못 읽고 실패한다). `git checkout origin/main -- src/dev/loc-baseline.json`으로 main 본을 받은 뒤 `bun src/dev/check-loc.ts --update`로 줄어든 파일만 내리고 `bun src/dev/check-loc.ts`가 0으로 끝나는지 본다. 기준선은 내려가기만 하고, 넘으면 파일을 나눈다 |
| `spec/tla/mailbox/covered.blobs` | 손으로 합치지 않는다. 같은 식으로 main 본을 받은 뒤, 합친 트리에서 `bun scripts/tla-check.ts --strict` 통과 → `bun scripts/tla-covered.ts --record` |
| `CHANGELOG.md` `Unreleased` | 줄을 더하기만 한다. 충돌 나면 양쪽 줄을 모두 남긴다 |
| `docs/guide.md` 설정·명령 표 | 양쪽 행을 모두 남기고 표 순서를 맞춘다 |

4. **같은 결함을 두 PR이 고치면** 먼저 머지된 쪽을 기준으로 뒤 PR을 닫거나 남은 차이만 남긴다. 같은 함수를 두 가지 방식으로 고친 채 둘 다 머지하지 않는다.
5. **코어 자동 착지의 한계.** `[TASK]` PR 착지(`tasks/pr-land-task.ts`)는 기준 브랜치가 앞서 있으면 task 브랜치에 merge하고, 충돌이 없을 때만 TLA+ 모델 통과 뒤 `covered.blobs`를 자동으로 다시 기록한다(`tasks/land-tla-covered.ts`). merge 충돌(`covered.blobs` 충돌 포함)은 워커에게 되돌린다. 원격 호스트 TASK(`tasks/land-remote.ts`)와 작업 레인 PR 착지(`lanes/pr-land.ts`)는 이 자동 재기록을 하지 않는다. 레인 착지는 `gh pr merge`가 실패하면 재시도하지 않고 `held`로 멈춘다. 그래서 main 보호의 "최신 기준이어야 머지"(`strict`)는 착지가 기준 뒤처짐을 되돌림(`rework`)으로 처리하게 바뀌기 전까지 켜지 않는다. 그동안은 위 1번을 사람이 지킨다.

## 7. 알려진 구조 부채

- 파일 단위 import 순환은 0건이지만(I13), 디렉터리 단위로는 서로 기대는 쌍이 많다. 예: `store/db.ts`가 `dashboard/preview-line.ts`·`lanes/status.ts`·`monitors/ledger.ts`·`tasks/ledger.ts`를 import한다. 계층 규칙(아래층이 위층을 모름)을 강제하는 게이트는 아직 없다.
- 새 코드는 이 얽힘을 늘리지 않는다. 특히 `store`·`channel`·`omp`에서 `daemon`·`dashboard`·`lanes`·`tasks` 쪽으로 새 import를 더하지 않는다. 필요하면 공용 타입·순수 함수를 아래층으로 옮긴다.
