# AGENTS.md

jabbu-pocket 저장소에서 일하는 에이전트가 지킬 규칙이다. 개요와 설치는 `README.md`, 동작 전체는 `docs/guide.md`, Discord 봇 설정은 `docs/discord.md`, 기여 절차는 `CONTRIBUTING.md`에 있다. 코드를 고치기 전에 `docs/architecture.md`(모듈 지도·코어 불변식·보호 구역·동시 PR 규칙)를 읽는다.

## 검증

- `bun test`(전체는 `bun run test`), `bun run check`(biome·tsc·시험 sleep·LOC), `bun run knip`(미사용 export). PR 전에 셋 모두 0으로 끝나야 한다.
- 모든 PR과 main push에서 `.github/workflows/ci.yml`이 같은 명령을 돌린다.

## 범위 밖 (만들지 않는다)

- omp를 포크하거나 패치하지 않는다. omp는 한 줄도 고치지 않고 공개 stdio RPC로만 말한다.
- Telegram 어댑터, 다중 사용자, 루프백 밖으로 여는 HTTP 엔드포인트, 쓰기 가능한 웹 UI·데스크톱 앱, 음성 전사.
- 허용: 루프백에만 여는 읽기 전용 현황판(`jabbu-pocket dashboard`)과 webhook 모니터 리스너, 오너 한 명의 DM·서버 채널만 받는 Discord 어댑터.
- 사람이 손으로 확인해야 하는 수락 기준.

## 비밀값

- 설치본 홈의 `secrets/*` 내용을 읽거나 출력하지 않는다. 로그·오류·시험 출력에 비밀값을 남기지 않는다.
- 시험의 봇 토큰 파일은 `TEST-discord-0` 같은 가짜 값만 쓰고(`test/helpers/bot-home.ts`), 마스킹 시험의 토큰 모양 문자열도 `xoxb-TEST-0`처럼 가짜로 만든다. 실제 토큰을 쓰는 시험 고정값을 두지 않는다.

## 작업 규칙

- 커밋은 파일 이름을 지정해 add한다. `git add -A`, `git add .`, `git commit -a`를 쓰지 않는다.
- 시간 의존 시험 금지: 고정 sleep 대신 이벤트를 구독하고 제한 시간을 둔 대기를 쓴다. 새 시험의 고정 sleep은 `bun run check`(`src/dev/test-sleeps.ts`)가 막는다. 부득이하면 그 줄이나 바로 앞 줄에 `// sleep-ok: <이유>` 표지를 붙인다.
- 시험 임시 파일은 `tmpdir()` 밑에 두고 실행이 끝나면 통째로 지운다.
- 스키마(표·컬럼·인덱스)를 바꾸는 커밋은 `src/store/schema-version.ts`의 `SCHEMA_VERSION`을 1 올린다. 더 새 스키마 DB는 쓰기 열기에서 `newer_schema`로 거부된다.
- 새 export는 쓰이거나 `@public`이어야 한다(`bun run knip`).
- PR 하나에 한 가지 일만 담는다. 머지 직전에 최신 `main`을 합치고(rebase·force push 아님) CI가 다시 초록인지 본다. `loc-baseline.json`·`covered.blobs`는 손으로 합치지 않는다. `git checkout origin/main -- <파일>`로 main 본을 받은 뒤 `bun src/dev/check-loc.ts --update`, `bun scripts/tla-check.ts --strict` 통과 뒤 `bun scripts/tla-covered.ts --record`로 다시 만든다(`docs/architecture.md` §6).
- `docs/architecture.md` §3 불변식을 바꾸는 변경은 같은 PR에서 그 문서와 게이트(테스트·TLA+ 모델)를 함께 고친다.
- 오너 승인 없이 push·npm publish·외부 배포를 하지 않는다.
