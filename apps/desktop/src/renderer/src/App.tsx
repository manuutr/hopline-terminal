import { WorkspaceTour } from './features/onboarding/WorkspaceTour'
import { WorkspaceTools } from './features/workspace/WorkspaceTools'
import { lazy, Suspense, useEffect, useState } from 'react'
import { AppShell } from './features/layout/AppShell'
import { DesignPreview } from './design/DesignPreview'
import { applyMotion, applyTheme } from './design/theme'
import { syncTabState, useUi } from './store'
import { wireVitals } from './features/terminal/liveness'
import { wireTerminalEvents } from './lib/terminals'
import { openSession } from './lib/connect'
import { wireAgentEvents } from './features/ai/store'
import { PromptDialog } from './features/prompts/PromptDialog'
import { KnownHostsDialog } from './features/knownhosts/KnownHostsDialog'
import { FindAll } from './features/terminal/FindAll'
import { UnlockDialog, VaultSetupDialog, wireVault } from './features/vault/UnlockDialog'
import { KeychainBrokenDialog } from './features/vault/KeychainBrokenDialog'
import { ImportReviewDialog, wireSync } from './features/settings/DataPanel'
import { ImportWizard } from './features/import/ImportWizard'
import { refreshNetBoxSource } from './features/import/store'
import { SetPlatformDialog, wirePlatformEvents } from './features/sessions/PlatformDetect'
import { BackupsDialog } from './features/backups/BackupsDialog'
import { wireBackups } from './features/backups/store'
import { EgressDialog } from './features/trust/EgressDialog'
import { PolicyBanner } from './features/trust/Managed'
import { useTrust } from './features/trust/store'
import { openSettings } from './lib/settings-nav'
import { wireOnboarding } from './features/onboarding/store'
import { wireSerialLines } from './features/terminal/serial-lines'
import { useOverrides } from './features/overrides/store'
import { useThemes } from './features/themes/store'
import { FirstRunPrivacy } from './features/privacy/PrivacyScreen'
import { wirePrivacy } from './features/privacy/store'
import { wireMenu } from './features/menu/model'
import { AboutDialog } from './features/menu/AboutDialog'

import { usePackets } from './features/packets/store'

const PacketsDialog = lazy(() => import('./features/packets/PacketsDialog').then((m) => ({ default: m.PacketsDialog })))

export function App(): React.JSX.Element {
  const packetsOpen = usePackets((s) => s.open)
  const [hash, setHash] = useState(location.hash)
  useEffect(() => {
    const on = () => setHash(location.hash)
    window.addEventListener('hashchange', on)
    wireTerminalEvents(syncTabState)
    const offVitals = wireVitals()
    wireAgentEvents()
    wirePlatformEvents()
    wireBackups()
    void useTrust.getState().loadPolicy()
    wireOnboarding()
    wireSerialLines()
    void useOverrides.getState().load()
    void useThemes.getState().load()
    // hopline://settings/<section>/<key> (validated in main against the registry).
    // A link only navigates: it never focuses a control (openSettings › via: 'link').
    const offLink = window.hopline.ux.onDeepLink((link) => openSettings(link.key ? `${link.section}/${link.key}` : link.section, { via: 'link' }))
    const offVault = wireVault()
    const offSync = wireSync()
    const offPrivacy = wirePrivacy()
    const offMenu = wireMenu()
    const offPackets = window.hopline.packets.onStage((stage, canFinish) => usePackets.setState({ stage, canFinish }))
    void refreshNetBoxSource()
    void useUi
      .getState()
      .load()
      .then(() => {
        const s = useUi.getState().settings
        if (s) {
          applyMotion(s.reduceMotion)
          applyTheme(s.theme, false)
        }
        // Startup benchmark (bench/): the first frame with sessions and settings loaded.
        requestAnimationFrame(() => performance.mark('hopline:ready'))
        // Deep link: #/open/<session name> opens a tab (used by dev screenshots and future CLI launch).
        const m = /^#\/open\/(.+)$/.exec(location.hash)
        if (m) {
          const target = useUi.getState().sessions.find((x) => x.name === decodeURIComponent(m[1]!))
          if (target) openSession(target)
          history.replaceState(null, '', location.pathname)
          setHash('')
        }
        if (location.hash === '#/audit' || location.hash.startsWith('#/settings')) {
          if (location.hash === '#/audit') useUi.getState().set({ auditOpen: true })
          // #/settings or #/settings/<section>/<key>, like hopline://settings/… (dev screenshots).
          else openSettings(location.hash.slice('#/settings/'.length) || undefined)
          history.replaceState(null, '', location.pathname)
          setHash('')
        }
      })
    return () => {
      window.removeEventListener('hashchange', on)
      offVault()
      offSync()
      offVitals()
      offLink()
      offPrivacy()
      offMenu()
      offPackets()
    }
  }, [])

  if (hash === '#/design') return <DesignPreview />
  return (
    <>
      <PolicyBanner />
      <AppShell />
      <PromptDialog />
      <KnownHostsDialog />
      <FindAll />
      <UnlockDialog />
      <VaultSetupDialog />
      <KeychainBrokenDialog />
      <ImportReviewDialog />
      <ImportWizard />
      <SetPlatformDialog />
      <BackupsDialog />
      <EgressDialog />
      <FirstRunPrivacy />
      <AboutDialog />
      <WorkspaceTools />
      <WorkspaceTour />
      {packetsOpen && <Suspense fallback={null}><PacketsDialog /></Suspense>}
    </>
  )
}
