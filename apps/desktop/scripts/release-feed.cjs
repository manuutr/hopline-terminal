// Both electron-builder and the main process use this build-time destination.
module.exports = function releaseFeed(env = process.env) {
  const owner = env.HOPLINE_RELEASES_OWNER?.trim() || 'manuutr'
  const repo = env.HOPLINE_RELEASES_REPO?.trim() || 'hopline-terminal'
  if (!/^[a-z0-9-]+$/i.test(owner) || !/^[a-z0-9_.-]+$/i.test(repo) || /^\.{1,2}$/.test(repo)) {
    throw new Error('HOPLINE_RELEASES_OWNER and HOPLINE_RELEASES_REPO must be GitHub names.')
  }
  return { provider: 'github', owner, repo, releaseType: 'draft' }
}
