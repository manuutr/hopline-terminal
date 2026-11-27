import { Menu as MenuIcon } from 'lucide-react'
import { Menubar as MB } from 'radix-ui'
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { mnemonicOf } from '@shared/menu'
import { cn } from '../../design'
import { MenuCheck, MenuChevron, MenuShortcut, MenuText, menuContent, menuItem, menuSeparator } from '../../design/Menu'
import { runAction, useActionsVersion } from '../../lib/actions'
import { modalOpen } from '../../lib/keys'
import { terminals } from '../../lib/terminals'
import { useUi } from '../../store'
import { holdEditTarget } from './actions'
import { itemState, resolveMenu, type UiMenu, type UiNode } from './model'

function followHighlight(event: React.FocusEvent<HTMLElement>) {
  const item = event.target.closest<HTMLElement>('[role^="menuitem"]')
  if (!item || item.closest('[role="menu"]') !== event.currentTarget) return
  event.currentTarget.style.setProperty('--highlight-y', item.offsetTop + 'px')
  event.currentTarget.style.setProperty('--highlight-height', item.offsetHeight + 'px')
}

/** At this window width and up the menus are inline (File Edit View …); below, one ≡ button. */
export const INLINE_MENUS_MIN_WIDTH = 1280

const dev = (): boolean => import.meta.env.DEV || !!window.hopline?.testMode

/** Group runs of radio items so each run is one radio group (Theme, the Window menu's tabs). */
function groups(items: UiNode[]): (UiNode | UiNode[])[] {
  const out: (UiNode | UiNode[])[] = []
  for (const n of items) {
    const radio = n.type === 'item' && n.kind === 'radio'
    const last = out.at(-1)
    if (radio && Array.isArray(last)) last.push(n)
    else out.push(radio ? [n] : n)
  }
  return out
}

/**
 * The in-app menu bar for Windows and Linux (macOS uses the native one). Radix Menubar gives the
 * menubar / menu / menuitem roles, arrow keys, Enter, Esc and type-ahead; on top of that:
 *
 * - **Alt tap** (press and release Alt alone) focuses the bar, as on Windows, and shows the `&`
 *   mnemonics. Alt+letter chords are never taken: they are the device's word motion (Esc-B, Esc-F).
 *   A letter is a mnemonic only once the bar or an open menu has the keyboard.
 * - **Focus goes back** to where it was (the terminal, a field) when the bar closes, and an Edit
 *   command acts on that element, not on the menu.
 * - Commands run through `runAction`, the same gate as a key press.
 */
