import { Braces, PanelTop } from 'lucide-react'
import { registerActions } from '../../lib/actions'
import { setPaletteStart } from '../../lib/palette-mode'
import { useUi } from '../../store'
import { useSnippets } from './store'

let installed = false
export function installSnippetActions(): void {
  if (installed) return
  installed = true
  registerActions([
    {
      id: 'snippets.manage',
      title: 'Snippets…',
      category: 'Automation',
      icon: Braces,
      keywords: 'snippet button bar macro commands variables',
      run: () => useSnippets.setState({ editor: { open: true, id: useSnippets.getState().list[0]?.id ?? 'new' } })
    },
    {
      id: 'snippets.run',
      title: 'Run a snippet…',
      category: 'Automation',
      icon: Braces,
      keywords: 'snippet insert',
      when: () => !!useUi.getState().activeTabId,
      run: () => {
        setPaletteStart('!')
        useUi.getState().set({ paletteOpen: true })
      }
    },
    {
      id: 'view.buttonBar',
      title: () => {
        const s = useSnippets.getState()
        const shown = s.barVisible ?? s.list.some((x) => x.onBar)
        return shown ? 'Hide the button bar' : 'Show the button bar'
      },
      category: 'View',
      icon: PanelTop,
      keywords: 'buttons toolbar snippets',
      run: () => {
        const s = useSnippets.getState()
        s.setBar(!(s.barVisible ?? s.list.some((x) => x.onBar)))
      }
    }
  ])
}
