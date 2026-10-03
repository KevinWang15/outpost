import { useState } from 'react'
import { Check, ChevronDown, LoaderCircle, RefreshCw, TriangleAlert } from 'lucide-react'
import type {
  Installation,
  SoftwareId,
  Target,
} from '../shared/session-manager'
import { softwareLabels } from '../shared/session-manager'
import type { useRequiredSoftware } from './useRequiredSoftware'
import { api } from './api'
import { Modal } from './ui'
import InstallModal from './InstallModal'
import ToolPicker from './ToolPicker'
import BackendPicker from './BackendPicker'

export default function RequiredSoftware({
  target,
  state,
  onUpdate,
  onInstallClose,
  onDialogOpen,
}: {
  target: Target
  state: ReturnType<typeof useRequiredSoftware>
  onUpdate: (target: Target) => void
  onInstallClose: () => void
  onDialogOpen: () => void
}) {
  const { report, checking, error, refresh } = state
  const [expanded, setExpanded] = useState<boolean | null>(null)
  const [install, setInstall] = useState<{
    softwareId: SoftwareId
    installation?: Installation
  } | null>(null)
  const [editing, setEditing] = useState(false),
    [tools, setTools] = useState(target.tools)
  const [backends, setBackends] = useState(target.backends)
  const [saving, setSaving] = useState(false),
    [saveError, setSaveError] = useState('')
  const allGood =
    !!report && report.software.every((item) => item.status === 'installed')
  const problemCount =
    report?.software.filter((item) => item.status !== 'installed').length ?? 0
  const open = expanded ?? !allGood
  const currentJob = report?.installation
  async function saveRequirements() {
    setSaving(true)
    setSaveError('')
    try {
      const updated = await api<Target>(
        `/targets/${target.id}/requirements`,
        'PATCH',
        { tools, backends },
      )
      onUpdate(updated)
      setEditing(false)
      setExpanded(null)
    } catch (error) {
      setSaveError((error as Error).message)
    } finally {
      setSaving(false)
    }
  }
  function closeInstall() {
    setInstall(null)
    setExpanded(null)
    void refresh()
    onInstallClose()
  }
  function editRequirements() {
    onDialogOpen()
    setTools(target.tools)
    setBackends(target.backends)
    setSaveError('')
    setEditing(true)
  }
  return (
    <section
      className={`software-panel ${allGood ? 'good' : 'attention'}`}
      aria-label="Required Software"
    >
      <div className="software-heading">
        <button
          className="software-toggle"
          aria-expanded={open}
          onClick={() => setExpanded(!open)}
        >
          {checking ? (
            <LoaderCircle className="loading-spinner" />
          ) : allGood ? (
            <Check />
          ) : (
            <TriangleAlert />
          )}
          <span>
            <strong>Required Software</strong>
            <small>
              {checking
                ? 'Checking this instance…'
                : error
                  ? 'Could not check software'
                  : allGood
                    ? 'All good · required software is installed'
                    : `${problemCount} ${problemCount === 1 ? 'requirement needs' : 'requirements need'} attention`}
            </small>
          </span>
          <ChevronDown />
        </button>
        <button
          className={`icon-button ${checking ? 'spinning' : ''}`}
          aria-label="Refresh required software"
          disabled={checking}
          onClick={() => {
            setExpanded(null)
            void refresh()
          }}
        >
          <RefreshCw />
        </button>
      </div>
      {open && (
        <div className="software-body">
          <p className="software-explanation">
            Checks the instance’s interactive login PATH and executable
            versions. Authentication is handled by each coding tool when you
            connect.
          </p>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          {report && (
            <div className="software-list">
              {report.software.map((item) => (
                <div className={`software-row ${item.status}`} key={item.id}>
                  {item.status === 'installed' ? (
                    <Check size={17} />
                  ) : (
                    <TriangleAlert size={17} />
                  )}
                  <div>
                    <strong>{softwareLabels[item.id]}</strong>
                    <span>
                      {item.status === 'missing'
                        ? 'Not installed'
                        : item.status === 'broken'
                          ? 'Version check failed'
                          : item.version}
                    </span>
                    {item.path && <code>{item.path}</code>}
                    {item.detail && <p>{item.detail}</p>}
                  </div>
                  {item.status !== 'installed' && (
                    <button
                      className="button secondary"
                      aria-label={`Auto install ${softwareLabels[item.id]}`}
                      disabled={currentJob?.status === 'running'}
                      onClick={() => { onDialogOpen(); setInstall({ softwareId: item.id }) }}
                    >
                      Auto install
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
          {currentJob && (
            <div className="installation-summary" role="status">
              <span>
                {softwareLabels[currentJob.softwareId]} installation:{' '}
                {currentJob.status === 'running'
                  ? 'running'
                  : currentJob.status === 'succeeded'
                    ? 'script completed'
                    : 'failed'}
              </span>
              <button
                className="button secondary"
                onClick={() => {
                  onDialogOpen()
                  setInstall({
                    softwareId: currentJob.softwareId,
                    installation: currentJob,
                  })
                }}
              >
                View installation log
              </button>
            </div>
          )}
          <div className="software-footer">
            <span>
              {report
                ? `Checked ${new Date(report.checkedAt).toLocaleTimeString()}`
                : 'Software checks run live on this instance.'}
            </span>
            <button className="button secondary" onClick={editRequirements}>
              Configure required software
            </button>
          </div>
        </div>
      )}
      {install && (
        <InstallModal
          targetId={target.id}
          {...install}
          onClose={closeInstall}
        />
      )}
      {editing && (
        <Modal
          title="Configure required software"
          subtitle={`Choose session backends and coding tools for new sessions on ${target.name}. Existing sessions stay visible and keep their backend and coding tool.`}
          closeDisabled={saving}
          onClose={() => setEditing(false)}
        >
          <BackendPicker
            value={backends}
            disabled={saving}
            onChange={setBackends}
          />
          <ToolPicker
            value={tools}
            disabled={saving}
            onChange={setTools}
          />
          {saveError && (
            <p className="error" role="alert">
              {saveError}
            </p>
          )}
          <div className="modal-actions">
            <button
              className="button secondary"
              disabled={saving}
              onClick={() => setEditing(false)}
            >
              Cancel
            </button>
            <button
              className="button primary"
              disabled={saving || !tools.length || !backends.length}
              onClick={() => void saveRequirements()}
            >
              {saving ? 'Saving…' : 'Save requirements'}
            </button>
          </div>
        </Modal>
      )}
    </section>
  )
}
