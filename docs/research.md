# Phase 1 — Thunderbird 확장 개발 조사 (Vimbird)

작성일: 2026-09-08
대상: Vimium 스타일 Hint Mode를 제공하는 Thunderbird 확장(Vimbird)

---

## 0. 조사 방법과 신뢰도 표기

이 문서의 사실은 세 가지 출처에서 나왔고, 각 항목에 신뢰도를 표기했습니다.

| 표기 | 의미 |
|---|---|
| **[빌드검증]** | 이 머신에 실제 설치된 Thunderbird 155.0 빌드의 `omni.ja` 내부 소스를 직접 열어 확인함 (가장 신뢰도 높음) |
| **[공식문서]** | developer.thunderbird.net / webextension-api.thunderbird.net / MDN 등 공식 문서 |
| **[미검증]** | 문서·커뮤니티 근거만 있고 실제 동작을 확인하지 못함 → 구현 전 스파이크 필요 |

검증 환경:

- 설치 경로: `/snap/thunderbird/current/usr/lib/thunderbird/` (snap, `latest/stable`, rev 1240)
- `application.ini`: `Version=155.0`, `BuildID=20260828084831`, `SourceStamp=d7ad5b5220b8af757553f3cc02971f7ba76e3a45` **[빌드검증]**
- 프로필: `~/snap/thunderbird/common/.thunderbird/` (snap 샌드박스 경로 — 일반 `~/.thunderbird`가 **아님**) **[빌드검증]**
- 검증 방법: `unzip omni.ja` 후 `chrome/messenger/content/messenger/**`, `modules/**`, `defaults/pref/**` 직접 grep

오래된 XUL 시대 문서(2015년 이전 Muttator/XUL overlay 등)는 근거로 사용하지 않았습니다. Thunderbird는 115 "Supernova"에서 UI를 대대적으로 재작성했고, XUL `<tree>` 위젯은 이미 제거되었기 때문입니다.

---

## 1. 현재 Thunderbird 버전과 릴리스 채널

- 설치본은 **Thunderbird 155.0 (Monthly Release 채널)** 입니다. **[빌드검증]**
- Thunderbird는 2026년 9월부터 Firefox와 같은 **격주(fortnightly) 릴리스 주기**로 전환했습니다. ESR 계열은 별도로 153.x가 유지됩니다. **[공식문서]**
- 이 구분이 중요한 이유: 뒤에서 설명할 **Experiment API 억제(suppression) 정책은 Monthly Release 채널을 대상으로 논의되었고 ESR은 대상이 아니기 때문**입니다. 즉 우리 개발 환경(155 Monthly)이 정책 변화의 최전선입니다.

---

## 2. 확장 개발 방식 — MailExtension

Thunderbird의 현재(그리고 유일한) 확장 형식은 **MailExtension**입니다. WebExtension 표준에 Thunderbird 전용 API(`messenger.*` 네임스페이스, `browser.*`도 별칭으로 동작)를 더한 것입니다. **[공식문서]**

- 레거시 XUL overlay 확장(Muttator, 구 Vimperator 계열)은 **완전히 불가능**합니다. 참고 대상은 되지만 이식 대상은 아닙니다.
- **manifest_version은 2와 3 모두 지원**됩니다. MV3는 TB 128 ESR부터 정식 지원되며, Mozilla/Thunderbird는 Chrome과 달리 MV2 폐기 일정을 발표하지 않았습니다. **[공식문서]**
- MV3에서도 background는 Chrome식 service worker가 아니라 **Limited Event Page**(DOM이 있는 background page, 유휴 시 종료 후 이벤트로 재기동)입니다. 즉 background에서 DOM/`window`를 쓸 수 있습니다. **[공식문서]**
- MV3 주요 변경: `browser_action` → `action`, `_execute_browser_action` → `_execute_action`. **[공식문서]**

### 개발/디버깅 환경 (설치본 pref 실측) **[빌드검증]**

| pref | 값 | 의미 |
|---|---|---|
| `devtools.chrome.enabled` | `true` (`all-thunderbird.js:362`) | **Browser Toolbox로 chrome DOM 직접 검사 가능** — 힌트 대상 DOM 구조 확인에 필수 |
| `devtools.debugger.remote-enabled` | `true` (`all-thunderbird.js:363`) | 원격 디버깅 가능 |
| `xpinstall.signatures.required` | `false` (`greprefs.js:1165`) | 이 빌드는 미서명 XPI 설치 가능(단 배포 시엔 ATN 서명 권장) |
| `extensions.autoDisableScopes` | `15` (`all-thunderbird.js:58`) | 외부 설치 확장은 기본 비활성 → 개발은 `about:debugging`의 임시 설치 사용 |

