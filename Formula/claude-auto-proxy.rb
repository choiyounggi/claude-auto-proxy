class ClaudeAutoProxy < Formula
  desc "Route Claude Code traffic on macOS through an HTTP or SOCKS5 proxy"
  homepage "https://github.com/choiyounggi/claude-auto-proxy"
  url "https://github.com/choiyounggi/claude-auto-proxy/archive/refs/tags/v0.3.0.tar.gz"
  sha256 "7af79fbd17a1892a5da91802e81614b2dd562f6cd6e198b14d2a87c5dde11cbe"
  head "https://github.com/choiyounggi/claude-auto-proxy.git", branch: "main"

  depends_on :macos
  depends_on "node"

  def install
    # No npm dependencies: the package is plain ES modules run by Homebrew's node.
    libexec.install "package.json", "bin", "src"
    (bin/"claude-auto-proxy").write_env_script libexec/"bin/claude-auto-proxy.js",
                                               PATH: "#{formula_opt_bin("node")}:$PATH"
  end

  def caveats
    <<~EOS
      Register your proxy and turn routing on:
        claude-auto-proxy onboard

      Turn it off again with:
        claude-auto-proxy off

      Before `brew uninstall`, remove the daemon and /etc/hosts entries:
        claude-auto-proxy uninstall
    EOS
  end

  test do
    assert_equal version.to_s, shell_output("#{bin}/claude-auto-proxy --version").strip
    assert_match "onboard", shell_output("#{bin}/claude-auto-proxy --help")
  end
end
