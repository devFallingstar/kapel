# 실환경 스모크 테스트 가이드

로컬 머신에서 v0.1 전체 기능을 실제 모델로 검증하는 절차입니다. 소요 시간은
인증 준비를 제외하면 15–20분 정도입니다.

> **요구 사항**: Node.js 20 이상, git. **Windows cmd, macOS, Linux 모두
> 네이티브 지원**합니다 (셸 명령은 POSIX에서는 bash, Windows에서는
> cmd.exe로 실행됩니다).

## 0. 설치 (Windows cmd / macOS / Linux 공통)

빌드 없이 저장소에 포함된 패키지 tarball을 전역 설치합니다 (한 줄):

```bash
npm install -g https://raw.githubusercontent.com/devFallingstar/kapel/main/release/devfallingstar-kapel-0.5.0.tgz
kapel --version
```

npm 레지스트리 배포 후에는 `npm install -g @devfallingstar/kapel` 로 대체됩니다.
URL 접근이 안 되는 네트워크라면: 레포를 클론한 뒤
`npm install -g ./kapel/release/devfallingstar-kapel-0.5.0.tgz`. 제거는
`npm uninstall -g @devfallingstar/kapel`.

> `npm install -g github:...` 형태는 쓰지 마세요 — npm의 워크스페이스
> git 의존성 처리 버그로 설치가 깨집니다(빈 명령어 증상). 이전에 그렇게
> 설치했다면 `npm uninstall -g orchestration-agent kapel` 후 위 방법으로
> 재설치하세요.

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

**기대 동작**: `kapel is not configured yet …` 안내 후 네 개의 화살표 목록이
차례로 나옵니다.

```text
Which coding backend should kapel use?   ← Claude Code / Codex / API key
Main orchestrator model                  ← 예: opus
Worker model — normal complexity         ← 예: sonnet
Worker model — low complexity / exploration  ← 예: haiku
```

선택한 백엔드가 설치/로그인되어 있지 않으면 `warning: … does not look ready`와
설치·로그인 방법을 알려 준 뒤 설정은 계속 진행됩니다(경고일 뿐 중단하지 않음).
답을 마치면 요약과 `saved to …/config.json`이 출력되고, 이어서 원래 하려던
명령(여기서는 대화형 모드)이 그대로 실행됩니다. `esc`로 취소하면
`setup cancelled`만 남고 아무것도 저장되지 않습니다.

확인 항목:

```bash
kapel config --show     # 저장된 백엔드·모델 3종 + 파일 경로
kapel config --path     # 경로만
kapel config            # 언제든 다시 설정 (현재 값이 기본 선택으로 뜸)
kapel --no-setup "..."  # 마법사를 건너뛰고 환경변수/기본값으로 실행
echo "" | kapel         # 파이프(비-TTY) — 마법사 없이 도움말만 출력
```

우선순위 확인: `--backend`/`-m` 플래그 → `AGENT_BACKEND`/`AGENT_MODEL` 환경변수
→ `~/.kapel/config.json` → 내장 기본값 순으로 먼저 잡히는 값이 이깁니다.
예를 들어 설정이 `claude-code`여도 `kapel --backend native "..."`는 네이티브
경로로 실행됩니다.

설정을 마친 뒤 `kapel init`을 실행하면 `.agent/config.yaml`의 `models:`가
전역 설정에서 채워집니다(`lead`/`reviewer` ← 오케스트레이터 모델,
`worker`·`cheap` ← 워커 모델 2종). 설정이 없으면 템플릿 그대로 복사됩니다.

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

kapel                     # 목적을 인자로 주지 않으면 대화형 모드로 진입
```

배너(`kapel v0.5.0  claude-sonnet-5  session 0f3c9a2b`)와 `kapel>` 프롬프트가
뜨면 대화로 버그 수정을 지시합니다. 이 프롬프트는 입력 편집기입니다:
줄 끝에 `\`를 붙이면(또는 여러 줄을 한 번에 붙여넣으면) 계속 입력할 수 있고
빈 줄로 끝냅니다; ↑/↓로 이전 입력을 다시 불러올 수 있고 이는 `~/.kapel/history`에
세션을 넘어 저장됩니다; `/`를 입력하고 Tab을 누르면 슬래시 명령어가 자동완성됩니다.

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
kapel> /exit
```

