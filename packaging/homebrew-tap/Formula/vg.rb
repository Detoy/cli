# Homebrew formula for vg (the @vibgrate/cli package).
# The release pipeline stamps url version + sha256 from the npm tarball.
class Vg < Formula
  desc "Deterministic, no-API-key code graph for AI assistants (vg)"
  homepage "https://vibgrate.com"
  url "https://registry.npmjs.org/@vibgrate/cli/-/cli-2026.1005.1.tgz"
  sha256 "77741fde781161e31f56398de5d22af81de9753875137839650ac4d6f68a31a4"
  license "Apache-2.0"
  depends_on "node"

  def install
    # Install from the tarball Homebrew already downloaded and checksum-verified
    # (staged into buildpath) — never a second, unverified registry fetch.
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/vg"]
    bin.install_symlink Dir["#{libexec}/bin/vibgrate"]
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/vg --version")
  end
end
