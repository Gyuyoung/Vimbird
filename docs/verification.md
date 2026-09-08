# 실측 검증 기록

작성일: 2026-09-08
대상 빌드: **Thunderbird 155.0** (snap `latest/stable` rev 1240, BuildID `20260828084831`)

이 문서는 [`research.md`](research.md)·[`design.md`](design.md)의 주장 중 **문서가 아니라 실제 실행으로 확인한 것들**과 그 방법을 기록합니다. 설계 결정의 근거이므로, Thunderbird를 업그레이드한 뒤 동작이 이상하면 여기부터 다시 돌려보면 됩니다.

---

## 1. 검증 방법: Marionette

Thunderbird는 Firefox와 동일한 자동화 인터페이스인 **Marionette**를 내장하고 있습니다(빌드 내 `chrome://remote/content/marionette`). 이걸 쓰면 **chrome 프로세스 안에서 임의의 JS를 실행**할 수 있어, 추측 대신 실제 DOM·API를 직접 확인할 수 있습니다.

```bash
xvfb-run -a thunderbird -profile <테스트프로필> -no-remote \
         -marionette -remote-allow-system-access
# → 127.0.0.1:2828 에서 대기
```

- `-remote-allow-system-access`가 없으면 chrome 컨텍스트 전환이 거부됩니다(TB 155에서 새로 요구됨).
- 클라이언트는 외부 의존성 없이 [`test/e2e/marionette.py`](../test/e2e/marionette.py)로 직접 구현했습니다(길이 접두 JSON 프로토콜).
- snap 패키지는 샌드박스 때문에 **프로필이 `$HOME` 안에** 있어야 합니다. 테스트는 `~/snap/thunderbird/common/vimbird-e2e-profile`을 씁니다.

`omni.ja`(빌드 내 소스 아카이브)도 함께 열어 대조했습니다:

```bash
unzip -qq /snap/thunderbird/current/usr/lib/thunderbird/omni.ja -d /tmp/tb
```

---

## 2. UI 구조 실측

| 확인 항목 | 결과 |
|---|---|
| 메인 창 windowtype | `mail:3pane` (여전히 유효) |
| 메인 창 루트 요소 | `<html>` (XUL `<window>` 아님) |
| 3-pane 문서 | `about:3pane`, 탭 내부 `<browser>`에 로드 |
| **`browser.isRemoteBrowser`** | **`false`** — 부모 프로세스 동기 접근 가능 |
| 폴더 트리 | `<ul id="folderTree" is="tree-listbox">`, 행은 `<li is="folder-tree-row">` |
| 스레드 목록 | `<tree-view id="threadTree">`, 행은 `<tr is="tree-view-table-row">` / `<thread-card>` |
| 메시지 표시 | `about:message` (역시 in-process chrome) |
| 메시지 헤더 버튼 | `about:message` 문서의 `.message-header-view-button` (XUL `toolbarbutton`) |
| 통합 툴바 버튼 | `<button is="unified-toolbar-button">`, **Shadow DOM 없음** |
| `document.createElement("div")` | 두 문서 모두 XHTML 네임스페이스 반환 |
| 작성 창 | 별도 최상위 창, `windowtype="msgcompose"` |

셀렉터 스캔 결과(빈 프로필, 1600×1000): chrome 문서 가시 후보 60개, `about:3pane` 6개. 메시지를 선택하면 `about:message`에서 13개가 추가됩니다.

---

## 3. 키 이벤트: 문서 경계를 넘는가? (설계 최대 쟁점)

`about:3pane`의 `#folderTree`에 포커스를 두고 실제 키(`WebDriver:PerformActions`)로 `f`를 눌렀을 때 리스너 발화 순서:

```
1. chromeWin.capture      target=about:3pane <ul>   ← 바깥 chrome 창이 가장 먼저
2. a3pWin.capture         target=about:3pane <ul>
3. chromeDoc.bubble       target=about:3pane <ul>
4. chromeWin.sysgroup     target=about:3pane <ul>
5. a3pWin.sysgroup        target=about:3pane <ul>
```

**결론**: in-process `<browser>` 안에서 발생한 키 이벤트는 바깥 chrome 창의 capture 리스너에 도달하며 순서상 가장 먼저다. → 창당 리스너 하나로 충분(설계 §6 전략 A).

### 3.1 키 소비 범위

