# 실환경 스모크 테스트 가이드

로컬 머신에서 v0.1 전체 기능을 실제 모델로 검증하는 절차입니다. 소요 시간은
인증 준비를 제외하면 15–20분 정도입니다.

> **요구 사항**: Node.js 20 이상, git. **Windows cmd, macOS, Linux 모두
> 네이티브 지원**합니다 (셸 명령은 POSIX에서는 bash, Windows에서는
> cmd.exe로 실행됩니다).

## 0. 설치 (Windows cmd / macOS / Linux 공통)

빌드 없이 저장소에 포함된 패키지 tarball을 전역 설치합니다 (한 줄):

```bash
npm install -g https://raw.githubusercontent.com/devFallingstar/kapel/main/release/devfallingstar-kapel-0.8.0.tgz
kapel --version
```

npm 레지스트리 배포 후에는 `npm install -g @devfallingstar/kapel` 로 대체됩니다.
URL 접근이 안 되는 네트워크라면: 레포를 클론한 뒤
`npm install -g ./kapel/release/devfallingstar-kapel-0.8.0.tgz`. 제거는
`npm uninstall -g @devfallingstar/kapel`.

> `npm install -g github:...` 형태는 쓰지 마세요 — npm의 워크스페이스
> git 의존성 처리 버그로 설치가 깨집니다(빈 명령어 증상). 이전에 그렇게
> 설치했다면 `npm uninstall -g orchestration-agent kapel` 후 위 방법으로
> 재설치하세요.

kapel은 **REPL 전용**입니다 — 에이전트 작업은 전부 `kapel`이 띄우는
프롬프트 안에서 일어나고, 셸의 명령들(`init`/`config`/`models`/`runs`/
`sessions`/`explain`/`policy`)은 설정과 조회만 합니다. 예전의 단발 실행
형태(`kapel "<objective>"`, `kapel exec/plan/orchestrate/resume/worker`)와
그 전용 플래그(`-i`, `-y`, `--system`, `--max-iterations`, 전역 `--json`,
`--sandbox`, `--worker-mode`)는 모두 제거되었습니다.

기여자용(소스 개발): 클론에서 `npm install && npm run build` 후
`node apps/cli/dist/index.js ...` 또는 `npm install -g .` 사용.
빠른 자체 점검: `npm test` → 1033개 테스트가 통과해야 합니다.

### Windows 참고

`bash` 도구와 검증기는 Windows에서 cmd.exe로 명령을 실행합니다 —
`&&`/`||`는 동작하지만 `export`, 백틱, `$(...)` 같은 POSIX 문법은 쓸 수
없습니다(에이전트에게도 도구 설명으로 안내됩니다). Git Bash나 WSL이
있다면 그쪽에서도 동일하게 동작합니다.

## 1. 인증 준비 (하나 이상)

