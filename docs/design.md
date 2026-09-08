# Phase 2 — Vimbird 아키텍처 설계

작성일: 2026-09-08
전제: [`docs/research.md`](research.md)의 조사 결과 (Thunderbird 155.0 빌드 실측 기준)

---

## 1. 설계 목표와 제약

### 1.1 목표

1. `f` → 화면의 클릭 가능한 UI에 힌트 표시 → 힌트 입력 → 실제 클릭. `Esc`로 취소.
2. **버튼 ID를 하드코딩하지 않는다.** 일반적 DOM 탐색 파이프라인으로 후보를 찾는다.
3. **Hint engine과 Thunderbird 종속 코드를 분리한다.**
4. 이후 `j/k`, `gg/G`, `o`, `r`, `a`, `x`, `d`, `/` 를 얹을 수 있는 모드 상태머신 구조.

### 1.2 조사에서 확정된 제약 (설계를 규정하는 것들)

| # | 제약 | 설계에 미치는 영향 |
|---|---|---|
| C1 | `commands` API는 수식키 없는 `f`를 등록 불가 (`ShortcutUtils.validate` → `MODIFIER_REQUIRED`) | 키 입력은 Experiment에서 직접 `keydown` 리스너로 받는다 |
| C2 | content script는 chrome 문서(`about:3pane` 등)에 주입 불가 | chrome DOM 접근은 전부 Experiment 경유 |
| C3 | `about:3pane` / `about:message`는 `remote` 아님 → 부모 프로세스 동기 접근 가능 | JSWindowActor/frame script/IPC **불필요**. 함수 호출로 직결 |
| C4 | 대상 UI가 여러 문서에 흩어져 있음 (chrome 창 / about:3pane / about:message / compose) | 문서 단위 엔진 + 창 단위 코디네이터. 힌트 라벨은 **전역 유일** |
| C5 | 스레드 목록은 가상 스크롤 | 보이는 행만 후보. 스크롤/리사이즈 시 힌트 무효화 |
| C6 | Shadow DOM 없음, 대부분 표준 HTML + 일부 XUL 요소 | `querySelectorAll` 통용. XUL의 `hidden`/`collapsed` 속성은 별도 처리 |
| C7 | Experiment 억제 스위치가 코드에 존재 (현재 off, 임시설치는 예외) | Experiment 표면적을 최소화하고 순수 로직은 분리 |
| C8 | 문서 경계를 넘는 key 이벤트 전파 여부 미검증 | 키 수신 전략을 **교체 가능**하게 추상화 (Spike 0에서 결정) |

---

## 2. 전체 아키텍처

```
┌─────────────────────────────────────────────────────────────────────┐
│ WebExtension (일반 권한)                                              │
│                                                                       │
│  background.js  ── 설정 저장(storage), 기본 키맵 로드, 진단 명령         │
│        │  browser.vimbird.* (Experiment API 호출)                     │
└────────┼──────────────────────────────────────────────────────────────┘
         ▼
┌─────────────────────────────────────────────────────────────────────┐
│ Experiment API (부모 프로세스 / 특권)  experiments/vimbird/            │
│                                                                       │
│  implementation.js                                                    │
│   ├ WindowWatcher   ExtensionSupport.registerWindowListener 로         │
│   │                 mail:3pane / msgcompose / messageWindow 부착        │
│   └ WindowSession (창 1개당 1개)                                       │
│      ├ DocumentRegistry  창에 속한 살아있는 문서 열거/추적               │
│      │    · messenger.xhtml (chrome)                                  │
│      │    · tabmail.currentAbout3Pane                                 │
│      │    · tabmail.currentAboutMessage                               │
│      ├ KeyBridge        keydown 수신 (전략 A 또는 B, §6)                │
│      └ HintSession      힌트 1회 수명 주기 관리 (§5)                    │
└────────┬──────────────────────────────────────────────────────────────┘
         │ 동기 함수 호출 (C3)
         ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 문서별 엔진 (각 target document 안에서 동작)                            │
│                                                                       │
│  DocumentAgent  ← Services.scriptloader.loadSubScript 로 주입          │
│   ├ collect()   후보 탐색  (dom/candidates.js + tb/targets.js)         │
│   ├ render()    힌트 오버레이 그리기 (dom/overlay.js)                   │
│   ├ filter()    입력에 따라 표시 갱신                                    │
│   ├ activate()  실제 클릭 (dom/activate.js)                            │
│   └ clear()     정리                                                   │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│ core/ — Thunderbird·DOM 비의존 순수 로직 (단위 테스트 대상)              │
│   hint-labels.js   라벨 생성 알고리즘                                   │
│   hint-matcher.js  입력 → 후보 필터 상태머신                             │
│   mode-machine.js  normal / hint 모드 전이 (Phase 5 확장 지점)          │
│   ranking.js       후보 정렬(화면 좌표 기준) 및 라벨 배분                 │
└─────────────────────────────────────────────────────────────────────┘
```