chrome 창 capture에서 `preventDefault() + stopPropagation()` 호출 시:

| 리스너 | `f` (소비) | `j` (미소비) |
|---|---|---|
| `chromeWin.capture` | 발화 | 발화 |
| `a3pWin.capture` | **차단** | 발화 |
| `#folderTree` 자체 핸들러 | **차단** | 발화 |
| `a3pWin.sysgroup` | 발화(차단 안 됨) | 발화 |

→ 기본 그룹은 완전히 차단되지만 **시스템 그룹은 별도 디스패치 그룹이라 막히지 않는다.** 그래서 Vimbird는 chrome 창에 리스너를 **두 개**(기본 그룹 + 시스템 그룹, 둘 다 capture) 붙이고, 같은 이벤트를 두 번 처리하지 않도록 `WeakMap`으로 판정 결과를 캐시합니다.

---

## 4. 활성화(클릭) 전략 비교

관찰 가능한 부작용으로 성공 여부를 판정했습니다(앱 메뉴 패널이 열리는가 / 작성 창이 생기는가 / 폴더 선택이 바뀌는가).

| 전략 | XUL `toolbarbutton` | HTML `button` | 폴더 행 `li[is]` | **스레드 행 `tr[is]`** |
|---|---|---|---|---|
| `el.click()` | ✅ | ✅ | ✅ | **❌ 무반응** |
| `createEvent("MouseEvent")` + `initMouseEvent` (mousedown→mouseup→click) | ✅ | ✅ | ✅ | **✅** |
| `createEvent("XULCommandEvent")` | ❌ | ❌ | — | — |
| `windowUtils.sendMouseEvent(...)` | **API 없음** | — | — | — |

### 4.0 `el.click()`이 메일 목록에서만 실패하는 이유

실사용 제보로 드러난 버그입니다. 스레드 목록의 클릭 핸들러가 이렇게 시작합니다(`tree-view.mjs:1387-1392`):

```js
// Bail out on non primary or double clicks.
if (event.button !== 0 || event.detail !== 1) {
  this.ensureCorrectFocus();
  return;
}
```

`HTMLElement.click()`이 만드는 click 이벤트는 **`detail: 0`** 이라 이 검사에 걸려 그대로 반환됩니다 → 행이 선택되지 않고 메시지 창도 바뀌지 않습니다. 폴더 트리(`tree-listbox`)에는 같은 검사가 없어 `click()`으로도 동작했기 때문에, 처음에는 문제가 드러나지 않았습니다.

**결론**: 활성화는 `button: 0`, `detail: 1`을 갖춘 **mousedown → mouseup → click 시퀀스**로 통일합니다. 이것이 실제 클릭에 가장 가깝고 위 네 종류 위젯 모두에서 동작합니다. `el.click()`은 시퀀스 생성이 실패할 때의 폴백으로만 남깁니다.

**테스트 교훈**: 처음 E2E 시나리오는 `selectedIndex >= 0`만 확인해서 **거짓 통과**했습니다(직전 시나리오의 선택 상태가 남아 있었음). 지금은 다른 행에서 출발해 ① 선택 인덱스가 목표 행으로 바뀌고 ② `about:message`의 `gMessage.subject`가 그 행의 제목과 일치하는지까지 확인합니다.

### 4.1 중요한 정정: `sendMouseEvent`는 더 이상 없다

`nsIDOMWindowUtils`에 남아 있는 이벤트 합성 API를 실제로 조회한 결과:

```
sendMouseEvent                          undefined
sendMouseEventToWindow                  undefined
sendKeyEvent                            undefined
sendNativeMouseEvent                    function
sendNativeKeyEvent                      function
dispatchDOMEventViaPresShellForTesting  function
```

오래된 애드온·블로그에서 흔히 보이는 `windowUtils.sendMouseEvent(...)` 기반 클릭 합성 코드는 **TB 155에서 그대로 실패**합니다. Vimbird는 `el.click()`을 1순위로, trusted MouseEvent 시퀀스를 폴백으로 사용합니다.

또한 오버레이가 떠 있어도 대상 중심의 `elementFromPoint()`가 대상 요소를 반환함을 확인했습니다(`pointer-events: none` 덕분).

---

## 5. 확장 로딩 관련 실측

