# kapel UX 갭 분석 및 로드맵

대상 비교군: **Claude Code**, **OpenAI Codex CLI**, **opencode (sst/opencode)**.
기준일 2026-08-19. kapel 쪽 근거는 모두 이 저장소의 실제 코드이며, peer 주장은
1차 문서에 인라인 링크로 표시했다. 확인하지 못한 항목은 `(미확인)`으로 남겼다.

이미 착륙 중인 작업(`--backend claude-code`, 최초 실행 설정 마법사 +
`~/.kapel/config.json` + `/config`, `BackendChatSession`)은 **존재하는 것으로 간주**하고
아래에서 다시 제안하지 않는다.

---

## 1. Executive summary — 지금 일상 사용성을 가장 크게 막는 5가지

**① 입력기가 사실상 없다.** `ttyLineSource()`는 프롬프트마다 새
`readline.createInterface`를 만들고 즉시 닫는다(`apps/cli/src/interactive.ts:749`).
결과적으로 **↑ 히스토리가 세션 내에서도 동작하지 않고**, 멀티라인 입력이 없고,
여러 줄 붙여넣기는 여러 개의 메시지로 쪼개지며, `@` 파일 멘션도 `/` 자동완성도 없다.
세 peer 모두 이걸 기본으로 제공한다 — Claude Code는 `\`+`Enter`/`Ctrl+J` 멀티라인과
`Ctrl+R` 역방향 검색, 작업 디렉터리별 영속 히스토리를 갖고
([interactive-mode](https://code.claude.com/docs/en/interactive-mode)), Codex는 `@` 퍼지
파일 검색을([getting-started](https://github.com/openai/codex/blob/rust-v0.44.0/docs/getting-started.md)),
opencode는 `@` 멘션·`!` 셸 모드·Emacs 편집 키맵 전체를 제공한다
([tui.mdx](https://github.com/sst/opencode/blob/dev/packages/web/src/content/docs/tui.mdx),
[keybinds.mdx](https://github.com/sst/opencode/blob/dev/packages/web/src/content/docs/keybinds.mdx)).
이 한 항목이 "다른 에이전트를 쓰다가 kapel로 오면 손이 아프다"의 대부분을 설명한다.

**② 턴이 도는 동안 화면이 죽어 있다.** provider는 `text.delta`를 스트리밍하지만
`AgentLoop.#runTurn`이 이를 내부 변수에 누적만 하고
(`packages/coding-agent/src/loop.ts:354-387`), 텍스트는 `model.turn.completed`에서
한 번에 방출된다. `TextRenderer`는 도구 시작 `→`/종료 `✓` 두 줄만 찍으므로
(`apps/cli/src/render.ts:168-180`), 모델이 생각하는 수십 초 동안 **스피너도, 경과 시간도,
부분 텍스트도 없다**. 세 peer 모두 토큰 단위 스트리밍이 기본이다.