### 2.1 계층 분리 원칙

| 계층 | Thunderbird 지식 | DOM 의존 | 테스트 방법 |
|---|---|---|---|
| `core/` | 없음 | 없음 | Node 단위 테스트 |
| `dom/` | 없음 (일반 DOM 규칙만) | 있음 | 어댑터 주입 + 페이크로 단위 테스트 |
| `tb/` | **여기에만 집중** (셀렉터, XUL 예외, 가상 스크롤) | 있음 | Thunderbird 수동 테스트 |
| `experiments/` | 창/문서 수명주기 | 있음 | Thunderbird 수동 테스트 |

"Thunderbird가 UI를 또 바꾸면 `tb/targets.js` 한 파일만 고친다"가 이 분리의 성공 기준입니다.

---

## 3. Thunderbird UI 접근 방식

### 3.1 창 부착

```js
ExtensionSupport.registerWindowListener("vimbird", {
  chromeURLs: [
    "chrome://messenger/content/messenger.xhtml",              // mail:3pane
    "chrome://messenger/content/messengercompose/messengercompose.xhtml", // msgcompose
    "chrome://messenger/content/messageWindow.xhtml",          // 독립 메시지 창
  ],
  onLoadWindow(win) { sessions.set(win, new WindowSession(win)); },
  onUnloadWindow(win) { sessions.get(win)?.dispose(); sessions.delete(win); },
});
```

`ExtensionSupport`(`modules/ExtensionSupport.sys.mjs`)를 쓰는 이유: 이미 열린 창과 앞으로 열릴 창을 모두 처리해 주고, Thunderbird가 애드온용으로 공식 제공하는 유틸이라 창 초기화 타이밍 문제를 스스로 해결해 줍니다. `Services.wm.getMostRecentWindow()`는 "지금 이 순간 하나"만 주므로 다중 창/신규 창을 놓칩니다 — 진단·단발성 접근에만 사용합니다.

### 3.2 문서 열거 (`DocumentRegistry`)

```js
*documents() {
  yield { id: "chrome", doc: win.document, win };              // 툴바, 탭, 메뉴바
  const tabmail = win.document.getElementById("tabmail");
  const a3p = tabmail?.currentAbout3Pane;                       // tabmail.js:1441
  if (a3p) yield { id: "about3pane", doc: a3p.document, win: a3p };
  const am = tabmail?.currentAboutMessage;                      // tabmail.js:1454
  if (am) yield { id: "aboutmessage", doc: am.document, win: am };
}
```

- **`tabmail.currentAbout3Pane` / `currentAboutMessage`는 Thunderbird가 제공하는 공식 접근자**이므로 내부 DOM 구조 추측 없이 안전하게 현재 탭의 문서를 얻습니다.
- 3pane 탭이 아닌 탭(설정, 캘린더, 콘텐츠 탭)에서는 `currentAbout3Pane`이 `null` → 자연스럽게 chrome 문서만 힌트 대상이 됩니다.
- compose 창에서는 chrome 문서 + `getBrowser().contentDocument`(본문 편집기)를 열거합니다. MVP에서는 본문 편집기 내부는 힌트 대상에서 제외(§9 범위).
- 메일 **본문**(`about:message` 안의 `<browser id="messagepane" type="content">`)은 Phase 2 확장 대상입니다. content 문서이므로 표준 `scripting.messageDisplay` 경로로 다루는 것이 정공법이며, Experiment로 억지로 뚫지 않습니다.

### 3.3 문서별 에이전트 주입

```js
Services.scriptloader.loadSubScript(
  extension.rootURI.resolve("src/agent/agent-bundle.js"),
  targetWindow   // 이 window 전역에 window.__vimbirdAgent 를 만든다
);
```

`loadSubScript`로 대상 window 전역에 에이전트를 만드는 방식은 tbkeys가 Mousetrap을 주입할 때 쓰는 검증된 패턴입니다. 이유:

- 오버레이를 **각 문서의 좌표계에서 직접** 그릴 수 있어 좌표 변환이 필요 없습니다.
- 키 리스너를 문서 내부에 붙일 수 있어 §6의 전략 B를 그대로 지원합니다.
- 부모에서 다른 문서의 DOM을 원격 조작하는 것보다 크로스-컴파트먼트 래퍼 이슈가 적습니다.

C3(동기 접근 가능) 덕분에 부모 ↔ 에이전트 통신은 **메시지 패싱이 아니라 직접 함수 호출**입니다.

---

## 4. 이벤트/키 처리 설계

### 4.1 모드 상태머신 (`core/mode-machine.js`)

