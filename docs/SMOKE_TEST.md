# 실환경 스모크 테스트 가이드

로컬 머신에서 v0.1 전체 기능을 실제 모델로 검증하는 절차입니다. 소요 시간은
인증 준비를 제외하면 15–20분 정도입니다.

> **요구 사항**: Node.js 20 이상, git. **Windows cmd, macOS, Linux 모두
> 네이티브 지원**합니다 (셸 명령은 POSIX에서는 bash, Windows에서는
> cmd.exe로 실행됩니다).

## 0. 설치 (Windows cmd / macOS / Linux 공통)

빌드 없이 저장소에 포함된 패키지 tarball을 전역 설치합니다 (한 줄):

```bash
npm install -g https://raw.githubusercontent.com/devFallingstar/kapel/main/release/devfallingstar-kapel-0.17.0.tgz
kapel --version
```

npm 레지스트리 배포 후에는 `npm install -g @devfallingstar/kapel` 로 대체됩니다.
URL 접근이 안 되는 네트워크라면: 레포를 클론한 뒤
`npm install -g ./kapel/release/devfallingstar-kapel-0.17.0.tgz`. 제거는
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
빠른 자체 점검: `npm test` → 2582개 테스트가 통과해야 합니다.

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
| Anthropic (키 없음, Claude Code) | `npm i -g @anthropic-ai/claude-code` 후 `claude auth login` 실행해 구독 로그인 | 시나리오 A-0/B2에서 사용 |

`kapel models` 로 각 모델 별칭의 자격증명 상태를 먼저 확인하세요.

Codex와 Claude Code 모두 로그인을 미리 실행해 두지 않았어도 됩니다 —
마법사(1.5)나 REPL 안의 `/login` 명령이 설치는 됐지만 로그인이 안 된 상태를
감지하면 지금 `codex login` / `claude auth login`을 실행할지 물어보고,
터미널을 넘겨 로그인을 마친 뒤 다시 확인해 줍니다.

## 1.5. 시나리오 A-0 — 첫 실행 마법사 (설정)

아직 설정한 적이 없는 머신에서 `kapel`을 터미널로 처음 실행하면, 어떤 백엔드와
모델을 쓸지 다섯 가지를 물어본 뒤 `~/.kapel/config.json`에 저장합니다. 깨끗한
상태에서 확인하려면 설정 디렉터리를 임시로 바꿔서 실행하세요:

```bash
export KAPEL_CONFIG_DIR=/tmp/kapel-smoke      # 실제 ~/.kapel 을 건드리지 않기 위함
kapel config --show                           # "not configured yet — run `kapel config`" + 경로, 종료 코드 0
kapel                                         # 목적 없이 실행 → 마법사가 먼저 뜸
```

**기대 동작**: `kapel is not configured yet …` 안내 후 다섯 개의 화살표 목록이
차례로 나옵니다. **첫 질문은 다중 선택**이라 가진 백엔드를 여러 개 함께 고를 수
있습니다(`space` 토글, `enter` 확정, 최소 하나 필수 — 아무것도 안 고른 상태에서
`enter`는 무시됩니다).

```text
Which coding backends should kapel use? (space to toggle, enter to confirm)
                                             ← ☑ Claude Code / ☑ Codex / ☐ API key
Main orchestrator model                      ← 예: opus
Worker model — most complex coding tasks     ← 예: opus
Worker model — routine, non-trivial tasks    ← 예: sonnet
Worker model — small, single-function tasks  ← 예: haiku
```

백엔드를 하나만 골랐다면 모델 목록 4개는 예전과 똑같이 그 백엔드의 목록입니다.
둘 이상 골랐다면 각 목록이 **선택한 모든 백엔드의 합집합**이 되고, 각 줄의 힌트
앞에 `Claude Code · ` / `Codex · `처럼 어느 백엔드인지가 붙습니다. 즉
오케스트레이터는 Claude Code의 `opus`, 일반적이지만 단순하지 않은 작업을 하는
워커는 Codex의 `gpt-5.1`처럼
섞어서 고를 수 있습니다(기본 선택은 Claude Code를 골랐으면 그 티어 기본값,
아니면 Codex, 그다음 API 키 목록 순).

선택한 백엔드가 설치/로그인되어 있지 않으면 `warning: … does not look ready`와
설치·로그인 방법을 알려 준 뒤 설정은 계속 진행됩니다(경고일 뿐 중단하지 않음 —
여러 개를 골랐다면 고른 순서대로 각각 검사합니다).
답을 마치면 요약과 `saved to …/config.json`이 출력되고, 이어서 원래 하려던
명령(여기서는 대화형 모드)이 그대로 실행됩니다. `esc`로 취소하면
`setup cancelled`만 남고 아무것도 저장되지 않습니다.