네이티브 백엔드는 대화가 60메시지를 넘으면 자동으로도 압축됩니다 — 오래된 도구
결과가 지워지고(대화 자체는 남고, 지워졌다는 표시만 남습니다) 회색 글씨로
`≈ context compacted: …` 한 줄이 뜨며 대화는 끊기지 않고 계속됩니다. `--backend
codex`/`--backend claude-code`에서는 외부 CLI가 자기 컨텍스트를 관리하므로
`/compact`는 "not supported with the … backend" 한 줄만 출력합니다.

이어서 **재개**를 확인합니다 — 대화는 `.agent/sessions.db`에 저장되므로
프로세스를 껐다 켜도 이어집니다:

```bash
kapel chat --continue     # 방금 그 대화를 그대로 이어받음 ("resumed … (N messages)")
```

`kapel chat --help`로 `--session <id>`(특정 대화, 접두사 가능)와 `--no-save`도
확인할 수 있습니다. 프롬프트에서 `/new`(새 대화), `/resume <id>`(전환),
`/model <alias>`(이후 턴부터 모델 교체), `/config`(설정 마법사를 다시 돌려
백엔드·모델을 이 대화에 바로 적용 — 대화 내용은 유지됨), `/compact`(지금 바로
컨텍스트 압축), `/help`도 함께 눌러 보세요. `/config`는 터미널에서만 동작하며,
파이프로 실행 중이면 `/config needs a terminal —` 안내가 나옵니다.

추가 확인: 턴 진행 중 Ctrl-C(해당 턴만 취소, 대화는 유지), 프롬프트에서 Ctrl-C
두 번(종료), Ctrl-D(종료).

**단발 실행(one-shot)** 형태도 그대로 동작합니다 — CI나 스크립트용:

```bash
kapel "calc.test.js가 실패하는 원인을 찾아서 고쳐줘. node calc.test.js로 검증까지 해줘."
```

추가 확인: `-y`(프롬프트 생략), `--json`(JSONL 스트림 — 대화형에서는 지원하지
않고 안내 후 종료 코드 1), Ctrl-C(중단), `--timeout 30`.

**파이프 입력 + objective 병합** 확인 — stdin이 터미널이 아니고 objective도
있으면, 파이프로 들어온 내용이 objective 뒤에 `--- piped input ---` 구분선과
함께 붙습니다:

```bash
cat calc.test.js | kapel "이 파일에서 버그를 찾아 고쳐줘"
echo -n "" | kapel "fix the failing test"   # 0바이트 파이프 → objective 단독과 동일
```

**기대 동작**: 첫 명령은 `calc.test.js`의 내용이 프롬프트에 포함된 채로 실행됨
(모델이 굳이 `read_file`을 부르지 않고도 파일 내용을 이미 알고 있음). 둘째
명령은 파이프가 없을 때와 동일하게 동작 — objective만으로 실행됨. `-y`,
`--json`, `-m`/`--backend` 등 다른 플래그와 조합해도 동일하게 동작합니다.
objective 없이 파이프만 하는 경우(`echo "hi" | kapel`)는 이 병합과 무관한
기존 기능 그대로입니다 — 대화형 REPL이 파이프 라인을 입력으로 소비.

**`AGENTS.md` 로딩** 확인 — 같은 저장소에 프로젝트 지시 파일을 두고 다시 실행합니다:

```bash
echo 'always run `node calc.test.js` after every edit' > AGENTS.md
kapel
```

**기대 동작**: 배너 다음 줄에 `instructions: AGENTS.md`가 뜨고, 첫 턴부터 그
규칙을 따릅니다. `.agent/AGENTS.md`(kapel 전용 규칙)와 `~/.kapel/AGENTS.md`
(`$KAPEL_CONFIG_DIR` 우선, 머신/사용자 전역 규칙)도 같은 방식으로 합쳐지며,
존재하는 파일만 배너에 나열됩니다 — 아무 파일도 없으면 그 줄 자체가 생략됩니다.

