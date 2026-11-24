# 변경 기록

공개판에 나가는 변화를 새것부터 적습니다. 변경 하나에 한 줄을 `Unreleased` 아래에 더하고, 릴리스 때 그 줄들을 버전 제목(`## x.y.z — YYYY-MM-DD`) 아래로 옮깁니다.

## Unreleased

- 현황판: `Host` 헤더가 `localhost`·`127.0.0.1`·`::1`(포트 무관)이 아니면 421로 답합니다(DNS rebinding으로 다른 이름의 웹 페이지가 현황판을 읽는 길을 막음). 터널의 공개 이름은 새 설정 `dashboard.allowedHosts`에 넣어야 합니다. 터널로 쓰던 설치본은 이 키를 넣고 `systemctl --user restart ompbot-dashboard`를 해야 계속 열립니다. 또 `Sec-Fetch-Site: cross-site`인 비-이동(스크립트) 요청은 403입니다. 링크 클릭 같은 이동 요청은 그대로 열립니다.
- 데몬 IPC 소켓: 요청 한 줄이 16 MiB(바이트)를 넘으면 줄바꿈이 왔든 안 왔든 버리고 연결을 닫습니다.

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
