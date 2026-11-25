# 메일박스 TLA+ 모델

메일박스(`src/core/mailbox.ts` 등)의 dispatch·전달 경합 규칙을 `Mailbox.tla`로 모델링하고, TLC로 모든 끼어들기 순서를 검사한다. 테스트가 몇 가지 순서만 덮는 경합(재시작 drain, steer, uncertain 전달)을 모델 검사로 덮는 것이 목적이다.

## 실행

```sh
bun scripts/tla-check.ts            # Java가 없으면 skip (종료 코드 0)
bun scripts/tla-check.ts --strict   # Java가 없으면 실패. CI 환경변수가 있어도 같다
bun scripts/tla-covered.ts          # 덮인 파일 게이트 (bun run check에 들어 있다)
bun scripts/tla-covered.ts --record # 모델을 다시 본 뒤 covered.blobs를 새로 기록
```

- TLC: tlaplus 정식 릴리스 `v1.7.4`의 `tla2tools.jar`
  - URL: `https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar`
  - sha256: `936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88`
  - 롤링 프리릴리스(`v1.8.0`, `rolling`)는 쓰지 않는다. 받은 jar는 `~/.cache/jabbu-pocket/tla2tools-v1.7.4.jar`(또는 `JABBU_TLA_JAR`)에 두고, sha256이 다르면 다시 받는다.
- `Mailbox.cfg`는 위반 없이 끝나야 하고 고유 상태가 1,000,000개를 넘지 않아야 한다.
- `broken-*.cfg`·`finding-*.cfg`는 머리의 `\* expect: <규칙>`이 위반돼야 한다. 하나라도 어긋나면 종료 코드 1이다.
- CI(`.github/workflows/ci.yml`)의 test 잡이 temurin 21을 깔고 `--strict`로 돌린다.

## 규칙

| 규칙 | 뜻 | 깨지면 생기는 일 |
| --- | --- | --- |
| `DispatchAtMostOnce` | inbound 행 하나는 omp 턴에 많아야 한 번 들어간다. 재시작, 동결, 원장 쓰기 실패가 끼어들어도 같다. `#markOrPark`의 원장 쓰기 실패는 `uncertain`으로 남고 다시 보내지 않는다. 오너의 `/queue retry`만 새로 센다. | 같은 요청이 두 번 실행된다(push·게시·메일이 두 번 나갈 수 있다). |
| `NoLostRow` | pending 행은 결국 pending을 벗어난다(dispatched·uncertain 또는 그 뒤 상태). 재시작 drain 중에 들어온 행도 같다. | 오너 메시지가 답 없이 큐에 영영 남는다. |
| `OriginFifo` | 한 origin에서 새 턴을 시작하는 일반 행은 받은 순서대로 시작한다. steer로 합쳐진 행, peer·`/followup` 행, 동결로 보류된 자율 행, steer 상한으로 다음 턴에 넘어간 행, `/queue retry` 행은 뺀다. | 나중 지시가 먼저 실행돼 앞 지시를 덮거나 뒤집는다. |
| `SingleTurnPerOrigin` | 한 origin에는 동시에 턴이 하나뿐이다. `#startTurn`이 child를 띄우고 준비를 기다리는 사이도 센다. | 같은 세션에 child 둘이 붙어 작업 트리와 장부를 같이 쓴다. |
| `DeliveryAtMostOnce` | outbound delivery는 많아야 한 번 성공(confirmed)으로 기록된다. `rate_limited`는 시도 횟수를 유지한 채 pending으로 돌아간다. | 답이 두 번 확정되거나, 긴 429 차단만으로 확정 실패 상한에 닿아 답이 버려진다. |

## 일부러 깬 모델 (`broken-*.cfg`)

| 파일 | 깬 것 | 잡아야 할 규칙 |
| --- | --- | --- |
| `broken-replay-uncertain.cfg` | 원장 쓰기 실패 행을 `pending`으로 남긴다 | `DispatchAtMostOnce` |
| `broken-sticky-skip.cfg` | 한 번 건너뛴 행(동결 보류·steer 상한)을 계속 건너뛴다 | `NoLostRow` |
| `broken-any-order.cfg` | drain이 첫 행이 아닌 아무 행이나 고른다 | `OriginFifo` |
| `broken-no-start-guard.cfg` | child를 띄우는 동안에도 drain이 돈다 | `SingleTurnPerOrigin` |
| `broken-recover-confirmed.cfg` | 재시작 recover가 confirmed delivery도 pending으로 돌린다 | `DeliveryAtMostOnce` |
| `broken-rate-limit-counts.cfg` | `rate_limited`가 시도 횟수를 올린다 | `DeliveryAtMostOnce` |
| `broken-no-write-ahead.cfg` | prompt·steer 전에 `sending`을 쓰지 않는다(고치기 전 소스) | `DispatchAtMostOnce` |
| `broken-timeout-retry.cfg` | child에 닿은 뒤 `request_timeout`으로 끝난 prompt를 새 driver로 다시 보낸다(고치기 전 소스) | `DispatchAtMostOnce` |

## 고친 틈 (T-20261125-09)

이 모델이 처음 찾은 `DispatchAtMostOnce` 위반 두 건(옛 `finding-*.cfg`)은 소스에서 전송 전 write-ahead로 고쳤다. 아래 두 경로는 이제 환경 가정이 아니라 `Mailbox.cfg`에서 늘 일어날 수 있는 동작이고, 위반 없이 통과한다. 옛 finding 파일은 고치기 전 동작을 켜는 broken 모델로 이름을 바꿔, 규칙이 그 동작을 계속 잡는지 본다.