```
        ┌──────────┐   f (편집중 아님)      ┌──────────┐
        │  normal  │ ────────────────────▶ │   hint   │
        │          │ ◀──────────────────── │          │
        └──────────┘   Esc / 활성화 완료     └──────────┘
             │                                   │
   Phase 5:  │ j k g G o r a x d /               │ [a-z] 누적, Backspace 삭제
             ▼                                   ▼
        (command dispatch)                  (filter → 유일 매치 시 activate)
```

- 모드 전이와 키 라우팅은 순수 함수로 구현하고, 부작용(힌트 표시/클릭)은 호출자가 수행합니다 → 단위 테스트 가능.
- Phase 5의 `gg` 같은 다중 키 시퀀스를 위해 `pending` 버퍼와 타임아웃을 처음부터 상태머신에 넣어 둡니다.

### 4.2 키 소비 규칙

| 상황 | 처리 |
|---|---|
| `normal` + `f` + 편집 컨텍스트 아님 | 소비(`preventDefault` + `stopPropagation`) 후 hint 모드 진입 |
| `normal` + 기타 키 | **소비하지 않음** (Thunderbird 기본 단축키 보존) |
| `hint` + 힌트 문자 | 소비, 필터 갱신 |
| `hint` + `Esc` | 소비, 취소 |
| `hint` + `Backspace` | 소비, 마지막 문자 제거 |
| `hint` + 무관한 키 | 소비 + 힌트 종료(Vimium 동작) — 오작동 방지 우선 |
| 편집 컨텍스트에 포커스 | **모든 키 미소비** (테스트 11) |

### 4.3 편집 컨텍스트 판정 (`isEditableTarget`)

```js
target.closest?.("input, textarea, select, [contenteditable=''], [contenteditable='true']")
  || target.isContentEditable
  || doc.designMode === "on"
  || ["textbox","searchbox","combobox"].includes(target.getAttribute?.("role"))
  || XUL: target.localName === "editor" || 조상에 <search-bar>/global-search-bar
```

Thunderbird 자체 핸들러는 이런 가드를 하지 않으므로(연구 §6.3) 우리가 직접 구현해야 합니다. 판정 로직은 `core`에 두고 요소 조회 함수만 주입해 테스트합니다.

---

## 5. Hint 파이프라인

요구된 파이프라인을 그대로 모듈 경계로 삼습니다.

```
DOM
 ↓  tb/targets.js       셀렉터 집합 (HTML + XUL + TB 커스텀 요소)
visible elements
 ↓  dom/visibility.js   rect·style·XUL hidden/collapsed·뷰포트 교차·가림(occlusion)
clickable elements
 ↓  dom/candidates.js   중복/중첩 제거, 비활성(disabled) 제외
candidate filtering
 ↓  core/ranking.js     화면 좌표(mozInnerScreenX/Y 보정)로 전역 정렬
hint generation
 ↓  core/hint-labels.js 균형 잡힌 라벨 생성 (전역 유일)
hint overlay
 ↓  dom/overlay.js      문서별 오버레이 컨테이너에 절대 위치 렌더
keyboard matching
 ↓  core/hint-matcher.js prefix 매칭 상태머신
element activation
 ↓  dom/activate.js     활성화 전략 체인
```

### 5.1 후보 셀렉터 (`tb/targets.js`) — ID 하드코딩 없음

```js
export const CLICKABLE_SELECTORS = [
  // 표준 HTML
  "a[href]", "button", "summary", "select", "input:not([type='hidden'])", "textarea",
  "[role='button']", "[role='link']", "[role='tab']", "[role='checkbox']",
  "[role='menuitem']", "[role='treeitem']", "[role='option']",
  "[onclick]", "[tabindex]:not([tabindex='-1'])", "[contenteditable='true']",
  // XUL (메일 헤더 툴바, 메뉴바, 탭바 등)
  "toolbarbutton", "tab", "menu", "menulist", "checkbox", "radio", "richlistitem",
  // Thunderbird 커스텀 요소 — 태그/속성 기반이며 개별 ID가 아님
  "button[is]",            // unified-toolbar-button, 각종 *-button
  "li[is='folder-tree-row']",
  "tr[is]",                // tree-view-table-row 계열
  "thread-card",
];
```

- 개별 버튼 ID(`#hdrReplyButton` 등)는 **어디에도 쓰지 않습니다.** 역할/태그/`is=` 속성만 사용합니다.
- Thunderbird가 새 커스텀 요소를 추가해도 `button[is]`, `[role=…]` 규칙에 대부분 자동 포함됩니다.
- 이 파일이 유일한 "TB 지식" 집중 지점입니다(C7 대비).

### 5.2 가시성/클릭 가능성 판정 (`dom/visibility.js`)