| 항목 | 결과 |
|---|---|
| `extensions.experiments.enabled` | `true` (기본값) |
| `extensions.experiments.suppressed` | `false` (억제 스위치는 존재하나 꺼져 있음) |
| `extensions.experiments.allowed` | `tbpro-add-on@thunderbird.net,owl@beonex.com` |
| 억제 시 임시설치 예외 | `!addon.temporarilyInstalled` 조건으로 개발 워크플로는 영향 없음 |
| `experiment_apis` manifest 제약 | 없음 → MV2/MV3 모두 가능 |
| `events: ["startup"]` | `SchemaAPIManager.onStartup()`이 `api.onStartup()` 호출 → background 수명과 무관 |
| **스크립트 로딩** | `Services.scriptloader.loadSubScript`는 확장 리소스 URL을 **거부**("Trying to load untrusted URI"). `loadSubScriptWithOptions(url, { target, allowUnsafeURL: true })`가 정답 — 프레임워크 자신이 experiment 스크립트를 이렇게 로드함(`ExtensionCommon.sys.mjs:1702`) |
| 설치 경로 | 소스 디렉터리(`file://`)와 패키징된 XPI(`jar:file://`) **양쪽 모두** 동작 확인 |

---

## 6. E2E 결과 (12/12)

[`test/e2e/run_e2e.py`](../test/e2e/run_e2e.py)를 실제 Thunderbird 155에 대해 실행한 결과입니다. 소스 디렉터리 설치와 XPI 설치 모두 동일하게 통과했습니다.

```
PASS  hints appear in toolbar and 3-pane — 20 hints across ['about:3pane', 'messenger.xhtml']
PASS  labels unique and prefix-free — 20 labels, 20 multi-character, all prefix-free
PASS  hint activates a toolbar button — hint 'al' opened the compose window
PASS  Escape cancels hint mode — 20 hints dismissed
PASS  multi-character hint selects a folder — hint 'sd' switched folders
PASS  message header is hinted — 44 hints, message header button hinted as 'fa'
PASS  thread row hint selects a message — row hint 'sg' selected message index 0
PASS  text input keeps its keystrokes — f left untouched for the subject field
PASS  compose window is hinted — 25 hints in the compose window
PASS  scroll dismisses hints — 44 hints dismissed on scroll
PASS  resize dismisses hints — 44 hints dismissed on resize
PASS  f does not leak into Thunderbird — f consumed before Thunderbird's own handlers
```

### 6.1 헤드리스 환경의 한계

xvfb에는 창 관리자가 없어 두 가지 제약이 있습니다.

1. **OS 포커스가 3-pane 창을 떠나지 못합니다.** `Services.focus.activeWindow = composeWindow` 대입도 무시됩니다. 그래서 작성 창을 대상으로 하는 두 시나리오(작성 창 힌트, 텍스트 입력 보호)는 실제 키 대신 **합성 `keydown`을 해당 창에 직접 디스패치**해 검증합니다. 리스너·가드·렌더링 경로는 동일하게 실행되지만 OS 레벨 키 전달까지는 확인하지 못합니다.
2. **`window.resizeTo()`가 무시될 수 있습니다.** 헤드리스 창이 가상 화면보다 커지면(관측: 창 1332×1460 vs 화면 1600×1000) 크기가 바뀌지 않습니다. 리사이즈 시나리오는 실제 크기 변경을 먼저 시도하고, 변하지 않으면 합성 `resize` 이벤트로 대체하며 결과에 어느 쪽을 썼는지 표시합니다.

따라서 작성 창 관련 두 항목과 리사이즈는 [`testing.md`](testing.md)의 수동 체크리스트로 한 번 더 확인해야 합니다.

---

## 7. 재현 방법

```bash
npm test                     # 순수 로직 단위 테스트 (Thunderbird 불필요)
npm run build                # dist/vimbird-<version>.xpi 생성
npm run test:e2e             # 헤드리스 Thunderbird 자동 실행 + 12개 시나리오
python3 test/e2e/run_e2e.py --xpi          # 패키징된 XPI로 동일 검증
python3 test/e2e/run_e2e.py --keep         # 검사용으로 Thunderbird를 띄워 둔 채 종료
```

`--keep`으로 띄워 둔 인스턴스에는 Marionette가 계속 열려 있으므로, `test/e2e/marionette.py`를 직접 import해 chrome JS를 실행하며 새 가설을 즉석에서 검증할 수 있습니다.
