import { buildApp } from './app'

const PORT = parseInt(process.env.PORT ?? '3001', 10)
const HOST = '0.0.0.0'

async function main() {
  const app = await buildApp()

  try {
    await app.listen({ port: PORT, host: HOST })
  } catch (err) {
    app.log.error(err)
    process.exit(1)
  }
}

main()