순서(비용이 싼 것부터):

1. `rect = el.getBoundingClientRect()` → `width*height > 0`
2. 뷰포트 교차: 문서 뷰포트와 교차 면적 > 0 (스크롤 밖 제외, C5의 가상 스크롤과 자연 정합)
3. `style.visibility !== "hidden"`, `display !== "none"`, `opacity > 0.05`
4. XUL 전용: `el.hidden`, `el.getAttribute("collapsed")`, `el.getAttribute("disabled")` 확인
5. 가림 판정: rect의 중심 + 4개 근접점에서 `doc.elementFromPoint()` → 결과가 후보 자신이거나 후보의 조상/자손이면 통과 (Vimium과 동일 휴리스틱)
6. 중첩 제거: 이미 채택된 후보와 rect IoU가 임계값(예: 0.9) 이상이고 조상-자손 관계면 **바깥쪽 하나만** 남김

DOM API 접근은 어댑터 객체(`{ rect, style, elementFromPoint }`)로 주입해서 페이크로 단위 테스트합니다.

### 5.3 라벨 생성 (`core/hint-labels.js`)

Vimium과 동일한 균형 트리 방식:

```js
export function generateLabels(count, chars = "asdfghjkl") {
  const hints = [""]; let offset = 0;
  while (hints.length - offset < count || hints.length === 1) {
    const base = hints[offset++];
    for (const c of chars) hints.push(c + base);
  }
  return hints.slice(offset, offset + count)
              .map(s => [...s].reverse().join(""))
              .sort();
}
```

보장되는 성질(테스트로 검증):

- 라벨 개수 = 후보 개수, 전부 유일
- **prefix-free**: 어떤 라벨도 다른 라벨의 접두사가 아님 → "정확히 일치하면 즉시 클릭"이 모호성 없이 성립 (테스트 15)
- 길이 차이가 최대 1 (균형)
- 기본 문자셋은 홈로우 `asdfghjkl` (설정 가능). 9개까지는 1글자, 90개까지는 2글자.

**라벨 배분**은 `core/ranking.js`가 결정합니다: 후보를 화면 좌표(문서별 `mozInnerScreenX/Y` 오프셋 적용) 기준 위→아래, 왼→오른쪽으로 정렬한 뒤 순서대로 라벨을 부여합니다. 즉 **여러 문서에 걸쳐 라벨이 전역 유일**하며(C4), 시각적으로 위쪽 요소가 짧은 라벨을 받습니다.

### 5.4 오버레이 (`dom/overlay.js`)

- 컨테이너: `doc.documentElement`에 append하는 `<div id="vimbird-hint-layer">`. **실측 확인**: `messenger.xhtml`과 `about:3pane` 양쪽에서 레이어가 정상 렌더되고(`visibility: visible`), 지정한 좌표에 정확히 배치되며, `pointer-events: none` 덕분에 대상 중심의 `elementFromPoint()`가 여전히 대상 요소를 반환합니다.
- **네임스페이스**: 두 문서 모두 `document.createElement("div")`가 XHTML 네임스페이스를 반환하는 것을 실측했습니다(루트가 `<html>`이므로). 그럼에도 `createElementNS(XHTML_NS, ...)`를 **명시적으로** 사용합니다 — `messenger.xhtml`의 `<html:body xmlns="…there.is.only.xul">`(`messenger.xhtml:302`)처럼 XUL 기본 네임스페이스가 섞여 있어, 컨테이너를 다른 위치에 붙이거나 XUL 문서가 대상이 될 때 조용히 XUL 요소가 만들어지는 사고를 막기 위함입니다.
- 위치: `position: fixed; left: rect.left px; top: rect.top px;` — 각 문서 자신의 좌표계라 변환 불필요.
- 스타일: 인라인 `<style>` 1개를 주입하고 모든 규칙을 `#vimbird-hint-layer` 하위로 스코프. 테마 상속을 피하기 위해 색/폰트/그림자 명시.
- 입력된 문자와 남은 문자를 다른 색 `<span>`으로 표시(Vimium 방식) → 다중 문자 힌트 진행 상황이 보임(테스트 14).
- `z-index`는 최대치. 단 네이티브 `menupopup`(OS 위젯 레이어)은 덮지 못함 → MVP 범위 밖으로 명시.
- 무효화: `resize`, `scroll`(capture, passive), `TabSelect`, 문서 언로드 시 **힌트 세션 즉시 종료** (테스트 12·13). 위치 재계산보다 종료가 안전하고 Vimium 동작과도 일치합니다.

### 5.5 활성화 (`dom/activate.js`) — **실측으로 확정**

> TB 155 헤드리스 인스턴스에서 네 가지 전략을 실제 위젯에 적용해 관찰 가능한 결과(앱 메뉴 패널 열림 / 작성 창 생성 / 폴더 선택 변경)로 검증했습니다. 검증 스크립트: `docs/verification.md` 참조.

