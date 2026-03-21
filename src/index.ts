import { buildApp } from './app'

const PORT = parseInt(process.env.PORT ?? '3001', 10)
const HOST = '0.0.0.0'

async function main() {
  const app = await buildApp()

  // Bootstrap : promouvoir le premier admin via INITIAL_ADMIN_EMAIL
  const initialAdminEmail = process.env.INITIAL_ADMIN_EMAIL
  if (initialAdminEmail) {
    const updated = await app.prisma.user.updateMany({
      where: { email: initialAdminEmail, role: 'developer' },
      data: { role: 'admin' },
    })
    if (updated.count > 0) {
      app.log.info(`Bootstrap: ${initialAdminEmail} promu admin`)
    }
  }

  try {
    await app.listen({ port: PORT, host: HOST })
  } catch (err) {
    app.log.error(err)
    process.exit(1)
  }
}

main()