확인 항목:

```bash
kapel config --show     # 병합된 실효 설정(값마다 어느 파일에서 왔는지) + 두 파일 경로
kapel config --path     # 머신 설정 경로만
kapel config            # 언제든 다시 설정 (현재 값이 기본 선택으로 뜸)
kapel --no-setup        # 마법사를 건너뛰고 환경변수/기본값으로 실행
echo "" | kapel         # 파이프(비-TTY) — 마법사 없이 도움말만 출력
```

**디렉터리별 설정(`--project`)** — 이 저장소에서만 다른 백엔드/모델을 쓰고 싶을
때는 `<저장소>/.agent/config.local.json`이 머신 설정을 덮어씁니다. 일부만 적어도
되고(백엔드 목록만, 역할 하나만, 또는 전부), 나머지는 머신 설정이 채웁니다:

```bash
kapel init                       # .agent/ 가 있어야 함 (--project 는 디렉터리를 만들지 않음)
kapel config --project           # 같은 마법사 → .agent/config.local.json 에 저장
kapel config --path --project    # 그 파일 경로만
kapel config --show              # 병합 결과 + 각 값의 출처 파일
```

**기대 동작**: `.agent/`가 없는 디렉터리에서 `kapel config --project`는 질문을
하나도 하지 않고 `… does not exist — run \`kapel init\` …`를 출력하며 종료 코드
1. `kapel init`은 `.gitignore`에 `.agent/config.local.json`을
`.agent/sessions.db*`·`.agent/worktrees/`와 함께 추가합니다. 파일이 깨져 있으면
`warning: ignoring …` 한 줄만 stderr로 뜨고 무시된 채 명령은 그대로 실행됩니다.

우선순위 확인: `--backend`/`-m` 플래그 → `AGENT_BACKEND`/`AGENT_MODEL` 환경변수
→ `.agent/config.local.json` → `~/.kapel/config.json` → **자동 감지** → 내장
기본값 순으로 먼저 잡히는 값이 이깁니다. 예를 들어 설정이 `claude-code`여도
`kapel --backend native`는 네이티브 경로로 실행됩니다.

**에이전트별 혼합 실행은 이제 동작합니다** — `/orchestrate`의 각 태스크는 그
태스크를 맡은 에이전트의 별칭이 `.agent/config.yaml`에 적어 둔 `backend:`로
돕니다. 즉 한 번의 실행에서 Claude Code 워커, Codex 워커, native 워커가 각자의
태스크 워크트리에서 나란히 돌 수 있고, 사용량도 각 백엔드의 모델 이름으로
따로 집계됩니다. 실제로 갈 수 있는 백엔드만 검사하므로, Codex를 쓰지 않는
설정은 `codex login`을 요구하지 않습니다. `backend:`가 없는 별칭은 예전처럼
그 실행의 기본 백엔드로 돕니다. 채팅 턴, `/plan`, `policy compile`은 여전히
**오케스트레이터 역할의 백엔드**로 도는데, 이는 기본 백엔드이기도 합니다.

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

마법사가 끝나면(그리고 그 다음부터는 곧바로), `.agent/`가 없는 저장소에서
REPL을 열 때 **자동 프로젝트 준비**가 곧바로 이어집니다(묻지 않습니다) —
2장 참고.

설정을 마친 뒤 `kapel init`을 실행하면 `.agent/config.yaml`의 `models:`가
실효 설정에서 채워집니다(`lead`/`reviewer` ← 오케스트레이터 모델,
`complex`·`worker`·`cheap` ← 워커 모델 3종). 각 별칭의 `provider:`는 그 역할이
쓰는 **자기 백엔드**에서 나오므로, Claude Code 리드 + Codex 워커 설정이라면
`lead: anthropic` / `worker: openai`로 정직하게 적힙니다. 설정이 없으면 템플릿
그대로 복사됩니다.

## 1.6. 시나리오 A-1 — 권한 규칙 설정 파일 (P1-5)

기본적으로 `write_file`/`edit_file`/`bash`는 프롬프트에서 매번 물어봅니다
(`-y` 같은 일괄 승인 플래그는 없습니다 — REPL에는 답할 사람이 있으니까요). 방금 만든
`$KAPEL_CONFIG_DIR/config.json`에 `permission` 블록을 직접 추가해서 특정
명령만 자동 허용/차단되는지 확인하세요:

```bash
# config.json의 최상위에 아래를 추가 (backends/models와 같은 레벨)
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

kapel --no-setup          # REPL 진입 — 4장에서 손으로 준비해 볼 것이므로 자동 준비는 꺼 둡니다
```