## 3. 시나리오 B — Codex 백엔드 (OpenAI OAuth)

```bash
cd /tmp/agent-fixture
kapel --backend codex "calc.js의 add 함수에 뺄셈 함수 sub를 추가해줘"
```

**기대 동작**: Codex CLI가 스폰되어 명령 실행·파일 변경이 스트리밍되고
정상 종료합니다. 미설치/미로그인이면 설치·로그인 안내 후 종료 코드 1.

## 3.5. 시나리오 B2 — Claude Code 백엔드 (구독 로그인)

API 키 없이 Claude 구독 로그인만으로 동작하는 경로입니다. 먼저 단발 실행:

```bash
cd /tmp/agent-fixture
kapel --backend claude-code "calc.js의 add 함수 옆에 sub 함수를 추가해줘"
```

**기대 동작**: `claude -p`가 스폰되어 도구 사용 라인(`→ claude: Edit`)과 최종
답변이 출력되고, `status: success`로 끝납니다. 미설치/미로그인이면 설치·로그인
안내(`npm install -g @anthropic-ai/claude-code`, `claude` 실행 후 로그인) 후
종료 코드 1.

이어서 **Claude Code 백엔드로 대화형 사용**을 확인합니다:

```bash
kapel --backend claude-code            # 목적 없이 실행 → 대화형
```

배너가 `kapel v0.5.0  claude-code · opus  session 0f3c9a2b` 형태로 뜨고, 그
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

참고: 오케스트레이션(`kapel orchestrate`)은 아직 `--backend claude-code`를
지원하지 않으며, 실행하면 그렇게 안내하고 종료합니다.

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

kapel plan "calc.js에 곱셈/나눗셈 함수를 추가하고 각각 테스트 파일도 만들어줘"
                                # 태스크 DAG + 라우팅 미리보기 (실행 없음)
kapel plan --why "calc.js에 곱셈/나눗셈 함수를 추가하고 각각 테스트 파일도 만들어줘"
                                # 각 태스크가 어느 규칙으로 어느 에이전트/모델에 라우팅되는지 근거 출력

kapel orchestrate "calc.js에 곱셈/나눗셈 함수를 추가하고 각각 테스트 파일도 만들어줘"
                                # 실제 실행 — worktree 격리 + 병렬 워커
```

**기대 동작**: `▶ T01 → explorer` 같은 태스크 라이프사이클 라인, worktree
생성(⎇)·병합(⇡) 라인, 태스크별 상태 테이블, `git log`에 merge 커밋들.

옵션 확인:

- `--tui` — Ink 라이브 대시보드
- `--worker-mode child` — 태스크별 자식 프로세스
- `--isolation none` — worktree 격리 끄기

## 5. 세션·재개·설명 (M6)

```bash
kapel runs                      # 방금 런이 목록에 표시
kapel explain T01               # 라우팅 근거 + 이벤트 다이제스트
kapel resume <runId>            # (실패한 런이 있을 때) 미완료 태스크만 재실행
```

대화(시나리오 A)와 오케스트레이션 런은 같은 `.agent/sessions.db`에 각자
저장됩니다: 대화는 `kapel chat --continue` / 프롬프트의 `/sessions`,
런은 `kapel runs`로 확인합니다. 대화형 프롬프트에서
`/orchestrate "<objective>"`로 위 파이프라인을 바로 돌릴 수도 있습니다
(정책 lock이 최신이어야 하며, 실패해도 대화는 유지됩니다).

## 6. 검증 게이트 (M5)

`.agent/config.yaml`에 추가 후 orchestrate를 다시 실행하면, 각 쓰기 태스크가
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

이슈가 발생하면 다음을 함께 공유해 주세요: 실행한 명령, `--json` 출력(가능하면),
`kapel explain <taskId>` 출력, `.agent/sessions.db`의 해당 런 ID.
