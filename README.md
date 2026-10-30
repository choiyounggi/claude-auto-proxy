# claude-auto-proxy

macOS에서 Claude Code의 연결을 HTTP·SOCKS5 프록시로 돌려 주는 도구입니다. 명령 하나로 켜고 끄며, 새 세션뿐 아니라 **이미 실행 중인 세션도** 다시 시작할 필요 없이 바로 프록시를 타게 됩니다.

```
claude-auto-proxy onboard      # 프록시 주소 입력 → 연결 확인 → 등록 → 켜기
claude-auto-proxy off
claude-auto-proxy on
```

## 왜 환경변수가 아닌가

Claude Code는 `HTTPS_PROXY`를 지원하지만 두 가지가 부족합니다.

- **실행 중인 세션에는 적용되지 않습니다.** 셸 환경변수는 시작할 때 한 번만 읽습니다.
- **SOCKS 프록시를 쓸 수 없습니다.** HTTP 프록시만 지원합니다. ([Claude Code 네트워크 설정 문서](https://code.claude.com/docs/en/network-config))

claude-auto-proxy는 프로세스 환경 대신 연결 경로를 바꿉니다. 그래서 어떤 세션이든, 그리고 SOCKS5 프록시로도 동작합니다.

## 동작 방식

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

- **TLS를 풀지 않습니다.** Claude Code는 진짜 Anthropic 서버의 인증서를 그대로 검증하므로 루트 인증서를 따로 설치할 필요가 없습니다.
- **DNS 조회는 프록시가 합니다.** 릴레이는 목적지를 호스트 이름 그대로 넘깁니다. 로컬 `/etc/hosts`가 자기 자신을 가리키게 돼 있어도 되돌아오는 루프가 생기지 않습니다.
- **설정을 연결마다 읽습니다.** 프록시를 바꿔도 데몬을 재시작할 필요가 없습니다.
- **목록에 있는 호스트만 넘깁니다.** 그 밖의 연결은 끊어서, 다른 로컬 프로세스가 범용 터널로 쓸 수 없게 합니다.

## 설치

Node.js 20 이상이 필요하고 macOS 전용입니다.

### Homebrew

```bash
brew tap choiyounggi/claude-auto-proxy https://github.com/choiyounggi/claude-auto-proxy
brew install claude-auto-proxy
```

### npm

```bash
npm install -g github:choiyounggi/claude-auto-proxy
```

> nvm 같은 버전 관리자로 설치한 Node를 쓰면, 그 Node 버전을 지웠을 때 데몬도 멈춥니다. Node를 바꾼 뒤에는 `claude-auto-proxy install`을 다시 실행하세요. Homebrew로 설치하면 이 문제가 없습니다.

## 시작하기 (온보딩)

```
$ claude-auto-proxy onboard
Enter the proxy router address.
proxy: http://proxy.example.com:3128
checking http://proxy.example.com:3128 → api.anthropic.com:443
  [1/3] reach the proxy                ok (12 ms)
  [2/3] open a tunnel to the target    ok (48 ms)
  [3/3] TLS handshake with the target  ok (95 ms)
registered: http://proxy.example.com:3128
Turn routing on now? [Y/n]
```

등록하기 전에 프록시와 세 번 주고받으며 실제로 연결되는지 확인합니다.

1. 프록시에 TCP로 접속합니다.
2. 프록시에 `api.anthropic.com:443` 터널을 열어 달라고 요청합니다.
3. 그 터널 위에서 실제 Anthropic 서버와 TLS 핸드셰이크를 합니다.

**세 단계를 모두 통과해야만 등록합니다.** 하나라도 실패하면 어느 단계에서 왜 막혔는지 보여 주고, 아무것도 저장하지 않습니다. 주소에 스킴을 빼고 `host:port`만 넣으면 HTTP 프록시로 봅니다. 스크립트에서는 `claude-auto-proxy onboard <url> --on`처럼 묻지 않고 실행할 수 있습니다.

## 사용법

시스템을 바꾸는 명령은 실행하면 sudo 비밀번호를 묻습니다. 명령 앞에 `sudo`를 붙이지 않아도 됩니다.

| 명령 | 하는 일 |
|---|---|
| `onboard [url] [--on]` | 주소를 묻고, 연결을 확인하고, 통과하면 등록한 뒤 켤지 묻습니다 |
| `set-proxy <url>` | 같은 연결 확인을 거쳐 프록시를 등록합니다. `http://[user:pass@]host:port`, `https://…`, `socks5://host:port` |
| `on` | 데몬이 없으면 설치하고, 터널이 열리는지 확인하고, hosts를 바꾼 뒤 실제 경로로 한 번 더 확인합니다. 두 번째 확인에 실패하면 hosts를 되돌립니다 |
| `off` | 라우팅을 끕니다. Claude Code가 다시 직접 연결합니다 |
| `status` | 켜짐 여부, 데몬 상태, 터널 상태를 보여 줍니다. sudo 없이 실행됩니다(프록시 주소는 sudo로 실행할 때만 보입니다) |
| `hosts` / `hosts add <host>` / `hosts remove <host>` / `hosts reset` | 경유할 호스트 목록을 관리합니다 |
| `install` | 데몬을 다시 설치합니다 (Node를 바꾼 뒤 등) |
| `uninstall [--purge]` | 라우팅을 끄고 데몬을 지웁니다. `--purge`를 붙이면 설정 파일까지 지웁니다 |

기본으로 경유하는 호스트는 API와 로그인에 쓰는 `api.anthropic.com`, `mcp-proxy.anthropic.com`, `claude.ai`, `claude.com`, `platform.claude.com`입니다. 플러그인 다운로드, npm, GitHub 같은 나머지 트래픽은 필요하면 `hosts add`로 추가하세요.

### Tailscale과 함께 쓰기

- **tailnet 안에 HTTP 프록시가 있으면** 그 주소를 그대로 지정합니다. 예: `set-proxy http://100.64.0.10:3128`
- **Tailscale을 userspace 모드로 돌리면** 로컬에 SOCKS5 서버가 생깁니다. `tailscaled --tun=userspace-networking --socks5-server=localhost:1055`로 띄우고 `onboard socks5://localhost:1055`로 등록하세요.
- **이 맥에서 도는 프록시는 루프를 조심해야 합니다.** 그 프록시가 이 맥의 `/etc/hosts`로 이름을 조회하면 127.0.0.1을 받아 릴레이로 되돌아옵니다. 이 경우 `on`이 hosts를 바꾼 뒤 확인하는 단계에서 실패를 감지하고 hosts를 되돌립니다. tailscaled가 이름을 어떻게 조회하는지는 확인하지 못했으니, 켠 뒤 `status`로 확인하세요.

## 켰을 때 알아 둘 점

- **실행 중인 세션은 조금 늦게 바뀝니다.** 이미 열려 있는 연결은 끊길 때까지 그대로 쓰이고, 새로 맺는 연결부터 프록시를 탑니다. 보통 수십 초 안에 바뀝니다.
- **같은 호스트를 쓰는 다른 앱도 경유합니다.** `/etc/hosts`는 맥 전체에 적용되므로 Claude 데스크톱 앱 같은 다른 앱도 이 호스트에 접속하면 프록시를 거칩니다.
- **켠 상태에서 데몬이나 프록시가 멈추면 Claude Code가 연결하지 못합니다.** 프록시 경유가 목적이므로 자동으로 직접 연결로 바꾸지 않습니다. `status`로 상태를 확인하고, 급하면 `off`로 바로 되돌리세요. 켜진 상태에서 `set-proxy`나 `hosts`로 설정을 바꾸면 실제 경로로 다시 확인하고, 실패하면 이전 설정으로 되돌립니다.
- **로컬의 443 포트를 씁니다.** 다른 프로그램이 이미 쓰고 있으면 데몬이 시작하지 않고, `on`은 라우팅을 켜지 않습니다.
- **TLS를 검사하는 프록시도 쓸 수 있습니다.** 이 경우 `status`에 "Node가 인증서를 신뢰하지 않음"이 나올 수 있습니다. 그 프록시의 루트 인증서가 키체인에 있으면 Claude Code는 정상적으로 연결합니다.

## 보안

- **데몬이 root로 하는 일은 포트 열기뿐입니다.** 루프백 주소의 443 포트는 root만 열 수 있습니다. 데몬은 root로 시작해 포트를 연 뒤 바로 `nobody` 계정으로 내려가서, 외부에서 들어온 바이트 해석이나 프록시와의 통신은 root가 아닌 권한으로 합니다.
- **데몬이 실행하는 코드는 root 소유 복사본입니다.** npm·Homebrew 설치 디렉터리는 사용자가 쓸 수 있으므로, `install`이나 `on` 때 코드를 `/Library/Application Support/claude-auto-proxy/app`(root 소유)에 복사해 그 복사본을 실행합니다. 버전이 바뀌면 다시 복사합니다.
- **남는 위험이 하나 있습니다.** 데몬을 시작하는 Node 실행 파일 자체는 Homebrew나 nvm 경로에 있어 사용자가 쓸 수 있습니다. 사용자 권한으로 도는 악성 코드가 그 파일을 바꿔치기하면, 데몬이 다시 시작될 때 root로 실행됩니다. `install`이 이 상황을 감지하면 알려 줍니다. 막으려면 root 소유 경로의 Node(예: nodejs.org의 공식 pkg 설치본, `/usr/local/bin/node`)로 `install`하세요.
- **프록시 인증정보는 노출하지 않습니다.** 설정 파일은 root 소유이고 데몬 그룹만 읽을 수 있습니다(0640). 로그·`status`·오류 메시지에는 `***`로 가려서 표시합니다.

## 파일 위치

| 경로 | 내용 |
|---|---|
| `/Library/Application Support/claude-auto-proxy/config.json` | 프록시 URL과 호스트 목록 (root 소유, 데몬 그룹만 읽기 가능, 0640) |
| `/Library/Application Support/claude-auto-proxy/app/` | 데몬이 실행하는 root 소유 코드 복사본 |
| `/Library/LaunchDaemons/io.github.choiyounggi.claude-auto-proxy.plist` | 데몬 정의 |
| `/Library/Logs/claude-auto-proxy.log` | 데몬 로그 (프록시 인증정보는 기록하지 않음) |
| `/etc/hosts` | 표시된 관리 블록만 넣고 뺍니다. 바꾸기 직전 상태는 `/etc/hosts.claude-auto-proxy.bak`에 남깁니다 |

## 개발

```bash
npm test
```

의존성이 없습니다. 테스트는 가짜 HTTP·SOCKS5 프록시와 로컬 TLS 서버로 전체 경로를 확인하며 sudo가 필요 없습니다(릴레이 테스트에는 `openssl`이 필요합니다). 설계 근거는 [docs/DESIGN.md](docs/DESIGN.md)에 있습니다.

## 릴리즈

main에 푸시하면 CI(`.github/workflows/ci.yml`)가 테스트를 통과한 뒤 자동으로 릴리즈합니다.

1. 마지막 태그 이후 커밋 메시지(Conventional Commits)로 버전을 정합니다.
   - `feat!:`나 본문의 `BREAKING CHANGE:` → major
   - `feat:` → minor
   - 그 밖의 커밋(규칙을 따르지 않는 메시지 포함) → patch
   - `docs:`·`chore:`·`ci:`·`test:`·`style:`만 있으면 릴리즈하지 않습니다.
2. `package.json` 버전을 올려 커밋하고 `vX.Y.Z` 태그를 붙여 GitHub Release를 만듭니다.
3. 태그 압축 파일의 sha256으로 `Formula/claude-auto-proxy.rb`를 갱신해 커밋합니다. `brew upgrade`가 새 버전을 받습니다.
4. 저장소 시크릿 `NPM_TOKEN`이 있으면 npm에도 배포합니다.

버전을 직접 올리고 싶으면 `package.json`의 버전을 더 큰 값으로 바꿔 푸시하세요. 계산된 값보다 크면 그 값이 쓰입니다. 릴리즈 커밋은 `github-actions[bot]`이 main에 직접 푸시하므로, main에 브랜치 보호를 걸면 이 단계가 실패합니다.
