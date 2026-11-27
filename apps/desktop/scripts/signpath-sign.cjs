// Windows signing through SignPath (decision D6, docs/SIGNING.md), as electron-builder's custom
// sign hook: called for every file it signs (hopline.exe, the uninstaller, the installer), before
// latest.yml is written, so the update feed's sha512 matches the signed installer.
//
// Only used when electron-builder.config.cjs finds SIGNPATH_API_TOKEN, SIGNPATH_ORGANIZATION_ID,
// SIGNPATH_PROJECT_SLUG and SIGNPATH_POLICY_SLUG. Optional: SIGNPATH_ARTIFACT_CONFIGURATION_SLUG,
// SIGNPATH_API_URL (default https://app.signpath.io/API/v1).
//
// SignPath REST API: submit the file, poll the signing request, download the signed file over it.
const { readFile, writeFile } = require('node:fs/promises')
const { basename } = require('node:path')

const POLL_MS = 5000
const TIMEOUT_MS = 15 * 60 * 1000

/**
 * The bearer token only goes back to the API's own origin (review L9): a status `location` or a
 * `signedArtifactLink` that points anywhere else is refused, not followed with the token.
 */
function sameOrigin(api, url, what) {
  let u
  try {
    u = new URL(url, api)
  } catch {
    throw new Error(`SignPath returned an invalid ${what}`)
  }
  if (u.origin !== new URL(api).origin) throw new Error(`SignPath ${what} points to ${u.origin}, not ${new URL(api).origin}: refusing to send the API token there`)
  return u.href
}

async function sign(configuration) {
  const file = configuration.path
  const api = (process.env.SIGNPATH_API_URL || 'https://app.signpath.io/API/v1').replace(/\/+$/, '')
  if (new URL(api).protocol !== 'https:') throw new Error('SignPath requires an HTTPS API URL.')
  const org = process.env.SIGNPATH_ORGANIZATION_ID
  const auth = { Authorization: `Bearer ${process.env.SIGNPATH_API_TOKEN}` }
  const form = new FormData()
  form.append('ProjectSlug', process.env.SIGNPATH_PROJECT_SLUG)
  form.append('SigningPolicySlug', process.env.SIGNPATH_POLICY_SLUG)
  if (process.env.SIGNPATH_ARTIFACT_CONFIGURATION_SLUG) form.append('ArtifactConfigurationSlug', process.env.SIGNPATH_ARTIFACT_CONFIGURATION_SLUG)
  form.append('Description', `Hopline ${process.env.GITHUB_REF_NAME || 'local'}: ${basename(file)}`)
  form.append('Artifact', new Blob([await readFile(file)]), basename(file))

  const submit = await fetch(`${api}/${org}/SigningRequests`, { method: 'POST', headers: auth, body: form, redirect: 'error' })
  if (submit.status !== 201) throw new Error(`SignPath refused ${basename(file)}: HTTP ${submit.status} ${(await submit.text()).slice(0, 300)}`)
  const rawLocation = submit.headers.get('location')
  if (!rawLocation) throw new Error('SignPath answered without a signing request location')
  const location = sameOrigin(api, rawLocation, 'signing request location')

  const started = Date.now()
  for (;;) {
    await new Promise((r) => setTimeout(r, POLL_MS))
    const r = await fetch(location, { headers: auth, redirect: 'error' })
    if (!r.ok) throw new Error(`SignPath status for ${basename(file)}: HTTP ${r.status}`)
    const s = await r.json()
    if (s.status === 'Completed') {
      const signed = await fetch(sameOrigin(api, s.signedArtifactLink, 'signed artifact link'), { headers: auth, redirect: 'error' })
      if (!signed.ok) throw new Error(`SignPath download for ${basename(file)}: HTTP ${signed.status}`)
      await writeFile(file, Buffer.from(await signed.arrayBuffer()))
      console.log(`  • signed by SignPath  file=${basename(file)}`)
      return
    }
    if (['Failed', 'Denied', 'Canceled'].includes(s.status)) throw new Error(`SignPath ${s.status.toLowerCase()} ${basename(file)} (${s.statusDetails || 'no details'})`)
    if (Date.now() - started > TIMEOUT_MS) throw new Error(`SignPath did not sign ${basename(file)} within 15 minutes (status ${s.status}; a manual approval may be pending)`)
  }
}
module.exports = sign
module.exports.sameOrigin = sameOrigin
