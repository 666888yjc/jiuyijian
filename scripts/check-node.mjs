// Match the starter's supported engine before copying, installing or building.
export function checkNode(version = process.versions.node) {
  const [major, minor] = version.split('.').map(Number);
  if (major !== 22 || minor < 12) {
    throw new Error(`This starter requires Node 22.12+ in the 22.x series; current Node is ${version}. Select Node 22 for this terminal, then retry. Keep that PATH for install, dev and build.`);
  }
}
checkNode();