`kapel`은 이제 프로젝트를 준비할지 **묻지 않습니다** — `.agent/`가 없는 새
저장소면 배너가 뜨기 전에 다음 한 줄을 찍고 `kapel init`과
`kapel policy compile`을 곧바로 그 자리에서 실행합니다. 두 명령이 셸에서
출력하는 것과 같은 요약이 REPL에 그대로 찍힙니다:

```text
setting this project up for kapel — creating .agent/ and compiling the
orchestration policy…
```

**모델 호출이 없다는 점을 확인하세요.** 안내 줄에 `(one model call)`이
없어야 하고, 이어지는 요약에 `Read the policy from its canonical form — no
model call.`이 있어야 합니다. 템플릿이 제공하는 정책은 kapel의 정규
형식(canonical form)이라 컴파일이 아니라 파싱으로 처리됩니다 —
자격증명이 하나도 없는 머신에서도 이 준비는 끝까지 완주합니다.

**산문 정책 레포에서는 시작 시 아예 실행하지 않습니다.** `.agent/`에
`orchestration.md`(산문)만 있고 lock이 없는 레포에서 `kapel`을 열면,
컴파일하지 않고 한 줄만 남깁니다:

```text
this project's orchestration policy has not been compiled — /plan or
/orchestrate will compile it (one model call), or `/policy` rewrites it in
the form that needs none.
```

`.agent/orchestration.lock.json`이 **생기지 않았는지** 확인하세요. REPL을
열었다는 것만으로는 모델을 부르지 않습니다 — `/plan`이나 `/orchestrate`를
칠 때 비로소 컴파일합니다. 그 줄은 세션당 한 번만 나옵니다.

실패해도 REPL은 멈추지 않고 대화로 이어지며, 같은 세션에서는(`/plan`이나
`/orchestrate`를 쳐도) 다시 시도하지 않습니다. 파이프·리다이렉트 입력이나
`--no-setup`에서는 이 준비가 아예 실행되지 않습니다.

**이 시나리오에서는 위 명령대로 `--no-setup`을 붙여 실행하세요** — 시나리오
C(4장)에서 `kapel init`과 `kapel policy compile`을 손으로 실행해 볼
것이므로, 자동 준비가 먼저 끝내 버리면 안 됩니다. `--no-setup`을 쓰면
`.agent/`도, 안내 줄도 생기지 않고 대화가 바로 시작됩니다(일반 대화에는
`.agent/`가 필요 없습니다).

터미널에서 실행하면 배너 대신 **대시보드 패널**이 먼저 뜹니다. 왼쪽은 설정
(작업 디렉터리, 세션 id, 이 대화가 쓰는 백엔드·모델, 설정된 백엔드별 로그인
상태, 네 개 역할의 `role  backend:model`), 오른쪽은 이 워크스페이스의 작업량
(`.agent/sessions.db`에서 읽은 오늘/최근 7일의 실행·대화 수, 성공/실패 태스크,
토큰 합계)입니다:

```text
╭─ kapel v0.17.0 ──────────────────────────────────────────────────────────────╮
├───────────────────────────────────────┬──────────────────────────────────────┤
│ setup                                 │ activity                             │
│ workspace    /tmp/agent-fixture       │ today    no runs yet                 │
│ session      0f3c9a2b                 │ 7 days   no runs yet                 │
│ chat         claude-sonnet-5          │                                      │
│ backends     ✓ claude-code            │ usage (kapel-tracked, 7 days)        │
│                                       │ claude-code  0 in · 0 out            │
│ orchestrator claude-code:opus         │                                      │
│ …                                     │                                      │
╰───────────────────────────────────────┴──────────────────────────────────────╯
▌ type /help for commands, /exit to quit

──────────────────────────────────────────────────────────────────────────────
kapel>
```

**확인할 것**:

- 새 저장소이므로 활동 칸은 `no runs yet`이어야 합니다(0이 늘어선 줄이 아니라).
- **제목은 상자 위 테두리 안에 박혀 있습니다** — `╭─ kapel v0.17.0 ───…─╮`.
  제목만 굵게, 테두리·기둥·구분선은 모두 강조색(muted sky blue)으로 그려집니다.
  예전처럼 상자 **안에** 제목 줄이 따로 있으면 안 됩니다. `/stats`로 다시 그려도
  똑같이 나와야 합니다.
