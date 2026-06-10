/** Docked card showing in-flight uploads with progress, retry, and dismiss (F3). */
import type { UploadJob } from '../lib/uploader.js'

const STAGE_LABEL: Record<UploadJob['stage'], string> = {
  queued: 'Waiting…',
  preparing: 'Preparing…',
  uploading: 'Uploading',
  finishing: 'Finishing…',
  done: 'Done',
  error: 'Failed',
}

export function UploadPanel({
  jobs,
  onRetry,
  onDismiss,
  onClearFinished,
}: {
  jobs: UploadJob[]
  onRetry: (id: string) => void
  onDismiss: (id: string) => void
  onClearFinished: () => void
}) {
  if (jobs.length === 0) return null
  const doneCount = jobs.filter((j) => j.stage === 'done').length

  return (
    <aside className="upload-panel" aria-label="Uploads">
      <header className="upload-panel-head">
        <span>
          Uploads {doneCount}/{jobs.length}
        </span>
        {doneCount > 0 && (
          <button className="link-btn" onClick={onClearFinished}>
            Clear finished
          </button>
        )}
      </header>
      <ul>
        {jobs.map((job) => (
          <li key={job.id} className={`upload-row stage-${job.stage}`}>
            <div className="upload-row-main">
              <span className="upload-name" title={job.fileName}>
                {job.fileName}
              </span>
              <span className="upload-stage">
                {job.stage === 'uploading'
                  ? `${STAGE_LABEL[job.stage]} ${Math.round(job.progress * 100)}%`
                  : STAGE_LABEL[job.stage]}
              </span>
              {job.stage === 'error' && (
                <button className="link-btn" onClick={() => onRetry(job.id)}>
                  Retry
                </button>
              )}
              {(job.stage === 'error' || job.stage === 'done') && (
                <button
                  className="icon-btn"
                  aria-label={`Dismiss ${job.fileName}`}
                  onClick={() => onDismiss(job.id)}
                >
                  ×
                </button>
              )}
            </div>
            {job.stage === 'error' && job.error && <p className="upload-error">{job.error}</p>}
            <div className="upload-bar">
              <div
                className="upload-bar-fill"
                style={{
                  width: `${Math.round((job.stage === 'done' || job.stage === 'finishing' ? 1 : job.progress) * 100)}%`,
                }}
              />
            </div>
          </li>
        ))}
      </ul>
    </aside>
  )
}
