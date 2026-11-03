# claude-auto-proxy

macOS에서 Claude Code가 어디로 연결할지를 명령 하나로 바꾸고 되돌리는 도구입니다. 두 가지 모드가 있습니다.

| 모드 | 언제 쓰나 | 켜기 / 끄기 | sudo |
|---|---|---|---|
| **라우터 모드** | 다른 Mac의 [claude-proxy-router](https://github.com/choiyounggi/claude-proxy-router)가 가진 여러 계정으로 요청을 보낼 때 | `router on` / `router off` | 필요 없음 |
| **프록시 모드** | 사내망 등에서 반드시 HTTP·SOCKS5 프록시를 거쳐야 할 때 | `on` / `off` | 필요 (비밀번호를 물음) |

```
라우터 모드:  Claude Code ──(API 주소 = 라우터)──▶ claude-proxy-router ──(여유 있는 계정)──▶ api.anthropic.com
프록시 모드:  Claude Code ──▶ /etc/hosts → 로컬 릴레이 ──(TLS 그대로)──▶ HTTP/SOCKS5 프록시 ──▶ api.anthropic.com
```

## 주요 기능

- **라우터 모드**: Claude Code 설정 파일(`~/.claude`, Orca 프로필마다, `$CLAUDE_CONFIG_DIR`)의 API 주소와 키를
  한 번에 라우터로 바꾸고, `router off`로 켜기 전 값으로 정확히 되돌립니다.
- **라우터 계정별 사용량**: `router status`가 라우터의 계정마다 5시간·주간·Fable 사용률과 "지금 이 계정으로 보낼지"를
  보여 줍니다. 라우터 모드의 Claude Code `/status`·`/usage`에는 계정 정보가 나오지 않기 때문입니다.
- **남은 로그인 경고**: 라우터 모드인데 이 Mac에 claude.ai 로그인이 남아 있으면, 일부 계정 요청이 라우터를 거치지 않는다고
  알려 줍니다.
- **프록시 모드**: HTTP CONNECT와 SOCKS5를 지원하고, TLS를 풀지 않으며, **이미 실행 중인 세션도** 다시 시작하지 않고
  프록시를 타게 합니다.
- **연결 확인 후에만 적용**: 라우터는 핑으로, 프록시는 TCP → 터널 → TLS 3단계로 실제로 닿는지 확인한 뒤에만 등록하고 켭니다.

## 설치

macOS 전용이고 Node.js 20 이상이 필요합니다.

```bash
npm install -g claude-auto-proxy
```

또는 Homebrew:

```bash
brew tap choiyounggi/claude-auto-proxy https://github.com/choiyounggi/claude-auto-proxy
brew install claude-auto-proxy
```

> nvm 같은 버전 관리자로 설치한 Node를 쓰면, 그 Node 버전을 지웠을 때 프록시 모드의 데몬도 멈춥니다. Node를 바꾼 뒤에는
> `claude-auto-proxy install`을 다시 실행하세요. Homebrew로 설치하면 이 문제가 없습니다.

## 빠른 시작

### 라우터 모드

라우터 Mac에서 `claude-proxy-router key`로 주소와 키를 확인한 뒤, 이 Mac에서:

```bash
claude-auto-proxy router onboard http://<라우터 주소>:18787 --on   # 키 입력 → 핑 확인 → 등록 → 켜기
claude-auto-proxy router status                                     # 상태와 계정별 사용량
claude-auto-proxy router off                                        # 끄기 (다시 켜기: router on)
```

- 켜고 끄는 것은 **새로 시작하는 Claude Code 세션부터** 적용됩니다. 열려 있는 세션은 다시 시작하세요.
- 라우터 모드에서 `/logout`해 둔 Mac은, `router off` 뒤에 직접 연결하려면 Claude Code에서 `/login`을 다시 해야 합니다.

### 프록시 모드

```bash
claude-auto-proxy onboard http://proxy.example.com:3128 --on   # 연결 확인 → 등록 → 켜기 (sudo 비밀번호를 물음)
claude-auto-proxy status                                       # 모드·데몬·터널 상태
claude-auto-proxy off                                          # 끄기 (다시 켜기: on)
```

실행 중인 세션도 보통 수십 초 안에 바뀝니다.

## 명령

명령 앞에 `sudo`를 붙이지 마세요. 시스템을 바꾸는 프록시 모드 명령은 필요할 때 스스로 sudo 비밀번호를 묻고, 라우터 모드
명령은 sudo로 실행하면 거부합니다.

**라우터 모드**

| 명령 | 하는 일 |
|---|---|
| `router onboard [url] [--on]` | 라우터 주소·키를 받아 핑으로 확인하고 등록합니다. 터미널이 아니면 키를 표준입력에서 읽습니다 |
| `router on` | Claude Code 설정 파일들이 라우터를 쓰게 합니다. 켜기 전에 핑으로 다시 확인합니다 |
| `router off` | 켜기 전 값으로 되돌립니다 |
| `router status` | 라우터 주소, 설정 파일별 적용 여부, 핑, **계정별 사용량**, 남은 로그인 경고 |

**프록시 모드**

| 명령 | 하는 일 |
|---|---|
| `onboard [url] [--on]` | 주소를 묻고, 연결을 확인하고, 통과하면 등록한 뒤 켤지 묻습니다 |
| `set-proxy <url>` | 같은 연결 확인을 거쳐 프록시를 등록합니다. `http://[user:pass@]host:port`, `https://…`, `socks5://host:port` (스킴 없이 `host:port`면 HTTP) |
| `on` | 데몬이 없으면 설치하고, 터널을 확인하고, hosts를 바꾼 뒤 실제 경로로 한 번 더 확인합니다. 두 번째 확인에 실패하면 hosts를 되돌립니다 |
| `off` | 라우팅을 끕니다. Claude Code가 다시 직접 연결합니다 |
| `status` | 켜짐 여부, 데몬, 터널 상태. sudo 없이 실행됩니다(프록시 주소는 sudo로 실행할 때만 보입니다) |
| `hosts` / `hosts add <host>` / `hosts remove <host>` / `hosts reset` | 경유할 호스트 목록을 관리합니다 |
| `install` | 데몬을 다시 설치합니다 (Node를 바꾼 뒤 등) |
| `uninstall [--purge]` | 라우팅을 끄고 데몬을 지웁니다. `--purge`면 설정 파일까지 지웁니다. 라우터 모드는 끄지 않습니다 |

`--help`로 전체 사용법을, `--version`으로 버전을 봅니다.

## 라우터 모드

라우터는 HTTP CONNECT 터널이 아니라 평문 HTTP로 API 요청 자체를 받습니다(계정을 고르려면 요청이 보여야 하므로).
그래서 라우터 모드는 연결 경로가 아니라 Claude Code가 부르는 **API 주소 자체를 바꿉니다.**

```
$ claude-auto-proxy router onboard
Enter the router address and key (on the router Mac: claude-proxy-router key).
router address (e.g. http://100.64.0.10:18787): http://100.64.0.10:18787
router key:                                   ← 입력한 키는 화면에 표시되지 않습니다
  ping http://100.64.0.10:18787  ok (25 ms, 4 accounts available, router 0.2.0)
registered: http://100.64.0.10:18787 (key cpr_***xY)
Point Claude Code at the router now? [Y/n]
```

- **등록 전 핑퐁**: 라우터의 `/_router/ping`에 키를 붙여 묻고, `pong`과 프로토콜 1이 돌아와야만 등록합니다. 실패하면
  닿지 않음(주소·tailnet 문제), 키 거부, 라우터가 아님으로 나눠 보여 줍니다.
- **`router on`**: 설정 파일의 `env`에 `ANTHROPIC_BASE_URL`(라우터 주소)과 `ANTHROPIC_AUTH_TOKEN`(라우터 키)을 넣습니다.
  대상은 `~/.claude/settings.json`, Orca 프로필마다 있는 `settings.json`, `$CLAUDE_CONFIG_DIR`의 `settings.json`입니다.
  라우터가 답하지 않으면 아무것도 바꾸지 않습니다.
- **`router off`**: 두 키를 켜기 전 값으로 되돌립니다. 그사이 손으로 주소를 바꾼 파일은 주소는 두고 라우터 키만 되돌린 뒤
  알려 줍니다. 되돌릴 값은 파일을 바꾸기 *전에* 저장하므로, 중간에 쓰기가 실패해도 `router off`로 돌아갈 수 있습니다.
- 켜 있는 동안 설정 파일은 소유자만 읽을 수 있게(0600) 두고 `router off` 때 원래 권한으로 되돌립니다. `settings.json`이
  심볼릭 링크(dotfiles 등)면 링크는 두고 원본을 바꿉니다.
- 같은 파일의 `env.ANTHROPIC_API_KEY`·`apiKeyHelper`, 옆의 `settings.local.json`, 셸의 `ANTHROPIC_API_KEY`·
  `ANTHROPIC_BASE_URL`처럼 라우터 설정을 덮을 수 있는 값이 있으면 경고합니다.
- `router on` 뒤에 Orca 프로필을 새로 만들었으면 `router on`을 한 번 더 실행하세요. `router status`가 파일별 적용 여부와
  예전 라우터 주소·키가 남은 파일을 알려 줍니다.

### 계정별 사용량 (`router status`)

라우터 모드의 Claude Code는 인증이 라우터 키뿐이라 `/status`에 계정이, `/usage`에 요금제 사용량(5시간·주간)이 나오지
않습니다. `router status`가 라우터의 `GET /_router/status`를 읽어 대신 보여 줍니다(값은 예시).

```
accounts (from the router):
  account-a  5h  41%  7d  58%  fable   5%  ok
  account-b  5h  25%  7d  69%  fable   7%  ok
  account-c  5h 100%  7d  65%  fable  14%  full
  account-d  5h   0%  7d 100%  fable  27%  limited until 2026-01-02T08:00:00.000Z
```

- 상태: `ok`, `ok (not for Fable)`, `full`, `full (Fable only)`, `limited until …`, `token …`, 토큰 갱신 실패.
- `ok`인지는 라우터가 계정 선택과 같은 규칙으로 계산해 보내는 `available`/`availableForFable`을 그대로 씁니다. 지금 쓸 수
  있는 계정이 먼저, 그 안에서는 라우터 점수가 낮은(여유가 많은) 순서입니다. 리셋 시각은 라우터의 시계로 판단합니다.
- `available`을 보내지 않는 라우터 0.1.0은 사용률 100%를 기준으로 대신 판단하고, 이 엔드포인트가 아예 없는 라우터에는 업데이트하라고 알려 줍니다.

### 남은 claude.ai 로그인 경고

라우터 모드에서도 Claude Code는 시작할 때 계정 요청 몇 개(`/api/claude_cli/bootstrap`, fast mode 확인)를 그 설정 폴더에
남은 claude.ai 로그인으로 `api.anthropic.com`에 직접 보냅니다(모델 호출은 라우터를 거칩니다). `router on`과
`router status`가 이런 폴더를 경고하니, 모든 계정 요청을 라우터로 보내려면 그 폴더를 쓰는 세션에서 `/logout`을 실행하세요.

- `.credentials.json`에 `claudeAiOauth`가 있거나, `.claude.json`에 `oauthAccount`가 있으면서 그 폴더의 Keychain 항목이
  있을 때 로그인으로 봅니다. Keychain 비밀값은 읽지 않으므로, 계정 정보가 남아 있으면서 Keychain 항목에 MCP 토큰만
  있으면 로그인으로 잘못 볼 수 있습니다.
- Keychain에 물을 수 없으면 경고 대신 확인하지 못한 폴더를 알려 줍니다. 경고는 종료 코드를 바꾸지 않습니다.
- `settings.json`의 `env`는 Claude Code가 실행하는 명령에도 전달되므로, 세션 안에서 `env`를 실행하면 라우터 키가 보입니다.

## 프록시 모드

### 왜 환경변수가 아닌가

Claude Code는 `HTTPS_PROXY`를 지원하지만 두 가지가 부족합니다.

- **실행 중인 세션에는 적용되지 않습니다.** 셸 환경변수는 시작할 때 한 번만 읽습니다.
- **SOCKS 프록시를 쓸 수 없습니다.** HTTP 프록시만 지원합니다. ([Claude Code 네트워크 설정 문서](https://code.claude.com/docs/en/network-config))

claude-auto-proxy는 프로세스 환경 대신 연결 경로를 바꿉니다. 그래서 어떤 세션이든, 그리고 SOCKS5 프록시로도 동작합니다.

### 동작 방식

```
Claude Code ──api.anthropic.com:443──▶ /etc/hosts → 127.0.0.1   (on/off는 이 블록만 넣고 뺍니다)
                                          │
                              릴레이 데몬 (launchd, 127.0.0.1:443)
                                          │  TLS ClientHello의 SNI로 목적지 확인
                                          │  TLS는 풀지 않고 바이트를 그대로 전달
                                          ▼
                              프록시 (HTTP CONNECT 또는 SOCKS5)
                                          ▼
                                  api.anthropic.com
```

- **TLS를 풀지 않습니다.** Claude Code는 진짜 Anthropic 서버의 인증서를 그대로 검증하므로 루트 인증서를 설치할 필요가 없습니다.
- **DNS 조회는 프록시가 합니다.** 릴레이는 목적지를 호스트 이름 그대로 넘기므로, 로컬 `/etc/hosts`가 자기 자신을 가리켜도
  되돌아오는 루프가 생기지 않습니다.
- **설정을 연결마다 읽습니다.** 프록시를 바꿔도 데몬을 재시작할 필요가 없습니다.
- **목록에 있는 호스트만 넘깁니다.** 그 밖의 연결은 끊어서, 다른 로컬 프로세스가 범용 터널로 쓸 수 없게 합니다.

### 온보딩

```
$ claude-auto-proxy onboard
Enter the proxy address (for a claude-proxy-router, use `claude-auto-proxy router onboard`).
proxy: http://proxy.example.com:3128
checking http://proxy.example.com:3128 → api.anthropic.com:443
  [1/3] reach the proxy                ok (12 ms)
  [2/3] open a tunnel to the target    ok (48 ms)
  [3/3] TLS handshake with the target  ok (95 ms)
registered: http://proxy.example.com:3128
Turn routing on now? [Y/n]
```

프록시에 TCP로 접속 → `api.anthropic.com:443` 터널 요청 → 그 터널 위에서 실제 Anthropic 서버와 TLS 핸드셰이크.
**세 단계를 모두 통과해야만 등록합니다.** 하나라도 실패하면 어느 단계에서 왜 막혔는지 보여 주고 아무것도 저장하지 않습니다.

기본으로 경유하는 호스트는 API와 로그인에 쓰는 `api.anthropic.com`, `mcp-proxy.anthropic.com`, `claude.ai`,
`claude.com`, `platform.claude.com`입니다. 플러그인 다운로드, npm, GitHub 같은 나머지 트래픽은 필요하면 `hosts add`로
추가하세요.

### Tailscale과 함께 쓰기

- **tailnet 안에 HTTP 프록시가 있으면** 그 주소를 그대로 지정합니다. 예: `set-proxy http://100.64.0.10:3128`
- **Tailscale을 userspace 모드로 돌리면** 로컬에 SOCKS5 서버가 생깁니다. `tailscaled --tun=userspace-networking --socks5-server=localhost:1055`로
  띄우고 `onboard socks5://localhost:1055`로 등록하세요.
- **이 Mac에서 도는 프록시는 루프를 조심해야 합니다.** 그 프록시가 이 Mac의 `/etc/hosts`로 이름을 조회하면 127.0.0.1을 받아
  릴레이로 되돌아옵니다. 이 경우 `on`이 hosts를 바꾼 뒤 확인하는 단계에서 실패를 감지하고 hosts를 되돌립니다.

### 켰을 때 알아 둘 점

- **실행 중인 세션은 조금 늦게 바뀝니다.** 이미 열린 연결은 끊길 때까지 그대로 쓰이고, 새 연결부터 프록시를 탑니다.
- **같은 호스트를 쓰는 다른 앱도 경유합니다.** `/etc/hosts`는 Mac 전체에 적용되므로 Claude 데스크톱 앱 같은 다른 앱도 거칩니다.
- **켠 상태에서 데몬이나 프록시가 멈추면 Claude Code가 연결하지 못합니다.** 자동으로 직접 연결로 바꾸지 않습니다. `status`로
  확인하고, 급하면 `off`로 되돌리세요. 켜진 상태에서 `set-proxy`나 `hosts`로 설정을 바꾸면 실제 경로로 다시 확인하고,
  실패하면 이전 설정으로 되돌립니다.
- **로컬의 443 포트를 씁니다.** 다른 프로그램이 이미 쓰고 있으면 데몬이 시작하지 않고, `on`은 라우팅을 켜지 않습니다.
- **TLS를 검사하는 프록시도 쓸 수 있습니다.** `status`에 "Node가 인증서를 신뢰하지 않음"이 나올 수 있지만, 그 프록시의 루트
  인증서가 키체인에 있으면 Claude Code는 정상적으로 연결합니다.

## 문제 해결

| 증상 | 확인·조치 |
|---|---|
| `router status`의 핑이 `unreachable` | 같은 tailnet인지, 라우터 Mac에서 라우터가 도는지(`claude-proxy-router status`) |
| 핑이 키 거부 | 라우터 Mac의 `claude-proxy-router key`로 키를 다시 확인하고 `router onboard`를 다시 실행 |
| `accounts: not available — … update it on the router Mac` | 라우터에 `/_router/status`가 없음. 라우터를 최신으로 업데이트 |
| 라우터를 켰는데 열려 있던 세션이 그대로 | 라우터 모드는 새 세션부터 적용. 세션을 다시 시작 |
| `router off` 뒤 Claude Code가 로그인을 요구 | 라우터 모드에서 `/logout`해 둔 상태. `/login` |
| 프록시 모드를 켠 뒤 Claude Code가 연결 못 함 | `status`로 데몬·터널 확인. 급하면 `off` |

## 보안

- **프록시 모드 데몬이 root로 하는 일은 포트 열기뿐입니다.** 루프백 443 포트는 root만 열 수 있습니다. 데몬은 root로 시작해
  포트를 연 뒤 바로 `nobody` 계정으로 내려가서, 외부에서 들어온 바이트 해석이나 프록시와의 통신은 root가 아닌 권한으로 합니다.
- **데몬이 실행하는 코드는 root 소유 복사본입니다.** npm·Homebrew 설치 디렉터리는 사용자가 쓸 수 있으므로, `install`이나
  `on` 때 코드를 `/Library/Application Support/claude-auto-proxy/app`(root 소유)에 복사해 그 복사본을 실행합니다.
- **남는 위험이 하나 있습니다.** 데몬을 시작하는 Node 실행 파일 자체는 Homebrew나 nvm 경로에 있어 사용자가 쓸 수 있습니다.
  사용자 권한으로 도는 악성 코드가 그 파일을 바꿔치기하면 데몬이 다시 시작될 때 root로 실행됩니다. `install`이 이 상황을
  감지하면 알려 줍니다. 막으려면 root 소유 경로의 Node(예: nodejs.org의 공식 pkg 설치본, `/usr/local/bin/node`)로 `install`하세요.
- **인증정보는 노출하지 않습니다.** 프록시 설정 파일은 root 소유이고 데몬 그룹만 읽을 수 있습니다(0640). 로그·`status`·오류
  메시지에서 프록시 인증정보와 라우터 키는 가려서 표시합니다.

## 파일 위치

| 경로 | 내용 |
|---|---|
| `~/Library/Application Support/claude-auto-proxy/router.json` | 라우터 모드: 라우터 주소·키와, `router off`가 되돌릴 이전 값 (0600) |
| `/Library/Application Support/claude-auto-proxy/config.json` | 프록시 모드: 프록시 URL과 호스트 목록 (root 소유, 데몬 그룹만 읽기 가능, 0640) |
| `/Library/Application Support/claude-auto-proxy/app/` | 데몬이 실행하는 root 소유 코드 복사본 |
| `/Library/LaunchDaemons/io.github.choiyounggi.claude-auto-proxy.plist` | 데몬 정의 |
| `/Library/Logs/claude-auto-proxy.log` | 데몬 로그 (프록시 인증정보는 기록하지 않음) |
| `/etc/hosts` | 표시된 관리 블록만 넣고 뺍니다. 바꾸기 직전 상태는 `/etc/hosts.claude-auto-proxy.bak`에 남깁니다 |

## 개발

```bash
npm test
```

의존성이 없습니다. 테스트는 가짜 HTTP·SOCKS5 프록시와 로컬 TLS 서버로 전체 경로를 확인하며 sudo가 필요 없습니다(릴레이
테스트에는 `openssl`이 필요합니다). 설계 근거는 [docs/DESIGN.md](docs/DESIGN.md)에 있습니다.

## 릴리즈

main에 푸시하면 CI(`.github/workflows/ci.yml`)가 테스트를 통과한 뒤 자동으로 릴리즈합니다.

1. 마지막 태그 이후 커밋 메시지(Conventional Commits)로 버전을 정합니다.
   - `feat!:`나 본문의 `BREAKING CHANGE:` → major
   - `feat:` → minor
   - 그 밖의 커밋(규칙을 따르지 않는 메시지 포함) → patch
   - `docs:`·`chore:`·`ci:`·`test:`·`style:`과 Git의 머지 커밋(`Merge pull request …`, `Merge branch …`)만 있으면 릴리즈하지 않습니다.
2. `package.json` 버전을 올려 커밋하고 `vX.Y.Z` 태그를 붙여 GitHub Release를 만듭니다.
3. npm에 배포합니다. 토큰 없이 npm의 trusted publishing(GitHub Actions OIDC)으로 인증하므로, npm의 패키지 설정에 이 저장소의
   `ci.yml`이 신뢰할 게시자로 등록돼 있어야 합니다(`npm trust github claude-auto-proxy --file ci.yml --repo choiyounggi/claude-auto-proxy --allow-publish`).
4. 태그 압축 파일의 sha256으로 `Formula/claude-auto-proxy.rb`를 갱신해 커밋합니다. `brew upgrade`가 새 버전을 받습니다.
5. 태그·GitHub Release·npm·formula 중 하나가 실패하면 그 job을 다시 실행하세요. 이미 끝난 것은 건너뛰고 빠진 단계만 실행합니다.

버전을 직접 올리고 싶으면 `package.json`의 버전을 더 큰 값으로 바꿔 푸시하세요. 계산된 값보다 크면 그 값이 쓰입니다. 릴리즈
커밋은 `github-actions[bot]`이 main에 직접 푸시하므로, main에 브랜치 보호를 걸면 이 단계가 실패합니다.