export function MenuBar({ compact }: { compact: boolean }): React.JSX.Element {
  useActionsVersion()
  // Re-read the tree whenever the app state moves (enabled and checked states), cheap and local.
  useUi((s) => s.workspaces)
  const [value, setValue] = useState('')
  const [mnemonics, setMnemonics] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const opener = useRef<Element | null>(null)
  const keepBar = useRef(false)
  const valueRef = useRef(value)
  useLayoutEffect(() => {
    valueRef.current = value
  }, [value])
  const menus = resolveMenu(false, dev())
  const palette = compact ? itemState('palette.open') : undefined

  const restore = () => {
    const el = opener.current as HTMLElement | null
    opener.current = null
    setMnemonics(false)
    // Someone already moved the keyboard (a click elsewhere while the menu faded out): leave it there.
    const now = document.activeElement
    if (now && now !== document.body && !root.current?.contains(now) && !now.closest('[data-menu-content]')) {
      setTimeout(() => {
        if (!opener.current) holdEditTarget(null)
      }, 0)
      return
    }
    if (el?.isConnected && el !== document.body && !root.current?.contains(el)) el.focus({ preventScroll: true })
    else {
      const id = useUi.getState().activeTabId
      const t = id ? terminals.get(id) : undefined
      if (t) t.focus()
      else document.querySelector<HTMLElement>('[data-launcher] input, #session-search')?.focus()
    }
    // After any command scheduled for this close has read it, unless a menu opened again since
    // (that one holds its own target).
    setTimeout(() => {
      if (!opener.current) holdEditTarget(null)
    }, 0)
  }

  /** Remember where the keyboard was, before the bar takes it. */
  const capture = () => {
    const a = document.activeElement
    if (!opener.current && a && !root.current?.contains(a) && !a.closest('[data-menu-content]')) {
      opener.current = a
      holdEditTarget(a)
    }
  }

  const run = (id: string, arg?: string) => {
    // The menu closes first and gives focus back; the command runs after, on that element.
    setTimeout(() => runAction(id, arg), 0)
  }

  // Alt tap: Alt pressed and released with nothing in between focuses the bar (or leaves it).
  useEffect(() => {
    let armed = false
    const down = (e: KeyboardEvent) => {
      armed = e.key === 'Alt' && !e.repeat && !e.ctrlKey && !e.shiftKey && !e.metaKey && !e.getModifierState?.('AltGraph')
    }
    const up = (e: KeyboardEvent) => {
      if (e.key !== 'Alt' || !armed) return
      armed = false
      if (modalOpen() || valueRef.current) return
      e.preventDefault()
      if (root.current?.contains(document.activeElement)) return restore()
      capture()
      setMnemonics(true)
      root.current?.querySelector<HTMLElement>('[role=menuitem]')?.focus()
    }
    const disarm = () => (armed = false)
    window.addEventListener('keydown', down, true)
    window.addEventListener('keyup', up, true)
    window.addEventListener('pointerdown', disarm, true)
    window.addEventListener('blur', disarm)
    return () => {
      window.removeEventListener('keydown', down, true)
      window.removeEventListener('keyup', up, true)
      window.removeEventListener('pointerdown', disarm, true)
      window.removeEventListener('blur', disarm)
    }
  })

  /** A letter in an open menu: the item with that mnemonic (one: run it; several: move between them). */
  const onContentKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') keepBar.current = true
    if (e.key.length !== 1 || e.ctrlKey || e.altKey || e.metaKey || !/[\p{L}\p{N}]/u.test(e.key)) return
    const k = e.key.toLowerCase()
    const hits = [...e.currentTarget.querySelectorAll<HTMLElement>(`[data-mnemonic="${CSS.escape(k)}"]:not([data-disabled])`)]
    if (!hits.length) return
    e.preventDefault()
    e.stopPropagation()
    if (hits.length === 1) hits[0]!.click()
    else hits[(hits.indexOf(document.activeElement as HTMLElement) + 1) % hits.length]!.focus()
  }

  /** The bar has the keyboard, no menu open: a letter opens its menu, Esc goes back. */
  const onBarKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (valueRef.current) return
    if (e.key === 'Escape') {
      e.preventDefault()
      return restore()
    }
    if (e.key.length !== 1 || e.ctrlKey || e.altKey || e.metaKey || compact) return
    const m = menus.find((x) => mnemonicOf(x.label) === e.key.toLowerCase())
    if (m) {
      e.preventDefault()
      setMnemonics(true)
      setValue(m.id)
    }
  }

  const closeFocus = (e: Event) => {
    e.preventDefault()
    // Esc in a menu leaves the keyboard on its title (Windows); anything else gives it back.
    if (keepBar.current) {
      keepBar.current = false
      return
    }
    // Only when no menu opened meanwhile (a click on the next title right after Esc).
    setTimeout(() => {
      if (!valueRef.current && !document.querySelector('[data-menu-content][data-state=open]')) restore()
    }, 0)
  }

  const item = (n: UiNode, key: string | number, inRadio = false): React.ReactNode => {
    if (n.type === 'separator') return <MB.Separator key={key} className={menuSeparator} />
    if (n.type === 'submenu')
      return (
        <MB.Sub key={key}>
          <MB.SubTrigger className={menuItem} data-mnemonic={mnemonicOf(n.label)} textValue={n.label.replace(/&/g, '')}>
            <MenuText label={n.label} mnemonics={mnemonics} />
            <MenuChevron />
          </MB.SubTrigger>
          <MB.Portal>
            <MB.SubContent onFocusCapture={followHighlight} data-menu-content="" className={menuContent} sideOffset={2} alignOffset={-4} onKeyDown={onContentKey}>
              {body(n.items)}
            </MB.SubContent>
          </MB.Portal>
        </MB.Sub>
      )
    const common = {
      className: menuItem,
      disabled: !n.enabled,
      'data-command': n.id,
      ...(n.arg ? { 'data-arg': n.arg } : {}),
      'data-mnemonic': mnemonicOf(n.label),
      textValue: n.label.replace(/&(&?)/g, '$1'),
      onSelect: () => run(n.id, n.arg)
    }
    const inner = (
      <>
        <MenuCheck on={!!n.checked} />
        <MenuText label={n.label} mnemonics={mnemonics} />
        <MenuShortcut keys={n.keys} />
      </>
    )
    if (n.kind === 'radio' && inRadio)
      return (
        <MB.RadioItem key={key} value={`${n.id}:${n.arg ?? ''}`} {...common}>
          {inner}
        </MB.RadioItem>
      )
    if (n.kind === 'checkbox')
      return (
        <MB.CheckboxItem key={key} checked={!!n.checked} {...common}>
          {inner}
        </MB.CheckboxItem>
      )
    return (
      <MB.Item key={key} {...common}>
        {inner}
      </MB.Item>
    )
  }

  const body = (items: UiNode[]) =>
    groups(items).map((g, i) =>
      Array.isArray(g) ? (
        <MB.RadioGroup key={i} value={(() => {
          const on = g.find((x) => x.type === 'item' && x.checked)
          return on && on.type === 'item' ? `${on.id}:${on.arg ?? ''}` : ''
        })()}>
          {g.map((n, j) => item(n, j, true))}
        </MB.RadioGroup>
      ) : (
        item(g, i)
      )
    )

  const trigger = 'flex h-7 cursor-default select-none items-center rounded px-2 text-sm text-fg-muted outline-none hover:bg-hover hover:text-fg focus-visible:bg-hover focus-visible:text-fg data-[state=open]:bg-hover data-[state=open]:text-fg'
  const content = (m: UiMenu | null, items: UiNode[]) => (
    <MB.Portal>
      <MB.Content onFocusCapture={followHighlight} data-menu-content="" data-menu={m?.id ?? 'app'} className={menuContent} align="start" sideOffset={2} onKeyDown={onContentKey} onCloseAutoFocus={closeFocus}>
        {body(items)}
      </MB.Content>
    </MB.Portal>
  )

  return (
    <MB.Root
      ref={root}
      value={value}
      onValueChange={(v) => {
        if (v) capture()
        setValue(v)
      }}
      onKeyDown={onBarKey}
      onBlur={(e) => {
        // The keyboard left the bar without opening a menu (Tab, a click elsewhere): drop the mnemonics.
        if (!valueRef.current && !root.current?.contains(e.relatedTarget as Node | null) && !(e.relatedTarget as Element | null)?.closest?.('[data-menu-content]')) {
          setMnemonics(false)
          opener.current = null
          holdEditTarget(null)
        }
      }}
      loop
      aria-label="Application menu"
      data-menubar=""
      data-compact={compact || undefined}
      className="flex h-full shrink-0 items-center gap-px pl-1.5 pr-1 [-webkit-app-region:no-drag]"
    >
      {compact ? (
        <MB.Menu value="app">
          <MB.Trigger className={cn(trigger, 'gap-1.5')} aria-label="Application menu" data-menu-id="app">
            <MenuIcon aria-hidden className="size-4" />
            Menu
          </MB.Trigger>
          {content(
            null,
            [
              ...(palette ? [{ type: 'item' as const, ...palette, id: 'palette.open', label: 'Find a command…' }, { type: 'separator' as const }] : []),
              ...menus.map((m): UiNode => ({ type: 'submenu', label: m.label, items: m.items }))
            ]
          )}
        </MB.Menu>
      ) : (
        menus.map((m) => (
          <Fragment key={m.id}>
            <MB.Menu value={m.id}>
              <MB.Trigger className={trigger} data-menu-id={m.id}>
                <MenuText label={m.label} mnemonics={mnemonics} />
              </MB.Trigger>
              {content(m, m.items)}
            </MB.Menu>
          </Fragment>
        ))
      )}
    </MB.Root>
  )
}
