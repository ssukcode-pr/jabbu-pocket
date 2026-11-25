# 변경 기록

공개판에 나가는 변화를 새것부터 적습니다. 변경 하나에 한 줄을 `Unreleased` 아래에 더하고, 릴리스 때 그 줄들을 버전 제목(`## x.y.z — YYYY-MM-DD`) 아래로 옮깁니다.

## Unreleased

## 0.1.1 — 2026-11-25

> ⚠️ 올리기 전에 읽기: 이 판은 0.1.0과 호환되지 않는 변화가 있습니다. ① 내부 이름 `ompbot`·`kencrew` → jabbu 전면 변경(아래 "이름"의 이전 방법을 한 번 따라야 함). ② 장부 스키마가 **8 → 11**로 올라갑니다(9 옛 이름 값 이전, 10 `tasks.runtime`, 11 `inbound.state`의 `sending`). 첫 시작에 자동 이전되며, 11이 된 장부는 0.1.0으로 열 수 없습니다(`newer_schema`) — 올리기 전에 백업하세요. ③ 터널로 현황판을 보던 설치본은 `dashboard.allowedHosts`가 필요합니다.

- 메일박스: 턴 시작(prompt)이나 steer를 보내기 직전에 행을 `sending`으로 적습니다(write-ahead). 보내는 사이 프로세스가 끊기거나 prompt가 `request_timeout`으로 끝나면 그 행은 다시 보내지 않고 `uncertain`으로 남아, 같은 요청이 두 번 실행되지 않습니다. 시작한 턴의 장부 기록이 실패하면 자식을 멈추고 행을 보류합니다. 메일박스 경합 규칙은 TLA+ 모델(`spec/tla/mailbox`)로 CI에서 검사합니다.
- `[TASK]`: 로컬 `[TASK]`가 herdr 없이 헤드리스 런타임으로 돕니다. 막힌 PR 착지는 다시 시도 버튼과 끝 커밋이 바뀌면 자동 1회 재시도. PR로 착지하는 저장소의 머지 버튼은 'PR 올리기'로 표시하고, 같은 tip의 PR이 이미 열려 있으면 다른 카드의 버튼은 다시 착지하지 않습니다. 착지가 기준 브랜치를 합친 뒤 TLA+ 모델이 통과하면 `covered.blobs`를 자동으로 다시 기록합니다. git이 이름 바꾸기를 worktree 칸에 표시해도 원래 파일을 놓치지 않습니다.
- 작업 레인: 시작이 실패하면 레인을 닫고 worktree를 정리합니다. worktree·브랜치가 이미 없는 레인은 바로 폐기하고, 읽기 전용 폴더가 있어도 끝까지 지웁니다. 무결성 거부 상한에서 분류별 대표 1건을 먼저 보입니다.
- agy: 드라이버를 ACP(`agy acp`)로 바꿉니다. 첨부 이미지는 image 블록으로, 권한 요청은 allow_once로 답하고, 이어 받은 세션의 trajectory 유실을 한 번 복구합니다. 내장 계정 풀과 `--app-data-dir` 무중단 계정 전환을 더합니다.
- Discord: `mentionFreeChannels`가 `requireMention`보다 우선합니다. 봇이 연 스레드는 24시간 비활성 뒤 숨깁니다. 나뉘어 온 피어 봇 답을 요청 하나로 받습니다.
- 현황판: gzip 응답·해시 붙은 캐시 자산, 신호 4개(한도 소진 예측·편집 겹침·컨텍스트 사용률·7일 비용), 인박스 재그룹(숨김 판정·두 줄 행).
- 운영: `gates --ko`(경보용 한국어 마지막 줄), `wikiNotes.turns: false`로 대화 턴 위키 노트만 끄기, `jabbu_dispatch`가 reload된 `dispatchHosts`를 호출마다 읽음, 다른 홈의 apply는 살아 있는 잠금 보유자를 기다리지 않음, `doctor`의 코어 덤프 오경고 제거, omp-superkit SUPER 호출이 대화·레인에서 맞물림, 트레이스 단일 파싱과 고아 레인 worktree 진단. 24시간 지난 붙잡힌 전달의 resend는 이유와 함께 거절합니다.
- 수정: 글자 자르기(로그·카드·알림·레인 제목·감사 로그·inject 미리보기·`redactThenClip`)가 서로게이트 쌍을 가르지 않습니다. 폼 HTML 엔티티가 서로게이트 코드 포인트를 만들지 않습니다. 오너 질문 창이 열려 있는 동안 RPC 꼬리 대기를 닫지 않습니다. 겹침으로 건너뛴 모니터 스크립트 출력을 본 것으로 기록하지 않습니다. 실패한 백필 패스 중 요청된 후속 패스를 버리지 않습니다. 레인 history가 JSON이 아니어도 장부 게이트가 읽힙니다. 예시 모니터가 파이썬 3.11 미만에서 `Z` 시각을 읽습니다.
- CI: 최신 omp 일일 검사, arm64 잡, dependabot, TLA+ 모델 검사.
- 문서: 기여자용 [설계 코어](docs/architecture.md)를 더합니다(모듈 지도, 코어 불변식 I1~I14와 그 게이트, 보호 구역, 확장점, 여러 PR이 동시에 들어올 때의 규칙, 알려진 구조 부채). AGENTS.md·CONTRIBUTING.md·PR 양식이 이 문서를 가리킵니다.
- 현황판: `Host` 헤더가 `localhost`·`127.0.0.1`·`::1`(포트 무관)이 아니면 421로 답합니다(DNS rebinding으로 다른 이름의 웹 페이지가 현황판을 읽는 길을 막음). 터널의 공개 이름은 새 설정 `dashboard.allowedHosts`에 넣어야 합니다. 터널로 쓰던 설치본은 이 키를 넣고 `systemctl --user restart jabbu-dashboard`를 해야 계속 열립니다. 또 `Sec-Fetch-Site: cross-site`인 비-이동(스크립트) 요청은 403입니다. 링크 클릭 같은 이동 요청은 그대로 열립니다.
- 데몬 IPC 소켓: 요청 한 줄이 16 MiB(바이트)를 넘으면 줄바꿈이 왔든 안 왔든 버리고 연결을 닫습니다.
- 이름: 남아 있던 내부 이름 `ompbot`·`kencrew`를 모두 jabbu 이름으로 바꿉니다. 옛 이름을 같이 읽는 호환 코드는 없으니 기존 설치는 아래 순서로 한 번 옮겨야 합니다. 장부 스키마 버전이 9로 올라갑니다(옛 이름 값 일회성 이전, 9가 된 장부는 이전 버전으로 열 수 없습니다).

  | 예전 | 지금 |
  |---|---|
  | 명령 `ompbot <명령>` | `jabbu-pocket <명령>` (`bin`의 `ompbot` 항목 삭제) |
  | 환경변수 `OMPBOT_HOME`·`OMPBOT_*` | `JABBU_HOME`·`JABBU_*` |
  | 기본 홈 `~/.ompbot` | `~/.jabbu` |
  | 홈 안 `ompbot.db`·`ompbot.sock`·`ompbot.lock`·`logs/ompbot.log` | `jabbu.db`·`jabbu.sock`·`jabbu.lock`·`logs/jabbu.log` |
  | 백업 `ompbot-<stamp>.db`·`ompbot-bundle-<stamp>.tar.gz` | `jabbu-<stamp>.db`·`jabbu-bundle-<stamp>.tar.gz` |
  | systemd 유닛 `ompbot.service`·`ompbot-<인스턴스>`·`ompbot-backup`·`ompbot-gc`·`ompbot-dashboard` | `jabbu.service`·`jabbu-<인스턴스>`·`jabbu-backup`·`jabbu-gc`·`jabbu-dashboard` |
  | 도구 `ompbot_dispatch` 등 10종 | `jabbu_dispatch` 등 (접미사 그대로) |
  | `OMP_HOST_DRIVER=kencrew` | `OMP_HOST_DRIVER=jabbu-pocket` |
  | 영수증 `runtime.kencrew` | `runtime.source` |
  | 레인 대화 키 `ompbot/work/…`, 카드 버튼 `ompbot:…`, 위키 원천 id `ompbot-task-…` 등 | `jabbu/work/…`, `jabbu:…`, `jabbu-task-…` |
  | 일감 유닛 접두사 `ompbot-`·`kencrew-` | `jabbu-` (`kencrew-` 없음) |

  이전 방법: ① 봇을 멈추고(`systemctl --user stop ompbot…`) 홈을 통째로 백업합니다. ② 홈 디렉터리 이름을 `~/.jabbu`(여러 봇이면 `~/.jabbu-<이름>`)로 바꾸고 안의 `ompbot.db`(`-wal`·`-shm` 포함)를 `jabbu.db…`로, `backups/`의 백업 파일을 새 이름으로 바꾸며 남은 `ompbot.sock`·`ompbot.lock`은 지웁니다. ③ `config.json`·스크립트에 든 옛 홈 경로와 `OMPBOT_HOME`을 `JABBU_HOME`으로 고칩니다. ④ `JABBU_HOME=<홈> jabbu-pocket units render`로 새 유닛을 만들어 켜고 옛 `ompbot*` 유닛은 끕니다(새 코드의 `apply`·`!restart`는 옛 유닛을 보지 못합니다). ⑤ 장부는 첫 시작에 스키마 9(이 판 전체로는 11)로 자동 이전됩니다(레인 대화 키·위키 원천 id·영수증 `runtime` 키). 세션 기록 속 옛 도구 이름은 옮기지 않으니 대화마다 새 세션으로 시작하세요. 페르소나·모니터 지시문이 옛 도구 이름(`ompbot_*`)을 부르면 새 이름으로 고칩니다.

