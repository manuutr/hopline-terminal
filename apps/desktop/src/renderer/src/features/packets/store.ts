import { create } from 'zustand'
import type { CaptureSource, PacketView } from '@shared/packets'
import { errorText } from '../../lib/errors'

interface State {
  open: boolean
  acquire: boolean
  busy: boolean
  stage: string
  error: string
  view: PacketView | null
  chat: boolean
  chatTurns: { id: string; question: string; answer: string }[]
  canFinish?: boolean
  selectedFrame?: number
  answer: string
}
export const usePackets = create<State>(() => ({ open: false, acquire: true, busy: false, stage: '', error: '', view: null, answer: '', chat: false, chatTurns: [] }))
export const showPackets = () => usePackets.setState({ open: true })

export async function packetTask(stage: string, fn: () => Promise<void>) {
  if (usePackets.getState().busy) return
  usePackets.setState({ busy: true, stage, error: '' })
  try { await fn() }
  catch (e) { usePackets.setState({ error: errorText(e) }) }
  finally { usePackets.setState({ busy: false, stage: '', canFinish: false }) }
}

export function openTrace(source: CaptureSource) {
  showPackets()
  return loadTrace(() => window.hopline.packets.open(source), false)
}

export function attachCapture(file?: File) {
  if (usePackets.getState().busy) return
  const wasChat = usePackets.getState().chat
  usePackets.setState({ chat: true })
  return loadTrace(() => file ? window.hopline.packets.openDropped(file) : window.hopline.packets.open({ kind: 'file' }), true, wasChat)
}

function loadTrace(read: () => Promise<PacketView | null>, chat: boolean, wasChat = false) {
  return packetTask('Opening capture…', async () => {
    const view = await read()
    if (view) usePackets.setState({ view, acquire: false, chat, chatTurns: [], selectedFrame: view.rows[0]?.frame, answer: '' })
    else if (chat) usePackets.setState({ chat: wasChat })
  })
}

export function detachCapture() {
  return packetTask('Removing attachment…', async () => {
    await window.hopline.packets.close()
    usePackets.setState({ chat: false, view: null, acquire: true, chatTurns: [], answer: '', selectedFrame: undefined })
  })
}

export function inspect(view: PacketView, filter: string, page = 0) {
  return packetTask('Filtering frames…', async () => {
    const next = await window.hopline.packets.view({ id: view.id, filter: filter.trim(), page })
    usePackets.setState({ view: next, selectedFrame: next.rows[0]?.frame, answer: '' })
  })
}