개발 루프는 **`about:debugging` → "이 Thunderbird" → "임시 부가 기능 로드"** 로 `manifest.json`을 직접 지정하는 방식이 표준입니다. 이 방식은 뒤에서 설명할 Experiment 억제 정책의 **예외**이기도 해서 개발에 유리합니다.

---

## 3. 일반 WebExtension API로 가능한 범위

설치본에 존재하는 Thunderbird 전용 parent API 목록 **[빌드검증]** (`chrome/messenger/content/messenger/parent/`):

```
ext-accounts, ext-addressBook, ext-browserAction, ext-chrome-settings-overrides,
ext-cloudFile, ext-commands, ext-composeAction, ext-compose, ext-extensionScripts,
ext-folders, ext-identities, ext-mail, ext-mailTabs, ext-menus,
ext-messageDisplayAction, ext-messageDisplay, ext-messages, ext-messengerSettings,
ext-messengerUtilities, ext-oauth_provider, ext-pkcs11, ext-scripting-tb,
ext-sessions, ext-spaces, ext-spacesToolbar, ext-tabs, ext-theme, ext-windows
```

핵심 결론: **이 API들은 전부 "데이터/모델 레벨"입니다.** 폴더 객체, 메시지 헤더, 탭 메타데이터, 레이아웃 설정은 다룰 수 있지만 **툴바 버튼·폴더 트리 행·스레드 행의 살아있는 DOM 노드를 돌려주는 API는 하나도 없습니다.** 따라서 "화면에 보이는 클릭 가능한 요소를 전부 찾아 힌트를 띄운다"는 요구사항은 표준 API만으로는 원리적으로 불가능합니다.

Vimbird에 그나마 유용한 표준 API:

| API | 용도 | 한계 |
|---|---|---|
| `tabs`, `windows` | 현재 활성 창/탭 종류 판별(3pane / message / compose) | DOM 접근 불가 |
| `mailTabs` | 표시 중인 폴더/선택된 메시지 조회·설정 | Phase 5의 `j/k` 일부를 API로 구현 가능 |
| `messageDisplay` | 현재 표시 중 메시지 | 헤더 버튼 DOM은 불가 |
| `commands` | 단축키 등록 | **아래의 치명적 제약** |
| `scripting.messageDisplay` (MV3) / `messageDisplayScripts` (MV2) | 메일 **본문** 문서에 스크립트 주입 | 본문 한정. chrome UI에는 주입 불가. 이미 열린 메시지엔 수동 `executeScript` 필요 |

### 3.1 `commands` API로는 `f` 단일 키를 등록할 수 없다 (결정적)

설치본의 검증 로직 원문 **[빌드검증]** (`modules/ShortcutUtils.sys.mjs:271~333`):

```js
const BASIC_KEYS = /^([A-Z0-9]|Comma|Period|Home|End|PageUp|PageDown|Space|Insert|Delete|Up|Down|Left|Right)$/;
const FUNCTION_KEYS_BASIC = /^(F[1-9]|F1[0-2])$/;
...
switch (modifiers.length) {
  case 0:
    // A lack of modifiers is only allowed with function keys.
    if (!FUNCTION_KEYS.test(key)) {
      return this.MODIFIER_REQUIRED;   // ← "F" 는 여기서 거부됨
    }
```

주석에 있는 예시 표까지 명시적입니다: `"Shift+F"` → `MODIFIER_REQUIRED`.

