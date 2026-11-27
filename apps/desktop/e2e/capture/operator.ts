import type { ElectronApplication } from '@playwright/test'

/** Use a fixture identity in screenshots that show an approval or audit entry. */
export async function neutralUser(app: ElectronApplication): Promise<void> {
  await app.evaluate(() => {
    const req = (process as unknown as { mainModule?: { require: (m: string) => unknown } }).mainModule?.require
    if (!req) throw new Error('no main require')
    const os = req('node:os') as { userInfo: (o?: unknown) => Record<string, unknown> }
    const orig = os.userInfo.bind(os)
    os.userInfo = (o?: unknown) => ({ ...orig(o), username: 'netops', homedir: '/home/netops' })
  })
}