- **강조색은 터미널 능력에 따라 3단계로 떨어집니다.** 확인:
  ```bash
  script -qfc "env COLORTERM=truecolor TERM=xterm-256color kapel chat --no-save --no-setup" /tmp/kapel-c.log
  grep -ao $'\033\[38;2;126;182;217m' /tmp/kapel-c.log | head -1   # 24비트

  script -qfc "env -u COLORTERM TERM=xterm-256color kapel chat --no-save --no-setup" /tmp/kapel-256.log
  grep -ao $'\033\[38;5;110m' /tmp/kapel-256.log | head -1         # 256색

  script -qfc "env -u COLORTERM TERM=xterm kapel chat --no-save --no-setup" /tmp/kapel-16.log
  grep -ao $'\033\[36m' /tmp/kapel-16.log | head -1                # 기본 시안
  ```
  256색 터미널에 24비트 이스케이프를 보내면 숫자가 화면에 그대로 찍히므로,
  이 단계 구분이 틀리면 바로 눈에 띕니다.
- **kapel이 스스로 하는 말에는 왼쪽에 강조색 막대(`▌ `)가 붙습니다** —
  배너 힌트, 자동 셋업 안내(여러 줄이면 줄마다), `resumed …`, 백엔드 자동 감지
  줄, Ctrl-C 안내까지 전부. 도구 로그(`→ read_file …`)와 모델의 답변에는
  붙지 않습니다.
- **`NO_COLOR=1`이면 장식은 전부 사라집니다** — 막대도, 프롬프트 위아래 선도,
  SGR 이스케이프도 하나도 없어야 합니다. 확인:
  ```bash
  script -qfc "env NO_COLOR=1 kapel chat --no-save --no-setup" /tmp/kapel-nc.log
  grep -ac $'\033\[[0-9;]*m' /tmp/kapel-nc.log   # 0
  ```
- 로그인 확인은 CLI를 두 번 띄우므로 1초 예산을 넘기면 해당 칸이 `…`로 그려집니다.
  잠시 뒤 `/stats`를 치면 다시 확인해 `✓`/`!`/`✗`로 채워집니다.
- `.agent/config.local.json`으로 덮어쓴 역할에는 `*`가 붙고, 상자 아래에
  `* from .agent/config.local.json` 한 줄이 나옵니다.
- 구독 잔량은 표시하지 않습니다. `claude`도 `codex`도 남은 사용량을 프로그램이
  읽을 수 있는 형태로 내주지 않기 때문에, 대신 kapel이 직접 기록한 사용량을
  `usage (kapel-tracked, 7 days)`라고 못 박아 보여줍니다.
- 폭이 80칸보다 좁으면 두 칸이 위아래로 쌓인 한 칸 상자로 바뀝니다. 터미널을
  좁혀 놓고 다시 `/stats`를 쳐서 확인해 보세요.
- **파이프·리다이렉트로 실행하면 대시보드는 뜨지 않습니다** — 예전 그대로의
  평문 배너(`kapel v0.17.0  claude-sonnet-5  session 0f3c9a2b`)만 나오고 제어
  문자는 하나도 섞이지 않습니다. 확인:
  `printf '/exit\n' | kapel chat --no-save | cat -A` 에 `^[` 가 없어야 합니다.
- **일반 화면이 기본입니다** — 전사 기록이 터미널 자체 스크롤백에 쌓이므로
  마우스 휠로 그대로 스크롤할 수 있고, ↑/↓ 화살표만이 프롬프트의 이전 메시지를
  불러옵니다. `--altscreen`을 주면 `vim`/`less`처럼 대체 화면 버퍼로 전환해
  깨끗한 화면에서 시작하고(`chat` 앞뒤 어디에 써도 됩니다), **끝내는 방법과
  무관하게**(`/exit`, Ctrl-D, Ctrl-C 두 번, 다른 터미널에서 `kill <pid>`) 원래
  터미널이 이전 히스토리까지 그대로 돌아와야 합니다 — 대체 화면에 남은 채로
  셸로 빠져나오면 버그입니다. 대체 화면에서는 휠이 화살표 키로 번역되지 않도록
  alternate scroll(`?1007`)도 함께 꺼집니다. 확인:

  ```bash
  script -qec "kapel chat --no-save --no-setup --altscreen" /tmp/kapel-tty.log   # 안에서 /exit
  grep -c $'\033\[?1049h' /tmp/kapel-tty.log   # 1 — 들어갈 때
  grep -c $'\033\[?1049l' /tmp/kapel-tty.log   # 1 — 나올 때 (순서대로 한 번씩)
  grep -c $'\033\[?1007l' /tmp/kapel-tty.log   # 1 — 휠→화살표 번역 끔

  script -qec "kapel chat --no-save --no-setup" /tmp/kapel-plain.log
  grep -c $'\033\[?1049' /tmp/kapel-plain.log  # 0 — 기본값(일반 화면)에는 하나도 없어야 합니다
  ```

  파이프·리다이렉트 실행과 `TERM=dumb`에서는 어느 쪽이든 이 시퀀스가 전혀
  나오지 않습니다(위 `cat -A` 확인과 같은 이유).