즉 **수식키 없는 `f`, `j`, `k`, `g`, `/` 같은 Vim 스타일 바인딩은 `commands` API로 절대 등록할 수 없습니다.** (관련 요청 Bugzilla #1591730은 2019년부터 미해결) 이것이 Vimbird가 Experiment API를 쓸 수밖에 없는 **첫 번째 결정적 이유**입니다.

### 3.2 content script로 chrome UI에 접근할 수 없다

`about:3pane`, `about:message`, `messenger.xhtml`은 **privileged chrome 문서**입니다. `manifest.json`의 `content_scripts.matches`로 이들을 대상 지정할 수 없습니다(공식 문서가 "not possible"이라고 명시). content script는 `runtime`/`i18n`/`menus`/`storage` 정도의 축소된 API만 쓸 수 있고, 나머지는 background로 메시지를 릴레이해야 합니다. **[공식문서]**

→ **두 번째 결정적 이유**: chrome DOM 접근에는 Experiment API가 필수입니다.

---

## 4. WebExtension Experiment API

### 4.1 구조 **[공식문서]**

`manifest.json`:

```json
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
```

- `implementation.js`는 `ExtensionCommon.ExtensionAPI`를 상속한 클래스를 정의하고 `getAPI(context)`에서 API 객체를 반환합니다.
- 이 스크립트는 **부모 프로세스의 특권 컨텍스트**에서 실행되어 `Services`, `ChromeUtils`, XPCOM 전체에 접근할 수 있습니다. 즉 `Services.wm.getMostRecentWindow("mail:3pane")`로 메인 창 DOM을 그대로 만질 수 있습니다.
- 최상위에서 `let`/`const` 대신 `var`를 써야 하는 로딩 제약이 있습니다(스크립트가 같은 스코프에 반복 로드될 수 있기 때문).
- **Firefox와 달리 Thunderbird는 릴리스 채널에서도 Experiment를 허용합니다.** (Firefox는 Nightly/unbranded 한정)
- 권한 모델: 세분화된 permission이 아니라 "Thunderbird와 컴퓨터에 대한 전체 접근" 이라는 단일 경고가 설치 시 표시됩니다.
- 스키마상 `experiment_apis`에 `min/max_manifest_version` 제한이 **없으므로 MV2/MV3 모두에서 사용 가능**합니다. **[빌드검증]** (`chrome/toolkit/content/extensions/schemas/experiments.json:17-22`, `"privileged": true`만 설정됨)

### 4.2 TB 155에 실제로 들어와 있는 Experiment 억제 메커니즘 (중요) **[빌드검증]**

설치본 pref (`defaults/pref/all-thunderbird.js:63-66`):

```js
pref("extensions.experiments.enabled", true);
pref("extensions.experiments.suppressed", false);
pref("extensions.experiments.allowed", "tbpro-add-on@thunderbird.net,owl@beonex.com");
```

`modules/ExtensionUtilities.sys.mjs:126-131`의 판정 로직:

```js
const isExperiment = !!data.manifest.experiment_apis;
const isSuppressedExperiment =
  isExperiment &&
  lazy.EXPERIMENTS_SUPPRESSED &&
  !lazy.EXPERIMENTS_ALLOWED.includes(addon.id) &&
  !addon.temporarilyInstalled;
```

억제 대상으로 판정되면 `updateBlocklistForSuppressedExperiments()`가 **로컬 블록리스트 stash에 `id:version`을 넣어 차단**하며, `MailGlue.sys.mjs:1006-1012`는 이 pref를 런타임에 observe해서 즉시 반영합니다.

이 코드에서 읽어낼 수 있는 사실:

1. **현재(TB 155 기본값) `suppressed=false` 이므로 Experiment 확장은 정상 동작합니다.** 스위치는 존재하지만 꺼져 있습니다.
2. Thunderbird는 Monthly Release 채널에서 Experiment 지원을 단계적으로 축소하려는 정책을 발표했다가 커뮤니티 반발로 **1년 연기**한 상태입니다(2026년 6월 개발 다이제스트). ESR은 대상이 아닙니다. **[공식문서]**
3. **`!addon.temporarilyInstalled` 조건 덕분에, `about:debugging`으로 임시 설치한 확장은 억제 정책이 켜져도 예외입니다.** → 개발·테스트 워크플로는 정책 변화와 무관하게 유지됩니다. **[빌드검증]**

**Vimbird에 대한 함의**: Experiment API는 지금 쓸 수 있고 앞으로도 개발용으로는 안전하지만, "배포용"으로는 정책 리스크가 있습니다. 따라서 설계에서 **Experiment 표면적을 최소화**(얇은 브리지 1개)하고, hint engine 본체는 Experiment와 무관한 순수 로직으로 분리해야 합니다. 정책이 바뀌면 브리지만 교체하면 되도록.

---

## 5. Thunderbird UI/문서 구조 (TB 155 실측)

### 5.1 메인 창 — `messenger.xhtml` **[빌드검증]**

`chrome/messenger/content/messenger/messenger.xhtml:48-55`:

```xml
<html id="messengerWindow" xmlns="http://www.w3.org/1999/xhtml"
      ...
      windowtype="mail:3pane"
```

- **`windowtype="mail:3pane"`은 여전히 유효합니다.** `Services.wm.getMostRecentWindow("mail:3pane")`은 현재도 올바른 접근 방법입니다.
- 다만 루트 요소는 이제 `<window>`가 아니라 **`<html>`** 입니다. XUL 요소(`<toolbar>`, `<hbox>`, `<vbox>`, `<menupopup>`)는 XHTML 문서 안에 XUL 네임스페이스로 섞여 있습니다. → **"XUL 문서"가 아니라 "XUL 요소를 포함한 XHTML 문서"** 로 이해해야 합니다.
- 상단 구조: `navigation-toolbox` → `titlebar`(안에 `<html:unified-toolbar>`) → `toolbar-menubar` → `tabs-toolbar`, 본문은 `messengerBody` → `tabmail-container` → `<tabmail>`.

### 5.2 통합 툴바(unified toolbar) **[빌드검증]**

- 위치: `chrome/messenger/content/messenger/unifiedtoolbar/` (`unified-toolbar.mjs`, `unified-toolbar-button.mjs`, `extension-action-button.mjs` 등)
- `unified-toolbar-button.mjs:269`:
  ```js
  customElements.define("unified-toolbar-button", UnifiedToolbarButton, { extends: "button" });
  ```
  즉 실제 DOM은 **`<button is="unified-toolbar-button">`** 이며 **Shadow DOM을 쓰지 않습니다.**
- Lit 기반이라는 통설은 틀렸습니다. 바닐라 Web Components + `<template>` 클론 방식입니다.
- **Vimbird에 좋은 소식**: 툴바 버튼이 평범한 `<button>`이라 `querySelectorAll` + `getBoundingClientRect()`가 그대로 통합니다. Shadow DOM 관통 로직이 필요 없습니다.
- 단, 메일 헤더 툴바 등 일부 영역은 여전히 XUL `toolbarbutton`을 씁니다(`aboutMessage.xhtml:819`의 `class="toolbarbutton-1 message-header-view-button"`). → **후보 탐색기는 HTML `<button>`과 XUL `toolbarbutton`을 모두 인식해야 합니다.**

### 5.3 3-pane 본체 — `about:3pane` **[빌드검증]**

메인 창이 아니라 **탭 안의 `<browser>`에 로드되는 별도 문서**입니다. `messenger.xhtml:6600-6607`:

```xml
<html:template id="mail3PaneTabTemplate">
  <stack flex="1">
    <browser flex="1" src="about:3pane" autocompletepopup="PopupAutoComplete"
             messagemanagergroup="single-page"/>
  </stack>
</html:template>
```

`about3Pane.xhtml`의 주요 노드:

| 영역 | DOM | 근거 |
|---|---|---|
| 폴더 창 | `<div id="folderPane">` → `<ul id="folderTree" is="tree-listbox">` | `about3Pane.xhtml:64,85-86` |
| 폴더 행 | `<li is="folder-tree-row" id="[mode]-[uri]" data-server-key=... >` (자식 `.name`, `.icon`, `.unread-count`) | `folder-tree-row.mjs` |
| 스레드 창 | `<div id="threadPane">` → `<tree-view id="threadTree">` | `about3Pane.xhtml:124,294` |
| 스레드 행 | `<tr is="tree-view-table-row">` (테이블 뷰) 또는 `<thread-card>` (카드 뷰) | `about3Pane.xhtml:435-469`, `tree-view.mjs` |
| 메시지 창 | `<message-pane id="messagePane">` | `about3Pane.xhtml:519` |

- **XUL `<tree>`는 없습니다.** TB 115의 "deforestation"(Bugzilla #1724841)으로 전부 HTML 리스트/테이블로 교체되었습니다. → 힌트 대상 탐색이 표준 DOM 작업이 됩니다.
- **주의: 스레드 목록은 가상 스크롤(virtualized)입니다.** `tree-view.mjs`가 뷰포트 근처 행만 DOM에 생성합니다(`#firstBufferRowIndex`/`#lastBufferRowIndex` + 스페이서). → 화면 밖 메시지는 힌트 대상이 될 수 없고, 스크롤 시 재스캔이 필요합니다. 이건 오히려 Vimium 철학("보이는 것만 힌트")과 일치합니다.

### 5.4 메시지 표시 — `about:message` **[빌드검증]**

- `message-pane.mjs`는 `#webBrowser`(웹 콘텐츠), `#messageBrowser`(`about:message`), `#multiMessageBrowser`(다중 선택 요약) 세 형제 `<browser>`를 두고 하나만 보여줍니다.
- `about:message` 안에는 다시 **`<browser id="messagepane" type="content">`** 가 있고 여기에 실제 메일 본문이 렌더됩니다 (`aboutMessage.xhtml:1824-1829`).
- 메시지 헤더 버튼(회신/전달/보관 등)은 `about:message` 문서에 있습니다: `<html:header id="messageHeader">` → `<div id="header-view-toolbox" role="toolbar">` → `<hbox id="header-view-toolbar">` 안의 `toolbarbutton-1 message-header-view-button` (`aboutMessage.xhtml:806-827`).
- 즉 **MVP 대상인 "message header buttons"는 `about:message` 문서 안에 있으므로 3pane 문서와 별개로 접근해야 합니다.**

### 5.5 문서 경계 / 프로세스 모델 (설계에 가장 중요) **[빌드검증]**

```
messenger.xhtml  (chrome, mail:3pane)        ← 창, 탭바, 통합 툴바, 메뉴바
 └ <browser src="about:3pane">               ← remote 속성 없음 = 부모 프로세스 in-process chrome
    ├ #folderTree, #threadTree               ← MVP 대상
    └ <message-pane>
       └ <browser id="messageBrowser" src="about:message">   ← in-process chrome
          └ <browser id="messagepane" type="content">        ← 메일 본문 (Phase 2 대상)
```

- `mail3PaneTabTemplate`/`mailMessageTabTemplate`의 `<browser>`에 **`remote="true"`가 없습니다.** 게다가 `message-pane.mjs`가 `this.messageBrowser.contentDocument`, `.contentWindow.displayMessage(...)`를 **동기적으로** 호출합니다(`message-pane.mjs:159-163, 330, 503`). → `about:3pane`과 `about:message`는 **부모 프로세스에서 동기 접근 가능**합니다.
- **이것이 설계상 가장 좋은 소식입니다.** Experiment 코드에서 프레임 스크립트/JSWindowActor/IPC 없이 다음처럼 바로 도달할 수 있습니다:
  ```js
  const win = Services.wm.getMostRecentWindow("mail:3pane");
  const about3Pane = win.document.getElementById("tabmail").currentAbout3Pane;   // tabmail.js:1441
  const aboutMessage = win.document.getElementById("tabmail").currentAboutMessage; // tabmail.js:1454
  ```
  `currentAbout3Pane` / `currentAboutMessage`는 **Thunderbird가 공식적으로 제공하는 tabmail 접근자**입니다. **[빌드검증]**
- 메일 본문 `#messagepane`만 `type="content"`이며(원격일 수 있음) Phase 2에서 별도 취급합니다. 본문은 표준 API인 `scripting.messageDisplay`로 접근하는 게 정공법입니다.
- **다만 문서가 여러 개라는 사실 자체는 남습니다.** 각 `<browser>`는 독립된 `document`/`window`이므로, 힌트 오버레이와 키 리스너를 문서별로 다뤄야 합니다.

### 5.6 작성(compose) 창 **[빌드검증]**

- `mail/components/compose/content/messengercompose.xhtml`, 루트 `<html id="msgcomposeWindow" ... windowtype="msgcompose">` — **독립된 최상위 chrome 창**이며 `mail:3pane`이 아닙니다.
- 본문 편집기는 `getBrowser().contentDocument`로 접근하는 별도 `<browser>`입니다.
- → Vimbird는 창 타입별로 동일한 엔진을 부착하는 구조여야 합니다(`mail:3pane`, `msgcompose`, `mail:messageWindow`).
- 창 부착에는 Thunderbird가 제공하는 `ExtensionSupport.registerWindowListener({ chromeURLs, onLoadWindow, onUnloadWindow })` (`modules/ExtensionSupport.sys.mjs:34`)를 쓰는 것이 표준입니다. **[빌드검증]** 새로 열리는 창과 이미 열린 창을 모두 처리해 줍니다.

---

## 6. 키보드 이벤트 가로채기

### 6.1 가능한 방법과 평가

| 방법 | 평가 |
|---|---|
| `commands` API | **불가.** §3.1대로 수식키 없는 `f` 등록 불가 |
| XUL `<keyset>`/`<key>` 주입 | 가능하지만 단일 문자·모드 상태머신(`gg`, 힌트 문자열 누적)에는 부적합 |
| Experiment에서 창/문서에 `addEventListener("keydown", h, true)` | **채택.** Thunderbird 자신이 쓰는 방식과 동일 |
| `nsIObserver`/XPCOM 전역 키 훅 | 불필요하게 침습적 |

Thunderbird 자체 코드도 같은 패턴을 씁니다: `mailWindow.js`의 `InitMsgWindow()`가 chrome 문서에
`document.addEventListener("keypress", handler, { mozSystemGroup: true })`를 붙여 F7(캐럿 브라우징) 등을 처리합니다.

### 6.2 반드시 스파이크로 검증할 항목 **[미검증]**

`about:3pane`이 in-process라 해도, **내부 문서에서 발생한 keydown이 바깥 `messenger.xhtml` window 리스너까지 도달하는지**는 Gecko의 chrome event handler 동작에 달려 있어 문서만으로 단정할 수 없습니다. 두 가설:

- (A) 도달한다 — chrome event handler 경로(`mozSystemGroup` 포함)로 부모 chrome 창까지 전파. 그렇다면 창당 리스너 1개로 충분.
- (B) 도달하지 않는다 — 웹의 iframe처럼 문서 경계에서 멈춤. 그렇다면 **문서별로 리스너를 각각 부착**해야 함.

→ **구현 첫 단계(Spike 0)에서 두 위치에 로그 리스너를 붙이고 스레드 트리에 포커스를 준 채 키를 눌러 실측합니다.** 설계는 (B)를 기본 가정으로 잡아 문서별 부착 구조로 가고, (A)가 참이면 단순화하는 방향이 안전합니다.

### 6.3 텍스트 입력 중 무시 처리

Thunderbird 자체 핸들러는 `event.target`이 입력 요소인지 검사하지 않습니다(기본 동작 순서에 의존). Vimbird는 **직접 가드를 구현해야 합니다**: `input`/`textarea`/`[contenteditable]`/`select`, `role="textbox"`, 검색창(`global-search-bar`), 그리고 작성 창 본문 편집기에 포커스가 있으면 힌트 모드를 발동시키지 않습니다. 테스트 시나리오 11번에 해당합니다.

---

## 7. 기존 프로젝트 조사

### 7.1 Thunderbird용 Vim 계열 확장

| 프로젝트 | 내용 | Vimbird와의 관계 |
|---|---|---|
| **tbkeys / tbkeys-lite** (github.com/wshanks/tbkeys) | 가장 중요한 선행 사례. Experiment API로 메인 창에 **Mousetrap** 라이브러리를 주입해 임의 단일키/시퀀스 바인딩을 구현. GMail 스타일 기본 바인딩 | **키 캡처 아키텍처의 레퍼런스.** `commands` API 한계를 Experiment로 우회한 실증. 단 hint mode는 없음 |
| **tbhints** (github.com/wshanks/tbhints) | 열린 메일 **본문 안의 링크**에만 힌트를 띄워 외부 브라우저로 열기(Ctrl+Shift+E) | 이름은 가장 가깝지만 범위가 본문 링크 한정. 우리 MVP(chrome UI 전체)와 다름 |
| **ThunderVim** (ATN) | 작성 창 안에서의 Vim 텍스트 편집 키 | 텍스트 편집 전용, 네비게이션/힌트 없음 |
| **thunderbird-vim** (github.com/LQR471814) | tbkeys 설정 JSON 프로파일일 뿐 | 참고용 키맵 |
| **Muttator** (vimperator-labs) | 과거 Thunderbird용 모달 Vim 클라이언트 | **XUL overlay 기반으로 사망.** 이식 불가, 기능 아이디어만 참고 |

**결론: "Thunderbird chrome UI 전체에 Vimium 스타일 힌트를 띄우는 확장"은 현재 존재하지 않습니다.** Vimbird는 빈 칸을 메우는 프로젝트이며, tbkeys(키 캡처) + tbhints(힌트 UI, 본문 한정)를 합친 상위집합에 가깝습니다.

### 7.2 Experiment API 실제 사용 예 (코드 레퍼런스)

- **thunderbird/webext-experiments**, **thunderbird/webext-support**, **thunderbird/webext-examples** — Thunderbird 애드온 팀이 유지하는 공식/준공식 예제·유틸 저장소. Experiment 스캐폴딩의 1차 참고 자료.
- **DKIM Verifier** (github.com/lieser/dkim_verifier) — `experiment_apis` 4개를 선언한 깔끔한 배관 예제.
- **Provider for Google Calendar** (github.com/kewisch/gdata-provider) — 대규모 Experiment + 테스트(Jest + WebExtension mock) 셋업 예제.
- **Quick Folder Move** — 구버전은 Experiment 기반, 현행판은 표준 API로 이관. "Experiment를 표준 API로 갈아타는" 마이그레이션 사례로 참고 가치.

### 7.3 Vimium hint mode 아키텍처 (알고리즘 레퍼런스)

github.com/philc/vimium — `content_scripts/link_hints.js`:

1. **후보 탐색**: 네이티브 클릭 가능 태그(`a, button, select, textarea, input, object, embed, details`), `onclick`/`jsaction`/`ng-click` 속성, ARIA role(button/link/tab/checkbox), `contenteditable`, `tabindex`, 클래스명 휴리스틱(`btn`, `button`).
2. **가시성 판정**: `getVisibleClientRect()` + 요소 중심/모서리에서 `elementFromPoint()`로 가림(occlusion) 검사.
3. **힌트 문자열 생성**: `linkHintCharacters`(기본 홈로우) 기반 `hintStrings()`. 문자를 앞에 덧붙여 가며 조합을 늘리고, 정렬/역순 배치로 **짧은 힌트가 눈에 잘 띄는 요소에 배분**되고 공통 prefix가 화면에 분산되게 함.
4. **오버레이**: 대상 요소 안에 넣지 않고(자식을 못 갖는 요소가 있으므로) 별도 컨테이너에 절대 위치 `<div>` 마커를 그림. 입력된 문자/남은 문자를 `<span>`으로 나눠 2색 표시.
5. **매칭/활성화**: 키 입력을 큐에 누적 → prefix로 필터 → 후보가 1개면 활성화. `Space`는 겹친 힌트 순환, `Esc`는 취소.

**Vimbird는 이 파이프라인을 그대로 채택하되**, 후보 탐색기만 Thunderbird DOM에 맞게 교체합니다(§5의 `button[is=unified-toolbar-button]`, XUL `toolbarbutton`, `li[is=folder-tree-row]`, `tr[is=tree-view-table-row]`, `thread-card`, 탭 등).

### 7.4 기타 선행 기술

- **Tridactyl** (Firefox), **Surfingkeys** (크로스 브라우저), **Vimium C** (Vimium 포크) — 힌트 알고리즘 비교 대상.
- **LinkHints** (lydell.github.io/LinkHints) — TypeScript로 힌트 기능만 구현한 프로젝트. **Vimbird처럼 "힌트만" 하는 설계의 참고로 가장 적합.**

---

## 8. 언어 선택: JavaScript (JSDoc 타입 주석) 채택

**결론: 순수 JavaScript(ESM/`.mjs` + `.js`) + JSDoc 타입 주석. TypeScript 컴파일 파이프라인은 두지 않습니다.**

근거:

1. **Experiment `implementation.js`는 특권 컨텍스트에서 특수한 규칙으로 로드됩니다** — 최상위 `var` 요구, `ChromeUtils.importESModule` 사용, `ExtensionCommon.ExtensionAPI` 상속. 번들러/트랜스파일 산출물은 이 로딩 방식과 충돌하기 쉽고, 디버깅 시 Browser Toolbox에서 보게 되는 코드가 소스와 달라집니다.
2. Thunderbird 코드베이스 자체가 **JSDoc 주석이 달린 순수 ESM(`.sys.mjs`)** 스타일입니다. 동일 스타일이 유지보수·참조에 유리합니다.
3. 빌드 없이 소스 디렉터리를 그대로 `about:debugging`에 임시 로드할 수 있어 **개발 루프가 가장 짧습니다**(수정 → 다시 로드).
4. 타입 안전이 필요한 부분(hint engine의 순수 로직)은 `// @ts-check` + JSDoc으로 `tsc --noEmit` 검사만 CI에 붙이면 TypeScript의 실익 대부분을 얻습니다.
5. 단위 테스트 대상인 hint engine은 DOM 비의존 순수 함수로 분리하므로 Node + 표준 테스트 러너로 바로 테스트 가능합니다.

---

## 9. 아키텍처 결론 (Phase 2 입력)

조사에서 확정된 제약:

1. `f` 단일 키 등록은 표준 API로 **불가능** → **Experiment API 필수** (`ShortcutUtils.validate` 검증됨)
2. chrome UI DOM 접근도 표준 API로 **불가능** → **Experiment API 필수**
3. Experiment는 TB 155에서 **정상 동작**하나 억제 스위치가 코드에 존재 → **표면적 최소화 + 임시설치 개발 워크플로 유지**
4. `about:3pane` / `about:message`는 **부모 프로세스 동기 접근 가능** → IPC·프레임 스크립트 불필요, `tabmail.currentAbout3Pane` / `currentAboutMessage` 사용
5. 대상 UI는 전부 **표준 HTML DOM**(일부 XUL 요소 혼재), Shadow DOM 없음 → `querySelectorAll` + `getBoundingClientRect` 통용
6. 스레드 목록은 **가상 스크롤** → 보이는 행만 힌트, 스크롤 시 재계산
7. 문서가 여러 개(창/3pane/message/compose) → **문서 단위로 붙는 엔진 + 창 단위 코디네이터** 구조 필요
8. 키 이벤트의 문서 경계 전파 여부 → **해소됨**: 내부 문서의 키가 바깥 chrome 창 capture 리스너에 가장 먼저 도달 (아래 §10)

---

## 10. 구현 단계에서 추가로 실측한 사실

Marionette로 실제 Thunderbird 155를 구동해 확인했습니다. 전체 기록은 [`verification.md`](verification.md)에 있습니다.

| 항목 | 결과 | 조사 단계 예상과의 차이 |
|---|---|---|
| `about:3pane` 브라우저 원격 여부 | `isRemoteBrowser === false` | 예상대로. IPC/프레임 스크립트 불필요 확정 |
| 키 이벤트 문서 경계 전파 | 바깥 chrome 창 capture가 **가장 먼저** 수신 | 설계는 안전하게 문서별 부착을 가정했으나 **창당 리스너 1개로 충분** |
| `stopPropagation`의 범위 | 기본 그룹은 완전 차단, **시스템 그룹은 차단 안 됨** | 새 발견 → chrome 창에 리스너를 두 개 부착 |
| `windowUtils.sendMouseEvent` | **존재하지 않음** (`sendNativeMouseEvent`만 남음) | 설계 초안의 활성화 전략이 통째로 무효 → `el.click()` 채택 |
| `el.click()` | XUL `toolbarbutton`·HTML `button`·폴더 행 **모두 동작** | 가장 단순한 방법이 가장 잘 통함 |
| `createEvent("XULCommandEvent")` | 동작하지 않음 | XUL 위젯에 `command` 이벤트만 보내는 접근은 실패 |
| `Services.scriptloader.loadSubScript` | 확장 리소스 URL 거부("untrusted URI") | `loadSubScriptWithOptions(..., allowUnsafeURL: true)` 필요 — 프레임워크 자신이 쓰는 호출 |
| 미서명 확장 설치 | 소스 디렉터리·XPI 모두 **임시 설치로 동작** | 개발 워크플로 확정 |
| snap 샌드박스 | 프로필이 `$HOME` 안이어야 함 | 테스트 프로필 경로를 `~/snap/thunderbird/common/` 아래로 |

남은 열린 질문:

- `scripting.messageDisplay`가 `about:message` chrome 셸(헤더/첨부)에 주입되는지, 본문 browser에만 주입되는지 **[미검증]** — Phase 2(본문 링크 힌트)에서 확인
- 헤드리스 환경에서는 OS 창 포커스를 옮길 수 없어, 작성 창 대상 시나리오는 수동 확인이 필요 **[부분 검증]**

---

## 11. 출처

**설치 빌드 실측 (TB 155.0, BuildID 20260828084831)**
- `chrome/messenger/content/messenger/messenger.xhtml` (48-55, 285, 6600-6612)
- `chrome/messenger/content/messenger/about3Pane.xhtml` (52-58, 64, 85-86, 124, 294, 435-469, 519)
- `chrome/messenger/content/messenger/aboutMessage.xhtml` (788-827, 1824-1829)
- `chrome/messenger/content/messenger/message-pane.mjs`, `tree-view.mjs`, `folder-tree-row.mjs`, `tree-listbox.mjs`
- `chrome/messenger/content/messenger/unifiedtoolbar/unified-toolbar-button.mjs` (269)
- `chrome/messenger/content/messenger/tabmail.js` (1441 `currentAbout3Pane`, 1454 `currentAboutMessage`)
- `chrome/messenger/content/messenger/parent/ext-*.js` (제공 API 목록)
- `chrome/toolkit/content/extensions/schemas/experiments.json` (17-22)
- `modules/ShortcutUtils.sys.mjs` (260-333 `validate`)
- `modules/ExtensionUtilities.sys.mjs` (17-34, 105-146, `updateBlocklistForSuppressedExperiments`)
- `modules/ExtensionSupport.sys.mjs` (13-95 `registerWindowListener`)
- `modules/MailGlue.sys.mjs` (988-1013)
- `defaults/pref/all-thunderbird.js` (58, 63-66, 362-363), `greprefs.js` (1165, 1168)

**공식 문서**
- https://developer.thunderbird.net/add-ons/mailextensions
- https://developer.thunderbird.net/add-ons/mailextensions/experiments
- https://developer.thunderbird.net/add-ons/mailextensions/supported-webextension-api
- https://developer.thunderbird.net/add-ons/whats-new/manifest-v3
- https://webextension-api.thunderbird.net/en/mv3/guides/experiments.html
- https://webextension-api.thunderbird.net/en/mv3/guides/manifestV3.html
- https://webextension-api.thunderbird.net/en/mv3/messageDisplayScripts.html
- https://developer.thunderbird.net/thunderbird-development/codebase-overview/mail-front-end
- https://source-docs.thunderbird.net/en/latest/frontend/mail_display.html
- https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/commands
- https://searchfox.org/comm-central/source/ (comm-central 소스 검색)

**정책/버그**
- https://bugzilla.mozilla.org/show_bug.cgi?id=1591730 (단축키 API 요청, 미해결)
- https://bugzilla.mozilla.org/show_bug.cgi?id=1724841 (XUL tree 제거 "deforestation")
- https://bugzilla.mozilla.org/show_bug.cgi?id=1646648 (tb-fission)
- https://blog.thunderbird.net/2026/06/thunderbird-monthly-development-digest-june-2026/ (Experiment 억제 1년 연기)
- https://blog.thunderbird.net/2023/02/thunderbird-115-supernova-preview-the-new-folder-pane/

**선행 프로젝트**
- https://github.com/wshanks/tbkeys · https://github.com/wshanks/tbhints
- https://github.com/thunderbird/webext-experiments · https://github.com/thunderbird/webext-support · https://github.com/thunderbird/webext-examples
- https://github.com/lieser/dkim_verifier · https://github.com/kewisch/gdata-provider · https://github.com/kewisch/quickmove-extension
- https://github.com/philc/vimium (`content_scripts/link_hints.js`) · https://lydell.github.io/LinkHints/ · https://github.com/tridactyl/tridactyl