| 경로 | 방법 | 확인 |
|---|---|---|
| Anthropic API 키 | `export ANTHROPIC_API_KEY=...` | `kapel models` 에 `api key` 표시 |
| Anthropic OAuth (키 없음) | [`ant` CLI](https://github.com/anthropics/anthropic-cli) 설치 후 `ant auth login` | `kapel models` 에 `oauth (ant)` 표시 |
| OpenAI (키 없음, Codex) | `npm i -g @openai/codex && codex login` (ChatGPT OAuth) | 시나리오 B에서 사용 |
| Anthropic (키 없음, Claude Code) | `npm i -g @anthropic-ai/claude-code` 후 `claude` 실행해 구독 로그인 | 시나리오 A-0/B2에서 사용 |

`kapel models` 로 각 모델 별칭의 자격증명 상태를 먼저 확인하세요.

## 1.5. 시나리오 A-0 — 첫 실행 마법사 (설정)

아직 설정한 적이 없는 머신에서 `kapel`을 터미널로 처음 실행하면, 어떤 백엔드와
모델을 쓸지 네 가지를 물어본 뒤 `~/.kapel/config.json`에 저장합니다. 깨끗한
상태에서 확인하려면 설정 디렉터리를 임시로 바꿔서 실행하세요:

```bash
export KAPEL_CONFIG_DIR=/tmp/kapel-smoke      # 실제 ~/.kapel 을 건드리지 않기 위함
kapel config --show                           # "not configured yet — run `kapel config`" + 경로, 종료 코드 0
kapel                                         # 목적 없이 실행 → 마법사가 먼저 뜸
```

**기대 동작**: `kapel is not configured yet …` 안내 후 다섯 개의 화살표 목록이
차례로 나옵니다.

```text
Which coding backend should kapel use?       ← Claude Code / Codex / API key
Main orchestrator model                      ← 예: opus
Worker model — most complex coding tasks     ← 예: opus
Worker model — everyday tasks                ← 예: sonnet
Worker model — small, single-function tasks  ← 예: haiku
```

선택한 백엔드가 설치/로그인되어 있지 않으면 `warning: … does not look ready`와
설치·로그인 방법을 알려 준 뒤 설정은 계속 진행됩니다(경고일 뿐 중단하지 않음).
답을 마치면 요약과 `saved to …/config.json`이 출력되고, 이어서 원래 하려던
명령(여기서는 대화형 모드)이 그대로 실행됩니다. `esc`로 취소하면
`setup cancelled`만 남고 아무것도 저장되지 않습니다.

확인 항목:

```bash
kapel config --show     # 저장된 백엔드·모델 4종 + 파일 경로
kapel config --path     # 경로만
kapel config            # 언제든 다시 설정 (현재 값이 기본 선택으로 뜸)
kapel --no-setup        # 마법사를 건너뛰고 환경변수/기본값으로 실행
echo "" | kapel         # 파이프(비-TTY) — 마법사 없이 도움말만 출력
```

우선순위 확인: `--backend`/`-m` 플래그 → `AGENT_BACKEND`/`AGENT_MODEL` 환경변수
→ `~/.kapel/config.json` → **자동 감지** → 내장 기본값 순으로 먼저 잡히는 값이
이깁니다. 예를 들어 설정이 `claude-code`여도 `kapel --backend native`는 네이티브
경로로 실행됩니다.

**백엔드 자동 감지** 확인 — 아무도 백엔드를 고르지 않은 상태(플래그 없음,
`AGENT_BACKEND` 없음, 설정 파일 없음)에서만 동작합니다:

```bash
env -u AGENT_BACKEND KAPEL_CONFIG_DIR=/tmp/kapel-empty kapel --no-setup
```

**기대 동작**: 로그인된 Claude Code CLI가 있으면
`backend: claude-code (auto-detected — set one with \`kapel config\`)` 한 줄이
stderr로 뜨고 그 백엔드로 REPL이 열립니다. Claude Code가 없으면 Codex를,
그것도 없으면 `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`/`OPENAI_API_KEY`가
있을 때 native를 고릅니다. 셋 다 없으면 예전처럼 조용히 native로 떨어집니다
(안내 줄 없음 — 이때 알려야 할 것은 감지가 아니라 없는 자격증명이므로).
감지는 프로세스당 한 번만 수행되고, 안내 줄도 한 번만 나옵니다.

설정을 마친 뒤 `kapel init`을 실행하면 `.agent/config.yaml`의 `models:`가
전역 설정에서 채워집니다(`lead`/`reviewer` ← 오케스트레이터 모델,
`complex`·`worker`·`cheap` ← 워커 모델 3종). 설정이 없으면 템플릿 그대로
복사됩니다.

## 1.6. 시나리오 A-1 — 권한 규칙 설정 파일 (P1-5)

기본적으로 `write_file`/`edit_file`/`bash`는 프롬프트에서 매번 물어봅니다
(`-y` 같은 일괄 승인 플래그는 없습니다 — REPL에는 답할 사람이 있으니까요). 방금 만든
`$KAPEL_CONFIG_DIR/config.json`에 `permission` 블록을 직접 추가해서 특정
명령만 자동 허용/차단되는지 확인하세요:

```bash
# config.json의 최상위에 아래를 추가 (backend/models와 같은 레벨)
#   "permission": {
#     "edit_file": "allow",
#     "bash": { "*": "ask", "git *": "allow", "rm *": "deny" }
#   }
kapel "git status를 실행해줘"       # git * → allow, 프롬프트 없이 바로 실행
kapel "테스트 파일을 하나 수정해줘"  # edit_file → allow, 프롬프트 없이 바로 편집
kapel "rm -rf 빌드 폴더를 지워줘"    # rm * → deny, 프롬프트 자체가 뜨지 않고 거부됨
```

`.agent/config.yaml`에도 같은 모양의 `permission:` 블록을 쓸 수 있고, 저장소
쪽이 머신 설정보다 우선합니다. 두 파일 어디에도 `permission`이 없으면 이전과
동일하게 동작합니다(기본값: 읽기 전용 도구만 자동 허용). 오타 등으로
`permission` 블록 일부가 잘못돼도 전체 설정이 깨지지 않고, 잘못된 항목만
무시된 채 `warning: …`이 stderr에 한 번 출력됩니다.

## 2. 시나리오 A — 대화형 에이전트 (M1)

테스트용 저장소를 하나 만들고 (Windows cmd에서는 파일 생성을 메모장 등으로 대체) 그 안에서 실행합니다:

```bash
mkdir -p /tmp/agent-fixture && cd /tmp/agent-fixture && git init -q
cat > calc.js <<'EOF'
function add(a, b) { return a - b; }   // 의도된 버그
module.exports = { add };
EOF
cat > calc.test.js <<'EOF'
const { add } = require("./calc");
if (add(2, 3) !== 5) { console.error("FAIL"); process.exit(1); }
console.log("PASS");
EOF
git add -A && git commit -qm init

kapel                     # REPL 진입 — 모든 에이전트 작업이 여기서 일어납니다
```

배너(`kapel v0.8.0  claude-sonnet-5  session 0f3c9a2b`)와 `kapel>` 프롬프트가
뜨면 대화로 버그 수정을 지시합니다. 이 프롬프트는 입력 편집기입니다:
줄 끝에 `\`를 붙이면(또는 여러 줄을 한 번에 붙여넣으면) 계속 입력할 수 있고
빈 줄로 끝냅니다; ↑/↓로 이전 입력을 다시 불러올 수 있고 이는 `~/.kapel/history`에
세션을 넘어 저장됩니다; Tab은 커서 아래 있는 것을 완성합니다 — `/` 명령 이름,
고정된 인자 목록을 가진 명령의 인자(`/model ` 뒤에서 내장 모델 별칭),
그리고 `@` 파일 멘션.

**`@` 파일 멘션 (P1-3)**을 먼저 확인합니다. `@`에 이어 경로 일부를 입력하고
Tab을 누르면 경로 전체에 대한 퍼지 매칭으로 완성됩니다 — `@clisrc` → `apps/cli/src/…`,
`@calc` → `calc.test.js`. 후보가 하나면 그대로 채워지고, 여럿이면 공통 접두사까지
채운 뒤 Tab을 한 번 더 누르면 목록이 표시됩니다. 후보는 git 저장소에서는
`git ls-files --cached --others --exclude-standard`(추적 파일 + `.gitignore`에
걸리지 않은 미추적 파일), 그 밖에서는 깊이 4까지의 디렉터리 탐색이며
`node_modules`/`.git`/`dist`는 건너뜁니다. 결과는 몇 초간 캐시되므로 Tab을
연타해도 매번 git을 띄우지 않습니다.

```text
kapel> @calc      ← Tab → "@calc.test.js"로 완성
kapel> @calc.test.js가 실패하는 원인을 찾아서 고쳐줘. node calc.test.js로 검증까지 해줘.
```

**기대 동작**: 멘션은 메시지에 그대로 남고, 전송 시점에 실재하는 파일만 모아
`[mentioned files: calc.test.js]` 한 줄이 메시지 끝에 덧붙습니다 — 파일 **내용은
붙지 않습니다**(에이전트가 `read_file`로 직접 읽습니다). 존재하지 않는 경로,
이메일 주소(`me@example.com`), 작업 디렉터리 밖을 가리키는 경로(`@../x`)는
무시되어 아무것도 덧붙지 않습니다.

```text
kapel> calc.test.js가 실패하는 원인을 찾아서 고쳐줘. node calc.test.js로 검증까지 해줘.
```

**기대 동작**: read/grep은 자동 허용, `edit_file`/`bash` 실행 전에 `allow ...? [y/n/a]`
프롬프트 → y 응답 → 수정 후 요약 + 그 턴의 토큰/비용 한 줄(`tokens +… in, +… out`).
프롬프트 위에는 실제로 일어날 일이 먼저 표시됩니다 — `bash`는 명령 전문,
`edit_file`은 `-`/`+` 유니파이드 diff, `write_file`은 경로와 내용 앞부분.
답은 `y`(이번만 허용) / `n`·Enter·Ctrl-C(거부) / `a`(이 세션 동안 계속 허용)
세 가지입니다. `a`는 `bash`의 경우 **명령 프리픽스**를 기억합니다 —
`npm test --run foo`에 `a`로 답하면 이후 `npm test …`는 다시 묻지 않지만
`npm publish`는 다시 묻습니다(`&&`·`|` 같은 셸 연산자가 섞인 명령은 기억하지 않음).
그 밖의 도구는 도구 이름 단위로 기억하며, 어느 쪽도 디스크에 저장되지 않아
프로세스가 끝나면 사라집니다.
프롬프트로 돌아오면 대화가 이어집니다:

```text
kapel> sub 함수도 추가하고 테스트도 같이 만들어줘
kapel> /usage        # 누적 토큰·비용
kapel> /compact      # 지금 바로 컨텍스트 압축 ("compacted: elided … / nothing to compact.")
kapel> /sessions     # 이 디렉터리의 대화 목록 (id, 마지막 갱신, 메시지 수, 제목)
kapel> /undo         # 직전 프롬프트 이전 상태로 작업 트리 복구
kapel> /exit
```

네이티브 백엔드는 대화가 60메시지를 넘으면 자동으로도 압축됩니다 — 오래된 도구
결과가 지워지고(대화 자체는 남고, 지워졌다는 표시만 남습니다) 회색 글씨로
`≈ context compacted: …` 한 줄이 뜨며 대화는 끊기지 않고 계속됩니다. `--backend
codex`/`--backend claude-code`에서는 외부 CLI가 자기 컨텍스트를 관리하므로
`/compact`는 "not supported with the … backend" 한 줄만 출력합니다.

**체크포인트와 `/undo`**를 확인합니다. 대화형 세션은 격리 없이 실제 파일을 고치므로,
kapel은 **매 프롬프트 직전에** 작업 트리를 스냅샷합니다(슬래시 명령은 파일을 바꾸지
않으므로 스냅샷하지 않습니다). 위에서 `calc.js`가 수정된 직후 `/undo`를 눌러 보세요:

```text
kapel> /undo
↩ restored 1 file to before "calc.test.js가 실패하는 원인을 …" (2 min ago)
  every edit since then is gone, including ones made by shell commands or other programs — undo is one-way
```

`git diff`로 되돌아갔는지 확인할 수 있습니다(`add(a, b) { return a - b; }`로 복귀).
스냅샷은 **임시 인덱스**에 만든 git tree 오브젝트라 인덱스·작업 트리·`git stash list`를
전혀 건드리지 않으며(`git stash list`가 비어 있는지 확인해 보세요), `git stash`가 못 보는
**추적되지 않는 파일까지** 포함합니다 — 에이전트가 새로 만든 파일은 `/undo`로 삭제되고,
지운 파일은 되살아납니다. 확인해 볼 경계 조건:

- 되돌릴 게 없을 때: `nothing to undo — no checkpoint has been taken in this session yet.`
- git 저장소가 아닌 디렉터리(`mkdir /tmp/plain && cd /tmp/plain && kapel`):
  스냅샷을 아예 만들지 않고 `/undo`가 `needs a git repository … Run \`git init\`` 안내.
- 머지/리베이스 진행 중(`git merge` 충돌 상태): `/undo is unavailable while a merge is
  in progress …`로 거부하고 체크포인트는 그대로 유지.
- `.gitignore` 대상과 `.agent/`는 스냅샷·복구 양쪽에서 제외됩니다(세션 DB가 되돌려지지
  않습니다). 되돌리기는 한 방향이며 `/redo`는 없습니다. 체크포인트는 세션당 최근 20개,
  메모리에만 남고 프로세스가 끝나면 사라집니다.

이어서 **재개**를 확인합니다 — 대화는 `.agent/sessions.db`에 저장되므로
프로세스를 껐다 켜도 이어집니다:

```bash
kapel chat --continue     # 방금 그 대화를 그대로 이어받음 ("resumed … (N messages)")
```

`kapel chat --help`로 `--session <id|name>`(특정 대화, id·접두사·`/name`으로
붙인 이름 모두 가능)와 `--no-save`도 확인할 수 있습니다. 프롬프트에서
`/new`(새 대화), `/resume <id|name>`(전환), `/name`(이 대화 이름 보기/짓기),
`/fork [name]`(지금까지 대화를 새 세션으로 복제하고 그쪽으로 전환),
`/model <alias>`(이후 턴부터 모델 교체), `/config`(설정 마법사를 다시 돌려
백엔드·모델을 이 대화에 바로 적용 — 대화 내용은 유지됨), `/compact`(지금 바로
컨텍스트 압축), `/undo`(직전 프롬프트 이전으로 파일 복구), `/help`도 함께 눌러 보세요. `/config`는 터미널에서만 동작하며,
파이프로 실행 중이면 `/config needs a terminal —` 안내가 나옵니다.

**`/name`·`/fork` (P1-8 나머지)** 확인:

```text
kapel> /name                    ← 아직 이름이 없으면 "(unnamed)"
kapel> /name calc-실험           ← 이름을 붙임 — 즉시 .agent/sessions.db에 반영
kapel> /name                    ← "calc-실험"
kapel> /fork before-refactor    ← 지금까지 대화를 새 세션으로 복제하고 그쪽으로 전환
```

**기대 동작**: `/fork`는 `forked to <newId8> (before-refactor) — now on the new
session.`을 출력하고, 이후 프롬프트는 새 세션 위에서 이어집니다 — 원본
(`calc-실험`)은 `/fork` 시점까지의 이력을 그대로 간직한 채 그 자리에 남아
있고, `/sessions`에 둘 다 별도 행으로 보입니다. `--session calc-실험`으로
원본을 다시 열 수 있습니다(이름이 여러 세션에 걸치면 가장 최근 것이 선택되고
그렇다는 안내가 한 줄 뜹니다). 이름은 빈 문자열이거나 `/`로 시작할 수 없습니다
(슬래시 명령과 헷갈리므로) — `/name /oops`는 즉시 거부됩니다.

추가 확인: 턴 진행 중 Ctrl-C(해당 턴만 취소, 대화는 유지), 프롬프트에서 Ctrl-C
두 번(종료), Ctrl-D(종료).

**제거된 표면** 확인 — 예전 단발 실행 명령과 플래그는 커맨더의 짧은 오류
한 줄과 종료 코드 1로 끝나야 합니다(REPL로 가라는 안내 문구는 나오지 않습니다):

```bash
kapel plan "add a health endpoint"   # error: unknown command 'plan'
kapel exec "fix the test"            # error: unknown command 'exec'
kapel worker                         # error: unknown command 'worker'
kapel "fix the failing test"         # error: unknown command 'fix the failing test'
kapel --json                         # error: unknown option '--json'
kapel -i shot.png                    # error: unknown option '-i'
echo $?                              # 1
```

`kapel --help`와 `kapel help`는 남은 관리용 명령(`chat`, `init`, `config`,
`models`, `runs`, `sessions`, `explain`, `policy`, `help`)과 전역 플래그
(`--cwd`, `-m/--model`, `--timeout`, `--backend`, `--no-setup`)만 보여야
합니다 — `exec`/`plan`/`orchestrate`/`resume`/`worker` 행이 없어야 합니다.

추가 확인: 턴 진행 중 Ctrl-C(해당 턴만 취소), `--timeout 30`.

**`AGENTS.md` 로딩** 확인 — 같은 저장소에 프로젝트 지시 파일을 두고 다시 실행합니다:

```bash
echo 'always run `node calc.test.js` after every edit' > AGENTS.md
kapel
```

**기대 동작**: 배너 다음 줄에 `instructions: AGENTS.md`가 뜨고, 첫 턴부터 그
규칙을 따릅니다. `.agent/AGENTS.md`(kapel 전용 규칙)와 `~/.kapel/AGENTS.md`
(`$KAPEL_CONFIG_DIR` 우선, 머신/사용자 전역 규칙)도 같은 방식으로 합쳐지며,
존재하는 파일만 배너에 나열됩니다 — 아무 파일도 없으면 그 줄 자체가 생략됩니다.

## 2.6. 이미지 첨부 — 현재 미지원

이미지 첨부는 단발 실행의 `-i/--image` 플래그로만 가능했고, 그 플래그는
제거되었습니다. REPL의 `@` 멘션은 에이전트가 `read_file`로 직접 읽도록 파일
**경로**를 알려 줄 뿐이라 이미지 첨부 경로가 아닙니다.

```bash
kapel -i ./screenshot.png    # error: unknown option '-i'
```

**기대 동작**: 위 한 줄과 종료 코드 1. 프로바이더 계층(`@agent/ai`)의 비전
입력 지원 자체는 그대로 남아 있으므로, 프롬프트에서 이미지를 붙이는 기능이
생기면 그 위에 얹으면 됩니다.

## 2.7. 시나리오 A-3 — 커스텀 슬래시 명령 (P1-4)

`kapel init`이 만든 `.agent/commands/review.md`가 이미 예시로 들어 있습니다
(`kapel init`을 아직 안 했다면 시나리오 C에서 먼저 실행). 대화형으로 확인:

```bash
cd /tmp/agent-fixture
kapel init          # 아직 안 했다면 — .agent/commands/review.md 포함
kapel
```

```text
kapel> /help                    ← "custom commands (.agent/commands/):" 아래
                                    "/review  Review the current diff for bugs..." 확인
kapel> /review calc.js의 add 함수만 집중해서 봐줘
```

**기대 동작**: `/review`는 `.agent/commands/review.md`의 본문(`$ARGUMENTS`
자리에 방금 입력한 "calc.js의 add 함수만 집중해서 봐줘"가 들어간 것)을 그대로
사용자 메시지로 보낸 것처럼 동작합니다 — 체크포인트가 찍히고, 응답 뒤 토큰
사용량 한 줄이 붙는 등 일반 메시지와 동일합니다.

새 명령을 직접 만들어 봅니다:

```bash
mkdir -p .agent/commands
cat > .agent/commands/tests.md <<'EOF'
---
description: Run the project's tests and summarize failures
model: claude-haiku-4-5
---
Run `node calc.test.js` via the bash tool and summarize any failures.

$ARGUMENTS
EOF
```

```text
kapel> /help          ← 다시 확인하면 /tests가 새로 나타남 (재시작 없이 즉시 반영)
kapel> /tests
```

**기대 동작**: `model:` 프론트매터가 있으므로 이 한 턴만 `claude-haiku-4-5`로
실행되고(배너/`\`/model\`` 상으로는 원래 모델로 바로 돌아옵니다), 나머지는 위와
동일합니다. 이름이 `^[a-z][a-z0-9-]{0,31}$`에 맞지 않는 파일(`Foo.md` 등)이나
내장 명령과 이름이 겹치는 파일(`help.md`)을 넣으면 `/help`에 `warning: skipping
…`이 한 줄 뜨고 해당 파일은 무시됩니다 — 내장 명령이 항상 우선합니다.

## 3. 시나리오 B — Codex 백엔드 (OpenAI OAuth)

```bash
cd /tmp/agent-fixture
kapel --backend codex           # REPL을 Codex 백엔드로 엶
```

```text
kapel> calc.js의 add 함수 옆에 뺄셈 함수 sub를 추가해줘
```

**기대 동작**: Codex CLI가 스폰되어 명령 실행·파일 변경이 스트리밍되고
턴이 정상 종료합니다. 배너에는 승인 절차가 Codex CLI 쪽에 있다는 줄이 뜹니다.
미설치/미로그인이면 설치·로그인 안내 후 종료 코드 1. `kapel config`에서
Codex를 골라 두면 플래그 없이도 같은 경로로 열립니다.

## 3.5. 시나리오 B2 — Claude Code 백엔드 (구독 로그인)

API 키 없이 Claude 구독 로그인만으로 동작하는 경로입니다:

```bash
cd /tmp/agent-fixture
kapel --backend claude-code     # REPL을 Claude Code 백엔드로 엶
```

**기대 동작**: `claude -p`가 스폰되어 도구 사용 라인(`→ claude: Edit`)과 최종
답변이 출력되고, `status: success`로 끝납니다. 미설치/미로그인이면 설치·로그인
안내(`npm install -g @anthropic-ai/claude-code`, `claude` 실행 후 로그인) 후
종료 코드 1.

이어서 **Claude Code 백엔드로 대화형 사용**을 확인합니다:

```bash
kapel --backend claude-code            # 목적 없이 실행 → 대화형
```

배너가 `kapel v0.8.0  claude-code · opus  session 0f3c9a2b` 형태로 뜨고, 그
아래에 `approvals are enforced by the Claude Code CLI — kapel does not prompt here`
가 표시됩니다 — 이 경로에서는 kapel이 `allow …? [y/n/a]`를 묻지 않습니다(승인은
Claude Code CLI가 자체 정책으로 처리).

```text
kapel> calc.test.js가 실패하는 이유를 찾아줘
kapel> 방금 말한 그 파일을 고쳐줘        ← 앞 턴을 기억하는지 확인 (--resume 연결)
kapel> /model sonnet                    ← 이후 턴부터 모델 교체 (대화는 유지)
kapel> /compact                         ← "not supported with the Claude Code backend." 한 줄
kapel> /sessions                        ← 네이티브 대화와 같은 DB에 기록됨
kapel> /exit
```

**기대 동작**: 두 번째 턴이 앞 대화를 알고 있어야 합니다 — 첫 턴은 그냥
실행되고, 이후 턴은 Claude Code가 돌려준 세션 id로 `--resume <id>`를 붙여
이어갑니다(대화 내용을 다시 보내지 않음). 대화는 `.agent/sessions.db`에
저장되므로 `kapel chat --continue --backend claude-code`로 이어받을 수 있고,
이때 첫 턴에만 저장된 대화 내용을 한 번 재생한 뒤 다시 세션 id로 이어갑니다.
(Codex 백엔드는 재개 가능한 id를 보고하지 않으므로 매 턴 최근 대화를 함께
보내는 무상태 방식으로 동작합니다.)

참고: 이 백엔드에서 연 REPL의 `/plan`·`/orchestrate`도 그대로 동작합니다.
플래닝은 `claude -p --permission-mode plan` 한 번(읽기 전용)으로 위임되고,
실행은 태스크마다 해당 태스크의 워크스페이스(워크트리)에서 `claude -p`를
하나씩 띄우며, 에이전트가 선언한 모델과 `tools:` 목록(`--allowedTools`로
전달)을 그대로 사용합니다.

## 4. 시나리오 C — 멀티 에이전트 오케스트레이션 (M2–M6)

```bash
cd /tmp/agent-fixture
kapel init                      # .agent/ 템플릿 복사
```

`.agent/config.yaml`의 `models:`를 보유한 자격증명에 맞게 수정하세요(전역 설정이
있으면 시나리오 A-0대로 이미 채워져 있습니다). Anthropic만 있다면 `reviewer`를
다음처럼 바꿉니다:

```yaml
  reviewer:
    provider: anthropic
    model: claude-opus-5
```

이후:

```bash
kapel policy compile            # 자연어 정책 → orchestration.lock.json (LLM 1회 호출)
                                # warnings/ambiguities에 orchestration.md:N 줄 번호가 붙는지 확인
kapel policy explain            # 컴파일된 정책 요약 확인
kapel policy check              # 오프라인 신선도 검사 (CI용)

# orchestration.md를 한 줄 고친 뒤(예: 동시성 숫자 변경), 아직 컴파일하지 않고:
kapel policy diff                # lock 대비 변경 예정 사항만 미리보기 (lock은 그대로)
kapel policy compile             # 실제로 lock을 갱신

# 위임 백엔드에서도 동일하게 동작합니다(API 키 불필요 — 3.4/3.5 참고):
kapel policy compile --backend codex   # `tokens — …` 줄에 CLI가 보고한 토큰이,
kapel policy diff --backend codex      # 보고가 없으면 `none reported by the codex CLI`가 출력됩니다

```

플래닝과 실행은 REPL 안에서 합니다:

```bash
kapel                           # REPL 진입
```

```text
kapel> /plan calc.js에 곱셈/나눗셈 함수를 추가하고 각각 테스트 파일도 만들어줘
kapel> /orchestrate calc.js에 곱셈/나눗셈 함수를 추가하고 각각 테스트 파일도 만들어줘
```

**`/plan` 기대 동작**: 태스크 DAG 표(ID/TYPE/COMPLEXITY/AGENT/DEPS/TITLE)에
이어 `Routing rationale:` 절이 **항상** 출력됩니다 — 각 태스크가 어느 규칙
(매칭 기준·strength·weight)으로 어느 에이전트/모델에 라우팅되는지, 매칭
규칙이 없으면 `suggestedAgent`나 오케스트레이터로 떨어졌는지까지. 예전의
`kapel plan --why`가 하던 일이며, 이제 플래그가 아니라 기본 동작입니다.
아무것도 실행되지 않습니다.

**`/orchestrate` 기대 동작**: `▶ T01 → explorer` 같은 태스크 라이프사이클
라인, worktree 생성(⎇)·병합(⇡) 라인, 태스크별 상태 테이블, `git log`에 merge
커밋들. 정책 lock이 없거나 오래되었으면 그 사실을 알리고 대화는 그대로
유지됩니다(REPL이 끊기지 않습니다).

격리(worktree), 검증기, 백엔드는 이제 플래그가 아니라 설정에서 결정됩니다 —
`--worker-mode`/`--isolation`/`--tui`/`--dry-run`/`--no-validate`는 제거되었고,
워커는 항상 이 프로세스의 네이티브 루프(또는 위임 백엔드의 CLI)에서 돕니다.

## 5. 세션·재개·설명 (M6)

REPL 안에서:

```text
kapel> /runs                    ← 방금 런이 목록에 표시 (id로 아래 명령을 씁니다)
kapel> /resume-run <runId>      ← (실패한 런이 있을 때) 미완료 태스크만 재실행
```

**기대 동작**: `/runs`는 ID/STATUS/STARTED/TASKS/OBJECTIVE 표를,
`/resume-run`은 `Resuming run <id> — N of M tasks left …`로 시작해 남은
태스크만 다시 실행합니다. 대화를 전환하는 `/resume`과는 다른 명령이라는
점을 확인하세요 — `/resume <sessionId>`는 여전히 대화 전환이고, 런 id를
넣어도 런을 재개하지 않습니다. 없는 런 id를 주면
`Unknown run … Run \`/runs\` to see the recorded ones.` 한 줄이 뜨고 대화는
유지됩니다.

셸에서:

```bash
kapel runs                      # 같은 목록 (--limit, --json)
kapel explain T01               # 라우팅 근거 + 이벤트 다이제스트 (--run, --json)
```

대화(시나리오 A)와 오케스트레이션 런은 같은 `.agent/sessions.db`에 각자
저장됩니다: 대화는 `kapel chat --continue` / 프롬프트의 `/sessions`,
런은 `/runs`(또는 `kapel runs`)로 확인합니다.

REPL 밖에서 대화 목록을 보거나 복제하려면:

```bash
kapel sessions                              # 이 워크스페이스의 대화 목록, 최근 갱신 순
kapel sessions fork <id>                    # 그 대화의 전체 이력을 새 세션으로 복제
kapel sessions fork <id> --name "실험 브랜치"  # …이름을 붙여서 복제
```

**기대 동작**: `kapel sessions`는 시나리오 A에서 만든 대화가 `ID`/`UPDATED`/
`MSGS`/`TITLE` 표로 보입니다(이름이 붙은 세션이 하나라도 있으면 `NAME` 열이
추가됩니다). `kapel sessions fork <id>`는 `Forked <id> → <newId>` 한 줄을
출력하고, 이후 `kapel sessions`에 복제본이 별도 행으로 나타나며 원본과
독립적으로 이어집니다 — 복제본에 `kapel chat --session <newId>`로 들어가
메시지를 보내도 원본 대화(`<id>`)의 메시지 수는 그대로입니다. `<id>` 자리에는
전체 id, 짧은 접두사, 세션 이름(위에서 `--name`으로 붙인 것) 중 아무거나
써도 됩니다; 접두사가 여러 세션에 걸치면 오류로 더 긴 접두사를 요구합니다.

## 6. 검증 게이트 (M5)

`.agent/config.yaml`에 추가한 뒤 `/orchestrate`를 다시 돌리면, 각 쓰기 태스크가
worktree 안에서 검증을 통과해야 병합됩니다:

```yaml
validation:
  - name: test
    command: node calc.test.js
```

## 알려진 주의점

- 카탈로그의 OpenAI 모델 ID(`gpt-5.1` 등)는 플레이스홀더에 가깝습니다 —
  네이티브 OpenAI 경로를 쓸 때는 `config.yaml`/`-m`에 실제 사용 가능한
  모델 ID를 지정하세요. (Codex 백엔드는 무관)
- `ant` OAuth 토큰은 단기 토큰이라 매우 긴 런은 만료될 수 있습니다.
- `~/.kapel/config.json`은 머신 단위 설정입니다. 저장소에 커밋되는
  `.agent/config.yaml`(에이전트별 모델)과는 별개이며, `kapel init`이 전자에서
  후자를 채워 줄 뿐입니다.
- `.agent/sessions.db*`와 `.agent/worktrees/`는 대상 저장소의 `.gitignore`에
  추가하는 것을 권장합니다.

## 문제 리포트

이슈가 발생하면 다음을 함께 공유해 주세요: 실행한 명령(또는 슬래시 명령),
`kapel runs --json` / `kapel explain <taskId> --json` 출력,
`.agent/sessions.db`의 해당 런 ID.