`kapel>` 프롬프트가 뜨면 대화로 버그 수정을 지시합니다. 이 프롬프트는 입력 편집기입니다:
줄 끝에 `\`를 붙이면(또는 여러 줄을 한 번에 붙여넣으면) 계속 입력할 수 있고
빈 줄로 끝냅니다; ↑/↓로 이전 입력을 다시 불러올 수 있고 이는 `~/.kapel/history`에
세션을 넘어 저장됩니다; Tab은 커서 아래 있는 것을 완성합니다 — `/` 명령 이름,
고정된 인자 목록을 가진 명령의 인자(`/model ` 뒤에서 내장 모델 별칭),
그리고 `@` 파일 멘션.

**프롬프트 위 가로선**부터 확인합니다. 프롬프트가 뜰 때마다 그 바로 위에 강조색
가로선이 한 줄 그어져, 지금 입력 중인 메시지가 위쪽 기록과 시각적으로 분리됩니다.
이 선은 그냥 출력된 한 줄이라 스크롤백에 그대로 남고, 다시 그리거나 지울 것이
없습니다. **아래쪽 선은 일부러 넣지 않았습니다** — 입력줄 아래는 `/` 메뉴가 쓰는
영역인데, 입력한 글자 수가 터미널 폭의 배수가 되는 순간 Node `readline`이 보는
커서 행과 실제 터미널의 커서 행이 한 줄 어긋납니다(짧은 `/명령`은 이 경계에 절대
닿지 않지만 일반 메시지는 폭마다 한 번씩 넘습니다). 매 타이핑마다 그 아래에 무언가를
그리면 줄바꿈된 입력이 한 줄 밀려 깨집니다. 파이프·리다이렉트·`NO_COLOR`에서는
이 선도 그려지지 않습니다.

**Ctrl-C는 입력 중이던 줄을 버립니다.** `/res`까지 치고 Ctrl-C를 누른 뒤 `/exit`를
치면 `/exit`가 그대로 실행되어야 합니다 — 예전에는 버퍼에 `/res`가 남아
`/exit/res`가 디스패치됐습니다. 버린 줄은 화면에 그대로 남고(무엇을 버렸는지
보이도록), 안내 `▌ (/exit to quit, Ctrl-C again to force)`는 그 아래 새 줄에 뜹니다.

```text
────────────────────────────────────────────────────────────────
kapel> /res            ← 여기서 Ctrl-C
▌ (/exit to quit, Ctrl-C again to force)
────────────────────────────────────────────────────────────────
kapel> /exit           ← 그대로 종료. "/exit/res"가 되면 안 됩니다
```

**`/` 명령 메뉴**를 먼저 확인합니다. 메시지 첫 글자로 `/`를 입력하는 순간 입력줄
**아래에** 이 세션의 명령 목록이 뜹니다 — 한 줄에 하나씩, `/help` 표에 있는 것과
같은 설명이 붙습니다. 글자를 더 입력하면 실시간으로 좁혀지고, 이름이 공백으로
끝나거나(인자 입력 시작) 줄이 더 이상 `/`로 시작하지 않으면 그 자리에서 지워집니다.
최대 8줄까지 보여주고 나머지는 `… and N more`로 셉니다. 메뉴는 **보여주기만** 합니다:
Tab은 지금까지처럼 완성하고, Enter는 화면에 후보가 하나만 남아 있어도 입력한 그대로를
보냅니다.

```text
────────────────────────────────────────────────────────────────
kapel> /          ← 입력줄 아래에 명령 목록 8줄 + "… and N more"
kapel> /re        ← /resume, /resume-run 두 줄만 남습니다
kapel> /re⏎       ← 목록이 깨끗이 지워지고 위쪽 기록에 잔상이 남지 않습니다
```

**기대 동작**: 어느 화면(`--altscreen` 유무 모두)에서든 목록이 그려졌다 지워지는
동안 프롬프트 위의 기록은 그대로입니다. 파이프·리다이렉트 실행에서는 메뉴가 아예
그려지지 않습니다 — 제어 문자가 하나도 나오지 않아야 합니다:

```bash
printf '/re\n/exit\n' | kapel chat --no-save --no-setup > /tmp/kapel-piped.log
grep -c $'\033' /tmp/kapel-piped.log   # 0
```

**`@` 파일 멘션 (P1-3)**을 이어서 확인합니다. `@`에 이어 경로 일부를 입력하고
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

**기대 동작**: read/grep은 자동 허용, `edit_file`/`bash` 실행 전에
`allow ...? [y/n/a, or say what to do instead]` 프롬프트 → y 응답 → 수정 후 요약 +
그 턴의 토큰/비용 한 줄(`tokens +… in, +… out`).
프롬프트 위에는 실제로 일어날 일이 먼저 표시됩니다 — `bash`는 명령 전문,
`edit_file`은 `-`/`+` 유니파이드 diff, `write_file`은 경로와 내용 앞부분.
답은 `y`(이번만 허용) / `n`·Enter·Ctrl-C(거부) / `a`(이 세션 동안 계속 허용) /
**그 밖의 아무 문장**(거부하면서 그 말을 그대로 에이전트에게 전달) 네 가지입니다.
예를 들어 `왜 이 파일을 지우려는 거야?`나 `config 파일을 대신 써줘`라고 답하면
해당 도구 호출은 실행되지 않고, 같은 턴 안에서 에이전트가 그 말에 답하며 다른
방법을 제안합니다(제안한 동작은 다시 프롬프트로 물어봅니다). 이 답변은 세션
허용 목록에 아무것도 남기지 않습니다. `a`는 `bash`의 경우 **명령 프리픽스**를 기억합니다 —
`npm test --run foo`에 `a`로 답하면 이후 `npm test …`는 다시 묻지 않지만
`npm publish`는 다시 묻습니다(`&&`·`|` 같은 셸 연산자가 섞인 명령은 기억하지 않음).
그 밖의 도구는 도구 이름 단위로 기억하며, 어느 쪽도 디스크에 저장되지 않아
프로세스가 끝나면 사라집니다.
프롬프트로 돌아오면 대화가 이어집니다:

```text
kapel> sub 함수도 추가하고 테스트도 같이 만들어줘
kapel> /usage        # 이 프로세스의 누적 토큰·비용
kapel> /stats        # 대시보드 다시 그리기 — 이제 today 칸이 "1 chat"과 실제 토큰으로 채워집니다
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
`/model <alias>`(이후 턴부터 모델 교체), `/config`(머신 설정 마법사를 다시 돌려
백엔드·모델을 이 대화에 바로 적용 — 이 디렉터리의 `.agent/config.local.json`
덮어쓰기는 그대로 유지되고, 백엔드는 오케스트레이터 역할의 것을 따릅니다;
대화 내용은 유지됨), `/compact`(지금 바로
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

## 2.6. 이미지 첨부 — `@` 멘션

이미지는 REPL의 `@` 멘션으로 첨부하며, **세 백엔드 모두** 동작합니다.
메시지에 `@screenshot.png`처럼 이미지 파일(png/jpg/jpeg/gif/webp)을 멘션하면
그 턴에 이미지가 첨부됩니다. 한 턴에 최대 4장, 장당 5 MiB — 이 한도는
백엔드와 무관하게 동일합니다.

```text
kapel> @screenshot.png 이 화면에서 뭐가 잘못됐어?
```

**기대 동작**: 프롬프트에 `[attached images: screenshot.png]`가 표시되고
모델이 이미지 내용을 근거로 답합니다. 전달 방식은 백엔드에 따라 다릅니다 —
네이티브는 이미지 자체를 전송, `--backend codex`는 Codex CLI의 자체 이미지
입력(`-i <경로>`)으로 경로를 전달, `--backend claude-code`는 프롬프트의
`<attached-images>` 블록으로 경로를 전달해 에이전트가 Read 도구로 직접
열어 봅니다. 한도 초과·읽기 실패 시에는 `note: @huge.png was not attached
— …` 안내 후 경로 멘션으로 강등되어 턴은 그대로 전송됩니다. 원샷 플래그는
여전히 없습니다 (`kapel -i x.png` → `error: unknown option '-i'`, 종료
코드 1).

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

배너가 `kapel v0.17.0  claude-code · opus  session 0f3c9a2b` 형태로 뜨고, 그
아래에 `approvals are enforced by the Claude Code CLI — kapel does not prompt here`
가 표시됩니다 — 이 경로에서는 kapel이 `allow …? [y/n/a, …]`를 묻지 않습니다(승인은
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

(2장에서 `--no-setup` 없이 `kapel`을 먼저 열어 자동 준비가 이미 끝났다면
`.agent/`와 lock이 있습니다 — `kapel init`은 `already exists`를 출력하며
종료 코드 1이니 이 단계를 건너뛰거나 `kapel init --force`로 다시 만드세요.
아래 `kapel policy compile`은 그대로 실행해도 됩니다.)

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
kapel policy compile            # 정규 형식 정책 → orchestration.lock.json
                                # `Read the policy from its canonical form — no model call.`
                                # `tokens — …` 줄이 **없어야** 합니다 (쓴 게 없으니까)
kapel policy explain            # 컴파일된 정책 요약 확인
kapel policy check              # 오프라인 신선도 검사 (CI용)

# .agent/orchestration.md를 열어 정규 형식인지 확인하세요 — 첫머리에
# `<!-- kapel:policy v1 -->` 마커가 있고, `## Execution` / `## Routing` 아래에
# 한 줄짜리 규칙들이 있어야 합니다.

# 편집기: 모델을 부르지 않고 정책을 고칩니다.
kapel policy edit               # "Concurrency" 선택 → 숫자 변경 → "Save"
                                # `No model was called.` 로 끝나고, 바뀐 항목이 diff로 출력됩니다
kapel policy check              # 편집 직후에도 lock이 이미 fresh여야 합니다 (컴파일 불필요)

# 정규 형식을 손으로 고친 뒤:
kapel policy diff                # lock 대비 변경 예정 사항만 미리보기 (lock은 그대로, 모델 호출 없음)
kapel policy compile             # 실제로 lock을 갱신 — 다만 손으로 칠 일은 거의 없습니다:
                                 # 아래처럼 다음 `kapel` 시작 때 알아서 다시 읽습니다

# 산문으로 되돌리면 모델 경로로 넘어갑니다. orchestration.md를 통째로
# 자연어 몇 문단으로 바꾼 뒤(마커 줄도 지우고):
kapel policy compile            # 이번에는 `Compiled policy using …` + `tokens — …`
                                # warnings/ambiguities에 orchestration.md:N 줄 번호가 붙는지 확인

# 마커는 남기고 규칙 한 줄만 망가뜨리면, 몇 번째 줄인지 stderr로 알린 뒤
# 모델로 컴파일합니다 — 조용히 무시하지 않는지 확인하세요.

# 위임 백엔드에서도 동일하게 동작합니다(API 키 불필요 — 3.4/3.5 참고):
kapel policy compile --backend codex   # 산문 정책일 때 `tokens — …` 줄에 CLI가 보고한 토큰이,
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
라인, worktree 생성(⎇)·병합(⇡) 라인, `git log`에 merge 커밋들. 실행이
끝나면 태스크별 상태 테이블(STATUS/ID/AGENT/TRIES/MODEL/TOKENS/$/TITLE)에
이어 **에이전트별 요약 테이블**이 출력됩니다 — 실제로 뭔가를 한 참가자마다
한 행씩, 오케스트레이터가 첫 행입니다: AGENT/ROLE/BACKEND·MODEL/TASKS/DID/
TOKENS 열로, 오케스트레이터 행은 `planned N tasks`(정책이 리뷰를 주입했으면
`· M reviews injected`도)와 objective 요약을, 워커 행은 `2 ok · 1 failed`
같은 태스크 집계와 완료한 태스크 제목들을 보여줍니다. 이스컬레이션된
태스크는 최종적으로 완료(또는 끝까지 실패)시킨 에이전트 쪽으로 집계됩니다.
`--json`에서는 같은 정보가 `run.summary` 줄의 `agents` 배열로 나옵니다.
정책 lock이 없거나 오래되었으면 그 사실을 알리고 대화는 그대로
유지됩니다(REPL이 끊기지 않습니다).

**준비되지 않은 프로젝트에서의 `/plan`·`/orchestrate`**: 대화형 세션은 2장
처럼 열릴 때 자동으로 준비를 마치므로, 이 상태를 보려면 `--no-setup`으로
시작했거나(2장 참고) 비대화형으로 시작한 세션이어야 합니다. 그런 세션은
`.agent/`나 lock이 없어도 자동 준비를 시도하지 않고 곧바로 에러를 냅니다.
확인해 보려면 `.agent/`가 없는 빈 디렉터리에서 `kapel --no-setup`을 연 뒤
`/plan 아무거나`를 입력하세요 — 아무 안내 줄도 없이 예전 그대로
`No .agent directory found — run \`kapel init\` first`가 출력됩니다.
(대화형 세션에서 자동 준비 자체가 실패했을 때는 실패를 알리는 한 줄이
뜨고, 같은 세션의 다음 `/plan`·`/orchestrate`에서는 다시 시도하지 않고
에러만 납니다. 정규 형식 정책은 모델을 부르지 않으므로 자격증명이 없다는
이유로 여기서 실패하지는 않습니다 — 정책을 산문으로 다시 쓴 프로젝트만
그렇습니다.)

격리(worktree), 검증기, 백엔드는 이제 플래그가 아니라 설정에서 결정됩니다 —
`--worker-mode`/`--isolation`/`--tui`/`--dry-run`/`--no-validate`는 제거되었고,
워커는 항상 이 프로세스의 네이티브 루프(또는 위임 백엔드의 CLI)에서 돕니다.

### 4.4. 에디터로 고친 정책은 알아서 따라옵니다

`.agent/orchestration.md`(정규 형식)를 에디터로 열어 한 줄 고칩니다:

```bash
sed -i 's/- Run at most 4 agents at a time./- Run at most 2 agents at a time./' .agent/orchestration.md
kapel        # 그냥 다시 엽니다 — 아무 명령도 치지 않습니다
```

**기대 동작**: 배너 전에 두 줄이 뜨고, lock이 갱신되어야 합니다.

```text
re-reading this project's edited orchestration policy…
Read the policy from its canonical form — no model call.
Lock written to …/.agent/orchestration.lock.json
```

`kapel policy check` → `policy lock is up to date`,
`.agent/orchestration.lock.json`의 `policy.maxConcurrency`가 2여야 합니다.
`kapel policy compile`을 손으로 칠 일이 없다는 것이 요점입니다.

**산문으로 고쳤을 때는 반대로 동작합니다** — `orchestration.md`를 자연어로
바꾸면(마커 줄도 지우고) 시작 시 컴파일하지 않고 한 줄만 남깁니다:

```text
this project's orchestration policy has changed since it was compiled — /plan
or /orchestrate will compile it (one model call), or `/policy` rewrites it in
the form that needs none.
```

lock이 **갱신되지 않았는지** 확인하세요.

## 4.5. `/policy` — 모델 없이 정책 고치기

REPL 안에서:

```text
kapel> /policy                  ← 화살표 목록이 뜹니다
```

**기대 동작**: `Orchestration policy` 제목 아래 `Orchestrator` / `Concurrency`
/ `Independent tasks` / `Attempts per task` / `Routing rules (5)…` /
`Review rules (1)…` / `Escalation rules (2)…` / `Save` / `Discard changes`
가 보입니다. 확인할 것:

- **스칼라 편집** — `Attempts per task`를 골라 숫자를 바꾸고 `Save`.
  `Wrote …/orchestration.md`, `Lock written to …`, 바뀐 항목 diff
  (`defaultMaxAttempts: 2 -> 4`), 마지막에 `No model was called.`
- **규칙 추가** — `Routing rules…` → `Add a rule…` → 필드를 고친 뒤 `Back`.
  목록에 새 규칙이 늘어나야 합니다. 반대로 규칙 화면에서 **esc**로 빠져나오면
  추가되지 **않아야** 합니다(아무것도 안 고치고 `Back`을 누른 경우는 추가됩니다).
- **규칙 삭제** — 규칙을 고른 뒤 `Remove this rule`.
- **취소** — `Discard changes`를 고르면 `Nothing written — the policy is
  unchanged.` 가 뜨고 파일이 그대로여야 합니다.
- **저장 직후 신선함** — 셸에서 `kapel policy check` → `policy lock is up to
  date`. 편집기가 lock까지 쓰므로 컴파일이 남아 있지 않습니다.
- **잘못된 에이전트 거부** — 편집기는 이 프로젝트가 정의하지 않은 에이전트를
  저장하지 못합니다(에이전트 필드가 목록 선택이라 정상 경로에서는 나오지
  않지만, `.agent/agents/`에서 파일 하나를 지운 뒤 `Save`를 눌러 보면
  `This policy cannot be saved yet:` 가 뜹니다).

파이프·리다이렉트에서는 `/policy`도 `kapel policy edit`도 물어볼 터미널이
없다고 알리고 종료합니다.

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
- `~/.kapel/config.json`은 머신 단위 설정이고, `.agent/config.local.json`은
  같은 모양의 디렉터리 단위 덮어쓰기(커밋되지 않음)입니다. 저장소에 커밋되는
  `.agent/config.yaml`(에이전트별 모델)과는 별개이며, `kapel init`이 전자에서
  후자를 채워 줄 뿐입니다.
- `.agent/sessions.db*`·`.agent/worktrees/`·`.agent/config.local.json`은 대상
  저장소의 `.gitignore`에 추가하는 것을 권장합니다(`kapel init`이 자동으로
  넣어 줍니다).

## 문제 리포트

이슈가 발생하면 다음을 함께 공유해 주세요: 실행한 명령(또는 슬래시 명령),
`kapel runs --json` / `kapel explain <taskId> --json` 출력,
`.agent/sessions.db`의 해당 런 ID.