## 0.1.0 — 2026-11-24

- jabbu-pocket 첫 공개판입니다. 이전 이름 kencrew의 0.5.0을 이어받았고, 아래는 그 뒤에 바뀐 것입니다.
- 이름: 프로젝트 이름을 kencrew에서 jabbu-pocket으로 바꿉니다(npm 이름·문서·그림). 새 명령 `jabbu-pocket`이 기존 `ompbot`과 같은 진입점입니다. 홈 디렉터리·유닛·도구 이름·환경변수는 그대로입니다.
- 작업 레인: `ompbot_lane_progress` 보고에 `evidence: {file}`이 필요합니다(레인 worktree 안의 일반 파일, 링크·밖의 경로는 거부). 코어가 sha256을 계산해 보고와 함께 기록하고 현황판 레인 줄 툴팁에 보입니다. 증거가 없으면 `progress not recorded`로 기록하지 않습니다. `needsOwner: true` 보고만 증거 없이 받습니다.
- 같은 메시지 id가 다른 내용으로 다시 들어오면(첨부 URL의 서명 쿼리 `ex`·`is`·`hm`만 다른 경우는 제외) `inbound_identity_conflict` 경고를 남기고 `ompbot gates`에 최근 24시간 건수(`inbound_identity_conflicts`, 보고만 하고 열리지 않음)를 보입니다. 처리는 그대로 첫 행을 유지합니다. 장부 스키마 버전이 4로 올라갑니다(`inbound_conflicts` 표 추가).
- 작업 레인: 레인 등급이 고른 모델이 omp 모델 목록에 없으면(목록을 못 읽을 때도) 첫 프롬프트를 보내지 않고 레인을 시작 실패로 닫습니다(❌, worktree·브랜치 제거). 재개·후속 턴과 대화 세션은 그대로 경고 뒤 기본 모델로 돕니다.
- 작업 레인: 완료 주장 없이 끝난 턴에 보내던 자동 재촉을 없앴습니다. 설정 `lanes.completionNudges`는 더 이상 쓰이지 않습니다. 남아 있어도 로드는 되고, 시작 때 `config_warning`(`config_key_ignored`) 한 줄만 남습니다. `ompbot doctor`의 `lane nudges` 줄도 없어졌습니다.
- 작업 레인: 게시판 알림이 레인 세션에만 붙고, 최근 3개 본문(글마다 200자, 인용 펜스)을 함께 싣습니다. 실린 글만 읽음 처리합니다. 오너 대화 세션에는 자동 알림이 붙지 않고 `ompbot_board_read`로 직접 읽습니다.
- `ompbot apply`·`ompbot drain --wait`: SIGINT·SIGTERM·SIGHUP을 받으면 걸어 둔 drain을 풀고 128+시그널 번호로 끝납니다(데몬 재시작을 요청한 뒤에는 무시하고 끝까지 갑니다).
- `ompbot apply`: `systemctl`·`git` 명령에 제한 시간(120초, 로컬 git 60초)을 두고, 넘으면 프로세스 그룹째 끝내고 그 단계를 실패로 영수증에 남깁니다.
- `ompbot apply`: 재부팅 전에 남은 `apply.lock`은 pid가 다시 쓰이고 있어도 낡은 잠금으로 보고 넘겨받습니다. 롤백 기준 파일(`config.json.last-good`, `head.last-good` 등)은 fsync 뒤 원자적으로 씁니다.
- `ompbot gates`: 죽은 apply가 남긴 drain이 10분 넘게 풀리지 않으면 `drain_orphaned` 게이트가 열립니다.
