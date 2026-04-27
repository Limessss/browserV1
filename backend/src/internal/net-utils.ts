/**
 * 本地调试端口分配（对齐 Go nextAvailablePort 语义：随机可用端口）。
 */
import { createServer } from 'node:net'

export async function allocateLocalPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      s.close((err) => {
        if (err) reject(err)
        else resolve(port)
      })
    })
  })
}