| 전략 | XUL `toolbarbutton`<br>(`#button-appmenu`) | HTML `button`<br>(`#folderPaneWriteMessage`) | 폴더 행<br>(`li[is=folder-tree-row]`) | 스레드 행<br>(`tr[is=tree-view-table-row]`) | 채택 |
|---|---|---|---|---|---|
| `el.click()` | ✅ 패널 열림 | ✅ 작성 창 생성 | ✅ 폴더 전환 | **❌ 무반응** | 폴백만 |
| `createEvent("MouseEvent")` + `initMouseEvent` 로 mousedown→mouseup→click | ✅ | ✅ | ✅ | ✅ 메일 표시 | **1순위** |
| `createEvent("XULCommandEvent")` + `initCommandEvent` | ❌ 무반응 | ❌ | — | — | 미채택 |
| `windowUtils.sendMouseEvent(...)` | **API 자체가 없음** | — | — | — | **불가** |

확정된 전략 체인:

1. XUL `menu`(드롭다운): `el.openMenu?.(true)` — 팝업은 클릭 합성보다 명시적 열기가 안정적
2. **trusted mousedown → mouseup → click 시퀀스** (`button: 0`, `detail: 1`, 요소 중심 좌표). 특권 컨텍스트에서 `doc.createEvent("MouseEvent")`로 만들면 trusted 이벤트가 됩니다
3. 폴백: `el.click()` — 시퀀스 생성이 실패하는 경우에만

**`el.click()`을 1순위에서 뺀 이유**(실사용 버그로 발견): 스레드 목록 핸들러가 `event.button !== 0 || event.detail !== 1`이면 즉시 반환하는데(`tree-view.mjs:1387-1392`), `HTMLElement.click()`이 만드는 이벤트는 `detail: 0`입니다. 폴더 트리에는 같은 검사가 없어 처음엔 문제가 보이지 않았습니다.

중요 정정: **`nsIDOMWindowUtils.sendMouseEvent`는 TB 155에 존재하지 않습니다.** 실측 결과 남아 있는 것은 `sendNativeMouseEvent`(OS 레벨, 화면 좌표, 비동기)와 `dispatchDOMEventViaPresShellForTesting`뿐입니다. 오래된 애드온/문서에서 흔히 보이는 `sendMouseEvent` 기반 클릭 합성 코드는 **현재 버전에서 그대로 실패**하므로 사용하지 않습니다.

- `F`(새 컨텍스트에서 열기)는 폴백 경로의 `initMouseEvent`에 Ctrl/Shift 플래그를 실어 확장합니다.
- 활성화 직전에 힌트 레이어를 제거하고, 레이어에는 `pointer-events: none`을 적용합니다(실측: 레이어가 떠 있어도 대상 중심의 `elementFromPoint`가 대상 요소를 그대로 반환).

---

## 6. 키 수신 전략 — **실측으로 확정 (전략 A)**

미검증 항목 C8을 헤드리스 Thunderbird 155에서 실제 키 입력(Marionette `PerformActions`)으로 측정했습니다.

**측정 1 — 문서 경계 전파**: 포커스를 `about:3pane`의 `#folderTree`에 두고 `f`를 눌렀을 때 리스너 발화 순서:

```
1. chromeWin.capture     target=about:3pane <ul>   ← 바깥 chrome 창이 가장 먼저 받는다
2. a3pWin.capture        target=about:3pane <ul>
3. chromeDoc.bubble      target=about:3pane <ul>
4. chromeWin.sysgroup    target=about:3pane <ul>
5. a3pWin.sysgroup       target=about:3pane <ul>
```

→ **내부 문서의 키 이벤트가 바깥 chrome 창의 capture 리스너에 도달하며, 심지어 가장 먼저 도달합니다.** (in-process `<browser>`의 chrome event handler 경로. `isRemoteBrowser === false` 실측 확인) 따라서 **전략 A(창 단위 리스너 1개)** 로 충분합니다.

**측정 2 — 키 소비**: chrome 창 capture에서 `preventDefault() + stopPropagation()`을 호출했을 때:

| 리스너 | `f`(소비함) | `j`(소비 안 함) |
|---|---|---|
| `chromeWin.capture` | 발화 | 발화 |
| `a3pWin.capture` | **차단됨** ✅ | 발화 |
| `folderTree` 자체 핸들러 | **차단됨** ✅ | 발화 |
| `a3pWin.sysgroup` | 발화(차단 안 됨) | 발화 |