**③ 승인 UX가 2택이고, 되돌릴 방법이 없다.** `askOnce()`는 `[y/N]` 뿐이며
(`apps/cli/src/prompter.ts:91`), 미리보기는 툴 입력 JSON을 120자로 자른 문자열이라
`edit_file`의 실제 diff를 볼 수 없다(`previewInput`). "이 세션 동안 이 도구는 허용",
"이 경로는 거부" 같은 축이 전혀 없고, 대화형 경로는 worktree 격리도 받지 않으므로
(`--isolation`은 `orchestrate`/`resume` 전용) 잘못 승인하면 작업 트리가 그대로 오염된다.
Claude Code는 `Shift+Tab` 권한 모드 순환과 `/rewind`(Esc Esc) 체크포인트를 갖고
([checkpointing](https://code.claude.com/docs/en/checkpointing)), opencode는 도구/패턴별
`allow|ask|deny`와 `/undo`·`/redo`를 갖는다
([permissions.mdx](https://github.com/sst/opencode/blob/dev/packages/web/src/content/docs/permissions.mdx)).

**④ 프로젝트 지시 파일이 없고, 컨텍스트 압축이 배선되어 있지 않다.**
시스템 프롬프트는 `defaultSystemPrompt(workspacePath)` 하나뿐이고, `CLAUDE.md`/`AGENTS.md`
상당물이 없다 — Claude Code는 managed→user→project→local 4계층
([memory](https://code.claude.com/docs/en/memory)), Codex는 `~/.codex/AGENTS.md` +
repo root + cwd 3단 병합, opencode는 `AGENTS.md` + `instructions` 키
([rules.mdx](https://github.com/sst/opencode/blob/dev/packages/web/src/content/docs/rules.mdx)).
게다가 `CompactionOptions`는 `loop.ts`에 구현되어 있지만 **CLI 어디에서도 주입하지 않는다**
(전 저장소에서 `compaction:`을 넘기는 호출부 0건). 긴 대화형 세션은 결국 컨텍스트
한도에서 실패한다.

**⑤ 오케스트레이션이라는 제품 명제가 대화형에서 보이지 않는다.** `▶ T02 → coder
(attempt 1)`은 **어떤 모델로 갔는지도, 왜 그리로 갔는지도** 말하지 않는다
(`render.ts:217`). 라우팅 근거는 사후 `kapel explain <taskId>`에만 있고, 비용은 런 전체
합계 한 줄뿐이라(`orchestrate.ts` `usageLine`) "비싼 모델이 계획하고 싼 워커가 실행한다"는
가치가 **숫자로 증명되지 않는다**. 병렬 진행 표시는 `--tui`(Ink 대시보드) 뒤에 숨어 있고
기본 경로가 아니다. peer들에게 없는 능력인데 kapel도 아직 보여주지 못하고 있다.

---

## 2. 능력 비교표

✅ = 있음, `~` = 부분/조건부, — = 없음

| 능력 | kapel | Claude Code | Codex | opencode |
|---|---|---|---|---|
| 세션 시작/재개 | ✅ `chat --continue`/`--session`, `/resume` | ✅ `-c`, `-r <id\|name>` | ✅ `codex resume [--last\|<ID>]` | ✅ `--continue/-c`, `--session/-s` |
| 세션 포크/분기 | — | ✅ `--fork-session`, `/branch` | ✅ Esc-Esc 후 Enter로 분기 | ✅ `--fork` |
| 세션 이름 지정 | — (id 접두사만) | ✅ `-n/--name` | `(미확인)` | ✅ `--title` |
| 멀티라인 입력 | — (`readline` 1줄) | ✅ `\`+Enter, `Ctrl+J`, `Shift+Enter` | `(미확인)` | ✅ (editor keymap) |
| 프롬프트 히스토리 ↑ / 검색 | — (프롬프트마다 새 인터페이스) | ✅ 디렉터리별 영속 + `Ctrl+R` | `(미확인)` | ✅ |
| `@` 파일 멘션 · 자동완성 | — | ✅ | ✅ 퍼지 파일 검색 | ✅ `@`, `@alias/` |
| `/` 명령 자동완성 | — (문자열 `switch`) | ✅ | `(미확인)` | ✅ 드롭다운 |
| 셸 모드 `!` | — | ✅ | `(미확인)` | ✅ |
| 외부 에디터로 작성 | — | ✅ `Ctrl+G` / `Ctrl+X Ctrl+E` | `(미확인)` | ✅ `/editor`, `<leader>e` |
| 이미지 첨부 | — | ✅ `Ctrl+V` 클립보드 | ✅ `-i/--image` | ✅ `attachment.image` |
| 파이프 입력 (`cat x \| agent`) | — (objective 있으면 stdin 무시) | ✅ `cat f \| claude -p` | ✅ | ✅ `--file/-f` |
| 토큰 스트리밍 출력 | — (턴 종료 후 일괄) | ✅ | ✅ | ✅ |
| 스피너/경과시간/라이브 토큰 | — | ✅ | ✅ | ✅ |
| diff 렌더링 | — (툴 입력 JSON 120자) | ✅ | ✅ | ✅ `diff` 설정 |
| todo/plan 표시 | — | ✅ `Ctrl+T` 태스크 리스트 | `(미확인)` | ✅ |
| 작업 중 메시지 큐잉 | — (턴 동안 입력 불가) | ✅ | `(미확인)` | `(미확인)` |
| 권한 모드 전환 | — (`-y` 전부 승인만) | ✅ `Shift+Tab`, `--permission-mode` | ✅ `-a/--ask-for-approval`, `--full-auto` | ✅ `plan`/`build` 에이전트, `--auto` |
| 도구/패턴별 권한 규칙 | `~` 코드 상수 `DEFAULT_PERMISSIONS` | ✅ `--allowedTools "Bash(git log *)"` | ✅ `approval_policy` + `sandbox_mode` | ✅ `permission: {bash: {"git *":"allow"}}` |
| 되돌리기 (checkpoint/undo) | — | ✅ `/rewind`, Esc Esc | ✅ Esc-Esc backtrack | ✅ `/undo`, `/redo`, `snapshot` |
| 프로젝트 지시 파일 | — | ✅ `CLAUDE.md` 4계층 + `.claude/rules/` | ✅ `AGENTS.md` 3단 | ✅ `AGENTS.md` + `instructions` |
| 사용자 전역 지시 파일 | — | ✅ `~/.claude/CLAUDE.md` | ✅ `~/.codex/AGENTS.md` | ✅ `~/.config/opencode/AGENTS.md` |
| 커스텀 슬래시 명령 | — | ✅ `.claude/commands/` = skills | `(미확인)` | ✅ `command` 키 |
| 서브에이전트 | `~` orchestrate 전용, 사용자 호출 불가 | ✅ `--agents`, `/agents` | `(미확인)` | ✅ `mode: subagent`, `@` 호출 |
| MCP | — | ✅ `claude mcp`, `--mcp-config` | ✅ `mcp_servers` TOML | ✅ `opencode mcp add` |
| Hooks / 플러그인 로더 | `~` `@agent/plugin` 타입만, 로더 없음 | ✅ hooks + plugins | `(미확인)` (lifecycle hooks 언급 존재) | ✅ `plugin`, `opencode plug` |
| LSP 통합 | — | — | — | ✅ `lsp` |
| 설정 계층 | `~` `~/.kapel/config.json` + `.agent/` | ✅ managed>CLI>local>project>user ([settings](https://code.claude.com/docs/en/settings)) | ✅ `~/.codex/config.toml` + `--profile` | ✅ 8단 병합 ([config.mdx](https://github.com/sst/opencode/blob/dev/packages/web/src/content/docs/config.mdx)) |
| 테마 | — (ANSI dim/bold만) | ✅ `/theme` | `(미확인)` | ✅ `<leader>t` |
| 비대화형 / CI | ✅ one-shot + `--json` JSONL | ✅ `-p --output-format json\|stream-json` | ✅ `codex exec --json`, `--output-schema` | ✅ `opencode run --format` |
| 컨텍스트 압축 | `~` 구현만 있고 미배선 | ✅ `/compact`, auto-compact | `(미확인)` | ✅ `/compact` |
| 세션 공유/웹 | — | ✅ `--cloud` | — | ✅ `/share`, `opencode web` |
| **멀티모델 라우팅** | ✅ policy IR + router | — | — | `~` 에이전트별 model |
| **자연어 정책 컴파일** | ✅ `kapel policy compile` | — | — | — |
| **worktree 병렬 격리** | ✅ 기본값 | — | — | — |
| **런 재개/설명** | ✅ `runs`/`explain`/`resume` | `~` agent view | — | — |
| 워커/모델별 비용 귀속 | — (런 합계만) | `~` `--max-budget-usd` | `(미확인)` | ✅ `opencode stats --models` |

**표에서 실제로 중요한 행에 대한 부연**

- *입력기 관련 6개 행이 한 덩어리다.* 개별로는 사소해 보이지만 원인이 하나
  (`ttyLineSource`의 프롬프트당 인터페이스)라서 **한 번에 고쳐지고 한 번에 고쳐야 한다**.
  현재 구조를 택한 이유는 코드 주석에 명시돼 있다 — permission prompter가 턴 중간에
  같은 stdin에 자기 인터페이스를 여는데 두 인터페이스가 답을 나눠 먹기 때문이다.
  즉 입력기 교체는 prompter와 함께 설계해야 한다.
- *권한 규칙 행.* kapel의 `DEFAULT_PERMISSIONS`는 `apps/cli/src/permissions.ts`의 18줄짜리
  상수다. 사용자가 손댈 표면이 전혀 없다. peer 셋 다 여기서 파일 기반 설정을 제공하며,
  특히 opencode의 `{"bash": {"*":"ask", "git *":"allow"}}` 형태가 kapel에 가장 잘 맞는다
  (오케스트레이션 정책이 이미 자연어→IR 컴파일이라, 권한도 같은 축에 얹을 수 있다).
- *서브에이전트 행.* kapel은 사실 peer들보다 강한 멀티에이전트 실행기를 갖고 있는데
  (라우터·스케줄러·worktree·검증 게이트), 대화형에서는 `/orchestrate` 한 줄로만 노출된다.
  peer들의 서브에이전트는 kapel의 워커보다 약하지만 **호출 가능하다**는 점에서 이긴다.
- *비용 귀속 행.* 이건 표에서 유일하게 "peer도 잘 못 하는데 kapel이 반드시 해야 하는" 칸이다.
  제품 명제가 "싼 모델에 일을 내린다"인데 그 절감액을 보여주는 화면이 없다.

---

## 3. 우선순위 로드맵

크기: **S** ≈ 1일 이하, **M** ≈ 2–5일, **L** ≈ 1주 이상.

### P0 — 다음 릴리스

**P0-1. 입력기 교체 (single long-lived readline + 영속 히스토리 + 멀티라인)** — **M** — ✅ shipped (v0.4.0)
- *무엇*: 프롬프트마다 인터페이스를 새로 만드는 대신 REPL 수명 전체에 하나의 readline을
  유지하고, `history` 배열을 `~/.kapel/history`(또는 `.agent/history`)에 영속화한다.
  `\` + `Enter`로 이어쓰기, 여러 줄 붙여넣기는 하나의 메시지로 취합(짧은 idle 타이머).
- *왜*: ①에서 설명한 대로 "손이 아프다"의 단일 최대 원인. 다른 어떤 기능보다 매일 체감된다.
- *구현 모양*: `apps/cli/src/interactive.ts`의 `ttyLineSource()`/`replLoop()`를 새 모듈
  `apps/cli/src/input.ts`로 분리. `apps/cli/src/prompter.ts`의 `askOnce()`가 자기
  인터페이스를 열지 않고 **동일 인터페이스를 빌려 쓰도록** 시그니처 변경
  (`createPrompter`에 `LineSource`를 주입). SIGINT 처리는 `PromptState`를 그대로 유지하되
  raw mode 토글 책임이 한 곳으로 모인다. `pipedLineSource()`는 그대로 둔다.
- *수용 기준*: (a) `/exit` 후 재실행해도 ↑로 직전 세션 프롬프트가 복구된다.
  (b) `\`+Enter로 3줄 프롬프트를 보내면 `session.messages()`에 메시지 1개가 쌓인다.
  (c) 40줄 텍스트 붙여넣기가 메시지 1개가 된다. (d) 턴 중 `allow …? [y/N]`이 여전히
  정상 동작하고 Ctrl-C가 "no"로 읽힌다 (기존 `interactive.test.ts` 전부 통과).

**P0-2. 턴 스트리밍 + 진행 표시** — **M** — ✅ shipped (v0.5.0)
- *무엇*: `text.delta`를 이벤트로 흘려보내고, 도구 실행 중에는 스피너 + 경과 초 + 누적
  토큰을 한 줄 상태로 갱신한다.
- *왜*: ②. 지금은 응답이 오기 전까지 kapel이 살아 있는지조차 알 수 없다. peer 3종 모두
  기본 제공이라 "느려 보인다"는 인상까지 함께 준다.
- *구현 모양*: `packages/coding-agent/src/loop.ts` `#runTurn`에서 `model.text.delta` 이벤트
  emit(기존 `model.turn.completed`는 유지 — JSONL 소비자 호환). `@agent/protocol`에 이벤트
  타입 추가. `apps/cli/src/render.ts` `TextRenderer`에 부분 텍스트 누적 출력과, TTY일 때만
  동작하는 `\r` 기반 상태 줄(비TTY면 무음). `JsonRenderer`는 델타를 그대로 통과.
- *수용 기준*: TTY에서 첫 텍스트가 화면에 뜰 때까지 체감 지연이 첫 토큰 지연과 같다.
  `--json` 출력의 기존 라인 형태가 바뀌지 않는다(신규 타입만 추가). 파이프/리다이렉트
  시 제어문자가 섞이지 않는다.

**P0-3. 컨텍스트 압축 배선 + `/compact`** — **S** — ✅ shipped (v0.5.0)
- *무엇*: 이미 있는 `CompactionOptions`를 대화형·one-shot 양쪽에 주입하고, 수동
  `/compact` 슬래시 명령과 `context.compacted` 한 줄 표시를 붙인다.
- *왜*: ④ 후반. **버그에 가까운 미배선**이다. 긴 세션이 조용히 실패한다. 비용도 상한 없이 는다.
- *구현 모양*: `apps/cli/src/interactive.ts`의 `createSession` 팩토리와 `apps/cli/src/run.ts`의
  `AgentLoop` 구성에 `compaction: { … }` 전달. `SLASH_COMMANDS`에 `compact` 추가하고
  `handleSlash`에 케이스 추가. `render.ts`에 `context.compacted` 케이스 한 줄.
- *수용 기준*: 60메시지 초과 대화가 압축 로그 한 줄을 남기고 계속된다. `/compact` 직후
  `/usage`의 다음 턴 input 토큰이 유의미하게 줄어든다.

**P0-4. 승인 UX 3택 + 세션 범위 기억 + 진짜 diff** — **M** — ✅ shipped (v0.5.0)
- *무엇*: `[y/N]` → `[y/n/a]` (a = 이 세션 동안 이 도구/이 명령 프리픽스 항상 허용).
  `edit_file`/`write_file`은 JSON 대신 유니파이드 diff 몇 줄을 보여준다. `bash`는 명령
  전문을 보여준다.
- *왜*: ③. 지금은 `npm test`를 매 턴 다시 승인해야 하고, 무엇을 승인하는지 120자 JSON으로만
  본다. Claude Code의 `--allowedTools "Bash(git log *)"`,
  opencode의 `{"bash":{"git *":"allow"}}`가 증명하듯 **프리픽스 단위 허용**이 실사용 단위다.
- *구현 모양*: `apps/cli/src/prompter.ts`의 `askOnce()` 응답 파싱 확장 + 세션 스코프
  allowlist(메모리). `apps/cli/src/permissions.ts`의 상수는 유지하되 런타임 오버레이를
  `@agent/coding-agent`의 `PermissionEngine`에 얹는다. diff 렌더링은 `previewInput` 옆에
  `previewEdit(tool, input)`를 추가해 `render.ts`와 공유.
- *수용 기준*: `bash npm test`를 `a`로 승인하면 같은 세션에서 다시 묻지 않고, `npm publish`는
  다시 묻는다. `edit_file` 프롬프트에 `-`/`+` 줄이 보인다.

**P0-5. 프로젝트/사용자 지시 파일(`AGENTS.md`) 로딩** — **S** — ✅ shipped (v0.5.0)
- *무엇*: `~/.kapel/AGENTS.md` → repo root `AGENTS.md` → `.agent/AGENTS.md` 순으로 읽어
  시스템 프롬프트 뒤에 이어 붙이고, 배너에 어떤 파일이 로드됐는지 한 줄 표시.
- *왜*: ④ 전반. peer 3종 공통의 최소 기대치이고, 이미 `AGENTS.md`를 갖고 있는 저장소가
  많아 **kapel만 그 저장소 규칙을 모르는 에이전트**가 된다. 파일명은 `AGENTS.md`로 간다 —
  Codex/opencode와 호환되고, Claude Code도 `@AGENTS.md` import로 받아준다
  ([memory](https://code.claude.com/docs/en/memory)).
- *구현 모양*: 신규 `apps/cli/src/instructions.ts`(읽기/병합/크기 제한). `apps/cli/src/run.ts`의
  `defaultSystemPrompt()`가 이를 합성. 대화형은 `interactive.ts`의 `createSession`에서,
  orchestrate 워커는 `.agent/agents/*.md`와 함께 합성(에이전트별 프롬프트가 이미 있으므로
  **프로젝트 지시가 그 앞에** 붙는다).
- *수용 기준*: repo에 `AGENTS.md`를 두면 배너에 `instructions: AGENTS.md`가 뜨고,
  거기 적은 규칙(예: "always run npm run typecheck")을 첫 턴부터 따른다.

**P0-6. 라우팅 근거·모델을 실행 중에 노출** — **S** — ✅ shipped (v0.5.0)
- *무엇*: `▶ T02 → coder (attempt 1)` → `▶ T02 → coder [claude-haiku-4-5] (rule: implementation)`.
  즉 **어떤 모델**로 갔고 **어떤 정책 규칙**이 그렇게 만들었는지를 그 자리에서 보여준다.
- *왜*: ⑤. 이 제품을 쓰는 이유 자체가 이 줄이다. 지금 이 정보는 `kapel explain`이
  사후에 재계산해서만 볼 수 있는데, 정작 필요한 순간은 런이 도는 동안이다.
  구현 비용도 낮다 — `PolicyRouter`가 이미 규칙 매칭 결과를 알고 있다.
- *구현 모양*: 스케줄러의 `task.started` 이벤트 payload에 `model`, `rule`(또는
  `suggestedAgent`/`fallback`) 필드 추가(`packages/orchestration`), `apps/cli/src/render.ts`
  `#emitTaskLifecycle`의 `task.started` 케이스 확장. `apps/cli/src/explain-cmd.ts`는
  같은 필드를 재계산 대신 그대로 읽도록 단순화 가능.
- *수용 기준*: `kapel orchestrate` 텍스트 출력에서 각 태스크의 모델과 매칭 규칙을 읽을 수
  있고, `--json`의 `task.started`에 동일 필드가 실린다.

### P1

**P1-1. 워커/모델별 비용 귀속과 `/cost` 분해** — **M** — ✅ shipped (v0.6.0)
- 런 요약 표에 태스크별 `MODEL / TOKENS / $` 열 추가, 마지막에 모델별 롤업
  (`orchestrator 1 task $0.42 · coder 3 tasks $0.03`). 대화형에는 `/usage`를 모델별로 쪼갠다.
- *왜*: "비싼 모델이 계획하고 싼 워커가 실행한다"의 **유일한 증명 수단**. 이게 없으면
  kapel의 차별점이 주장으로만 남는다. opencode의 `opencode stats --models`가 가장 가까운
  선례다([cli.mdx](https://github.com/sst/opencode/blob/dev/packages/web/src/content/docs/cli.mdx)).
- *파일*: `packages/ai`의 `UsageTracker`에 태그(agent/model) 축 추가,
  `apps/cli/src/orchestrate.ts`의 `usageLine`/`summaryRow`, `apps/cli/src/interactive.ts`의
  `usageTotalsLine`. 위임 백엔드(claude-code/codex)는 구독 기반이라 $ 산출 불가 —
  토큰만 표시하고 `$ n/a`로 명시.
- *수용*: 3태스크 런에서 모델별 토큰·비용 합이 전체 합과 일치한다.

**P1-2. `/undo` — 대화형 체크포인트** — **M** — ✅ shipped (v0.6.0)
- 매 사용자 프롬프트 직전에 작업 트리 스냅샷(git repo면 `git stash create` 기반 오브젝트,
  아니면 `.agent/checkpoints/<n>/` 복사)을 남기고 `/undo`로 되돌린다. bash가 만든 변경은
  추적하지 않음을 명시(Claude Code도 동일한 한계를 문서화한다,
  [checkpointing](https://code.claude.com/docs/en/checkpointing)).
- *왜*: kapel은 대화형에서 격리 없이 직접 쓰기 때문에 peer보다 오히려 더 필요하다.
- *파일*: 신규 `apps/cli/src/checkpoint.ts`, `interactive.ts`의 `handleMessage` 진입점,
  `SLASH_COMMANDS`. `@agent/workspace`의 git 헬퍼 재사용.

**P1-3. `@` 파일 멘션과 `/` 자동완성** — **M** (P0-1 선행) — ✅ shipped (v0.6.0)
- `@`에서 `glob` 기반 퍼지 목록, `/`에서 `SLASH_COMMANDS` 목록. 이미 있는
  `apps/cli/src/select-prompt.ts`의 화살표 선택 UI를 재사용한다.
- *파일*: `apps/cli/src/input.ts`(P0-1 산출물), `select-prompt.ts`, `interactive.ts`.

**P1-4. 커스텀 슬래시 명령 `.agent/commands/*.md`** — **S** — ✅ shipped (v0.6.0)
- frontmatter로 `model`/`agent`를 지정할 수 있게 하면 **kapel에서만 의미 있는 형태**가 된다
  (`/review-pr`를 항상 orchestrator 모델로). Claude Code는 이를 skills로 통합했고
  ([skills](https://code.claude.com/docs/en/skills)), opencode는 `command` 키를 쓴다.
- *파일*: `apps/cli/src/interactive.ts`의 `handleSlash` 앞단에 파일 기반 조회,
  `apps/cli/src/init.ts` 템플릿에 예시 1개.

**P1-5. 권한 규칙을 설정 파일로 노출** — **M** — ✅ shipped (v0.6.0)
- `~/.kapel/config.json`(P0-4의 세션 allowlist를 영속화)과 `.agent/config.yaml`에
  `permission:` 블록. opencode 문법(`{"bash": {"*": "ask", "git *": "allow"}}`)을 그대로 차용.
- *파일*: `apps/cli/src/config.ts`(스키마 확장), `apps/cli/src/permissions.ts`,
  `packages/coding-agent`의 `PermissionEngine`.

**P1-6. 파이프 입력과 비대화형 정합** — **S** — ✅ shipped (v0.6.0)
- `cat log.txt | kapel "설명해줘"`가 stdin을 프롬프트에 합치도록. 현재는 objective가 있으면
  stdin이 버려진다(`index.ts`의 기본 액션). CI에서 실제로 쓰이는 형태다.
- *파일*: `apps/cli/src/index.ts`, `apps/cli/src/run.ts`.

**P1-7. 정책 저작 UX** — **M** — ✅ shipped (v0.6.0)
- `kapel policy compile`이 지금 warnings/ambiguities를 출력하지만, 고치는 루프가 없다.
  (a) ambiguity가 가리키는 `orchestration.md`의 원문 줄 번호를 찍고,
  (b) `kapel policy diff`로 lock 변경 전후를 보여주고,
  (c) `kapel plan --why <taskId>`로 **실행 전에** 라우팅 근거를 미리 본다.
- *왜*: 자연어 정책이 이 제품의 입력 언어인데, 그 언어를 디버깅할 도구가 없다.
- *파일*: `apps/cli/src/policy.ts`, `apps/cli/src/plan.ts`, `@agent/policy`의 컴파일 결과에
  source span 보존.

**P1-8. 세션 이름·포크** — **S** — ✅ shipped (v0.6.0) / **P1-9. 이미지 첨부** — **M** — ✅ shipped (v0.6.0)
- 전자는 `NewChatSession`에 `name` 추가 + `/name`; 후자는 `@agent/ai`의 메시지 파트에
  이미지 지원이 있는지 먼저 확인 필요.

### P3 — 2026-08-22 배치 — ✅ shipped

P0/P1 이후의 사용성 배치. 여섯 항목이 함께 착륙했다.

- **턴 중 메시지 큐잉 + 스티어링** — 턴이 도는 동안 입력한 줄이 더 이상 버려지지
  않는다. 일반 텍스트는 돌고 있는 턴에 주입되어(native 백엔드) 다음 모델 호출이
  집어가고 — 턴이 먼저 끝나면 자동으로 후속 턴이 정확히 한 번 응답한다 —
  `/`·`!` 줄과 위임 백엔드의 입력은 턴 종료 후 FIFO로 실행된다. 밴드에 타이핑
  중인 줄과 `N queued`가 표시된다.
- **병렬 워커 인라인 진행 밴드** — `/orchestrate` 중 `[T01 ✔] [T02 ▶ coder 12s]`
  요약 행이 밴드 규율로 라이브 갱신된다(아래 P2의 해당 항목). REPL과 orchestrate가
  하나의 페인터를 공유하도록 `OrchestratePresentation`으로 배선했다.
- **턴 종료 변경 요약 + `/diff`** — 턴이 디스크를 바꿨으면 `Δ 4 files +52 −11`
  한 줄이 남고, `/diff [n]`이 체크포인트 트리 대비 전체 diff를 보여준다.
- **터미널 알림 (BEL + OSC 9)** — 승인 프롬프트 대기 시작(무조건), 10초 이상 걸린
  턴 종료, 런 종료에 알림. `notify: off|bell|osc9|auto` 설정과 `KAPEL_NO_NOTIFY=1`.
  TTY 전용, 파이프에는 바이트 하나도 나가지 않는다.
- **`!` 셸 모드** — `!cmd`는 터미널을 넘겨 대화형 실행, `!!cmd`는 출력을 캡처해
  다음 메시지에 컨텍스트로 첨부한다.
- **Ctrl+R 역방향 히스토리 검색** — 프롬프트에서 고전적 reverse-i-search.

### P4 — 2026-09-01 배치 — ✅ shipped (v0.17.0)

터미널 UI 정리 배치. 여섯 항목이 함께 착륙했고, 그중 셋은 한 가지 원인의 증상이었다.

- **일반 화면이 기본, 휠은 스크롤** — REPL이 대체 화면 버퍼 대신 터미널의 일반
  화면에서 돈다. 전사 기록이 터미널 자체 스크롤백에 쌓이므로 마우스 휠이 그대로
  스크롤하고, ↑/↓만 이전 메시지를 불러온다(대체 화면에서는 많은 에뮬레이터가
  휠을 화살표 키로 번역해 히스토리를 넘겼다). `--altscreen`으로 옵트인할 수
  있고, 그때는 alternate scroll(`?1007`)을 꺼서 같은 일이 생기지 않게 한다.
- **select 프롬프트가 키보드를 통째로 넘겨받는다** — `InputManager.withSuspended`가
  suspension 동안 readline의 keypress 리스너를 스트림에서 떼어낸다(역방향 검색이
  쓰던 것과 같은 분리). 전에는 `/config` 마법사·`/policy` 피커·`/login` 확인에서
  누른 키가 잠들어 있어야 할 편집기에도 들어가, ↑가 히스토리에서 `/config`를
  불러오고 답을 확정하는 Enter가 그 줄을 미드턴 입력으로 큐에 넣었다 — 마법사가
  끝나자마자 다시 열리던 것, 프롬프트로 돌아온 뒤 Enter를 한 번 칠 때까지 입력이
  죽어 있던 것이 모두 이 누수였다.
- **`/config`는 뒤처리를 한다** — 각 질문은 답하는 즉시 스스로 지워지고
  (`summarize: false`), 경고·저장 요약은 줄바꿈까지 세는 transient 블록으로
  출력됐다가 마법사가 끝나면 화면에서 걷힌다. 남는 것은 `> /config` 에코 바와
  한 줄 결과 알림뿐이고, 프롬프트가 곧바로 돌아온다.
- **마크다운 렌더링** — 어시스턴트 텍스트의 `**bold**`/`__bold__`, `` `code` ``
  (강조색), `# 제목`(굵게, 마커 제거), ``` 펜스(펜스 줄 dim, 내용 원문)를 실제
  스타일로 그린다. 델타 단위 스트리밍을 유지하는 작은 상태 기계로, 청크 경계에
  걸린 마커만 잠깐 붙들고 줄바꿈마다 스타일을 닫는다. 색이 꺼진 스트림은 원문
  그대로.
- **도구 호출은 전사 기록에 남지 않는다** — `→ claude: Bash`, `→ codex: …`,
  `→ bash {…}`와 그 아래 `✓`가 사라지고, 실행 중인 도구 이름은 상태 밴드의
  스피너가 보여 준다. 거부·오류(`✗ (tool denied)`)만 한 줄로 남는다.

### P2 / 탐색적

- **MCP 클라이언트** — **L**. `@agent/plugin`이 이미 `registerTool`을 갖고 있어 붙일 자리는
  있다. 다만 kapel의 차별점이 아니고, 워커마다 MCP 서버 수명을 관리하는 비용이 크다.
  peer 3종 모두 갖고 있으므로 "생태계 진입권"으로서만 의미가 있다.
- **Hooks** — **M**. `.agent/hooks.yaml`로 `PreToolUse`/`PostTask` 정도. 단, kapel에는 이미
  `validation:`이라는 강한 후크가 있어 중복 위험이 있다. 검증기와 통합 설계 후에.
- **플러그인 로더** — **M**. `@agent/plugin`은 타입만 있고 실제 로더가 없다. 정책 변환
  (`registerPolicyTransform`)은 kapel 고유의 재미있는 확장 축이다.
- **대화형에서 병렬 워커 인라인 진행 표시** — **M** — ✅ shipped (P3 배치). `--tui` 전면 대시보드가 아니라,
  라인 기반 출력 하단에 `[T01 ✔] [T02 ▶ coder 12s] [T03 ⏸ dep]` 요약 한 줄. peer에 없는 화면.
- **테마 / 색상 설정** — **S**. 현재 ANSI dim/bold 고정.
- **LSP·세션 공유·웹 UI** — 하지 않는 쪽에 가깝다(4장 참조).

---

## 4. 명시적으로 하지 않을 것

| 항목 | 이유 |
|---|---|
| Claude Code의 background sessions / daemon / `--cloud` / remote-control | kapel의 "여러 일을 동시에"는 이미 worktree 스케줄러가 담당한다. 세션 수퍼바이저를 별도로 만드는 건 같은 문제를 두 번 푸는 것이고, 운영 비용(데몬, 프로세스 수명, 복구)이 1인 메인테이너 규모를 넘는다. |
| opencode의 headless server + web UI + SDK + ACP | 터미널 제품 명제와 직교하고, 표면적이 유지비의 대부분을 차지한다. 통합이 필요하면 이미 있는 **JSONL 이벤트 스트림**이 더 정직한 계약이다. |
| vim 모드, 이모지 shortcode, 음성 입력, 맞춤법 검사, prompt suggestions | Claude Code에는 있지만 전부 "입력기 위의 장식"이다. P0-1로 기본 입력기가 정상이 된 뒤에도 체감 이득이 작고, 각각이 영구 유지 부담이다. |
| Claude Code의 fullscreen renderer급 자체 TUI를 대화형에 도입 | 대화형은 **라인 기반**으로 유지한다. 스크롤백·`grep`·리다이렉트 친화성이 CI/스크립트와 함께 쓰이는 kapel의 성격에 더 맞고, Ink는 `--tui`(orchestrate 대시보드)에만 두는 현재 분리가 옳다. |
| Codex의 `--profile` 다층 config, opencode의 8단 config 병합 | kapel은 **머신 층(`~/.kapel/config.json`) + 저장소 층(`.agent/`)** 두 개로 충분하다. 층이 늘면 "왜 이 모델이 골라졌나"를 설명하는 비용이 층 수에 비례해 늘고, 그건 이 제품이 가장 잘해야 하는 설명 능력과 정면 충돌한다. |
| opencode식 provider 마켓플레이스(수백 개 모델 나열) | kapel의 올바른 추상화는 **orchestrator / complex / middle / low 네 슬롯**이다(이미 `KapelModels`가 그렇게 되어 있다). 모델 목록이 아니라 역할이 사용자에게 노출돼야 한다. |
| Claude Code의 auto memory(모델이 스스로 쓰는 메모리) | kapel은 "정책을 컴파일해 결정론적으로 집행한다"를 파는 제품이다. 모델이 몰래 축적한 메모리가 라우팅·리뷰 결과를 바꾸면 `kapel explain`의 설명이 거짓이 된다. 사람이 쓴 `AGENTS.md`(P0-5)까지만 간다. |
| LSP 통합 | opencode만 갖고 있고, 검증기(`validation:`)가 이미 typecheck/lint를 태스크 게이트로 돌린다. 편집 시점 진단보다 **머지 전 게이트**가 kapel의 실행 모델에 맞다. |

---

## 5. 메인테이너에게 남기는 열린 질문

1. **`--backend claude-code`가 기본이 되면 native loop의 UX는 누가 소유하나?**
   P0-2(스트리밍)·P0-4(승인)·P1-2(체크포인트)는 native 경로의 기능이다. 위임 백엔드에서는
   Claude Code CLI가 자체 승인·스트리밍을 갖고 있어 **두 경로의 UX가 갈라진다**.
   (a) 위임 경로는 하위 CLI 화면을 그대로 통과시킬 것인가, (b) `BackendChatSession`이
   정규화해 kapel의 화면으로 다시 그릴 것인가? 이 선택이 P0-2/P0-4의 범위를 두 배로 바꾼다.
2. **`kapel>`의 기본 동작이 단일 루프인 게 맞나?** 제품 이름이 오케스트레이션인데 기본
   대화는 단일 에이전트이고 orchestrate는 `/orchestrate`로 옵트인이다. "복잡한 요청이면
   자동으로 계획→분배"가 명제에 더 가깝지 않은가? (그렇다면 정책 lock 부재 시의 폴백
   경험이 P0가 된다.)
3. **대화형에도 worktree 격리를 넣을 것인가?** 넣으면 P1-2(`/undo`)가 거의 공짜가 되지만,
   "내가 보고 있는 파일이 안 바뀐다"는 혼란이 생긴다.
4. **비용의 진실 소스.** 위임 백엔드는 구독 기반이라 $ 계산이 불가능하다. P1-1의 표에서
   토큰만 보여줄 것인가, 정가 기준 "환산 절감액"을 보여줄 것인가(오해 소지)?
5. **`AGENTS.md`의 위치.** repo root(다른 에이전트와 공유) vs `.agent/`(kapel 전용)?
   전자를 권하지만, 그러면 `.agent/agents/*.md`의 에이전트별 프롬프트와 합성 순서를
   문서화해야 한다.
6. **`ant` OAuth 토큰 만료.** `models.ts`의 주석이 인정하듯 토큰은 런 시작 시 1회만
   해석된다. 긴 orchestrate 런이 중간에 401을 맞는 문제를 P1로 볼 것인가?
7. **`--json` 대화형.** 현재 명시적으로 거부한다(`runInteractive`). Claude Code는
   `-p --input-format stream-json --output-format stream-json`으로 대화형을 스크립트화한다.
   kapel도 이 축을 열 것인가, 아니면 orchestrate JSONL만으로 충분하다고 볼 것인가?

---

## 부록 — 확인하지 못한 peer 동작

이 환경의 egress 프록시가 `developers.openai.com`과 `opencode.ai`를 차단해서 다음은
1차 문서로 검증하지 못했다.

- **Codex CLI의 슬래시 명령 전체 목록** `(미확인)`. `openai/codex` 저장소의
  `docs/slash_commands.md`는 현재 `developers.openai.com`으로 보내는 스텁이고 그 도메인이
  차단돼 있다. 위 표의 Codex 칸에서 `/init`·`/compact`·`/diff`·`/model`·`/approvals` 등의
  존재 여부는 확인 실패로 남겼다.
- **Codex의 멀티라인 입력·프롬프트 히스토리·큐잉·todo 표시** `(미확인)`. 확인된 것은
  `Esc`-`Esc` backtrack(이전 메시지에서 대화 분기), `@` 퍼지 파일 검색, `-i/--image`,
  `--cd/-C`, `AGENTS.md` 3단 병합, `codex resume [--last|<ID>]`,
  `codex exec --json/--output-schema/-o/--skip-git-repo-check`, `config.toml`의
  `approval_policy`/`sandbox_mode`/`profiles`/`mcp_servers`/`model_providers`/`notify`/
  `history`/`file_opener`/`tui`뿐이다
  ([getting-started](https://github.com/openai/codex/blob/rust-v0.44.0/docs/getting-started.md),
  [exec](https://github.com/openai/codex/blob/rust-v0.44.0/docs/exec.md),
  [config](https://github.com/openai/codex/blob/rust-v0.44.0/docs/config.md) — 모두
  `rust-v0.44.0` 태그 기준이라 **최신 배포본과 차이가 있을 수 있다**).
- **opencode**는 `opencode.ai/docs`가 차단돼 GitHub의 문서 소스(`dev` 브랜치의
  `packages/web/src/content/docs/*.mdx`)로 대체 확인했다. 배포본과 미세한 차이가 있을 수 있다.
- **Codex의 hooks/플러그인** `(미확인)`. `requirements.toml`과 `allow_managed_hooks_only`라는
  라이프사이클 후크 관련 키가 저장소 문서에 언급되지만 내용은 차단된 페이지에 있다.