| 경로 | 고친 동작 (`src/core/mailbox-sending.ts`) | 깬 모델 |
| --- | --- | --- |
| 턴 시작(`#openTurn`의 `driver.prompt`)이나 steer를 기다리는 사이 apply drain cut·OOM·kill -9로 프로세스가 끝난다 → prompt/steer는 child에 닿았지만 `markDispatched` 전이다. | 보내기 직전에 행을 `sending`으로 적는다(`beginSend`, entry_cursor 함께). 새 프로세스의 `recoverDispatched`(`settleDeadProcessRows`)와 `resumePending`은 `sending` 행을 cut 기록과 상관없이 `uncertain`(`send_interrupted`)으로 두고 다시 보내지 않는다. | `broken-no-write-ahead.cfg` (`BugNoWriteAhead`) |
| `driver.prompt`가 `request_timeout`으로 끝났지만 child는 이미 받았다. | 행이 `sending`이므로 재시도하지 않고 `uncertain`(`prompt_timeout`)으로 두고 child를 멈춘다(`settleFailedSend`). 받지 않은 것이 확실한 `not_started`만 `pending`으로 되돌려 한 번 재시도하고, 이때 `sending`을 다시 쓴다. | `broken-timeout-retry.cfg` (`BugTimeoutRetry`) |

## 모델 범위와 줄인 것

- 크기: origin 2개, 행 3개, 계획 재시작 1회, steer 상한 1, delivery 1개. `Mailbox.cfg`의 고유 상태는 94,027개다(aarch64 4코어에서 liveness 포함 약 20초).
  - 1·2행은 o1이다. 3행은 Init에서 o1(steer 상한 이월)이나 o2(다른 origin과의 끼어들기)를 고른다.
  - 1행은 owner·auto·waiter를 다 고르고, 2행은 owner(1행 뒤의 FIFO 짝·steer 대상), 3행은 auto(동결 보류·상한 이월)다.
- 동작: 도착(`#handle`), drain(`#drain`의 건너뛰기·첫 행 dispatch), steer 경로(leafId 뒤 턴 끝 확인, `sending` write-ahead와 steer, steer 던짐, 턴 끝 뒤 기록, 원장 실패), 새 턴 경로(`sending` write-ahead와 prompt, 받지 않은 prompt 실패, 닿은 뒤 `request_timeout`, 원장 실패 시 child 정지), final 도착과 `#onFinal`/`#onExit` 정리, 동결·해제, `/queue retry`(`mailbox-commands.ts` `retryUncertain`), 계획 재시작(drain 모드 → 아무 단계에서나 끊김: busyTurns 0, cut, 전송 뒤 기록 전의 cut·kill -9 → `recoverDispatched`의 `sending`→`uncertain` → `resumePending`), delivery 전이(`store/transitions.ts` `transitionDelivery`, `channel/pump.ts`의 claim·confirm·fail·defer, 재시작 `recover`, 오너 `ack`·`resend`).
- 한 origin의 일은 직렬 체인에서 돈다. await 사이(leafId·steer·prompt 대기)만 단계로 나눠 다른 동작이 끼어들게 했다.
- 상태 수를 줄이려고 묶은 것(규칙 판정은 바뀌지 않는다):
  - peer 행과 `/followup` 행은 `waiter` 하나로 묶었다. 둘 다 steer되지 않고 턴이 없을 때까지 기다린다.
  - answered와 failed_notified는 `closed` 하나다. dispatched·closed 행의 kind·sends·fifoOut은 한 값으로 접는다.
  - drain을 부르는 곳(도착, 턴 끝, 재시작 `resumePending`, 정체 행 sweep, `/queue retry`)은 "고를 행이 있으면 언젠가 drain이 돈다"(약한 공정성)로 묶었다. 그래서 `NoLostRow`의 깬 판은 drain 호출 누락이 아니라 건너뛰기 조건 고착으로 만든다.
  - delivery는 inbound 변수와 공유하는 것이 없어, delivery는 inbound 행이 들어오기 전에만, inbound 행은 delivery가 처음 모양일 때만 움직이게 했다(두 쪽 상태를 곱하지 않고 더한다). 두 쪽 모두 재시작과의 순서는 모두 남는다.
  - steer가 던지면 child가 읽었다고 본다(최악의 경우로 sends를 센다).
  - write-ahead(`sending` 쓰기)와 전송은 한 단계다. 둘 사이에 끊기면 sends 0인 `sending` 행이 `uncertain`이 될 뿐이고(놓침, 두 번 실행 아님), 쓰기 실패는 보내지 않고 pending에 두어 drain 전과 같은 상태다.
  - 닿지 않은 `request_timeout`·`not_started`의 재시도(sends가 그대로다), 오너의 `/drop`·`/queue close`, 재시작 이어가기 행(`cut-<id>`, 새 글이라 재전송이 아니다)은 모델에 넣지 않았다.
  - `/queue retry`는 행마다 한 번이다(재시도·원장 실패가 끝없이 되풀이되는 고리를 막는다).

## 덮인 파일 게이트

`covered.blobs`는 모델이 다루는 파일 8개의 `git hash-object` 값이다. `bun run check`의 `bun scripts/tla-covered.ts`가 작업 트리와 대조해, 하나라도 바뀌면 바뀐 파일 이름을 출력하고 실패한다. 바뀐 동작이 모델과 맞는지 다시 보고 `bun scripts/tla-check.ts`로 확인한 뒤 `--record`로 다시 기록한다.
