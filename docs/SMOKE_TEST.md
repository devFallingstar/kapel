# 실환경 스모크 테스트 가이드

로컬 머신에서 v0.1 전체 기능을 실제 모델로 검증하는 절차입니다. 소요 시간은
인증 준비를 제외하면 15–20분 정도입니다.

> **요구 사항**: Node.js 22 이상(권장 24), git, bash가 있는 환경
> (macOS / Linux / WSL — 도구 실행과 검증기가 `bash -lc`를 사용하므로
> Windows 네이티브 셸은 지원하지 않습니다).

## 0. 설치

```bash
git clone https://github.com/devFallingstar/multi-model-orchestration-agent.git
cd multi-model-orchestration-agent
git checkout claude/upload-zip-commit-b8wouv
npm install && npm run build

# 편의를 위한 alias (또는 `npm link -w @agent/cli` 후 `agent` 사용)
alias agent="node $(pwd)/apps/cli/dist/index.js"
```

빠른 자체 점검: `npm test` → 774개 테스트가 통과해야 합니다.

### Windows (cmd) 사용자

`alias`는 cmd에서 동작하지 않습니다. 대신 저장소 루트에서 한 번 실행하세요:

```cmd
npm link -w @agent/cli
```

이후 아무 디렉토리에서나 `agent ...`를 쓸 수 있습니다(제거:
`npm unlink -g @agent/cli`). 임시로 쓰려면
`doskey agent=node C:\경로\apps\cli\dist\index.js $*` 도 가능합니다.

**제한**: `bash` 도구와 `validation:` 검증기는 `bash`를 스폰하므로 PATH에
bash가 필요합니다(Git for Windows 설치 후 cmd에서 `bash -c "echo ok"` 로
확인). 파일 읽기/수정/검색 도구와 worktree 격리는 Windows 네이티브로
동작합니다. 가장 매끄러운 경험은 WSL 또는 Git Bash 터미널입니다.

## 1. 인증 준비 (하나 이상)

| 경로 | 방법 | 확인 |
|---|---|---|
| Anthropic API 키 | `export ANTHROPIC_API_KEY=...` | `agent models` 에 `api key` 표시 |
| Anthropic OAuth (키 없음) | [`ant` CLI](https://github.com/anthropics/anthropic-cli) 설치 후 `ant auth login` | `agent models` 에 `oauth (ant)` 표시 |
| OpenAI (키 없음, Codex) | `npm i -g @openai/codex && codex login` (ChatGPT OAuth) | 시나리오 B에서 사용 |

`agent models` 로 각 모델 별칭의 자격증명 상태를 먼저 확인하세요.

## 2. 시나리오 A — 단일 에이전트 루프 (M1)

테스트용 저장소를 하나 만들고 그 안에서 실행합니다:

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

agent "calc.test.js가 실패하는 원인을 찾아서 고쳐줘. node calc.test.js로 검증까지 해줘."
```

**기대 동작**: read/grep은 자동 허용, `edit_file`/`bash` 실행 전에 `allow ...? [y/N]`
프롬프트 → y 응답 → 수정 후 테스트 통과 요약 + 토큰/비용 출력, 종료 코드 0.

추가 확인: `-y`(프롬프트 생략), `--json`(JSONL 스트림), Ctrl-C(중단), `--timeout 30`.

## 3. 시나리오 B — Codex 백엔드 (OpenAI OAuth)

```bash
cd /tmp/agent-fixture
agent --backend codex "calc.js의 add 함수에 뺄셈 함수 sub를 추가해줘"
```

**기대 동작**: Codex CLI가 스폰되어 명령 실행·파일 변경이 스트리밍되고
정상 종료합니다. 미설치/미로그인이면 설치·로그인 안내 후 종료 코드 1.

## 4. 시나리오 C — 멀티 에이전트 오케스트레이션 (M2–M6)

```bash
cd /tmp/agent-fixture
agent init                      # .agent/ 템플릿 복사
```

`.agent/config.yaml`의 `models:`를 보유한 자격증명에 맞게 수정하세요.
Anthropic만 있다면 `reviewer`를 다음처럼 바꿉니다:

```yaml
  reviewer:
    provider: anthropic
    model: claude-opus-5
```

이후:

```bash
agent policy compile            # 자연어 정책 → orchestration.lock.json (LLM 1회 호출)
agent policy explain            # 컴파일된 정책 요약 확인
agent policy check              # 오프라인 신선도 검사 (CI용)

agent plan "calc.js에 곱셈/나눗셈 함수를 추가하고 각각 테스트 파일도 만들어줘"
                                # 태스크 DAG + 라우팅 미리보기 (실행 없음)

agent orchestrate "calc.js에 곱셈/나눗셈 함수를 추가하고 각각 테스트 파일도 만들어줘"
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
agent runs                      # 방금 런이 목록에 표시
agent explain T01               # 라우팅 근거 + 이벤트 다이제스트
agent resume <runId>            # (실패한 런이 있을 때) 미완료 태스크만 재실행
```

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
- `.agent/sessions.db*`와 `.agent/worktrees/`는 대상 저장소의 `.gitignore`에
  추가하는 것을 권장합니다.

## 문제 리포트

이슈가 발생하면 다음을 함께 공유해 주세요: 실행한 명령, `--json` 출력(가능하면),
`agent explain <taskId>` 출력, `.agent/sessions.db`의 해당 런 ID.
