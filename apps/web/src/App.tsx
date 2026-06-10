import { useEffect, useState } from 'react'
import type { HealthResponse } from '@cf-mediashare/shared'

type Status =
  | { state: 'loading' }
  | { state: 'ok'; data: HealthResponse }
  | { state: 'error'; message: string }

export function App() {
  const [status, setStatus] = useState<Status>({ state: 'loading' })

  useEffect(() => {
    fetch('/api/health')
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = (await res.json()) as HealthResponse
        setStatus({ state: 'ok', data })
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : 'Unknown error'
        setStatus({ state: 'error', message })
      })
  }, [])

  return (
    <main className="shell">
      <h1>cf-mediashare</h1>
      <p className="tagline">
        Self-hosted, Cloudflare-native photo &amp; video sharing for small trusted groups.
      </p>

      <section className="card">
        <h2>Phase 0 — Scaffold</h2>
        <p>
          Deployable skeleton: one Worker serving this app and the API. Build out the phases in{' '}
          <code>DEVELOPMENT.md</code>.
        </p>
        <p className="probe">
          Worker API:{' '}
          {status.state === 'loading' && <span className="muted">checking…</span>}
          {status.state === 'ok' && (
            <span className="ok">healthy ({status.data.service})</span>
          )}
          {status.state === 'error' && (
            <span className="err">unreachable — {status.message}</span>
          )}
        </p>
      </section>
    </main>
  )
}