→ 기본 그룹 전파는 완전히 차단되어 **폴더 트리 type-ahead 같은 Thunderbird 기본 동작으로 키가 새지 않습니다.** 다만 **시스템 그룹은 별도 디스패치 그룹이라 `stopPropagation`으로 막히지 않으므로**, chrome 창에 리스너를 **두 개**(기본 그룹 capture + 시스템 그룹 capture) 붙여 양쪽에서 소비합니다. XUL `<key>` 핸들러는 `defaultPrevented`를 확인하므로 `preventDefault()`로도 대부분 억제됩니다.

**최종 구조**:

```js
const opts = [{ capture: true }, { capture: true, mozSystemGroup: true }];
for (const o of opts) win.addEventListener("keydown", onKeyDown, o);
```

`KeyBridge`는 여전히 인터페이스(`attach`/`detach`)로 분리해 둡니다 — 향후 Thunderbird가 3pane을 원격(Fission) 브라우저로 전환하면 문서 단위 부착(전략 B)으로 갈아끼울 수 있어야 하기 때문입니다. 실제로 `tb-fission`(Bugzilla #1646648)이 진행 중이라 이 대비는 이론적 사족이 아닙니다.

---

## 7. 힌트 세션 수명주기

```
[f 입력]
  1. HintSession.start()
  2. registry.documents() 순회
       · 에이전트 미주입 문서면 loadSubScript 주입
       · agent.collect() → 후보 배열 (요소 참조는 문서 쪽에 보관, 부모엔 핸들만)
  3. core/ranking.js 로 전역 정렬 → core/hint-labels.js 로 라벨 생성
  4. 문서별로 agent.render(labelAssignments)
  5. 키 입력마다 core/hint-matcher.js 로 상태 갱신
       · 후보 다수  → agent.filter(prefix)   (일치하지 않는 힌트 숨김)
       · 유일 매치  → owner.agent.activate(handle) → end()
       · 매치 없음  → end()
  6. end(): 모든 agent.clear(), 리스너 원복, 모드 normal 복귀
```

- **요소 참조는 부모로 넘기지 않습니다.** 문서 쪽 에이전트가 `Map<handleId, Element>`를 보관하고 부모는 `{docId, handleId, screenRect, tag}`만 다룹니다 → 크로스-컴파트먼트 참조 누수와 GC 문제 회피.
- 세션은 항상 `end()`로 수렴하며, 문서 언로드/창 닫힘/`onShutdown`에서도 강제 정리합니다.

---

## 8. 파일 레이아웃

```
Vimbird/
├── manifest.json                 # MV3, experiment_apis 선언
├── package.json                  # 테스트/빌드 스크립트만 (런타임 의존성 0)
├── README.md
├── docs/
│   ├── research.md               # Phase 1
│   ├── design.md                 # 이 문서
│   ├── verification.md           # 실측 기록 (Marionette)
│   └── testing.md                # 테스트 실행법 + 수동 체크리스트
├── scripts/
│   └── build.mjs                 # dist/vimbird-<version>.xpi 생성 (의존성 없는 zip 작성기)
├── src/
│   ├── background/background.js  # 상태 로그만 (힌트 로직은 여기 없음)
│   ├── core/                     # 순수 로직 (TB·DOM 비의존)
│   │   ├── hint-labels.js
│   │   ├── hint-matcher.js
│   │   ├── ranking.js
│   │   └── editable.js
│   ├── dom/                      # DOM 의존, TB 비의존
│   │   ├── visibility.js
│   │   ├── candidates.js
│   │   ├── overlay.js
│   │   └── activate.js
│   ├── tb/
│   │   └── targets.js            # ★ Thunderbird 셀렉터/예외 집중 지점
│   └── agent/
│       └── agent.js              # 문서에 주입되는 에이전트 (dom/ + tb/ 사용)
├── experiments/
│   └── vimbird/
│       ├── schema.json
│       └── implementation.js     # 창 부착 / 문서 열거 / 키 수신 / 힌트 세션
└── test/
    ├── *.test.js                 # 단위 테스트 (node --test)
    └── e2e/
        ├── marionette.py         # 의존성 없는 Marionette 클라이언트
        └── run_e2e.py            # 헤드리스 Thunderbird 자동 실행 + 시나리오 검증
```

**번들 단계는 없습니다.** 각 모듈은 `var Vimbird = ...` 네임스페이스에 붙는 클래식 스크립트라서, Experiment가 필요한 순서대로 대상 문서에 개별 로드합니다:

```js
Services.scriptloader.loadSubScriptWithOptions(this.extension.rootURI.resolve(path), {
  target,            // 대상 window (에이전트) 또는 평범한 객체 (부모의 core)
  allowUnsafeURL: true,
});
```

`allowUnsafeURL`이 **반드시 필요합니다**: 그냥 `loadSubScript`를 쓰면 확장 리소스 URL(`file://`, `jar:file://`)이 "Trying to load untrusted URI"로 거부됩니다. 이는 프레임워크가 experiment 스크립트 자체를 로드할 때 쓰는 것과 같은 호출입니다(`ExtensionCommon.sys.mjs:1702`). 소스 디렉터리 임시 설치와 패키징된 XPI 양쪽에서 동작을 확인했습니다.

같은 파일이 Node의 `require`로도 로드되므로(단위 테스트) 각 모듈 끝에 `module.exports` 가드가 있습니다.

---

## 9. manifest 결정

```json
{
  "manifest_version": 3,
  "name": "Vimbird",
  "browser_specific_settings": {
    "gecko": { "id": "vimbird@gyuyoung", "strict_min_version": "128.0" }
  },
  "background": { "scripts": ["src/background/background.js"] },
  "permissions": ["storage"],
  "experiment_apis": {
    "vimbird": {
      "schema": "experiments/vimbird/schema.json",
      "parent": {
        "scopes": ["addon_parent"],
        "paths": [["vimbird"]],
        "script": "experiments/vimbird/implementation.js",
        "events": ["startup"]
      }
    }
  }
}
```

결정 근거:

- **MV3 채택**: TB 128 ESR 이후 정식 지원이고 155에서 완전 동작. `experiment_apis` 스키마에 manifest_version 제한이 없음을 빌드에서 확인(research §4.1). 문제가 생기면 MV2로 되돌리는 비용은 manifest 몇 줄이며, 우리 코드는 MV3 전용 API에 의존하지 않습니다.
- **`events: ["startup"]`**: Experiment를 확장 시작 시점에 로드하고 `onStartup()`에서 창 리스너를 부착합니다. 이렇게 하면 **MV3 event page가 유휴 종료되어도 힌트 기능이 죽지 않습니다.** (MV3에서 background 수명에 로직을 매다는 것이 가장 흔한 함정)
- **권한 최소화**: MVP에 필요한 표준 권한은 `storage`뿐입니다. 나머지 능력은 전부 Experiment가 제공합니다(대신 설치 시 전체 접근 경고가 표시됨 — README에 명시).
- **`strict_min_version: 128.0`**: MV3 + `currentAbout3Pane`/unified toolbar 구조가 성립하는 하한선. 실제 검증은 155에서만 이뤄졌음을 README에 명시합니다.

---

## 10. MVP 범위와 비범위

**포함**
- `f` 힌트 모드 (표시 → 입력 → 클릭 → `Esc`/`Backspace`)
- 대상: 통합 툴바 버튼, 탭, 메뉴바, 폴더 트리 행, 스레드 목록 행, 메시지 헤더 버튼
- 3pane 창 + compose 창(같은 코드 경로, 동작 확인 대상)
- 다중 문자 힌트, prefix 충돌 없는 라벨
- 텍스트 입력 포커스 시 비활성

**비포함 (후속)**
- 메일 **본문 HTML 링크** 힌트 (Phase 2 확장 — `scripting.messageDisplay` 경로)
- `j/k`, `gg/G`, `o`, `r`, `a`, `x`, `d`, `/` (Phase 5)
- 설정 UI, 키맵 커스터마이즈 (기본값은 코드 상수로 시작)
- 네이티브 `menupopup` 내부 항목 힌트
- 스크롤 중 힌트 위치 추적(대신 종료)

---

## 11. 테스트 전략

### 11.1 자동 테스트 (`node --test`, 의존성 0)

| 대상 | 검증 내용 |
|---|---|
| `hint-labels` | 개수 일치, 유일성, **prefix-free**, 길이 균형, 문자셋 변경, 0/1/9/10/90/91개 경계 |
| `hint-matcher` | 단일/다중 문자 매칭, 공통 prefix(테스트 15), Backspace, Esc, 무매치 종료 |
| `ranking` | 화면 좌표 정렬 안정성, 다문서 오프셋 합성, 동률 처리 |
| `editable` | 입력 요소/`contenteditable`/XUL 검색창 판정 (테스트 11) |
| `visibility` | 페이크 어댑터로 rect 0, 뷰포트 밖, `display:none`, XUL `hidden`/`collapsed`, 가림, 중첩 제거 |

### 11.2 E2E 자동 테스트 (실제 Thunderbird)

Thunderbird 내장 **Marionette**로 chrome 프로세스에 접속해, 진짜 키 이벤트를 보내고 진짜 DOM을 검사합니다(`test/e2e/`). 일회용 프로필을 만들어 헤드리스로 띄우므로 사용자 프로필과 완전히 분리됩니다.

12개 시나리오가 아래를 덮습니다: 힌트 표시(다문서), 라벨 유일성·prefix-free, 툴바 버튼 활성화, `Esc` 취소, 다중 문자 힌트로 폴더 전환, 메시지 헤더 힌트, 스레드 행 활성화, 텍스트 입력 보호, 작성 창 힌트, 스크롤·리사이즈 해제, 키 누수 방지.

**한계**: 헤드리스에는 창 관리자가 없어 OS 포커스가 3-pane 창을 떠나지 못합니다. 작성 창 대상 두 시나리오는 합성 `keydown`으로 코드 경로만 검증하므로 수동 확인이 필요합니다(`docs/testing.md`).

### 11.3 수동 테스트 (`docs/testing.md`)

요구된 15개 시나리오를 체크리스트로 정리하고, 각 항목에 자동화 여부를 표시했습니다. 사람이 봐야 하는 것은 힌트의 **시각적 위치·가독성**, 대용량 폴더에서의 체감 성능, OS 포커스가 실제로 이동하는 상황입니다.

### 11.4 진단 지원

Experiment가 `messenger.vimbird.dumpCandidates()`를 노출합니다 — 힌트를 띄우지 않고 문서별 후보 개수와 태그 분포만 반환합니다. Thunderbird UI가 바뀌어 특정 버튼이 힌트를 못 받을 때, `src/tb/targets.js`의 셀렉터를 고치기 전에 여기서 누락을 확인합니다. `getStatus()`는 확장이 어떤 창에 붙어 있는지 보여줍니다.

---

## 12. 구현 순서 (Phase 3)

Spike 0~3은 확장을 만들기 전에 **헤드리스 Thunderbird 155 + Marionette**로 이미 완료했습니다(`docs/verification.md`). 결과가 §5.5·§6에 반영되어 있어 구현은 확정된 사실 위에서 시작합니다.

| 단계 | 내용 | 상태 |
|---|---|---|
| ~~Spike 0~~ | 키 이벤트 문서 경계 전파 / 소비 | ✅ 완료 → 전략 A 확정 |
| ~~Spike 1~~ | 두 문서에 오버레이 렌더 | ✅ 완료 |
| ~~Spike 2~~ | `currentAbout3Pane` 접근 + 후보 스캔 | ✅ 완료 (chrome 60개 / about:3pane 6개 가시 후보) |
| ~~Spike 3~~ | 활성화 전략 비교 | ✅ 완료 → `el.click()` 1순위 확정 |
| ~~M1~~ | 단일 문서(chrome) 힌트 완주 | ✅ 완료 |
| ~~M2~~ | 다문서 확장 (3pane, message) + 전역 라벨 | ✅ 완료 — chrome/about:3pane/about:message/compose 동시 힌트 |
| ~~M3~~ | 엣지 케이스 (편집 포커스, 스크롤/리사이즈 종료, compose 창) | ✅ 완료 — 단위 33개 + E2E 12개 통과 |

구현 중 실측으로 바로잡은 것 두 가지:

1. `Services.scriptloader.loadSubScript`는 확장 리소스를 거부한다 → `loadSubScriptWithOptions(..., allowUnsafeURL: true)` (§8)
2. 활성화보다 세션 종료를 먼저 하면 안 된다 — 종료가 에이전트의 요소 참조를 놓아버리므로 `activate()` → `endSession()` 순서를 지켜야 한다

---

## 13. 위험과 대응

| 위험 | 영향 | 대응 |
|---|---|---|
| ~~키 이벤트가 문서 경계를 못 넘음 (C8)~~ | — | **해소됨** (§6 실측). 다만 Fission 전환 대비로 `KeyBridge` 추상화 유지 |
| ~~합성 클릭이 위젯을 못 깨움~~ | — | **해소됨** (§5.5 실측). `el.click()` + trusted MouseEvent 폴백 |
| 미검증 위젯 종류(스레드 행, 메시지 헤더 버튼, 메뉴 항목) | 일부 대상 미동작 | 활성화 전략 체인 + 실패 시 콘솔 경고. 메시지가 있는 프로필로 추가 검증 필요 |
| Thunderbird UI 재변경 | 후보 누락 | 셀렉터를 `tb/targets.js` 한 곳에 집중, 진단 덤프 모드 제공 |
| Experiment 억제 정책 활성화 | 배포판 차단 | 개발은 임시설치(예외). 표면적 최소화로 향후 표준 API 이관 여지 확보. ESR 채널 안내 |
| MV3 event page 종료로 기능 정지 | 힌트 무반응 | 로직을 background가 아닌 Experiment `onStartup`에 배치 |
| 오버레이가 접근성/포커스 방해 | 사용성 저하 | `pointer-events:none`, `aria-hidden="true"`, 포커스 이동 없음 |
| snap 샌드박스 제약 | 설치/디버깅 실패 | 프로필 경로 `~/snap/thunderbird/common/.thunderbird/` 사용, README에 명시 |
